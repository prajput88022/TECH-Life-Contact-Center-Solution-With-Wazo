-- =====================================================================
-- TECH-Life Contact-Center Solution
-- RBAC & Theme Color System Migration
-- =====================================================================
-- Implements the final role hierarchy and permission model:
-- - Superadmin: platform-level only, tenant lifecycle control
-- - Reseller/Admin: tenant-scoped with child tenant management
-- - Manager: queue/campaign/IVR/reports operations within tenant
-- - User Manager: user CRUD within tenant (no deletion)
-- - Reports Only: read-only MIS reports
-- - Supervisor/Agent: existing role mappings unchanged
-- - Theme: per-user selection across 5 colors (brand, ocean, forest, sunset, midnight)
-- =====================================================================

-- =====================================================================
-- 1. EXTEND PERMISSIONS TABLE (if not already complete)
-- =====================================================================

-- Ensure all permission codes exist
INSERT INTO permissions (code, description) VALUES
  ('tenant.create', 'Create new tenant'),
  ('tenant.edit', 'Edit tenant settings'),
  ('tenant.delete', 'Delete tenant'),
  ('tenant.view', 'View tenant info'),
  ('tenant.switch', 'Switch between own and child tenants'),
  
  ('users.create', 'Create users'),
  ('users.edit', 'Edit users'),
  ('users.delete', 'Delete users (superadmin only)'),
  ('users.view', 'View user list'),
  
  ('roles.assign', 'Assign roles to users'),
  ('roles.view', 'View roles'),
  
  ('queues.create', 'Create queues'),
  ('queues.edit', 'Edit queues'),
  ('queues.delete', 'Delete queues'),
  ('queues.view', 'View queues'),
  
  ('campaigns.create', 'Create campaigns'),
  ('campaigns.edit', 'Edit campaigns'),
  ('campaigns.delete', 'Delete campaigns'),
  ('campaigns.view', 'View campaigns'),
  ('campaigns.robo', 'Create/edit robo campaigns'),
  
  ('ivr.create', 'Create IVR menus'),
  ('ivr.edit', 'Edit IVR menus'),
  ('ivr.delete', 'Delete IVR menus'),
  ('ivr.view', 'View IVR menus'),
  ('ivr.audio', 'Upload IVR audio files'),
  
  ('reports.view', 'View MIS reports'),
  ('reports.export', 'Export reports'),
  ('reports.schedule', 'Schedule report delivery'),
  
  ('recordings.view', 'View recordings'),
  ('recordings.download', 'Download recordings'),
  ('recordings.delete', 'Delete recordings'),
  
  ('agent.view', 'View agent activity'),
  ('agent.edit', 'Edit agent settings'),
  
  ('themes.manage', 'Change application theme')
ON CONFLICT (code) DO NOTHING;

-- =====================================================================
-- 2. EXTEND USERS TABLE WITH THEME & SETTINGS
-- =====================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_color VARCHAR(20) DEFAULT 'brand',
  ADD COLUMN IF NOT EXISTS ui_preferences JSONB DEFAULT '{"sidebar_collapsed": false, "density": "normal"}',
  ADD COLUMN IF NOT EXISTS CONSTRAINT chk_theme_color
    CHECK (theme_color IN ('brand', 'ocean', 'forest', 'sunset', 'midnight'));

-- =====================================================================
-- 3. CREATE STANDARD TENANT-SCOPED ROLES
-- =====================================================================

-- Helper: Create role if it doesn't exist (on first tenant creation)
-- This is typically called by application code in tenantSetup.js

-- Superadmin role (platform-level only, NULL tenant_id)
INSERT INTO roles (tenant_id, name, role_type, is_system)
  SELECT NULL, 'Superadmin', 'superadmin'::user_role_type, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM roles WHERE tenant_id IS NULL AND name = 'Superadmin')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- 4. DEFINE ROLE PERMISSION BUNDLES (per tenant)
-- =====================================================================
-- Applications code calls createStandardRoles() in tenantSetup.js
-- to create these for each new tenant. Schema below documents the expected roles:

-- ADMIN (Reseller/Primary Admin): Full control within tenant + child management
-- Permissions: tenant.*, users.*, roles.assign, queues.*, campaigns.*, ivr.*, reports.*, recordings.*, agent.*

-- MANAGER: Queue/Campaign/IVR operations and reports, NO user deletion
-- Permissions: queues.*, campaigns.*, ivr.*, ivr.audio, reports.*, agent.view, themes.manage

-- USER_MANAGER: User CRUD only (no delete)
-- Permissions: users.create, users.edit, users.view, roles.view, roles.assign

-- REPORTS_ONLY: Read-only reports
-- Permissions: reports.view, reports.export, recordings.view, agent.view

-- SUPERVISOR: Existing call center supervisor
-- (preserved from previous schema, no change)

-- AGENT: Existing call center agent
-- (preserved from previous schema, no change)

