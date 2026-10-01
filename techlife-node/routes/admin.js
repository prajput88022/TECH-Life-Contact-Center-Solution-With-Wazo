const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireRole, requirePermission, canAssignRole } = require('../src/auth');
const { pool } = require('../src/db');
const { writeAuditLog } = require('../src/auditLog');
const bcrypt = require('bcryptjs');
const wazoProvisioning = require('../src/wazoProvisioningService');
const phoneMasker = require('../src/phoneMasker');
const { resolveTenantContext } = require('../src/tenantContext');
const { audioUpload, leadsUpload } = require('../src/uploadMiddleware');
const { parse } = require('csv-parse/sync');
const fs = require('fs');

router.use(requireRole(['admin', 'superadmin']));
router.use(resolveTenantContext);

/**
 * Postgres raises error code 23503 (foreign_key_violation) when a
 * DELETE would orphan rows that reference it -- e.g. deleting a queue
 * that has historical calls pointing at it. We deliberately let that
 * happen rather than CASCADE, since cascading would silently destroy
 * reporting history. This turns that DB error into a clear message
 * instead of a raw stack trace.
 */
function deleteBlockedMessage(err, entityLabel) {
    if (err.code === '23503') {
        return `${entityLabel} can't be deleted because other records (calls, reports, or configuration) still reference it. ` +
               `Use the Edit form to deactivate it instead if you want to stop it being used going forward.`;
    }
    return `Delete failed: ${err.message}`;
}

// ---- Middleware to check for critical permissions ----
const checkUserManagement = (req, res, next) => {
    const perms = req.session.user.permissions || [];
    if (!perms.includes('user.create') && !perms.includes('user.edit')) {
        return res.status(403).send('You do not have permission to manage users.');
    }
    next();
};

const checkTenantManagement = (req, res, next) => {
    const roles = req.session.user.roles || [];
    if (!roles.includes('superadmin')) {
        return res.status(403).send('Only superadmin can manage tenant hierarchy.');
    }
    next();
};

