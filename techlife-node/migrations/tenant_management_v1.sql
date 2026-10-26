BEGIN;

-- ---------------------------------------------------------
-- 1. Ensure same-tenant composite keys can be referenced
-- ---------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_tenant_id
    ON agents (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_queues_tenant_id
    ON queues (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_tenant_id_v1
    ON campaigns (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dispositions_tenant_id_id
    ON dispositions (tenant_id, id);

-- ---------------------------------------------------------
-- 2. Repair queue membership tenant ownership
-- ---------------------------------------------------------
ALTER TABLE queue_agents
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE queue_agents qa
SET tenant_id = q.tenant_id
FROM queues q
WHERE q.id = qa.queue_id
  AND qa.tenant_id IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM queue_agents WHERE tenant_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration stopped: queue_agents has rows whose queue could not be mapped to a tenant';
    END IF;
END $$;

ALTER TABLE queue_agents
    ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_queue_agents_tenant_queue
    ON queue_agents (tenant_id, queue_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_queue_agents_tenant_queue'
    ) THEN
        ALTER TABLE queue_agents
            ADD CONSTRAINT fk_queue_agents_tenant_queue
            FOREIGN KEY (tenant_id, queue_id)
            REFERENCES queues (tenant_id, id)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_queue_agents_tenant_agent'
    ) THEN
        ALTER TABLE queue_agents
            ADD CONSTRAINT fk_queue_agents_tenant_agent
            FOREIGN KEY (tenant_id, agent_id)
            REFERENCES agents (tenant_id, id)
            NOT VALID;
    END IF;
END $$;

ALTER TABLE queue_agents
    VALIDATE CONSTRAINT fk_queue_agents_tenant_queue;

ALTER TABLE queue_agents
    VALIDATE CONSTRAINT fk_queue_agents_tenant_agent;

-- ---------------------------------------------------------
-- 3. Repair campaign membership tenant ownership
-- ---------------------------------------------------------
ALTER TABLE campaign_agents
    ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE campaign_agents ca
SET tenant_id = c.tenant_id
FROM campaigns c
WHERE c.id = ca.campaign_id
  AND ca.tenant_id IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM campaign_agents WHERE tenant_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Migration stopped: campaign_agents has rows whose campaign could not be mapped to a tenant';
    END IF;
END $$;

ALTER TABLE campaign_agents
    ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_agents_tenant_campaign
    ON campaign_agents (tenant_id, campaign_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_campaign_agents_tenant_campaign'
    ) THEN
        ALTER TABLE campaign_agents
            ADD CONSTRAINT fk_campaign_agents_tenant_campaign
            FOREIGN KEY (tenant_id, campaign_id)
            REFERENCES campaigns (tenant_id, id)
            NOT VALID;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_campaign_agents_tenant_agent'
    ) THEN
        ALTER TABLE campaign_agents
            ADD CONSTRAINT fk_campaign_agents_tenant_agent
            FOREIGN KEY (tenant_id, agent_id)
            REFERENCES agents (tenant_id, id)
            NOT VALID;
    END IF;
END $$;

ALTER TABLE campaign_agents
    VALIDATE CONSTRAINT fk_campaign_agents_tenant_campaign;

ALTER TABLE campaign_agents
    VALIDATE CONSTRAINT fk_campaign_agents_tenant_agent;

-- ---------------------------------------------------------
-- 4. Three-level disposition hierarchy
-- parent_id is nullable for top-level dispositions.
-- ---------------------------------------------------------
ALTER TABLE dispositions
    ADD COLUMN IF NOT EXISTS parent_id UUID,
    ADD COLUMN IF NOT EXISTS hierarchy_level SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_dispositions_tenant_parent'
    ) THEN
        ALTER TABLE dispositions
            ADD CONSTRAINT fk_dispositions_tenant_parent
            FOREIGN KEY (tenant_id, parent_id)
            REFERENCES dispositions (tenant_id, id)
            NOT VALID;
    END IF;
END $$;

ALTER TABLE dispositions
    VALIDATE CONSTRAINT fk_dispositions_tenant_parent;

ALTER TABLE dispositions
    DROP CONSTRAINT IF EXISTS dispositions_hierarchy_level_check;

ALTER TABLE dispositions
    ADD CONSTRAINT dispositions_hierarchy_level_check
    CHECK (hierarchy_level BETWEEN 1 AND 3);

ALTER TABLE dispositions
    DROP CONSTRAINT IF EXISTS dispositions_no_self_parent_check;

ALTER TABLE dispositions
    ADD CONSTRAINT dispositions_no_self_parent_check
    CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX IF NOT EXISTS idx_dispositions_tenant_tree
    ON dispositions (tenant_id, parent_id, hierarchy_level, sort_order);

-- Existing dispositions remain top-level (level 1).
-- The admin routes must validate parent level and prevent cycles.

-- ---------------------------------------------------------
-- 5. Tenant-specific pause / break codes
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS pause_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code VARCHAR(40) NOT NULL,
    label VARCHAR(120) NOT NULL,
    description VARCHAR(500),
    is_paid BOOLEAN NOT NULL DEFAULT TRUE,
    counts_toward_productivity BOOLEAN NOT NULL DEFAULT FALSE,
    max_duration_seconds INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_pause_codes_tenant_code UNIQUE (tenant_id, code),
    CONSTRAINT ck_pause_codes_duration
        CHECK (max_duration_seconds IS NULL OR max_duration_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_pause_codes_tenant_active
    ON pause_codes (tenant_id, is_active, sort_order, code);

-- ---------------------------------------------------------
-- 6. Reusable tenant-owned media / audio catalogue
-- Store relative application paths, not user-supplied paths.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(160) NOT NULL,
    description VARCHAR(500),
    media_type VARCHAR(30) NOT NULL DEFAULT 'audio',
    storage_path TEXT NOT NULL,
    original_filename VARCHAR(255),
    mime_type VARCHAR(120),
    file_extension VARCHAR(12),
    file_size_bytes BIGINT,
    checksum_sha256 CHAR(64),
    duration_seconds NUMERIC(10,3),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    uploaded_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_media_assets_type
        CHECK (media_type IN ('audio')),
    CONSTRAINT ck_media_assets_size
        CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
    CONSTRAINT ck_media_assets_duration
        CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_active
    ON media_assets (tenant_id, is_active, name);

CREATE INDEX IF NOT EXISTS idx_media_assets_tenant_checksum
    ON media_assets (tenant_id, checksum_sha256)
    WHERE checksum_sha256 IS NOT NULL;

COMMIT;
