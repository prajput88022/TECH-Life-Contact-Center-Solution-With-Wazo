BEGIN;

-- Tenant-scoped unique keys support composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trunks_tenant_id
    ON trunks (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_tenant_id
    ON agents (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_tenant_id
    ON campaigns (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prefixes_tenant_id
    ON prefixes (tenant_id, id);

-- User groups are tenant-owned.
CREATE TABLE IF NOT EXISTS user_groups (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(120) NOT NULL,
    description VARCHAR(500),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_groups_tenant
    ON user_groups (tenant_id);

-- Only agents belonging to the same tenant can join a group.
CREATE TABLE IF NOT EXISTS user_group_agents (
    tenant_id UUID NOT NULL,
    group_id  UUID NOT NULL,
    agent_id  UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (group_id, agent_id),

    FOREIGN KEY (tenant_id, group_id)
        REFERENCES user_groups (tenant_id, id) ON DELETE CASCADE,

    FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_group_agents_agent
    ON user_group_agents (tenant_id, agent_id);

-- Optional route scopes. NULL means that dimension is unrestricted.
ALTER TABLE prefixes
    ADD COLUMN IF NOT EXISTS campaign_id UUID,
    ADD COLUMN IF NOT EXISTS agent_id UUID,
    ADD COLUMN IF NOT EXISTS user_group_id UUID;

-- Enforce same-tenant campaign, agent and group references.
DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_prefix_campaign_same_tenant'
          AND conrelid = 'prefixes'::regclass
    ) THEN
        ALTER TABLE prefixes
            ADD CONSTRAINT fk_prefix_campaign_same_tenant
            FOREIGN KEY (tenant_id, campaign_id)
            REFERENCES campaigns (tenant_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_prefix_agent_same_tenant'
          AND conrelid = 'prefixes'::regclass
    ) THEN
        ALTER TABLE prefixes
            ADD CONSTRAINT fk_prefix_agent_same_tenant
            FOREIGN KEY (tenant_id, agent_id)
            REFERENCES agents (tenant_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_prefix_group_same_tenant'
          AND conrelid = 'prefixes'::regclass
    ) THEN
        ALTER TABLE prefixes
            ADD CONSTRAINT fk_prefix_group_same_tenant
            FOREIGN KEY (tenant_id, user_group_id)
            REFERENCES user_groups (tenant_id, id);
    END IF;
END
$migration$;

-- A prefix can use multiple trunks, all within its tenant.
CREATE TABLE IF NOT EXISTS prefix_trunks (
    tenant_id  UUID NOT NULL,
    prefix_id  UUID NOT NULL,
    trunk_id   UUID NOT NULL,
    priority   INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (prefix_id, trunk_id),

    FOREIGN KEY (tenant_id, prefix_id)
        REFERENCES prefixes (tenant_id, id) ON DELETE CASCADE,

    FOREIGN KEY (tenant_id, trunk_id)
        REFERENCES trunks (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prefix_trunks_route_order
    ON prefix_trunks (tenant_id, prefix_id, priority, trunk_id);

-- Preserve existing single-trunk assignments.
INSERT INTO prefix_trunks
    (tenant_id, prefix_id, trunk_id, priority, is_active)
SELECT p.tenant_id, p.id, p.trunk_id, 0, TRUE
FROM prefixes p
JOIN trunks tr
  ON tr.id = p.trunk_id
 AND tr.tenant_id = p.tenant_id
ON CONFLICT (prefix_id, trunk_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_prefixes_campaign_scope
    ON prefixes (tenant_id, campaign_id)
    WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prefixes_agent_scope
    ON prefixes (tenant_id, agent_id)
    WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prefixes_group_scope
    ON prefixes (tenant_id, user_group_id)
    WHERE user_group_id IS NOT NULL;

COMMIT;
