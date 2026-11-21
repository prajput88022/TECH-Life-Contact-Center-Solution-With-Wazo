SET ROLE techlife;

BEGIN;

-- Agent SIP legs do not necessarily have a direct trunk identifier.
ALTER TABLE call_intelligence_packets
    ALTER COLUMN trunk_id DROP NOT NULL;

ALTER TABLE call_intelligence_packets
    ADD COLUMN channel_role VARCHAR(16) NOT NULL DEFAULT 'trunk';

ALTER TABLE call_intelligence_packets
    ADD CONSTRAINT ci_packet_channel_role_ck
    CHECK (
        (channel_role = 'trunk' AND trunk_id IS NOT NULL)
        OR
        (channel_role = 'agent' AND agent_id IS NOT NULL)
    );

ALTER TABLE call_intelligence_ami_events
    ADD COLUMN channel_role VARCHAR(16) NOT NULL DEFAULT 'trunk';

ALTER TABLE call_intelligence_ami_events
    ADD CONSTRAINT ci_ami_channel_role_ck
    CHECK (
        (channel_role = 'trunk' AND trunk_id IS NOT NULL)
        OR
        (channel_role = 'agent' AND agent_id IS NOT NULL)
    );

-- Normalized call-leg snapshots for graphical journey and SIP ladder.
CREATE TABLE call_intelligence_call_legs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    tenant_id UUID NOT NULL,
    session_id UUID NOT NULL,

    app_call_id UUID,
    trunk_id UUID,
    agent_id UUID,

    channel_role VARCHAR(16) NOT NULL
        CHECK (channel_role IN ('trunk', 'agent')),

    channel_name VARCHAR(512) NOT NULL,
    peer_channel VARCHAR(512),

    unique_id VARCHAR(256),
    linked_id VARCHAR(256),

    endpoint_name VARCHAR(128),

    direction VARCHAR(24),
    caller_id_number VARCHAR(256),
    connected_line_number VARCHAR(256),

    context_name VARCHAR(256),
    extension VARCHAR(256),

    channel_state VARCHAR(64),
    hangup_cause INTEGER,
    hangup_cause_text VARCHAR(256),

    started_at TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,

    event_count BIGINT NOT NULL DEFAULT 0
        CHECK (event_count >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ci_leg_session_fk
        FOREIGN KEY (tenant_id, session_id)
        REFERENCES call_intelligence_capture_sessions (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT ci_leg_call_fk
        FOREIGN KEY (tenant_id, app_call_id)
        REFERENCES calls (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_leg_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_leg_agent_fk
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_leg_role_owner_ck
        CHECK (
            (channel_role = 'trunk' AND trunk_id IS NOT NULL)
            OR
            (channel_role = 'agent' AND agent_id IS NOT NULL)
        ),

    CONSTRAINT ci_leg_time_ck
        CHECK (
            (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
            AND
            (answered_at IS NULL OR started_at IS NULL OR answered_at >= started_at)
        )
);

CREATE UNIQUE INDEX uq_ci_leg_unique_id
    ON call_intelligence_call_legs
       (tenant_id, session_id, unique_id)
    WHERE unique_id IS NOT NULL AND unique_id <> '';

CREATE INDEX idx_ci_legs_linked_id
    ON call_intelligence_call_legs
       (tenant_id, session_id, linked_id);

CREATE INDEX idx_ci_legs_call
    ON call_intelligence_call_legs
       (tenant_id, app_call_id, started_at);

CREATE INDEX idx_ci_legs_agent
    ON call_intelligence_call_legs
       (tenant_id, agent_id, started_at DESC)
    WHERE agent_id IS NOT NULL;

CREATE INDEX idx_ci_legs_trunk
    ON call_intelligence_call_legs
       (tenant_id, trunk_id, started_at DESC)
    WHERE trunk_id IS NOT NULL;

COMMENT ON TABLE call_intelligence_call_legs IS
    'Verified Asterisk trunk and agent SIP channel legs for graphical call journey reconstruction.';

COMMIT;

RESET ROLE;
