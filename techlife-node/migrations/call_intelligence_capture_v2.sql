SET ROLE techlife;

BEGIN;

-- ============================================================
-- TECH-Life Call Intelligence v2
-- Tenant / trunk / agent scopes and concurrent capture sessions.
-- ============================================================

-- The old packet and artifact foreign keys reference the
-- session's single trunk. Remove them before changing that model.

ALTER TABLE call_intelligence_packets
    DROP CONSTRAINT IF EXISTS ci_packet_session_trunk_fk;

ALTER TABLE call_intelligence_artifacts
    DROP CONSTRAINT IF EXISTS ci_artifact_session_trunk_fk;

-- The former model allowed only one active capture globally.
-- One shared HEP receiver will now serve multiple active sessions.

DROP INDEX IF EXISTS public.uq_ci_one_global_active_session;

-- ============================================================
-- 1. Capture session ownership and scope
-- ============================================================

ALTER TABLE call_intelligence_capture_sessions
    DROP CONSTRAINT IF EXISTS ci_session_trunk_fk;

ALTER TABLE call_intelligence_capture_sessions
    DROP CONSTRAINT IF EXISTS ci_session_tenant_id_trunk_uq;

ALTER TABLE call_intelligence_capture_sessions
    ALTER COLUMN trunk_id DROP NOT NULL;

ALTER TABLE call_intelligence_capture_sessions
    ADD COLUMN capture_scope VARCHAR(16) NOT NULL DEFAULT 'trunk',
    ADD COLUMN agent_id UUID;

ALTER TABLE call_intelligence_capture_sessions
    ADD CONSTRAINT ci_session_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_capture_sessions
    ADD CONSTRAINT ci_session_agent_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_capture_sessions
    ADD CONSTRAINT ci_session_scope_ck
        CHECK (
            (
                capture_scope = 'tenant'
                AND trunk_id IS NULL
                AND agent_id IS NULL
            )
            OR
            (
                capture_scope = 'trunk'
                AND trunk_id IS NOT NULL
                AND agent_id IS NULL
            )
            OR
            (
                capture_scope = 'agent'
                AND agent_id IS NOT NULL
            )
        );

-- Reserve the RTP-capable profile in the schema.
-- The application must not offer it until the dedicated RTP
-- media-capture component is installed and verified.

ALTER TABLE call_intelligence_capture_sessions
    DROP CONSTRAINT IF EXISTS
        call_intelligence_capture_sessions_capture_profile_check;

ALTER TABLE call_intelligence_capture_sessions
    ADD CONSTRAINT ci_session_profile_ck
        CHECK (capture_profile IN (
            'sip',
            'sip_rtcp',
            'sip_rtp_rtcp'
        ));

CREATE INDEX idx_ci_sessions_scope_history
    ON call_intelligence_capture_sessions
       (tenant_id, capture_scope, created_at DESC);

CREATE INDEX idx_ci_sessions_agent_history
    ON call_intelligence_capture_sessions
       (tenant_id, agent_id, created_at DESC)
    WHERE agent_id IS NOT NULL;

CREATE INDEX idx_ci_sessions_active
    ON call_intelligence_capture_sessions
       (status, scheduled_start_at)
    WHERE status IN ('scheduled', 'starting', 'active', 'stopping');

CREATE INDEX idx_ci_sessions_tenant_active
    ON call_intelligence_capture_sessions
       (tenant_id, status, scheduled_start_at)
    WHERE status IN ('scheduled', 'starting', 'active', 'stopping');


-- ============================================================
-- 2. Packet attribution
-- Each accepted packet has one verified tenant-owned trunk.
-- Agent and application-call attribution are optional.
-- ============================================================

ALTER TABLE call_intelligence_packets
    ADD COLUMN agent_id UUID,
    ADD COLUMN app_call_id UUID;

ALTER TABLE call_intelligence_packets
    ADD CONSTRAINT ci_packet_session_fk
        FOREIGN KEY (tenant_id, session_id)
        REFERENCES call_intelligence_capture_sessions (tenant_id, id)
        ON DELETE CASCADE;

ALTER TABLE call_intelligence_packets
    ADD CONSTRAINT ci_packet_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_packets
    ADD CONSTRAINT ci_packet_agent_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_packets
    ADD CONSTRAINT ci_packet_app_call_fk
        FOREIGN KEY (tenant_id, app_call_id)
        REFERENCES calls (tenant_id, id)
        ON DELETE RESTRICT;

CREATE INDEX idx_ci_packets_agent_time
    ON call_intelligence_packets
       (tenant_id, session_id, agent_id, packet_time);

CREATE INDEX idx_ci_packets_app_call
    ON call_intelligence_packets
       (tenant_id, app_call_id, packet_time)
    WHERE app_call_id IS NOT NULL;


-- ============================================================
-- 3. Session and target artifacts
-- A tenant-wide artifact need not belong to one trunk.
-- ============================================================

