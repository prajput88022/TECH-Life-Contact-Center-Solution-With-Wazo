SET ROLE techlife;

BEGIN;

-- ============================================================
-- TECH-Life Call Intelligence: Capture sessions
-- One capture session represents one live or scheduled window.
-- HEP capture remains globally controlled by the scheduler.
-- ============================================================

CREATE TABLE call_intelligence_capture_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    trunk_id UUID NOT NULL,

    requested_by UUID,

    capture_mode VARCHAR(16) NOT NULL DEFAULT 'scheduled'
        CHECK (capture_mode IN ('live', 'scheduled')),

    capture_profile VARCHAR(16) NOT NULL DEFAULT 'sip'
        CHECK (capture_profile IN ('sip', 'sip_rtcp')),

    status VARCHAR(16) NOT NULL DEFAULT 'scheduled'
        CHECK (status IN (
            'scheduled', 'starting', 'active',
            'stopping', 'completed', 'failed', 'cancelled'
        )),

    timezone VARCHAR(80) NOT NULL,

    scheduled_start_at TIMESTAMPTZ NOT NULL,
    scheduled_stop_at TIMESTAMPTZ NOT NULL,

    max_duration_seconds INTEGER NOT NULL DEFAULT 3600
        CHECK (max_duration_seconds BETWEEN 60 AND 14400),

    max_storage_bytes BIGINT NOT NULL DEFAULT 268435456
        CHECK (max_storage_bytes BETWEEN 1048576 AND 2147483648),

    retention_days SMALLINT NOT NULL DEFAULT 7
        CHECK (retention_days BETWEEN 1 AND 30),

    actual_start_at TIMESTAMPTZ,
    actual_stop_at TIMESTAMPTZ,

    stop_reason VARCHAR(80),

    packets_received BIGINT NOT NULL DEFAULT 0
        CHECK (packets_received >= 0),

    packets_persisted BIGINT NOT NULL DEFAULT 0
        CHECK (packets_persisted >= 0),

    packets_rejected BIGINT NOT NULL DEFAULT 0
        CHECK (packets_rejected >= 0),

    bytes_written BIGINT NOT NULL DEFAULT 0
        CHECK (bytes_written >= 0),

    heartbeat_at TIMESTAMPTZ,
    worker_id VARCHAR(128),

    attempt_count SMALLINT NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ci_session_trunk_fk
        FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT ci_session_tenant_id_uq
        UNIQUE (tenant_id, id),

    CONSTRAINT ci_session_tenant_id_trunk_uq
        UNIQUE (tenant_id, id, trunk_id),

    CONSTRAINT ci_session_window_ck
        CHECK (scheduled_stop_at > scheduled_start_at),

    CONSTRAINT ci_session_duration_ck
        CHECK (
            scheduled_stop_at <=
            scheduled_start_at +
            make_interval(secs => max_duration_seconds)
        ),

    CONSTRAINT ci_session_actual_window_ck
        CHECK (
            actual_stop_at IS NULL OR
            (
                actual_start_at IS NOT NULL AND
                actual_stop_at >= actual_start_at
            )
        ),

    CONSTRAINT ci_session_live_start_ck
        CHECK (
            capture_mode <> 'live' OR
            scheduled_start_at <= created_at + INTERVAL '1 minute'
        )
);

-- Only one HEP capture may be starting, active or stopping
-- at any time across the Wazo installation.
CREATE UNIQUE INDEX uq_ci_one_global_active_session
    ON call_intelligence_capture_sessions ((1))
    WHERE status IN ('starting', 'active', 'stopping');

CREATE INDEX idx_ci_sessions_scheduled
    ON call_intelligence_capture_sessions
       (scheduled_start_at, created_at)
    WHERE status = 'scheduled';

CREATE INDEX idx_ci_sessions_tenant_history
    ON call_intelligence_capture_sessions
       (tenant_id, created_at DESC);

CREATE INDEX idx_ci_sessions_tenant_trunk
    ON call_intelligence_capture_sessions
       (tenant_id, trunk_id, scheduled_start_at DESC);


-- ============================================================
-- HEP telemetry records accepted for a capture session.
-- The application must filter trunk ownership before INSERT.
-- ============================================================

