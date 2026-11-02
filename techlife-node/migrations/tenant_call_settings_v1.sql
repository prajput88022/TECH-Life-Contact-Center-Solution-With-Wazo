CREATE TABLE IF NOT EXISTS tenant_call_settings (
    tenant_id UUID PRIMARY KEY
        REFERENCES tenants(id) ON DELETE CASCADE,
    inbound_auto_answer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_call_settings
    ADD COLUMN IF NOT EXISTS inbound_auto_answer_enabled
        BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tenant_call_settings
    ADD COLUMN IF NOT EXISTS updated_by UUID;

ALTER TABLE tenant_call_settings
    ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW();
