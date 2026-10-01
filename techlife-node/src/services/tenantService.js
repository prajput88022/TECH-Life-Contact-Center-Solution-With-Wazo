// =====================================================================
// TECH-Life Contact-Center Solution
// Tenant Management & RBAC Service
// =====================================================================
// Provides tenant lifecycle, role assignment, permission checking,
// and tenant switching with strict boundary enforcement.
// =====================================================================

const db = require('../config/database');
const logger = require('../config/logger');

/**
 * Tenant Service: manages tenant lifecycle and multi-tenant boundaries
 */
class TenantService {
  /**
   * Create a new tenant (superadmin only)
   */
  static async createTenant(tenantName, tenantSlug, parentTenantId = null, adminCreds = null) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Insert tenant row
      const tenantResult = await client.query(
        `INSERT INTO tenants (name, slug, parent_tenant_id, tenant_level, timezone, is_active)
         VALUES ($1, $2, $3, COALESCE((SELECT tenant_level + 1 FROM tenants WHERE id = $3), 0), 'UTC', true)
         RETURNING id, name, slug, parent_tenant_id, tenant_level`,
        [tenantName, tenantSlug, parentTenantId]
      );
      const tenantId = tenantResult.rows[0].id;
      logger.info(`[TenantService] Created tenant: ${tenantId} (${tenantName})`);

      // 2. Create standard roles for this tenant (admin, manager, user_manager, reports_only)
      await this.createStandardRoles(client, tenantId);

      // 3. If parent tenant specified, add to access control
      if (parentTenantId) {
        await client.query(
          `INSERT INTO tenant_access_control (tenant_id, allowed_tenant_id, access_level)
           VALUES ($1, $2, 'full')`,
          [parentTenantId, tenantId]
        );
        logger.info(`[TenantService] Added child tenant access: ${parentTenantId} -> ${tenantId}`);
      }

      // 4. Create initial admin user if credentials provided
      if (adminCreds) {
        const userId = await require('./userService').createUser(
          client,
          tenantId,
          adminCreds.username,
          adminCreds.email,
          adminCreds.password,
          adminCreds.fullName
        );

        // Assign admin role
        const adminRoleResult = await client.query(
          `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Admin'`,
          [tenantId]
        );
        if (adminRoleResult.rows.length > 0) {
          await client.query(
            `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`,
            [userId, adminRoleResult.rows[0].id]
          );
          logger.info(`[TenantService] Assigned admin role to user ${userId}`);
        }
      }

