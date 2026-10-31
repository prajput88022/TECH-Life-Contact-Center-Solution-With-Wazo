BEGIN;

CREATE TABLE IF NOT EXISTS tenant_activity_log_settings (
    tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    categories jsonb NOT NULL DEFAULT
      '{"auth":true,"users":true,"campaigns":true,"telephony":true,"ivr":true,"integrations":true,"other":true}'::jsonb,
    updated_by uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenant_activity_log_categories_object
      CHECK (jsonb_typeof(categories) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx
    ON audit_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_action_created_idx
    ON audit_logs (tenant_id, action, created_at DESC);

COMMIT;
