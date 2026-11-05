const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const { writeAuditLog } = require('../src/auditLog');
const { loadTenantAppearance } = require('../src/tenantAppearance');

router.use(requireRole(['superadmin']));
router.use(loadTenantAppearance);

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


// ---------------- Global Super Admin accounts ----------------
router.get('/users', async (req, res) => {
    const result = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.is_active, u.created_at,
                t.slug AS tenant_slug
           FROM users u
           JOIN tenants t ON t.id = u.tenant_id
          WHERE EXISTS (
              SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
               WHERE ur.user_id = u.id
                 AND r.role_type::text = 'superadmin'
          )
          ORDER BY u.created_at DESC`
    );

    res.render('superadmin/users', {
        pageTitle: 'Superadmin — Super Admin Users',
        superAdmins: result.rows
    });
});

router.post('/users/create', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim();
    const password = String(req.body.password || '');

    if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) {
        return res.status(400).send(
            'Username must be 3–50 characters and contain only letters, numbers, dots, underscores or hyphens.'
        );
    }
    if (password.length < 12) {
        return res.status(400).send('Password must be at least 12 characters.');
    }
    if (!fullName) {
        return res.status(400).send('Full name is required.');
    }

    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const tenant = await client.query(
            `SELECT id FROM tenants WHERE slug = 'acme' AND is_active = TRUE LIMIT 1`
        );
        if (!tenant.rows.length) {
            throw new Error('Active internal account tenant "acme" was not found.');
        }

        // Reuse the existing global role; create it only if missing.
        let role = await client.query(
            `SELECT id FROM roles
              WHERE tenant_id IS NULL
                AND role_type::text = 'superadmin'
              ORDER BY id LIMIT 1`
        );

        let roleId;
        if (role.rows.length) {
            roleId = role.rows[0].id;
        } else {
            role = await client.query(
                `INSERT INTO roles (tenant_id, name, role_type, is_system)
                 VALUES (NULL, 'Superadmin', 'superadmin', TRUE)
                 RETURNING id`
            );
            roleId = role.rows[0].id;
        }

        const existing = await client.query(
            `SELECT id FROM users WHERE tenant_id = $1 AND username = $2 FOR UPDATE`,
            [tenant.rows[0].id, username]
        );

        let userId;
        if (existing.rows.length) {
            userId = existing.rows[0].id;
            const alreadySuperadmin = await client.query(
                `SELECT 1
                   FROM user_roles ur
                   JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = $1
                    AND r.role_type::text = 'superadmin'
                  LIMIT 1`,
                [userId]
            );

            if (!alreadySuperadmin.rows.length) {
                return await client.query('ROLLBACK').then(() =>
                    res.status(409).send(
                        'That username already belongs to a non-Super Admin account. Choose another username.'
                    )
                );
            }

            await client.query(
                `UPDATE users
                    SET password_hash = $1, full_name = $2,
                        is_active = TRUE, updated_at = NOW()
                  WHERE id = $3`,
                [passwordHash, fullName, userId]
            );
        } else {
            const inserted = await client.query(
                `INSERT INTO users
                    (tenant_id, username, password_hash, full_name, is_active)
                 VALUES ($1, $2, $3, $4, TRUE)
                 RETURNING id`,
                [tenant.rows[0].id, username, passwordHash, fullName]
            );
            userId = inserted.rows[0].id;
        }

        await client.query(
            `INSERT INTO user_roles (user_id, role_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [userId, roleId]
        );

        await client.query('COMMIT');
        await writeAuditLog(
            req.session.user.tenantId,
            req.session.user.id,
            'SUPERADMIN_USER_CREATED',
            'user',
            userId,
            null,
            { username }
        );
        return res.redirect('/superadmin/users');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Super Admin user creation failed:', e.message);
        return res.status(500).send('Could not create Super Admin account. Check the server log.');
    } finally {
        client.release();
    }
});

// Canonical tenant feature allowlist. Keep existing keys for compatibility;
// new keys correspond to actual TECH-Life navigation and application modules.
const FEATURE_KEYS = [
    'voice', 'inbound', 'outbound', 'internal_calling',
    'call_recording', 'webrtc', 'video_calling', 'omnichannel',
    'campaigns', 'auto_dialer', 'queues', 'call_monitoring',
    'barge', 'whisper', 'call_listening', 'mis_reports',
    'sip_trunks', 'mattermost', 'skills', 'dispositions',
    'user_groups', 'pause_codes', 'skill_routing', 'robo_agents',
    'list_management', 'callback_management', 'media_assets',
    'ivr', 'caller_id', 'dnc_management', 'privacy_masking',
    'crm_integration', 'webchat', 'staff_chat', 'audit_logs'
];

