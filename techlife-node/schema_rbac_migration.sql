-- =====================================================================
-- TECH-Life RBAC and Tenant Hierarchy Migration
-- Phase 1-2: Extended roles, permission model, tenant hierarchy, theme support
-- =====================================================================

-- 1. Update user_role_type ENUM to include new roles
ALTER TYPE user_role_type ADD VALUE 'manager';
ALTER TYPE user_role_type ADD VALUE 'user_manager';
ALTER TYPE user_role_type ADD VALUE 'reports_only';

-- 2. Add tenant hierarchy and type fields (if not already present)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_type VARCHAR(32) NOT NULL DEFAULT 'normal';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id);

-- 3. Add theme preference to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference VARCHAR(32) NOT NULL DEFAULT 'brand';

-- 4. Populate default permissions for all role types
INSERT INTO permissions (code, description) VALUES
  -- Superadmin permissions
  ('tenant.create', 'Create new tenants'),
  ('tenant.edit', 'Edit tenant settings'),
  ('tenant.delete', 'Delete tenants'),
  ('tenant.manage_features', 'Manage tenant features'),
  ('user.create', 'Create users'),
  ('user.edit', 'Edit users'),
  ('user.delete', 'Delete users'),
  ('user.assign_role', 'Assign roles to users'),
  ('role.manage', 'Manage roles and permissions'),
  
  -- Admin permissions
  ('queue.manage', 'Create, edit, delete queues'),
  ('ivr.manage', 'Create, edit, delete IVR menus'),
  ('campaign.manage', 'Create, edit, delete campaigns'),
  ('did.manage', 'Create, edit, delete DIDs'),
  ('trunk.manage', 'Create, edit, delete SIP trunks'),
  ('crm.configure', 'Configure CRM integrations'),
  ('privacy.configure', 'Manage privacy and masking settings'),
  ('agent.provision', 'Provision agents and SIP lines'),
  
  -- Manager permissions
  ('queue.view', 'View queue status and metrics'),
  ('queue.monitor', 'Live queue monitoring'),
  ('ivr.view', 'View IVR menus'),
  ('campaign.view', 'View campaigns'),
  ('call.monitor', 'Monitor calls in real-time'),
  ('agent.status.view', 'View agent status'),
  ('reports.view', 'View reports'),
  ('reports.export', 'Export reports to CSV/Excel'),
  
  -- User Manager permissions
  ('user.create', 'Create users'),
  ('user.edit', 'Edit users'),
  ('user.assign_role', 'Assign roles to users (non-superadmin)'),
  
  -- Reports-only permissions
  ('reports.view.daily', 'View daily reports'),
  ('reports.view.queue', 'View queue reports'),
  ('reports.view.agent', 'View agent reports'),
  ('reports.view.ivr', 'View IVR reports'),
  ('reports.export.csv', 'Export reports to CSV'),
  ('recordings.play', 'Play call recordings'),
  ('agent_activity.view', 'View agent activity logs'),
  
  -- Agent permissions
  ('call.handle', 'Handle calls'),
  ('call.transfer', 'Transfer calls'),
  ('call.hold', 'Put calls on hold'),
  ('call.conference', 'Add calls to conference'),
  ('status.set', 'Set agent status'),
  ('chat.handle', 'Handle chat'),
  ('email.handle', 'Handle email')
ON CONFLICT (code) DO NOTHING;

-- 5. Populate role_permissions for standard roles (superadmin gets all)
WITH role_ids AS (
  SELECT id, role_type FROM roles WHERE is_system = TRUE
),
all_perms AS (
  SELECT id FROM permissions
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM role_ids r
CROSS JOIN all_perms p
WHERE r.role_type = 'superadmin'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 6. Admin role permissions (all except superadmin-only)
WITH admin_role AS (
  SELECT id FROM roles WHERE role_type = 'admin' AND is_system = TRUE LIMIT 1
),
admin_perms AS (
  SELECT id FROM permissions
  WHERE code IN (
    'queue.manage', 'ivr.manage', 'campaign.manage', 'did.manage',
    'trunk.manage', 'crm.configure', 'privacy.configure', 'agent.provision',
    'queue.view', 'queue.monitor', 'ivr.view', 'campaign.view',
    'call.monitor', 'agent.status.view', 'reports.view', 'reports.export',
    'user.create', 'user.edit', 'user.assign_role'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM admin_role), id FROM admin_perms
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 7. Manager role permissions
WITH manager_role AS (
  SELECT id FROM roles WHERE role_type = 'manager' AND is_system = TRUE LIMIT 1
),
manager_perms AS (
  SELECT id FROM permissions
  WHERE code IN (
    'queue.view', 'queue.monitor', 'ivr.view', 'campaign.view',
    'call.monitor', 'agent.status.view', 'reports.view', 'reports.export'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM manager_role), id FROM manager_perms
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 8. User Manager role permissions
WITH um_role AS (
  SELECT id FROM roles WHERE role_type = 'user_manager' AND is_system = TRUE LIMIT 1
),
um_perms AS (
  SELECT id FROM permissions
  WHERE code IN ('user.create', 'user.edit', 'user.assign_role')
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM um_role), id FROM um_perms
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 9. Reports-only role permissions
WITH ro_role AS (
  SELECT id FROM roles WHERE role_type = 'reports_only' AND is_system = TRUE LIMIT 1
),
ro_perms AS (
  SELECT id FROM permissions
  WHERE code IN (
    'reports.view.daily', 'reports.view.queue', 'reports.view.agent',
    'reports.view.ivr', 'reports.export.csv', 'recordings.play',
    'agent_activity.view'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM ro_role), id FROM ro_perms
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- 10. Agent role permissions
WITH agent_role AS (
  SELECT id FROM roles WHERE role_type = 'agent' AND is_system = TRUE LIMIT 1
),
agent_perms AS (
  SELECT id FROM permissions
  WHERE code IN (
    'call.handle', 'call.transfer', 'call.hold', 'call.conference',
    'status.set', 'chat.handle', 'email.handle'
  )
)
INSERT INTO role_permissions (role_id, permission_id)
SELECT (SELECT id FROM agent_role), id FROM agent_perms
ON CONFLICT (role_id, permission_id) DO NOTHING;