CREATE TABLE call_intelligence_packets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    tenant_id UUID NOT NULL,
    session_id UUID NOT NULL,
    trunk_id UUID NOT NULL,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    packet_time TIMESTAMPTZ,

    record_type VARCHAR(8) NOT NULL
        CHECK (record_type IN ('sip', 'rtcp')),

    correlation_id VARCHAR(512),
    call_id VARCHAR(512),
    channel_name VARCHAR(512),

    source_ip INET,
    destination_ip INET,

    source_port INTEGER
        CHECK (source_port IS NULL OR source_port BETWEEN 1 AND 65535),

    destination_port INTEGER
        CHECK (destination_port IS NULL OR destination_port BETWEEN 1 AND 65535),

    transport_protocol SMALLINT
        CHECK (transport_protocol IS NULL OR transport_protocol IN (6, 17)),

    sip_method VARCHAR(32),
    sip_status_code SMALLINT
        CHECK (sip_status_code IS NULL OR sip_status_code BETWEEN 100 AND 699),

    sip_reason VARCHAR(256),
    sip_cseq VARCHAR(128),
    sip_request_uri TEXT,
    sip_from_uri TEXT,
    sip_to_uri TEXT,

    payload BYTEA,

    parsed_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT ci_packet_session_trunk_fk
        FOREIGN KEY (tenant_id, session_id, trunk_id)
        REFERENCES call_intelligence_capture_sessions
                   (tenant_id, id, trunk_id)
        ON DELETE CASCADE,

    CONSTRAINT ci_packet_payload_size_ck
        CHECK (
            payload IS NULL OR octet_length(payload) <= 262144
        )
);

CREATE INDEX idx_ci_packets_session_time
    ON call_intelligence_packets
       (tenant_id, session_id, packet_time, id);

CREATE INDEX idx_ci_packets_correlation
    ON call_intelligence_packets
       (tenant_id, session_id, correlation_id);

CREATE INDEX idx_ci_packets_channel
    ON call_intelligence_packets
       (tenant_id, session_id, channel_name);


-- ============================================================
-- Actual files produced by the capture worker.
-- Paths are relative to the protected capture storage root.
-- ============================================================

CREATE TABLE call_intelligence_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id UUID NOT NULL,
    session_id UUID NOT NULL,
    trunk_id UUID NOT NULL,

    artifact_type VARCHAR(20) NOT NULL
        CHECK (artifact_type IN (
            'sip_pcap', 'sip_txt', 'rtcp_report',
            'hep_jsonl', 'manifest'
        )),

    file_name VARCHAR(255) NOT NULL,
    relative_path TEXT NOT NULL,

    content_type VARCHAR(128),

    byte_size BIGINT NOT NULL DEFAULT 0
        CHECK (byte_size >= 0),

    sha256 CHAR(64),

    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ci_artifact_session_trunk_fk
        FOREIGN KEY (tenant_id, session_id, trunk_id)
        REFERENCES call_intelligence_capture_sessions
                   (tenant_id, id, trunk_id)
        ON DELETE CASCADE,

    CONSTRAINT ci_artifact_path_ck
        CHECK (
            relative_path <> '' AND
            relative_path NOT LIKE '/%' AND
            relative_path !~ '(^|/)\.\.(/|$)'
        ),

    CONSTRAINT ci_artifact_hash_ck
        CHECK (sha256 IS NULL OR sha256 ~ '^[a-fA-F0-9]{64}$')
);

CREATE INDEX idx_ci_artifacts_session
    ON call_intelligence_artifacts
       (tenant_id, session_id, created_at DESC);

CREATE INDEX idx_ci_artifacts_expiry
    ON call_intelligence_artifacts (expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE call_intelligence_capture_sessions IS
    'Tenant-owned live and scheduled TECH-Life HEP capture sessions.';

COMMENT ON TABLE call_intelligence_packets IS
    'HEP-derived SIP and RTCP records accepted after tenant/trunk filtering.';

COMMENT ON TABLE call_intelligence_artifacts IS
    'Files generated by TECH-Life Call Intelligence capture sessions.';

COMMIT;

RESET ROLE;
