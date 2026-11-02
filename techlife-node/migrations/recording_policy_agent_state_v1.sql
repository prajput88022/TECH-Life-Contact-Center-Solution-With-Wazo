BEGIN;

CREATE TABLE IF NOT EXISTS recording_policy_agent_state (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    wazo_user_id INTEGER NOT NULL,
    original_flags JSONB NOT NULL,
    applied_flags JSONB NOT NULL,
    sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    last_error TEXT,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, agent_id),
    CONSTRAINT recording_policy_agent_state_status_ck
        CHECK (sync_status IN ('pending','managed','restored','error','conflict')),
    CONSTRAINT recording_policy_agent_state_flags_ck
        CHECK (
            jsonb_typeof(original_flags) = 'object'
            AND jsonb_typeof(applied_flags) = 'object'
        )
);

CREATE INDEX IF NOT EXISTS idx_recording_policy_agent_state_status
ON recording_policy_agent_state (tenant_id, sync_status, updated_at);

COMMIT;
