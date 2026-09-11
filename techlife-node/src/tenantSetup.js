/**
 * Provisions the standard scaffolding every new tenant needs to
 * actually be usable: the 4 standard roles (roles is tenant-scoped, so
 * without this a brand-new tenant has nowhere for /admin/users/create
 * to assign a role -- this was a real gap caught while testing the
 * reseller/sub-tenant flow end-to-end), and optionally an initial admin
 * user so someone can actually log in and manage the new tenant.
 *
 * Used by both superadmin tenant creation and reseller sub-tenant
 * creation, so both paths produce an equally usable tenant.
 */
const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const STANDARD_ROLES = ['admin', 'supervisor', 'agent', 'mis_agent'];

async function createStandardRoles(client, tenantId) {
    const roleIds = {};
    for (const roleType of STANDARD_ROLES) {
        const label = roleType.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const res = await client.query(
            `INSERT INTO roles (tenant_id, name, role_type, is_system) VALUES ($1,$2,$3,TRUE) RETURNING id`,
            [tenantId, label, roleType]
        );
        roleIds[roleType] = res.rows[0].id;
    }
    return roleIds;
}

/**
 * Creates the tenant's roles, and if adminCreds is given
 * ({username, password, fullName, email}) also creates its first admin
 * user so the tenant is immediately usable. Runs in its own transaction.
 */
async function provisionNewTenant(tenantId, adminCreds = null) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const roleIds = await createStandardRoles(client, tenantId);

        let adminUserId = null;
        if (adminCreds && adminCreds.username && adminCreds.password) {
            const hash = await bcrypt.hash(adminCreds.password, 10);
            const userRes = await client.query(
                `INSERT INTO users (tenant_id, username, email, password_hash, full_name)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                [tenantId, adminCreds.username, adminCreds.email || null, hash, adminCreds.fullName || adminCreds.username]
            );
            adminUserId = userRes.rows[0].id;
            await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [adminUserId, roleIds.admin]);
        }

        await client.query('COMMIT');
        return { roleIds, adminUserId };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { provisionNewTenant, STANDARD_ROLES };