const DEFAULT_FEATURE_KEYS = new Set([
    'voice', 'inbound', 'outbound', 'internal_calling'
]);

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
    res.render('superadmin/tenants', {
        pageTitle: 'Superadmin — Tenants',
        tenants, editId, editFeatures,
        featureKeys: FEATURE_KEYS,
        defaultFeatureKeys: DEFAULT_FEATURE_KEYS
    });
});

router.post('/tenants/create', async (req, res) => {
    const {
        name, slug, feature, feature_form_submitted, tenant_type,
        admin_username, admin_password, admin_full_name, admin_email
    } = req.body;
    const result = await pool.query(
        'INSERT INTO tenants (name, slug, tenant_type) VALUES ($1,$2,$3) RETURNING id',
        [name, slug, tenant_type === 'reseller' ? 'reseller' : 'normal']
    );
    const newId = result.rows[0].id;
    for (const fk of FEATURE_KEYS) {
        const enabled = feature_form_submitted === '1'
            ? !!(feature && Object.prototype.hasOwnProperty.call(feature, fk))
            : DEFAULT_FEATURE_KEYS.has(fk);
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

router.post('/tenants/save-features', async (req, res) => {
    const tenantId = req.body.tenant_id;
    const submitted = req.body.feature_form_submitted;
    const selected = req.body.feature || {};

    // A missing marker could mean a malformed request, not an intentional
    // request to disable every checkbox.
    if (submitted !== '1') {
        return res.status(400).send('Feature form submission could not be verified.');
    }
    if (typeof tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
        return res.status(400).send('Invalid tenant ID.');
    }
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
        return res.status(400).send('Invalid feature selection.');
    }

    // Reject unknown keys rather than accepting arbitrary feature names.
    const unknownKeys = Object.keys(selected).filter((key) => !FEATURE_KEYS.includes(key));
    if (unknownKeys.length) {
        return res.status(400).send('Unknown feature key: ' + unknownKeys.join(', '));
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const tenant = await client.query(
            'SELECT id FROM tenants WHERE id = $1 FOR UPDATE',
            [tenantId]
        );
        if (!tenant.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).send('Tenant not found.');
        }

        for (const key of FEATURE_KEYS) {
            const value = Object.prototype.hasOwnProperty.call(selected, key)
                ? selected[key]
                : undefined;

            if (value !== undefined && value !== '1' && value !== 'on' && value !== true) {
                await client.query('ROLLBACK');
                return res.status(400).send('Invalid value for feature: ' + key);
            }

            const enabled = value === '1' || value === 'on' || value === true;

            await client.query(
                `INSERT INTO tenant_features (tenant_id, feature_key, is_enabled)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (tenant_id, feature_key)
                 DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
                [tenantId, key, enabled]
            );
        }

        await client.query('COMMIT');

        await writeAuditLog(
            req.session.user.tenantId,
            req.session.user.id,
            'TENANT_FEATURES_UPDATED',
            'tenant',
            tenantId,
            null,
            { enabled_features: FEATURE_KEYS.filter((key) =>
                Object.prototype.hasOwnProperty.call(selected, key)
            ) }
        );

        return res.redirect('/superadmin/tenants?edit=' + encodeURIComponent(tenantId));
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Tenant feature update failed:', err);
        return res.status(500).send('Could not save tenant features. Check the server log.');
    } finally {
        client.release();
    }
});

// Retain the old single-feature endpoint for compatibility with any older
// page or integration, but apply the same strict tenant/key validation.
router.post('/tenants/toggle-feature', async (req, res) => {
    const { tenant_id, feature_key, enabled } = req.body;

    if (!FEATURE_KEYS.includes(feature_key)) {
        return res.status(400).send('Unknown feature key.');
    }
    if (typeof tenant_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant_id)) {
        return res.status(400).send('Invalid tenant ID.');
    }
    if (enabled !== '0' && enabled !== '1') {
        return res.status(400).send('Invalid feature state.');
    }

    try {
        const tenant = await pool.query('SELECT id FROM tenants WHERE id = $1', [tenant_id]);
        if (!tenant.rows.length) return res.status(404).send('Tenant not found.');

        await pool.query(
            `INSERT INTO tenant_features (tenant_id, feature_key, is_enabled)
             VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, feature_key)
             DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
            [tenant_id, feature_key, enabled === '1']
        );
        return res.redirect('/superadmin/tenants?edit=' + encodeURIComponent(tenant_id));
    } catch (err) {
        console.error('Single tenant feature update failed:', err);
        return res.status(500).send('Could not update tenant feature.');
    }
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
