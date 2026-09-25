-- Tenant and role policy for existing installations.
-- Run after schema.sql and tenant_hierarchy_schema.sql.
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'user_manager';
ALTER TYPE user_role_type ADD VALUE IF NOT EXISTS 'reports_only';
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(30) NOT NULL DEFAULT 'blue';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_check;
ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN ('blue','violet','green','orange','midnight'));

INSERT INTO permissions (code, description) VALUES
 ('users.read','View users'), ('users.write','Create and edit users'), ('users.delete','Delete users'),
 ('queues.read','View queues'), ('queues.write','Create and edit queues'), ('queues.delete','Delete queues'),
 ('ivr.read','View IVR'), ('ivr.write','Create and edit IVR'), ('ivr.delete','Delete IVR'),
 ('campaigns.read','View campaigns'), ('campaigns.write','Create and edit campaigns'),
 ('reports.read','View reports'), ('reports.export','Export reports'), ('monitor.read','Monitor calls'),
 ('tenant.create','Create top-level tenants'), ('tenant.edit','Edit top-level tenants'), ('tenant.delete','Delete top-level tenants'),
 ('tenant.subtenant.create','Create child tenants'), ('tenant.subtenant.edit','Edit owned child tenants'), ('tenant.subtenant.delete','Delete owned child tenants')
ON CONFLICT (code) DO NOTHING;

INSERT INTO roles (tenant_id, name, role_type, is_system)
SELECT t.id, v.name, v.role_type::user_role_type, TRUE
FROM tenants t CROSS JOIN (VALUES ('Manager','manager'),('User Manager','user_manager'),('Reports Only','reports_only')) v(name,role_type)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.tenant_id=t.id AND r.role_type=v.role_type::user_role_type);
