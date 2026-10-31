BEGIN;

CREATE TABLE IF NOT EXISTS inbound_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    group_code VARCHAR(40) NOT NULL,
    name VARCHAR(150) NOT NULL,
    destination_type VARCHAR(20) NOT NULL DEFAULT 'queue',
    default_queue_id UUID,
    default_ivr_id UUID,
    default_agent_id UUID,
    default_extension VARCHAR(30),
    queue_timeout_seconds INTEGER NOT NULL DEFAULT 60,
    no_agent_action VARCHAR(20) NOT NULL DEFAULT 'voicemail',
    welcome_message TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT inbound_groups_tenant_code_unique
        UNIQUE (tenant_id, group_code),

    CONSTRAINT inbound_groups_destination_check
        CHECK (destination_type IN ('queue','ivr','agent','extension')),

    CONSTRAINT inbound_groups_timeout_check
        CHECK (queue_timeout_seconds BETWEEN 0 AND 7200),

    CONSTRAINT inbound_groups_no_agent_check
        CHECK (no_agent_action IN ('voicemail','hangup','extension'))
);

ALTER TABLE dids
    ADD COLUMN IF NOT EXISTS inbound_group_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dids_inbound_group_fk'
          AND conrelid = 'dids'::regclass
    ) THEN
        ALTER TABLE dids
            ADD CONSTRAINT dids_inbound_group_fk
            FOREIGN KEY (inbound_group_id)
            REFERENCES inbound_groups(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inbound_groups_tenant_active
    ON inbound_groups(tenant_id, is_active);

CREATE INDEX IF NOT EXISTS idx_dids_inbound_group
    ON dids(tenant_id, inbound_group_id);

COMMIT;
