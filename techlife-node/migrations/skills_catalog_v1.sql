BEGIN;

CREATE TABLE IF NOT EXISTS skills (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL,
    description VARCHAR(250),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT skills_tenant_name_unique UNIQUE (tenant_id, name),
    CONSTRAINT skills_name_format CHECK (
        name = lower(name)
        AND name ~ '^[a-z0-9][a-z0-9 _-]{0,59}$'
    )
);

CREATE INDEX IF NOT EXISTS idx_skills_tenant_active_name
    ON skills (tenant_id, is_active, name);

COMMIT;