      await client.query('COMMIT');
      return tenantResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error(`[TenantService] createTenant failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create standard roles for a tenant
   */
  static async createStandardRoles(client, tenantId) {
    const roles = [
      { name: 'Admin', type: 'admin' },
      { name: 'Manager', type: 'supervisor' },
      { name: 'User Manager', type: 'agent' },
      { name: 'Reports Only', type: 'agent' }
    ];

    for (const role of roles) {
      await client.query(
        `INSERT INTO roles (tenant_id, name, role_type, is_system)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (tenant_id, name) DO NOTHING`,
        [tenantId, role.name, role.type]
      );
    }

    // Assign permissions to roles
    const permissions = await client.query(`SELECT id, code FROM permissions`);
    const permMap = {};
    permissions.rows.forEach(p => {
      permMap[p.code] = p.id;
    });

    // Admin: all permissions
    const adminRole = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Admin'`,
      [tenantId]
    );
    if (adminRole.rows.length > 0) {
      const adminPerms = Object.values(permMap);
      for (const permId of adminPerms) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [adminRole.rows[0].id, permId]
        );
      }
    }

    // Manager: queue, campaign, IVR, reports, agent view
    const managerRole = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Manager'`,
      [tenantId]
    );
    if (managerRole.rows.length > 0) {
      const managerPerms = [
        'queues.create', 'queues.edit', 'queues.delete', 'queues.view',
        'campaigns.create', 'campaigns.edit', 'campaigns.delete', 'campaigns.view', 'campaigns.robo',
        'ivr.create', 'ivr.edit', 'ivr.delete', 'ivr.view', 'ivr.audio',
        'reports.view', 'reports.export',
        'agent.view', 'themes.manage', 'recordings.view'
      ];
      for (const permCode of managerPerms) {
        if (permMap[permCode]) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [managerRole.rows[0].id, permMap[permCode]]
          );
        }
      }
    }

    // User Manager: users.create, users.edit, users.view, roles.view, roles.assign
    const userMgrRole = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'User Manager'`,
      [tenantId]
    );
    if (userMgrRole.rows.length > 0) {
      const userMgrPerms = ['users.create', 'users.edit', 'users.view', 'roles.view', 'roles.assign'];
      for (const permCode of userMgrPerms) {
        if (permMap[permCode]) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [userMgrRole.rows[0].id, permMap[permCode]]
          );
        }
      }
    }

    // Reports Only: reports.view, reports.export, recordings.view, agent.view
    const reportsRole = await client.query(
      `SELECT id FROM roles WHERE tenant_id = $1 AND name = 'Reports Only'`,
      [tenantId]
    );
    if (reportsRole.rows.length > 0) {
      const reportPerms = ['reports.view', 'reports.export', 'recordings.view', 'agent.view'];
      for (const permCode of reportPerms) {
        if (permMap[permCode]) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [reportsRole.rows[0].id, permMap[permCode]]
          );
        }
      }
    }

    logger.info(`[TenantService] Created standard roles for tenant ${tenantId}`);
  }

  /**
   * Get accessible tenants for a user (own + child tenants if admin/reseller)
   */
  static async getAccessibleTenants(userId, userTenantId) {
    try {
      // Get user's roles
      const rolesResult = await db.query(
        `SELECT r.role_type FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1`,
        [userId]
      );

      const roleTypes = rolesResult.rows.map(r => r.role_type);
      let tenants = [];

      if (roleTypes.includes('superadmin')) {
        // Superadmin can see all tenants
        const allTenants = await db.query(`SELECT id, name, slug FROM tenants WHERE is_active = true`);
        tenants = allTenants.rows;
      } else if (roleTypes.includes('admin')) {
        // Admin can see own tenant + direct children
        const ownTenants = await db.query(
          `SELECT id, name, slug FROM tenants 
           WHERE (id = $1 OR parent_tenant_id = $1) AND is_active = true`,
          [userTenantId]
        );
        tenants = ownTenants.rows;
      } else {
        // Other roles see only their own tenant
        const ownTenant = await db.query(
          `SELECT id, name, slug FROM tenants WHERE id = $1 AND is_active = true`,
          [userTenantId]
        );
        tenants = ownTenant.rows;
      }

      return tenants;
    } catch (err) {
      logger.error(`[TenantService] getAccessibleTenants failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Validate tenant switch (ensure user has access)
   */
  static async validateTenantSwitch(userId, currentTenantId, targetTenantId) {
    const accessibleTenants = await this.getAccessibleTenants(userId, currentTenantId);
    const isAllowed = accessibleTenants.some(t => t.id === targetTenantId);

    if (!isAllowed) {
      logger.warn(`[TenantService] Unauthorized tenant switch: user ${userId} from ${currentTenantId} to ${targetTenantId}`);
      throw new Error('Unauthorized tenant access');
    }

    return true;
  }

  /**
   * Edit tenant settings (admin/superadmin only)
   */
  static async editTenant(tenantId, updates) {
    try {
      const allowedFields = ['name', 'timezone', 'wazo_context_name'];
      const fields = Object.keys(updates).filter(k => allowedFields.includes(k));

      if (fields.length === 0) {
        return { id: tenantId };
      }

      const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const values = [tenantId, ...fields.map(f => updates[f])];

      const result = await db.query(
        `UPDATE tenants SET ${setClauses}, updated_at = now()
         WHERE id = $1
         RETURNING id, name, slug, timezone`,
        values
      );

      logger.info(`[TenantService] Updated tenant ${tenantId}: ${fields.join(', ')}`);
      return result.rows[0];
    } catch (err) {
      logger.error(`[TenantService] editTenant failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get tenant details (with hierarchy info)
   */
  static async getTenant(tenantId) {
    try {
      const result = await db.query(
        `SELECT id, name, slug, parent_tenant_id, tenant_level, timezone, wazo_context_name, is_active
         FROM tenants WHERE id = $1`,
        [tenantId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Tenant ${tenantId} not found`);
      }

      const tenant = result.rows[0];

      // Get child tenants if any
      const childrenResult = await db.query(
        `SELECT id, name, slug FROM tenants WHERE parent_tenant_id = $1 AND is_active = true`,
        [tenantId]
      );

      tenant.children = childrenResult.rows;
      return tenant;
    } catch (err) {
      logger.error(`[TenantService] getTenant failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = TenantService;
