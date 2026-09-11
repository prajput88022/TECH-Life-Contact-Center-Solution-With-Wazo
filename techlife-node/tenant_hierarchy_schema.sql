-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: Reseller / Sub-Tenant hierarchy
-- Apply after all previous schema files
-- =====================================================================
-- Two tenant types:
--   'normal'   -- a regular tenant. Sees/manages only itself.
--   'reseller' -- can create sub-tenants (parent_tenant_id -> this
--                 tenant). A reseller's admin can switch into and
--                 manage any of its own sub-tenants (users, queues,
--                 campaigns, DIDs, trunks), but NEVER another
--                 reseller's sub-tenants or any unrelated tenant.
--                 Only the platform Superadmin can see/manage every
--                 tenant regardless of hierarchy.
--
-- A sub-tenant itself defaults to tenant_type = 'normal' and cannot
-- create further sub-tenants (single level of reselling) unless a
-- superadmin explicitly promotes it to 'reseller' -- kept simple and
-- auditable rather than allowing arbitrary nesting depth.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS tenant_type      VARCHAR(20) NOT NULL DEFAULT 'normal'
        CHECK (tenant_type IN ('reseller','normal')),
    ADD COLUMN IF NOT EXISTS parent_tenant_id  UUID REFERENCES tenants(id);

CREATE INDEX IF NOT EXISTS idx_tenants_parent ON tenants(parent_tenant_id);

-- A sub-tenant's parent must actually be a reseller -- enforced at the
-- application layer when creating sub-tenants (Postgres CHECK
-- constraints can't easily reference another row), but documented here
-- as the invariant: parent_tenant_id IS NOT NULL implies the tenant
-- referenced by parent_tenant_id has tenant_type = 'reseller'.

-- Trunks are already tenant-scoped (trunks.tenant_id). The hierarchy
-- rule for trunks is enforced the same way as everything else: a
-- reseller admin can create/view/edit trunks for itself OR any of its
-- own sub-tenants (by assigning trunks.tenant_id to the sub-tenant's
-- id while operating in that sub-tenant's admin context), but never
-- for a tenant outside its own hierarchy. No schema change needed --
-- see src/tenantContext.js for the enforcement.
