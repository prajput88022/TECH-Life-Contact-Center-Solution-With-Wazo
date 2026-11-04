BEGIN;

CREATE TABLE IF NOT EXISTS agent_digital_presence (
    tenant_id UUID NOT NULL,
    agent_id UUID NOT NULL,
    session_hash CHAR(64) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'active',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agent_digital_presence_pkey
        PRIMARY KEY (tenant_id, agent_id, session_hash),

    CONSTRAINT agent_digital_presence_status_check
        CHECK (status IN ('active', 'away')),

    CONSTRAINT fk_agent_digital_presence_agent
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_digital_presence_active
    ON agent_digital_presence (tenant_id, last_seen_at DESC)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_agent_digital_presence_agent
    ON agent_digital_presence (tenant_id, agent_id, last_seen_at DESC);

COMMIT;