// ---- Dashboard ----
router.get('/', async (req, res) => {
    const t = req.effectiveTenant.id;
    const totals = (await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM agents WHERE tenant_id = $1 AND is_active) AS agents,
            (SELECT COUNT(*) FROM queues WHERE tenant_id = $1 AND is_active) AS queues,
            (SELECT COUNT(*) FROM campaigns WHERE tenant_id = $1 AND is_active) AS campaigns,
            (SELECT COUNT(*) FROM dids WHERE tenant_id = $1 AND is_active) AS dids,
            (SELECT COUNT(*) FROM calls WHERE tenant_id = $1 AND start_time > now() - interval '24 hours') AS calls_24h`,
        [t]
    )).rows[0];
    res.render('admin/index', { pageTitle: 'Admin — Dashboard', totals });
});

// ---- Tenant switcher (reseller admins only) ----
router.get('/switch-tenant', (req, res) => {
    res.redirect('/admin' + (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : ''));
});

// ---- Sub-Tenants (reseller + superadmin only) ----
router.get('/sub-tenants', checkTenantManagement, async (req, res) => {
    const u = req.session.user;
    const isSuper = u.roles.includes('superadmin');

    // Superadmin sees all tenants and sub-tenants; reseller sees only its own.
    let subs;
    if (isSuper) {
        subs = (await pool.query(
            'SELECT * FROM tenants WHERE parent_tenant_id IS NOT NULL ORDER BY created_at DESC'
        )).rows;
    } else if (req.isReseller) {
        subs = (await pool.query(
            'SELECT * FROM tenants WHERE parent_tenant_id = $1 ORDER BY created_at DESC',
            [u.tenantId]
        )).rows;
    } else {
        return res.status(403).send('Your tenant is not a reseller — sub-tenants are not available.');
    }
    res.render('admin/sub_tenants', { pageTitle: 'Admin — Sub-Tenants', subs });
});

router.post('/sub-tenants/:id/delete', checkTenantManagement, async (req, res) => {
    const u = req.session.user;
    const isSuper = u.roles.includes('superadmin');

    // Ownership check: if not superadmin, the sub-tenant must belong to THIS reseller
    if (!isSuper) {
        const check = await pool.query('SELECT id FROM tenants WHERE id = $1 AND parent_tenant_id = $2', [req.params.id, u.tenantId]);
        if (!check.rows[0]) return res.status(403).send('That sub-tenant does not belong to you.');
    }

    try {
        await pool.query('DELETE FROM tenant_features WHERE tenant_id = $1', [req.params.id]);
        await pool.query('DELETE FROM roles WHERE tenant_id = $1', [req.params.id]);
        await pool.query('DELETE FROM tenants WHERE id = $1', [req.params.id]);
        await writeAuditLog(u.tenantId, u.id, 'SUB_TENANT_DELETED', 'tenant', req.params.id);
        res.redirect('/admin/sub-tenants');
    } catch (e) {
        if (e.code === '23503') {
            return res.status(409).send('This sub-tenant still has users, queues, campaigns, or other data and cannot be deleted.');
        }
        res.status(500).send('Delete failed: ' + e.message);
    }
});

router.post('/sub-tenants/create', checkTenantManagement, async (req, res) => {
    const u = req.session.user;
    const isSuper = u.roles.includes('superadmin');

    const parentId = isSuper ? (req.body.parent_tenant_id || u.tenantId) : u.tenantId;
    const parentCheck = await pool.query('SELECT * FROM tenants WHERE id = $1', [parentId]);
    const parent = parentCheck.rows[0];
    if (!parent) return res.status(400).send('Parent tenant not found.');

    const b = req.body;
    const result = await pool.query(
        `INSERT INTO tenants (name, slug, timezone, tenant_type, parent_tenant_id)
         VALUES ($1,$2,$3,'normal',$4) RETURNING id`,
        [b.name, b.slug, b.timezone || 'UTC', parentId]
    );
    const newId = result.rows[0].id;

    const { provisionNewTenant } = require('../src/tenantSetup');
    await provisionNewTenant(newId, b.admin_username && b.admin_password
        ? { username: b.admin_username, password: b.admin_password, fullName: b.admin_full_name, email: b.admin_email }
        : null);

    await writeAuditLog(parentId, u.id, 'SUB_TENANT_CREATED', 'tenant', newId, null, { name: b.name, slug: b.slug });
    res.redirect('/admin/sub-tenants');
});

// ---- Users (with strict permission enforcement) ----
router.get('/users', checkUserManagement, async (req, res) => {
    const t = req.effectiveTenant.id;
    const users = (await pool.query(
        `SELECT u.id, u.username, u.full_name, u.email, u.is_active, u.theme_preference,
                array_agg(r.role_type::text) AS roles,
                ag.extension, ag.sip_username, ag.provisioning_status, ag.provisioning_error
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         LEFT JOIN agents ag ON ag.user_id = u.id
         WHERE u.tenant_id = $1
         GROUP BY u.id, ag.extension, ag.sip_username, ag.provisioning_status, ag.provisioning_error
         ORDER BY u.created_at DESC`,
        [t]
    )).rows;
    res.render('admin/users', { pageTitle: 'Admin — Users', users, editId: req.query.edit || null });
});

router.post('/users/create', checkUserManagement, async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const userRoles = req.session.user.roles || [];

    // Validate that user has permission to create this role
    if (!canAssignRole(userRoles, b.role_type)) {
        return res.status(403).send(`You cannot assign the ${b.role_type} role.`);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hash = await bcrypt.hash(b.password, 10);
        const userRes = await client.query(
            `INSERT INTO users (tenant_id, username, email, password_hash, full_name, theme_preference)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [t, b.username, b.email, hash, b.full_name, 'brand']
        );
        const newUserId = userRes.rows[0].id;

        const roleRes = await client.query('SELECT id FROM roles WHERE tenant_id = $1 AND role_type = $2 LIMIT 1', [t, b.role_type]);
        if (roleRes.rows[0]) {
            await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [newUserId, roleRes.rows[0].id]);
        }

        let newAgentId = null;
        if (b.role_type === 'agent') {
            const agentRes = await client.query(
                `INSERT INTO agents (tenant_id, user_id, provisioning_status) VALUES ($1,$2,'pending') RETURNING id`,
                [t, newUserId]
            );
            newAgentId = agentRes.rows[0].id;
        }
        await client.query('COMMIT');
        await writeAuditLog(t, req.session.user.id, 'USER_CREATED', 'user', newUserId, null, { username: b.username, role: b.role_type });

        if (newAgentId) {
            const mode = b.sip_provisioning_mode || 'auto';
            if (mode === 'manual' && b.manual_extension) {
                await wazoProvisioning.attachManualLine(
                    t, newAgentId, b.manual_extension,
                    b.manual_sip_username || ('agt' + b.manual_extension),
                    b.manual_sip_password || crypto.randomBytes(8).toString('hex')
                );
            } else {
                const requested = b.requested_extension || null;
                const result = await wazoProvisioning.provisionForAgent(t, newAgentId, requested);
                if (!result.ok) {
                    await writeAuditLog(t, req.session.user.id, 'AGENT_PROVISIONING_FAILED', 'agent', newAgentId, null, result);
                }
            }
        }
        res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).send('Error creating user: ' + e.message);
    } finally {
        client.release();
    }
});

