BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_tenant_id_id_uq
    ON media_assets (tenant_id, id);

ALTER TABLE queues
    ADD COLUMN IF NOT EXISTS moh_asset_id UUID,
    ADD COLUMN IF NOT EXISTS periodic_announce_asset_id UUID,
    ADD COLUMN IF NOT EXISTS periodic_announce_interval_seconds INTEGER NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS announce_position BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS announce_hold_time BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS retry_on_timeout BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS ring_on_hold BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS wazo_moh_uuid VARCHAR(36),
    ADD COLUMN IF NOT EXISTS wazo_moh_name VARCHAR(128),
    ADD COLUMN IF NOT EXISTS wazo_skill_rule_id INTEGER,
    ADD COLUMN IF NOT EXISTS wazo_sync_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS wazo_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS wazo_last_synced_at TIMESTAMPTZ;

ALTER TABLE skills
    ADD COLUMN IF NOT EXISTS wazo_skill_id INTEGER,
    ADD COLUMN IF NOT EXISTS wazo_skill_name VARCHAR(64),
    ADD COLUMN IF NOT EXISTS wazo_sync_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS wazo_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS wazo_last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS skills_tenant_wazo_id_uq
    ON skills (tenant_id, wazo_skill_id)
    WHERE wazo_skill_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS queues_tenant_wazo_skill_rule_uq
    ON queues (tenant_id, wazo_skill_rule_id)
    WHERE wazo_skill_rule_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'queues_moh_asset_tenant_fk'
          AND conrelid = 'public.queues'::regclass
    ) THEN
        ALTER TABLE queues ADD CONSTRAINT queues_moh_asset_tenant_fk
            FOREIGN KEY (tenant_id, moh_asset_id)
            REFERENCES media_assets (tenant_id, id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'queues_periodic_asset_tenant_fk'
          AND conrelid = 'public.queues'::regclass
    ) THEN
        ALTER TABLE queues ADD CONSTRAINT queues_periodic_asset_tenant_fk
            FOREIGN KEY (tenant_id, periodic_announce_asset_id)
            REFERENCES media_assets (tenant_id, id) ON DELETE RESTRICT;
    END IF;
END
$$;

ALTER TABLE queues
    ADD CONSTRAINT queues_periodic_announce_interval_ck
    CHECK (periodic_announce_interval_seconds BETWEEN 10 AND 3600);

COMMIT;
