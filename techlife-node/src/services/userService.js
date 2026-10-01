// =====================================================================
// TECH-Life Contact-Center Solution
// User & Role Management Service
// =====================================================================
// Handles user creation, role assignment, permission checking,
// and enforces user_manager role restrictions (no delete).
// =====================================================================

const db = require('../config/database');
const bcrypt = require('bcrypt');
const logger = require('../config/logger');

/**
 * User Service: manages users, roles, and permissions
 */
class UserService {
  /**
   * Create a new user within a tenant
   */
  static async createUser(client, tenantId, username, email, password, fullName) {
    try {
      const passwordHash = await bcrypt.hash(password, 10);

      const result = await client.query(
        `INSERT INTO users (tenant_id, username, email, password_hash, full_name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [tenantId, username, email, passwordHash, fullName]
      );

      logger.info(`[UserService] Created user ${result.rows[0].id} in tenant ${tenantId}`);
      return result.rows[0].id;
    } catch (err) {
      logger.error(`[UserService] createUser failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Edit user (email, full_name, status only; not password/roles via this method)
   */
  static async editUser(userId, tenantId, updates) {
    try {
      const allowedFields = ['email', 'full_name', 'is_active'];
      const fields = Object.keys(updates).filter(k => allowedFields.includes(k));

      if (fields.length === 0) {
        return { id: userId };
      }

      const setClauses = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
      const values = [userId, tenantId, ...fields.map(f => updates[f])];

      const result = await db.query(
        `UPDATE users SET ${setClauses}, updated_at = now()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, username, email, full_name, is_active`,
        values
      );

      if (result.rows.length === 0) {
        throw new Error(`User ${userId} not found in tenant ${tenantId}`);
      }

      logger.info(`[UserService] Updated user ${userId}: ${fields.join(', ')}`);
      return result.rows[0];
    } catch (err) {
      logger.error(`[UserService] editUser failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * List users in a tenant
   */
  static async listUsers(tenantId, limit = 50, offset = 0) {
    try {
      const result = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
                array_agg(r.name) as roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = $1
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset]
      );

      return result.rows;
    } catch (err) {
      logger.error(`[UserService] listUsers failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get user details with roles and permissions
   */
  static async getUser(userId, tenantId) {
    try {
      const result = await db.query(
        `SELECT u.id, u.username, u.email, u.full_name, u.mfa_enabled, u.is_active, u.theme_color, u.created_at
         FROM users u
         WHERE u.id = $1 AND u.tenant_id = $2`,
        [userId, tenantId]
      );

      if (result.rows.length === 0) {
        throw new Error(`User ${userId} not found in tenant ${tenantId}`);
      }

      const user = result.rows[0];

      // Get roles
      const rolesResult = await db.query(
        `SELECT r.id, r.name, r.role_type
         FROM roles r
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1`,
        [userId]
      );
      user.roles = rolesResult.rows;

      // Get permissions (flatten from all roles)
      const permsResult = await db.query(
        `SELECT DISTINCT p.code
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1`,
        [userId]
      );
      user.permissions = permsResult.rows.map(p => p.code);

      return user;
    } catch (err) {
      logger.error(`[UserService] getUser failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Assign role to user (user_manager cannot assign superadmin)
   */
  static async assignRole(userId, tenantId, roleId, requestingUserRoles) {
    try {
      // Check if role is superadmin (cannot assign via user_manager)
      const roleResult = await db.query(
        `SELECT role_type FROM roles WHERE id = $1`,
        [roleId]
      );

      if (roleResult.rows.length === 0) {
        throw new Error(`Role ${roleId} not found`);
      }

      const isSuperAdmin = roleResult.rows[0].role_type === 'superadmin';

      // Only platform-level superadmin can assign superadmin
      if (isSuperAdmin && !requestingUserRoles.includes('superadmin')) {
        throw new Error('Only superadmin can assign superadmin role');
      }

      // Insert or update role assignment
      await db.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [userId, roleId]
      );

      logger.info(`[UserService] Assigned role ${roleId} to user ${userId}`);

      // Log audit event
      await db.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, new_value)
         VALUES ($1, $2, 'role.assigned', 'user_role', $3, $4)`,
        [tenantId, userId, userId, JSON.stringify({ roleId })]
      );

      return { userId, roleId };
    } catch (err) {
      logger.error(`[UserService] assignRole failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Remove role from user (user_manager cannot revoke superadmin)
   */
  static async removeRole(userId, tenantId, roleId, requestingUserRoles) {
    try {
      const roleResult = await db.query(
        `SELECT role_type FROM roles WHERE id = $1`,
        [roleId]
      );

      if (roleResult.rows.length === 0) {
        throw new Error(`Role ${roleId} not found`);
      }

      const isSuperAdmin = roleResult.rows[0].role_type === 'superadmin';

      if (isSuperAdmin && !requestingUserRoles.includes('superadmin')) {
        throw new Error('Only superadmin can revoke superadmin role');
      }

      // Ensure user has at least one role after removal
      const remainingRoles = await db.query(
        `SELECT COUNT(*) as count FROM user_roles WHERE user_id = $1 AND role_id != $2`,
        [userId, roleId]
      );

      if (remainingRoles.rows[0].count === 0) {
        throw new Error('User must have at least one role');
      }

      await db.query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [userId, roleId]
      );

      logger.info(`[UserService] Removed role ${roleId} from user ${userId}`);

      // Log audit event
      await db.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, new_value)
         VALUES ($1, $2, 'role.revoked', 'user_role', $3, $4)`,
        [tenantId, userId, userId, JSON.stringify({ roleId })]
      );

      return { userId, roleId, removed: true };
    } catch (err) {
      logger.error(`[UserService] removeRole failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Check if user has a specific permission
   */
  static async hasPermission(userId, permissionCode) {
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1 AND p.code = $2`,
        [userId, permissionCode]
      );

      return result.rows[0].count > 0;
    } catch (err) {
      logger.error(`[UserService] hasPermission failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get all permissions for a user (cached in session)
   */
  static async getUserPermissions(userId) {
    try {
      const result = await db.query(
        `SELECT DISTINCT p.code
         FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1`,
        [userId]
      );

      return result.rows.map(r => r.code);
    } catch (err) {
      logger.error(`[UserService] getUserPermissions failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Change user password
   */
  static async changePassword(userId, tenantId, currentPassword, newPassword) {
    try {
      const userResult = await db.query(
        `SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2`,
        [userId, tenantId]
      );

      if (userResult.rows.length === 0) {
        throw new Error(`User ${userId} not found`);
      }

      const isValid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
      if (!isValid) {
        throw new Error('Current password is incorrect');
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await db.query(
        `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
        [newHash, userId]
      );

      logger.info(`[UserService] Password changed for user ${userId}`);
      return { userId, changed: true };
    } catch (err) {
      logger.error(`[UserService] changePassword failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = UserService;