ALTER TABLE call_intelligence_artifacts
    ALTER COLUMN trunk_id DROP NOT NULL;

ALTER TABLE call_intelligence_artifacts
    ADD COLUMN agent_id UUID;

ALTER TABLE call_intelligence_artifacts
    ADD CONSTRAINT ci_artifact_session_fk
        FOREIGN KEY (tenant_id, session_id)
        REFERENCES call_intelligence_capture_sessions (tenant_id, id)
        ON DELETE CASCADE;

ALTER TABLE call_intelligence_artifacts
    ADD CONSTRAINT ci_artifact_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_artifacts
    ADD CONSTRAINT ci_artifact_agent_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT;

ALTER TABLE call_intelligence_artifacts
    DROP CONSTRAINT IF EXISTS
        call_intelligence_artifacts_artifact_type_check;

ALTER TABLE call_intelligence_artifacts
    ADD CONSTRAINT ci_artifact_type_ck
        CHECK (artifact_type IN (
            'sip_pcap',
            'rtp_pcap',
            'full_pcap',
            'sip_txt',
            'rtcp_report',
            'hep_jsonl',
            'manifest'
        ));

CREATE INDEX idx_ci_artifacts_agent
    ON call_intelligence_artifacts
       (tenant_id, agent_id, created_at DESC)
    WHERE agent_id IS NOT NULL;


-- ============================================================
-- 4. AMI channel lifecycle and DTMF events
-- Only whitelisted, ownership-verified events should be stored.
-- Do not store arbitrary AMI events or channel variables.
-- ============================================================

CREATE TABLE call_intelligence_ami_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    tenant_id UUID NOT NULL,
    session_id UUID NOT NULL,

    trunk_id UUID,
    agent_id UUID,
    app_call_id UUID,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    event_type VARCHAR(32) NOT NULL
        CHECK (event_type IN (
            'Newchannel',
            'Newstate',
            'Hangup',
            'DialBegin',
            'DialEnd',
            'BridgeEnter',
            'BridgeLeave',
            'Rename',
            'DTMFBegin',
            'DTMFEnd',
            'VarSet'
        )),

    channel_name VARCHAR(512),
    peer_channel VARCHAR(512),

    unique_id VARCHAR(256),
    linked_id VARCHAR(256),

    wazo_tenant_uuid UUID,
    wazo_user_uuid UUID,
    wazo_line_id INTEGER,

    context_name VARCHAR(256),
    extension VARCHAR(256),

    caller_id_number VARCHAR(256),
    caller_id_name VARCHAR(256),
    connected_line_number VARCHAR(256),

    application VARCHAR(256),
    application_data TEXT,

    cause INTEGER,
    cause_text VARCHAR(256),

    digit VARCHAR(8),
    duration_ms INTEGER
        CHECK (
            duration_ms IS NULL
            OR duration_ms BETWEEN 0 AND 600000
        ),

    direction VARCHAR(24),

    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT ci_ami_event_session_fk
        FOREIGN KEY (tenant_id, session_id)
        REFERENCES call_intelligence_capture_sessions (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT ci_ami_event_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_ami_event_agent_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_ami_event_app_call_fk
        FOREIGN KEY (tenant_id, app_call_id)
        REFERENCES calls (tenant_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX idx_ci_ami_events_session_time
    ON call_intelligence_ami_events
       (tenant_id, session_id, event_time, id);

CREATE INDEX idx_ci_ami_events_linked_id
    ON call_intelligence_ami_events
       (tenant_id, linked_id, event_time)
    WHERE linked_id IS NOT NULL;

CREATE INDEX idx_ci_ami_events_unique_id
    ON call_intelligence_ami_events
       (tenant_id, unique_id, event_time)
    WHERE unique_id IS NOT NULL;

CREATE INDEX idx_ci_ami_events_agent_time
    ON call_intelligence_ami_events
       (tenant_id, agent_id, event_time)
    WHERE agent_id IS NOT NULL;

CREATE INDEX idx_ci_ami_events_app_call
    ON call_intelligence_ami_events
       (tenant_id, app_call_id, event_time)
    WHERE app_call_id IS NOT NULL;

COMMENT ON TABLE call_intelligence_ami_events IS
    'Ownership-verified Asterisk AMI channel lifecycle and DTMF events for Call Intelligence sessions.';

COMMENT ON TABLE call_intelligence_capture_sessions IS
    'Tenant, trunk or agent scoped live and scheduled capture sessions; multiple sessions may be active concurrently.';

COMMENT ON TABLE call_intelligence_packets IS
    'HEP SIP and RTCP records assigned to a verified tenant-owned trunk and optional agent/call.';

COMMENT ON TABLE call_intelligence_artifacts IS
    'Tenant, trunk or agent scoped downloadable capture artifacts.';

COMMIT;

RESET ROLE;
