-- Apply after schema.sql on existing installations.
-- Adds the controlled tenant-management roles and per-user theme preference.
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'user_manager';
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'reports_only';

ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(30) NOT NULL DEFAULT 'blue';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_check;
ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN ('blue','violet','green','orange','midnight'));

INSERT INTO permissions (code, description) VALUES
 ('users.read', 'View tenant users'),
 ('users.write', 'Create and edit tenant users'),
 ('users.delete', 'Delete tenant users'),
 ('queues.read', 'View queues'),
 ('queues.write', 'Create and edit queues'),
 ('queues.delete', 'Delete queues'),
 ('ivr.read', 'View IVR menus'),
 ('ivr.write', 'Create and edit IVR menus'),
 ('ivr.delete', 'Delete IVR menus'),
 ('campaigns.read', 'View campaigns'),
 ('campaigns.write', 'Create and edit campaigns'),
 ('reports.read', 'View reports'),
 ('reports.export', 'Export reports'),
 ('monitor.read', 'Monitor live calls'),
 ('tenant.create', 'Create tenants'),
 ('tenant.edit', 'Edit tenant settings'),
 ('tenant.delete', 'Delete tenants')
ON CONFLICT (code) DO NOTHING;

-- Existing tenant rows receive the additional managed roles. Existing role
-- names are preserved; this migration is safe to rerun.
INSERT INTO roles (tenant_id, name, role_type, is_system)
SELECT t.id, x.name, x.role_type::user_role_type, TRUE
FROM tenants t
CROSS JOIN (VALUES
 ('Manager','manager'), ('User Manager','user_manager'), ('Reports Only','reports_only')
) AS x(name, role_type)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.role_type = x.role_type::user_role_type
);

-- Superadmin is the only tenant lifecycle authority. Tenant admins do not
-- receive these permissions through the application role matrix.
