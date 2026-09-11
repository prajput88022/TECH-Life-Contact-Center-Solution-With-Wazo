/**
 * Reseller / Sub-Tenant isolation.
 *
 * A tenant admin normally operates on their own tenant only. A
 * 'reseller' tenant's admin may additionally switch into and manage any
 * of ITS OWN sub-tenants (tenants.parent_tenant_id = the reseller's own
 * id) -- never another reseller's sub-tenants, never an unrelated
 * tenant. This is the single choke point every admin route uses to
 * determine which tenant_id to read/write; no route computes this
 * itself, so the isolation rule can't be forgotten on one page.
 *
 * Mounted after requireRole(['admin','superadmin']) in routes/admin.js.
 * Populates:
 *   req.effectiveTenant     -- the tenant row currently being managed
 *   req.manageableTenants   -- [own tenant, ...own sub-tenants] -- the
 *                              only tenants this admin is ever allowed
 *                              to switch into
 *   res.locals.effectiveTenant / res.locals.manageableTenants -- same,
 *                              for the sidebar tenant switcher
 *
 * Switching tenant context happens via ?as_tenant=<id> on any admin
 * route; the choice is remembered in the session and re-validated
 * against req.manageableTenants on every request (so a stale/tampered
 * session value can never grant access to a tenant outside the
 * allowed set -- if the id in session isn't in manageableTenants this
 * request, it's silently ignored and the admin's own tenant is used).
 */
const { pool } = require('./db');

async function resolveTenantContext(req, res, next) {
    const u = req.session.user;
    if (!u) return next();

    const ownRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [u.tenantId]);
    const own = ownRes.rows[0];
    if (!own) return res.status(500).send('Tenant not found');

    let manageable = [own];
    if (own.tenant_type === 'reseller') {
        const subsRes = await pool.query(
            'SELECT * FROM tenants WHERE parent_tenant_id = $1 ORDER BY name',
            [own.id]
        );
        manageable = manageable.concat(subsRes.rows);
    }

    const requestedId = req.query.as_tenant || req.session.activeTenantId;
    const match = requestedId ? manageable.find((t) => t.id === requestedId) : null;
    const effective = match || own;

    if (req.query.as_tenant) {
        // Only remember the switch if it was actually a valid target --
        // an invalid/foreign id in the query string is simply ignored,
        // never stored.
        req.session.activeTenantId = match ? match.id : own.id;
    }

    req.effectiveTenant = effective;
    req.manageableTenants = manageable;
    req.isReseller = own.tenant_type === 'reseller';
    res.locals.effectiveTenant = effective;
    res.locals.manageableTenants = manageable;
    res.locals.isReseller = own.tenant_type === 'reseller';
    next();
}

module.exports = { resolveTenantContext };