-- =====================================================================
-- 5. TENANT HIERARCHY EXTENSION (for multi-level tenant support)
-- =====================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS parent_tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tenant_level INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wazo_context_name VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_hierarchy ON tenants(parent_tenant_id, tenant_level);

-- =====================================================================
-- 6. AUDIT TABLE ENHANCEMENT (track permission/role changes)
-- =====================================================================

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS role_id UUID REFERENCES roles(id),
  ADD COLUMN IF NOT EXISTS permission_ids UUID[];

CREATE INDEX IF NOT EXISTS idx_audit_role_changes
  ON audit_logs(tenant_id, action, created_at DESC)
  WHERE action IN ('role.created', 'role.assigned', 'permission.granted', 'permission.revoked');

-- =====================================================================
-- 7. USER SESSION ENHANCEMENTS (for effective tenant/role tracking)
-- =====================================================================

-- Track which tenant each session is scoped to
-- This is populated at login and updated on tenant switch
-- Applications reads this to ensure all queries are tenant-scoped

CREATE TABLE IF NOT EXISTS user_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token   VARCHAR(255) NOT NULL UNIQUE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    effective_roles UUID[] NOT NULL DEFAULT '{}',
    permissions_cached JSONB DEFAULT '{}',
    ip_address      INET,
    user_agent      VARCHAR(500),
    login_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_tenant ON user_sessions(user_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at) WHERE is_active = TRUE;

-- =====================================================================
-- 8. TENANT ACCESS CONTROL LIST (for reseller/admin child tenant visibility)
-- =====================================================================

CREATE TABLE IF NOT EXISTS tenant_access_control (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    allowed_tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    access_level    VARCHAR(20) NOT NULL DEFAULT 'view', -- view/edit/full
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, allowed_tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_tac_tenant ON tenant_access_control(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tac_allowed ON tenant_access_control(allowed_tenant_id);

-- =====================================================================
-- 9. THEME PALETTE DEFINITIONS (for frontend styling)
-- =====================================================================

CREATE TABLE IF NOT EXISTS theme_palettes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(50) NOT NULL UNIQUE,  -- brand/ocean/forest/sunset/midnight
    primary_color   VARCHAR(7) NOT NULL,
    secondary_color VARCHAR(7) NOT NULL,
    accent_color    VARCHAR(7) NOT NULL,
    neutral_bg      VARCHAR(7) NOT NULL,
    neutral_text    VARCHAR(7) NOT NULL,
    success_color   VARCHAR(7) NOT NULL,
    warning_color   VARCHAR(7) NOT NULL,
    error_color     VARCHAR(7) NOT NULL,
    css_variables   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO theme_palettes (name, primary_color, secondary_color, accent_color, neutral_bg, neutral_text, success_color, warning_color, error_color, css_variables) VALUES
('brand',    '#0066cc', '#003399', '#ff6600', '#f5f5f5', '#1a1a1a', '#27ae60', '#f39c12', '#e74c3c', '{"--primary": "#0066cc", "--secondary": "#003399"}'),
('ocean',    '#1e90ff', '#0047ab', '#00bfff', '#e6f2ff', '#003d66', '#2ecc71', '#f1c40f', '#e74c3c', '{"--primary": "#1e90ff", "--secondary": "#0047ab"}'),
('forest',   '#27ae60', '#1a6d2f', '#2ecc71', '#e8f5e9', '#1b5e20', '#52c41a', '#faad14', '#ff7875', '{"--primary": "#27ae60", "--secondary": "#1a6d2f"}'),
('sunset',   '#ff6b35', '#ff4500', '#ffa500', '#fff3e0', '#663300', '#4caf50', '#fbc02d', '#ff6b6b', '{"--primary": "#ff6b35", "--secondary": "#ff4500"}'),
('midnight', '#1a237e', '#3f51b5', '#5c6bc0', '#263238', '#eceff1', '#66bb6a', '#fdd835', '#f44336', '{"--primary": "#1a237e", "--secondary": "#3f51b5"}');

-- =====================================================================
-- 10. INITIAL SUPERADMIN ROLE PERMISSIONS (create once)
-- =====================================================================

-- This is called during initial platform setup; it assigns ALL permissions to superadmin
-- INSERT INTO role_permissions (role_id, permission_id)
-- SELECT r.id, p.id FROM roles r, permissions p
-- WHERE r.tenant_id IS NULL AND r.name = 'Superadmin'
-- ON CONFLICT DO NOTHING;

-- =====================================================================
-- 11. CONSTRAINTS & FINAL CHECKS
-- =====================================================================

-- Prevent non-superadmin from creating/editing superadmin-only roles
ALTER TABLE roles
  ADD CONSTRAINT chk_superadmin_scope
    CHECK ((role_type = 'superadmin' AND tenant_id IS NULL) OR (role_type != 'superadmin'));

-- Ensure each user has at least one role
ALTER TABLE users
  ADD CONSTRAINT chk_user_has_role
    CHECK (id IN (SELECT user_id FROM user_roles));

-- =====================================================================
-- End of RBAC & Theme Migration
-- =====================================================================
