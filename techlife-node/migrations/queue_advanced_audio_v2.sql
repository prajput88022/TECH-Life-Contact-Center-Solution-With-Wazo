BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS queues_tenant_id_id_uq
    ON queues (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS ivr_menus_tenant_id_id_uq
    ON ivr_menus (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS agents_tenant_id_id_uq
    ON agents (tenant_id, id);

ALTER TABLE queues
    ADD COLUMN IF NOT EXISTS welcome_asset_id UUID,
    ADD COLUMN IF NOT EXISTS wazo_welcome_sound TEXT,
    ADD COLUMN IF NOT EXISTS wazo_periodic_announce_sound TEXT,
    ADD COLUMN IF NOT EXISTS wazo_audio_sync_status VARCHAR(20)
        NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS wazo_audio_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS wazo_audio_last_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wait_timeout_action VARCHAR(20)
        NOT NULL DEFAULT 'hangup',
    ADD COLUMN IF NOT EXISTS wait_timeout_queue_id UUID,
    ADD COLUMN IF NOT EXISTS wait_timeout_ivr_id UUID,
    ADD COLUMN IF NOT EXISTS wait_timeout_agent_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queues_welcome_asset_tenant_fk') THEN
        ALTER TABLE queues ADD CONSTRAINT queues_welcome_asset_tenant_fk
            FOREIGN KEY (tenant_id, welcome_asset_id)
            REFERENCES media_assets (tenant_id, id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queues_timeout_queue_tenant_fk') THEN
        ALTER TABLE queues ADD CONSTRAINT queues_timeout_queue_tenant_fk
            FOREIGN KEY (tenant_id, wait_timeout_queue_id)
            REFERENCES queues (tenant_id, id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queues_timeout_ivr_tenant_fk') THEN
        ALTER TABLE queues ADD CONSTRAINT queues_timeout_ivr_tenant_fk
            FOREIGN KEY (tenant_id, wait_timeout_ivr_id)
            REFERENCES ivr_menus (tenant_id, id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queues_timeout_agent_tenant_fk') THEN
        ALTER TABLE queues ADD CONSTRAINT queues_timeout_agent_tenant_fk
            FOREIGN KEY (tenant_id, wait_timeout_agent_id)
            REFERENCES agents (tenant_id, id) ON DELETE RESTRICT;
    END IF;
END
$$;

ALTER TABLE queues
    ADD CONSTRAINT queues_wait_timeout_action_ck
    CHECK (
        (wait_timeout_action = 'hangup'
            AND wait_timeout_queue_id IS NULL
            AND wait_timeout_ivr_id IS NULL
            AND wait_timeout_agent_id IS NULL)
        OR
        (wait_timeout_action = 'queue'
            AND wait_timeout_queue_id IS NOT NULL
            AND wait_timeout_ivr_id IS NULL
            AND wait_timeout_agent_id IS NULL)
        OR
        (wait_timeout_action = 'ivr'
            AND wait_timeout_queue_id IS NULL
            AND wait_timeout_ivr_id IS NOT NULL
            AND wait_timeout_agent_id IS NULL)
        OR
        (wait_timeout_action = 'agent'
            AND wait_timeout_queue_id IS NULL
            AND wait_timeout_ivr_id IS NULL
            AND wait_timeout_agent_id IS NOT NULL)
    );

COMMIT;