router.post('/users/:id/delete', checkUserManagement, async (req, res) => {
    const t = req.effectiveTenant.id;
    const perms = req.session.user.permissions || [];

    // Prevent deletion if user lacks the explicit permission
    if (!perms.includes('user.delete')) {
        return res.status(403).send('You do not have permission to delete users.');
    }

    try {
        await pool.query('DELETE FROM agents WHERE user_id = $1 AND tenant_id = $2', [req.params.id, t]);
        await pool.query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'USER_DELETED', 'user', req.params.id);
        res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This user'));
    }
});

router.post('/users/:id/edit', checkUserManagement, async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;

    await pool.query(
        `UPDATE users SET full_name = $1, email = $2, is_active = $3, theme_preference = $4
         WHERE id = $5 AND tenant_id = $6`,
        [b.full_name, b.email, b.is_active === '1', b.theme_preference || 'brand', req.params.id, t]
    );
    if (b.new_password) {
        const hash = await bcrypt.hash(b.new_password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3', [hash, req.params.id, t]);
    }
    await writeAuditLog(t, req.session.user.id, 'USER_UPDATED', 'user', req.params.id, null, b);
    res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---- Queues (admin only) ----
router.get('/queues', requirePermission(['queue.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const queues = (await pool.query('SELECT * FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('admin/queues', { pageTitle: 'Admin — Queues', queues, editId: req.query.edit || null });
});

router.post('/queues/create', requirePermission(['queue.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `INSERT INTO queues (tenant_id, name, queue_number, strategy, max_wait_seconds, sla_seconds, wrapup_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [t, b.name, b.queue_number, b.strategy, b.max_wait_seconds || null, b.sla_seconds || 20, b.wrapup_seconds || 0]
    );
    await writeAuditLog(t, req.session.user.id, 'QUEUE_CREATED', 'queue', null, null, b);
    res.redirect('/admin/queues' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/queues/:id/edit', requirePermission(['queue.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE queues SET name = $1, queue_number = $2, strategy = $3, max_wait_seconds = $4,
            sla_seconds = $5, wrapup_seconds = $6, is_active = $7
         WHERE id = $8 AND tenant_id = $9`,
        [b.name, b.queue_number, b.strategy, b.max_wait_seconds || null, b.sla_seconds || 20,
         b.wrapup_seconds || 0, b.is_active === '1', req.params.id, t]
    );
    await writeAuditLog(t, req.session.user.id, 'QUEUE_UPDATED', 'queue', req.params.id, null, b);
    res.redirect('/admin/queues' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/queues/:id/delete', requirePermission(['queue.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM queues WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'QUEUE_DELETED', 'queue', req.params.id);
        res.redirect('/admin/queues' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This queue'));
    }
});

// ---- IVR Menus ----
router.get('/ivr', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const menus = (await pool.query('SELECT * FROM ivr_menus WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const editId = req.query.edit || null;
    let options = [];
    if (editId) {
        options = (await pool.query(
            `SELECT o.*, q.name AS queue_name, sm.name AS submenu_name FROM ivr_menu_options o
             LEFT JOIN queues q ON q.id = o.target_queue_id
             LEFT JOIN ivr_menus sm ON sm.id = o.target_submenu_id
             WHERE o.ivr_menu_id = $1 ORDER BY o.dtmf_digit`,
            [editId]
        )).rows;
    }
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('admin/ivr', { pageTitle: 'Admin — IVR Menus', menus, editId, options, queues });
});

router.post('/ivr/create', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const result = await pool.query(
        `INSERT INTO ivr_menus (tenant_id, name, greeting_type, greeting_text, invalid_retry_limit, timeout_seconds)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [t, b.name, b.greeting_type || 'tts', b.greeting_text || null, b.invalid_retry_limit || 3, b.timeout_seconds || 5]
    );
    await writeAuditLog(t, req.session.user.id, 'IVR_MENU_CREATED', 'ivr_menu', result.rows[0].id, null, b);
    res.redirect(`/admin/ivr?edit=${result.rows[0].id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/ivr/:id/edit', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE ivr_menus SET name = $1, greeting_type = $2, greeting_text = $3, invalid_retry_limit = $4, timeout_seconds = $5, is_active = $6
         WHERE id = $7 AND tenant_id = $8`,
        [b.name, b.greeting_type, b.greeting_text || null, b.invalid_retry_limit || 3, b.timeout_seconds || 5, b.is_active === '1', req.params.id, t]
    );
    res.redirect(`/admin/ivr?edit=${req.params.id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/ivr/:id/delete', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM ivr_menus WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'IVR_MENU_DELETED', 'ivr_menu', req.params.id);
        res.redirect('/admin/ivr' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This IVR menu'));
    }
});

router.post('/ivr/:id/options/create', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `INSERT INTO ivr_menu_options (tenant_id, ivr_menu_id, dtmf_digit, label, action_type, target_queue_id, target_extension, target_submenu_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [t, req.params.id, b.dtmf_digit, b.label, b.action_type,
         b.action_type === 'queue' ? b.target_queue_id : null,
         b.action_type === 'extension' ? b.target_extension : null,
         b.action_type === 'submenu' ? b.target_submenu_id : null]
    );
    res.redirect(`/admin/ivr?edit=${req.params.id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/ivr/:id/options/:optionId/delete', requirePermission(['ivr.manage']), async (req, res) => {
    const t = req.effectiveTenant.id;
    await pool.query('DELETE FROM ivr_menu_options WHERE id = $1 AND tenant_id = $2', [req.params.optionId, t]);
    res.redirect(`/admin/ivr?edit=${req.params.id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

// ---- Privacy & Number Masking ----
router.get('/privacy-settings', requirePermission(['privacy.configure']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const settings = (await pool.query('SELECT mask_number_for_agents, mask_number_for_supervisors FROM tenants WHERE id = $1', [t])).rows[0];
    res.render('admin/privacy_settings', { pageTitle: 'Admin — Privacy & Number Masking', settings });
});

router.post('/privacy-settings/toggle', requirePermission(['privacy.configure']), async (req, res) => {
    const t = req.effectiveTenant.id;
    const field = req.body.field === 'agents' ? 'mask_number_for_agents' : 'mask_number_for_supervisors';
    const newValue = req.body.enabled === '1';
    await pool.query(`UPDATE tenants SET ${field} = $1 WHERE id = $2`, [newValue, t]);
    phoneMasker.invalidateCache(t);
    await writeAuditLog(t, req.session.user.id, 'NUMBER_MASKING_CHANGED', 'tenant', t, null, { [field]: newValue });
    res.redirect('/admin/privacy-settings' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

module.exports = router;
