const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const { writeAuditLog } = require('../src/auditLog');

router.use(requireRole(['superadmin']));

router.get('/', async (req, res) => {
    const tenants = (await pool.query('SELECT id, name, slug, is_active, created_at FROM tenants ORDER BY created_at DESC')).rows;
    const totals = (await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM tenants WHERE is_active) AS active_tenants,
            (SELECT COUNT(*) FROM users) AS total_users,
            (SELECT COUNT(*) FROM agents WHERE is_active) AS total_agents,
            (SELECT COUNT(*) FROM calls WHERE start_time > now() - interval '24 hours') AS calls_24h`
    )).rows[0];
    res.render('superadmin/index', { pageTitle: 'Superadmin — Platform Dashboard', tenants, totals });
});

const FEATURE_KEYS = ['voice','inbound','outbound','call_recording','webrtc','video_calling',
    'omnichannel','campaigns','auto_dialer','queues','call_monitoring','barge','whisper',
    'call_listening','mis_reports'];

router.get('/tenants', async (req, res) => {
    const tenants = (await pool.query(
        `SELECT t.id, t.name, t.slug, t.is_active, t.tenant_type, t.parent_tenant_id, p.name AS parent_name
         FROM tenants t LEFT JOIN tenants p ON p.id = t.parent_tenant_id
         ORDER BY COALESCE(p.name, t.name), t.name`
    )).rows;
    const editId = req.query.edit || null;
    let editFeatures = {};
    if (editId) {
        const rows = (await pool.query('SELECT feature_key, is_enabled FROM tenant_features WHERE tenant_id = $1', [editId])).rows;
        rows.forEach((r) => { editFeatures[r.feature_key] = r.is_enabled; });
    }
    res.render('superadmin/tenants', { pageTitle: 'Superadmin — Tenants', tenants, editId, editFeatures, featureKeys: FEATURE_KEYS });
});

router.post('/tenants/create', async (req, res) => {
    const { name, slug, feature, tenant_type, admin_username, admin_password, admin_full_name, admin_email } = req.body;
    const result = await pool.query(
        'INSERT INTO tenants (name, slug, tenant_type) VALUES ($1,$2,$3) RETURNING id',
        [name, slug, tenant_type === 'reseller' ? 'reseller' : 'normal']
    );
    const newId = result.rows[0].id;
    for (const fk of FEATURE_KEYS) {
        const enabled = !!(feature && feature[fk] !== undefined);
        await pool.query('INSERT INTO tenant_features (tenant_id, feature_key, is_enabled) VALUES ($1,$2,$3)', [newId, fk, enabled]);
    }

    // Every tenant needs its own roles rows to be usable at all, and
    // ideally its first admin user so someone can actually log in.
    const { provisionNewTenant } = require('../src/tenantSetup');
    await provisionNewTenant(newId, admin_username && admin_password
        ? { username: admin_username, password: admin_password, fullName: admin_full_name, email: admin_email }
        : null);

    await writeAuditLog(req.session.user.tenantId, req.session.user.id, 'TENANT_CREATED', 'tenant', newId, null, req.body);
    res.redirect('/superadmin/tenants');
});

router.post('/tenants/:id/set-type', async (req, res) => {
    // Superadmin-only override: promote/demote a tenant between
    // 'reseller' and 'normal'. A tenant that already has sub-tenants
    // cannot be demoted (would orphan them) -- checked here rather than
    // relying on a DB constraint, so the error message is clear.
    const { id } = req.params;
    const { tenant_type } = req.body;
    if (tenant_type === 'normal') {
        const subCount = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE parent_tenant_id = $1', [id]);
        if (parseInt(subCount.rows[0].n, 10) > 0) {
            return res.status(400).send('Cannot demote a reseller that still has sub-tenants. Reassign or remove its sub-tenants first.');
        }
    }
    await pool.query('UPDATE tenants SET tenant_type = $1 WHERE id = $2', [tenant_type === 'reseller' ? 'reseller' : 'normal', id]);
    await writeAuditLog(req.session.user.tenantId, req.session.user.id, 'TENANT_TYPE_CHANGED', 'tenant', id, null, { tenant_type });
    res.redirect('/superadmin/tenants');
});

router.post('/tenants/toggle-feature', async (req, res) => {
    const { tenant_id, feature_key, enabled } = req.body;
    await pool.query(
        `INSERT INTO tenant_features (tenant_id, feature_key, is_enabled) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, feature_key) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
        [tenant_id, feature_key, enabled === '1']
    );
    res.redirect(`/superadmin/tenants?edit=${tenant_id}`);
});

router.post('/tenants/:id/toggle-active', async (req, res) => {
    await pool.query('UPDATE tenants SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
    await writeAuditLog(req.session.user.tenantId, req.session.user.id, 'TENANT_ACTIVE_TOGGLED', 'tenant', req.params.id);
    res.redirect('/superadmin/tenants');
});

router.post('/tenants/:id/delete', async (req, res) => {
    const { id } = req.params;
    const subCount = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE parent_tenant_id = $1', [id]);
    if (parseInt(subCount.rows[0].n, 10) > 0) {
        return res.status(400).send('This tenant still has sub-tenants. Delete or reassign those first.');
    }
    try {
        await pool.query('DELETE FROM tenant_features WHERE tenant_id = $1', [id]);
        await pool.query('DELETE FROM roles WHERE tenant_id = $1', [id]);
        await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
        await writeAuditLog(req.session.user.tenantId, req.session.user.id, 'TENANT_DELETED', 'tenant', id);
        res.redirect('/superadmin/tenants');
    } catch (e) {
        if (e.code === '23503') {
            return res.status(409).send(
                'This tenant still has users, queues, campaigns, or other configured data and cannot be deleted. ' +
                'Disable it instead (set inactive) if you want to stop it being used.'
            );
        }
        res.status(500).send('Delete failed: ' + e.message);
    }
});

module.exports = router;
