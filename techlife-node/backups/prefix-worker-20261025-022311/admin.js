const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const { writeAuditLog } = require('../src/auditLog');
const bcrypt = require('bcryptjs');
const wazoProvisioning = require('../src/wazoProvisioningService');
const wazoTrunkProvisioning = require('../src/wazoTrunkProvisioningService');
const {
    provisionPrefixOutboundRoute,
    setPrefixOutboundRouteEnabled
} = require('../src/wazoOutboundRoutingService');
const { provisionInboundDid } = require('../src/wazoInboundRoutingService');
const trunkCredentialCrypto = require('../src/trunkCredentialCrypto');
const phoneMasker = require('../src/phoneMasker');
const { resolveTenantContext } = require('../src/tenantContext');
const { loadTenantAppearance } = require('../src/tenantAppearance');
const { audioUpload, leadsUpload } = require('../src/uploadMiddleware');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const { convertToWav } = require('../src/audioConversionService');

router.use((req, res, next) => {
    const roles = req.session?.user?.roles || [];
    if (roles.includes('superadmin')) {
        return res.status(403).send('Superadmin accounts must use the superadmin portal.');
    }
    next();
});
router.use(requireRole(['admin']));
router.use(resolveTenantContext);
router.use(loadTenantAppearance);

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

// ---------------- Dashboard ----------------


// ---------------- Recording Storage Settings ----------------
router.get('/recording-settings', async (req, res, next) => {
    try {
        const t = req.effectiveTenant.id;
        const result = await pool.query(
            'SELECT * FROM recording_settings WHERE tenant_id = $1', [t]
        );
        const settings = result.rows[0] || {
            storage_provider: 's3',
            destination_name: '',
            destination_prefix: 'recordings',
            keep_local_copy: true,
            keep_remote_copy: true,
            local_base_path: '/var/lib/techlife/recordings',
            folder_template: '{yyyy}/{mm}/{dd}',
            filename_template: '{timestamp}_{call_id}_{recording_id}',
            audio_format: 'wav',
            mp3_bitrate_kbps: 128,
            retention_days: '',
            download_enabled: true,
            remote_upload_enabled: false
        };
        res.render('admin/recording-settings', {
            pageTitle: 'Admin — Recording Settings', settings,
            saved: req.query.saved === '1'
        });
    } catch (err) { next(err); }
});

router.post('/recording-settings', async (req, res, next) => {
    try {
        const t = req.effectiveTenant.id;
        const b = req.body;
        const allowedProviders = ['s3','azure','gcs','sftp','s3compatible'];
        const allowedFormats = ['wav','mp3','ogg','flac'];
        const provider = String(b.storage_provider || '');
        const format = String(b.audio_format || '');
        const bitrate = Number(b.mp3_bitrate_kbps);
        const retention = String(b.retention_days || '').trim();
        const prefix = String(b.destination_prefix || 'recordings').trim();
        const destination = String(b.destination_name || '').trim();
        const localPath = String(b.local_base_path || '').trim();
        const folder = String(b.folder_template || '').trim();
        const filename = String(b.filename_template || '').trim();

        if (!allowedProviders.includes(provider) ||
            !allowedFormats.includes(format) ||
            ![64,96,128,160,192,256,320].includes(bitrate) ||
            (retention && (!/^\d+$/.test(retention) ||
                Number(retention) < 1 || Number(retention) > 36500)) ||
            !localPath.startsWith('/') || localPath.includes('\\0') ||
            !prefix || prefix.startsWith('/') || prefix.includes('..') ||
            !folder || folder.length > 255 ||
            !filename || filename.length > 255 ||
            !filename.includes('{recording_id}') ||
            destination.length > 255) {
            return res.status(400).send(
                'Invalid settings. Filename template must include {recording_id}; path and template values must be valid.'
            );
        }

        // Remote upload stays disabled until a real provider adapter is installed.
        await pool.query(`
            INSERT INTO recording_settings (
                tenant_id, storage_provider, destination_name,
                destination_prefix, keep_local_copy, keep_remote_copy,
                local_base_path, folder_template, filename_template,
                audio_format, mp3_bitrate_kbps, retention_days,
                download_enabled, remote_upload_enabled, updated_at
            ) VALUES (
                $1,$2,$3,$4,TRUE,TRUE,$5,$6,$7,$8,$9,$10,$11,FALSE,NOW()
            )
            ON CONFLICT (tenant_id) DO UPDATE SET
                storage_provider=EXCLUDED.storage_provider,
                destination_name=EXCLUDED.destination_name,
                destination_prefix=EXCLUDED.destination_prefix,
                keep_local_copy=TRUE, keep_remote_copy=TRUE,
                local_base_path=EXCLUDED.local_base_path,
                folder_template=EXCLUDED.folder_template,
                filename_template=EXCLUDED.filename_template,
                audio_format=EXCLUDED.audio_format,
                mp3_bitrate_kbps=EXCLUDED.mp3_bitrate_kbps,
                retention_days=EXCLUDED.retention_days,
                download_enabled=EXCLUDED.download_enabled,
                remote_upload_enabled=FALSE, updated_at=NOW()
        `, [
            t, provider, destination || null, prefix, localPath,
            folder, filename, format, bitrate,
            retention ? Number(retention) : null,
            b.download_enabled === '1'
        ]);

        await writeAuditLog(t, req.session.user.id,
            'RECORDING_SETTINGS_UPDATED', 'tenant', t, null, {
                storage_provider: provider,
                destination_name: destination || null,
                audio_format: format,
                remote_upload_enabled: false
            });

        res.redirect('/admin/recording-settings?saved=1');
    } catch (err) { next(err); }
});

// Recordings are not listed or played in the Admin portal.

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

// ---------------- Tenant switcher (reseller admins only) ----------------
// GET so it's a plain link/dropdown-navigation from the sidebar; the
// tenantContext middleware validates as_tenant against manageableTenants
// on every request, so this can never be used to jump to a foreign tenant.
router.get('/switch-tenant', (req, res) => {
    res.redirect('/admin' + (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : ''));
});

// ---------------- Sub-Tenants (reseller admins only) ----------------
router.get('/sub-tenants', async (req, res) => {
    if (!req.isReseller) return res.status(403).send('Your tenant is not a reseller — sub-tenants are not available.');
    // Always the reseller's OWN sub-tenants, regardless of which
    // sub-tenant context they're currently switched into.
    const subs = (await pool.query(
        'SELECT * FROM tenants WHERE parent_tenant_id = $1 ORDER BY created_at DESC',
        [req.session.user.tenantId]
    )).rows;
    res.render('admin/sub_tenants', { pageTitle: 'Admin — Sub-Tenants', subs });
});

router.post('/sub-tenants/:id/delete', async (req, res) => {
    const u = req.session.user;
    // Ownership check: the sub-tenant must actually belong to THIS
    // reseller -- a reseller can never delete another reseller's
    // sub-tenant, even by guessing its id.
    const check = await pool.query('SELECT id FROM tenants WHERE id = $1 AND parent_tenant_id = $2', [req.params.id, u.tenantId]);
    if (!check.rows[0]) return res.status(403).send('That sub-tenant does not belong to you.');

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

router.post('/sub-tenants/create', async (req, res) => {
    const u = req.session.user;
    const ownRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [u.tenantId]);
    const own = ownRes.rows[0];
    if (own.tenant_type !== 'reseller') return res.status(403).send('Your tenant is not a reseller.');

    const b = req.body;
    const result = await pool.query(
        `INSERT INTO tenants (name, slug, timezone, tenant_type, parent_tenant_id)
         VALUES ($1,$2,$3,'normal',$4) RETURNING id`,
        [b.name, b.slug, b.timezone || 'UTC', own.id]
    );
    const newId = result.rows[0].id;

    const { provisionNewTenant } = require('../src/tenantSetup');
    await provisionNewTenant(newId, b.admin_username && b.admin_password
        ? { username: b.admin_username, password: b.admin_password, fullName: b.admin_full_name, email: b.admin_email }
        : null);

    await writeAuditLog(own.id, u.id, 'SUB_TENANT_CREATED', 'tenant', newId, null, { name: b.name, slug: b.slug });
    res.redirect('/admin/sub-tenants');
});

// ---------------- Users ----------------
router.get('/users', async (req, res) => {
    const t = req.effectiveTenant.id;
    const users = (await pool.query(
        `SELECT u.id, u.username, u.full_name, u.email, u.is_active,
                array_agg(r.role_type::text) AS roles,
                ag.id AS agent_id, ag.caller_id,
                ag.extension, ag.sip_username, ag.provisioning_status, ag.provisioning_error
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         LEFT JOIN agents ag ON ag.user_id = u.id
         WHERE u.tenant_id = $1
           AND NOT EXISTS (
               SELECT 1
                 FROM user_roles sur
                 JOIN roles sr ON sr.id = sur.role_id
                WHERE sur.user_id = u.id
                  AND sr.role_type::text = 'superadmin'
           )
         GROUP BY u.id, ag.id, ag.caller_id, ag.extension, ag.sip_username,
                  ag.provisioning_status, ag.provisioning_error
         ORDER BY u.created_at DESC`,
        [t]
    )).rows;
    const [assignmentAgents, assignmentGroups] = await Promise.all([
        pool.query(`SELECT a.id, COALESCE(NULLIF(u.full_name, ''), a.agent_number, a.extension, a.id::text) AS display_name
                    FROM agents a LEFT JOIN users u ON u.id = a.user_id
                    WHERE a.tenant_id = $1 AND a.is_active = TRUE ORDER BY display_name`, [t]).then(r => r.rows),
        pool.query(`SELECT id, name FROM user_groups WHERE tenant_id = $1 AND is_active = TRUE ORDER BY name`, [t]).then(r => r.rows)
    ]);
    const selectedSupervisor = req.query.edit || req.query.supervisor_id || '';
    let assignedAgentIds = [], assignedGroupIds = [];
    if (selectedSupervisor && users.some(x => x.id === selectedSupervisor &&
        (Array.isArray(x.roles) ? x.roles : String(x.roles || '').replace(/[{}]/g,'').split(',')).includes('supervisor'))) {
        [assignedAgentIds, assignedGroupIds] = await Promise.all([
            pool.query('SELECT agent_id FROM supervisor_agent_assignments WHERE tenant_id=$1 AND supervisor_id=$2', [t, selectedSupervisor]).then(r => r.rows.map(x => x.agent_id)),
            pool.query('SELECT group_id FROM supervisor_group_assignments WHERE tenant_id=$1 AND supervisor_id=$2', [t, selectedSupervisor]).then(r => r.rows.map(x => x.group_id))
        ]);
    }
    res.render('admin/users', {
        pageTitle: 'Admin — Users', users, editId: req.query.edit || null,
        assignmentAgents, assignmentGroups, assignedAgentIds, assignedGroupIds
    });
});

router.post('/users/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const allowedTenantRoles = new Set(['admin', 'supervisor', 'agent', 'mis_agent']);
    if (!allowedTenantRoles.has(String(b.role_type || ''))) {
        return res.status(400).send('Invalid role for a tenant user.');
    }

    const callerId = String(b.caller_id || '').trim();

    if (b.role_type === 'agent' &&
        callerId &&
        (callerId.length > 30 || !/^[+0-9*#]+$/.test(callerId))) {
        return res.status(400).send(
            'Agent CLI must be up to 30 characters and contain only digits, +, * or #.'
        );
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hash = await bcrypt.hash(b.password, 10);
        const userRes = await client.query(
            `INSERT INTO users (tenant_id, username, email, password_hash, full_name) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [t, b.username, b.email, hash, b.full_name]
        );
        const newUserId = userRes.rows[0].id;

        const roleRes = await client.query('SELECT id FROM roles WHERE tenant_id = $1 AND role_type = $2 LIMIT 1', [t, b.role_type]);
        if (roleRes.rows[0]) {
            await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [newUserId, roleRes.rows[0].id]);
        }

        let newAgentId = null;
        if (b.role_type === 'agent') {
            const agentRes = await client.query(
                `INSERT INTO agents (tenant_id, user_id, caller_id, provisioning_status)
                 VALUES ($1,$2,$3,'pending') RETURNING id`,
                [t, newUserId, callerId || null]
            );
            newAgentId = agentRes.rows[0].id;
        }
        if (b.role_type === 'supervisor') {
            const idsFrom = value => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(String))];
            const agentIds = idsFrom(b.supervisor_agent_ids);
            const groupIds = idsFrom(b.supervisor_group_ids);
            if (agentIds.length) {
                const valid = await client.query(
                    'SELECT id FROM agents WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])',
                    [t, agentIds]
                );
                if (valid.rowCount !== agentIds.length) throw new Error('One or more assigned agents are invalid for this tenant.');
                for (const agentId of agentIds) {
                    await client.query(`INSERT INTO supervisor_agent_assignments (tenant_id, supervisor_id, agent_id)
                                        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t, newUserId, agentId]);
                }
            }
            if (groupIds.length) {
                const valid = await client.query(
                    'SELECT id FROM user_groups WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])',
                    [t, groupIds]
                );
                if (valid.rowCount !== groupIds.length) throw new Error('One or more assigned groups are invalid for this tenant.');
                for (const groupId of groupIds) {
                    await client.query(`INSERT INTO supervisor_group_assignments (tenant_id, supervisor_id, group_id)
                                        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t, newUserId, groupId]);
                }
            }
        }
        await client.query('COMMIT');
        await writeAuditLog(t, req.session.user.id, 'USER_CREATED', 'user', newUserId, null, { username: b.username });

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

router.post('/users/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    const protectedUser = await pool.query(
        `SELECT 1 FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id
         WHERE u.id = $1 AND u.tenant_id = $2
           AND r.role_type::text = 'superadmin'
         LIMIT 1`,
        [req.params.id, t]
    );
    if (protectedUser.rows.length) {
        return res.status(403).send('Superadmin accounts cannot be deleted from tenant administration.');
    }
    try {
        // agents row (if any) cascades via its own FK to users; delete
        // order matters only in that agents.user_id -> users.id, so we
        // remove the agent row first if present.
        await pool.query('DELETE FROM agents WHERE user_id = $1 AND tenant_id = $2', [req.params.id, t]);
        await pool.query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'USER_DELETED', 'user', req.params.id);
        res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This user'));
    }
});

router.post('/users/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const protectedUser = await pool.query(
        `SELECT 1 FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON r.id = ur.role_id
         WHERE u.id = $1 AND u.tenant_id = $2
           AND r.role_type::text = 'superadmin'
         LIMIT 1`,
        [req.params.id, t]
    );
    if (protectedUser.rows.length) {
        return res.status(403).send('Superadmin accounts cannot be edited from tenant administration.');
    }
    const b = req.body;
    const callerId = String(b.caller_id || '').trim();

    if (Object.prototype.hasOwnProperty.call(b, 'caller_id') &&
        callerId &&
        (callerId.length > 30 || !/^[+0-9*#]+$/.test(callerId))) {
        return res.status(400).send(
            'Agent CLI must be up to 30 characters and contain only digits, +, * or #.'
        );
    }

    // Scope the UPDATE to this tenant explicitly -- a user id from
    // outside the effective tenant simply won't match any row.
    await pool.query(
        `UPDATE users SET full_name = $1, email = $2, is_active = $3 WHERE id = $4 AND tenant_id = $5`,
        [b.full_name, b.email, b.is_active === '1', req.params.id, t]
    );
    if (b.new_password) {
        const hash = await bcrypt.hash(b.new_password, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3', [hash, req.params.id, t]);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'caller_id')) {
        await pool.query(
            'UPDATE agents SET caller_id = $1 WHERE user_id = $2 AND tenant_id = $3',
            [callerId || null, req.params.id, t]
        );
    }

    const isSupervisorResult = await pool.query(`
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        JOIN users u ON u.id=ur.user_id
        WHERE u.id=$1 AND u.tenant_id=$2 AND r.role_type::text='supervisor' LIMIT 1`,
        [req.params.id, t]);
    if (isSupervisorResult.rowCount) {
        const idsFrom = value => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(String))];
        const agentIds = idsFrom(b.supervisor_agent_ids);
        const groupIds = idsFrom(b.supervisor_group_ids);
        const [validAgents, validGroups] = await Promise.all([
            agentIds.length ? pool.query('SELECT id FROM agents WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])', [t, agentIds]) : Promise.resolve({ rows: [] }),
            groupIds.length ? pool.query('SELECT id FROM user_groups WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])', [t, groupIds]) : Promise.resolve({ rows: [] })
        ]);
        if (validAgents.rowCount !== agentIds.length || validGroups.rowCount !== groupIds.length) {
            return res.status(400).send('One or more supervisor assignments are invalid for this tenant.');
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM supervisor_agent_assignments WHERE tenant_id=$1 AND supervisor_id=$2', [t, req.params.id]);
            await client.query('DELETE FROM supervisor_group_assignments WHERE tenant_id=$1 AND supervisor_id=$2', [t, req.params.id]);
            for (const agentId of agentIds) {
                await client.query('INSERT INTO supervisor_agent_assignments (tenant_id, supervisor_id, agent_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t, req.params.id, agentId]);
            }
            for (const groupId of groupIds) {
                await client.query('INSERT INTO supervisor_group_assignments (tenant_id, supervisor_id, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [t, req.params.id, groupId]);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
    await writeAuditLog(t, req.session.user.id, 'USER_UPDATED', 'user', req.params.id, null, b);
    res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Queues ----------------

const QUEUE_STRATEGIES = new Set([
    'ringall', 'roundrobin', 'leastrecent',
    'leastcalls', 'random', 'skillbased'
]);

const QUEUE_FALLBACK_ACTIONS = new Set([
    'leave', 'next_queue', 'callback', 'voicemail'
]);

function parseQueueRequiredSkills(raw) {
    const input = String(raw || '').trim();
    if (!input) return [];

    const requirements = [];
    const seen = new Set();

    for (const part of input.split(',')) {
        const match = part.trim().match(/^([a-zA-Z0-9_-]+)(?::([1-5]))?$/);
        if (!match) {
            throw new Error(
                'Skills must use the format skill or skill:level, separated by commas; levels are 1–5.'
            );
        }

        const name = match[1].toLowerCase();
        if (seen.has(name)) {
            throw new Error('Duplicate skill: ' + name);
        }
        seen.add(name);

        requirements.push({
            name,
            min_proficiency: Number(match[2] || 1)
        });
    }

    return requirements;
}

function validateQueueBody(body) {
    const name = String(body.name || '').trim();
    const queueNumber = String(body.queue_number || '').trim();
    const strategy = String(body.strategy || 'ringall');
    const fallback = String(body.skill_fallback_action || 'leave');

    if (!name || name.length > 120) {
        throw new Error('Queue name is required and must be at most 120 characters.');
    }

    if (!/^[a-zA-Z0-9*#+_-]{1,40}$/.test(queueNumber)) {
        throw new Error('Queue number must be 1–40 characters and contain only letters, digits, *, #, +, _ or -.');
    }

    if (!QUEUE_STRATEGIES.has(strategy)) {
        throw new Error('Invalid queue strategy.');
    }

    if (!QUEUE_FALLBACK_ACTIONS.has(fallback)) {
        throw new Error('Invalid skill fallback setting.');
    }

    const requiredSkills = parseQueueRequiredSkills(body.required_skills);

    if (strategy === 'skillbased' && requiredSkills.length === 0) {
        throw new Error('Skill Based queues require at least one required skill.');
    }

    function integerField(value, label, min, max, defaultValue) {
        if (value === undefined || value === null || String(value).trim() === '') {
            return defaultValue;
        }

        if (!/^\d+$/.test(String(value).trim())) {
            throw new Error(label + ' must be a whole number.');
        }

        const n = Number(value);
        if (n < min || n > max) {
            throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
        }
        return n;
    }

    return {
        name,
        queueNumber,
        strategy,
        maxWait: integerField(body.max_wait_seconds, 'Max wait', 1, 86400, null),
        sla: integerField(body.sla_seconds, 'SLA target', 1, 86400, 20),
        wrapup: integerField(body.wrapup_seconds, 'Wrap-up', 0, 86400, 0),
        isActive: body.is_active === '1',
        requiredSkills,
        fallback
    };
}

function queueFormRedirect(req) {
    return '/admin/queues' +
        (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : '');
}

function sendQueueValidationError(res, error) {
    return res.status(400).send(error.message || 'Invalid queue settings.');
}

router.get('/queues', async (req, res) => {
    const t = req.effectiveTenant.id;
    const queues = (await pool.query(
        'SELECT * FROM queues WHERE tenant_id = $1 ORDER BY name',
        [t]
    )).rows;

    res.render('admin/queues', {
        pageTitle: 'Admin — Queues',
        queues,
        editId: req.query.edit || null
    });
});

router.post('/queues/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    let q;

    try {
        q = validateQueueBody(req.body);
    } catch (error) {
        return sendQueueValidationError(res, error);
    }

    try {
        const result = await pool.query(
            `INSERT INTO queues
                (tenant_id, name, queue_number, strategy,
                 max_wait_seconds, sla_seconds, wrapup_seconds,
                 required_skills_json, skill_fallback_action)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
             RETURNING id`,
            [
                t, q.name, q.queueNumber, q.strategy,
                q.maxWait, q.sla, q.wrapup,
                JSON.stringify(q.requiredSkills), q.fallback
            ]
        );

        await writeAuditLog(
            t, req.session.user.id, 'QUEUE_CREATED',
            'queue', result.rows[0].id, null, req.body
        );

        return res.redirect(queueFormRedirect(req));
    } catch (error) {
        console.error('Queue creation failed:', error.message);
        return res.status(500).send('Queue could not be created. Check the server log.');
    }
});

router.post('/queues/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    let q;

    try {
        q = validateQueueBody(req.body);
    } catch (error) {
        return sendQueueValidationError(res, error);
    }

    try {
        const result = await pool.query(
            `UPDATE queues
                SET name = $1, queue_number = $2, strategy = $3,
                    max_wait_seconds = $4, sla_seconds = $5,
                    wrapup_seconds = $6, is_active = $7,
                    required_skills_json = $8::jsonb,
                    skill_fallback_action = $9
              WHERE id = $10 AND tenant_id = $11
              RETURNING id`,
            [
                q.name, q.queueNumber, q.strategy,
                q.maxWait, q.sla, q.wrapup, q.isActive,
                JSON.stringify(q.requiredSkills), q.fallback,
                req.params.id, t
            ]
        );

        if (!result.rowCount) {
            return res.status(404).send('Queue not found for this tenant.');
        }

        await writeAuditLog(
            t, req.session.user.id, 'QUEUE_UPDATED',
            'queue', req.params.id, null, req.body
        );

        return res.redirect(queueFormRedirect(req));
    } catch (error) {
        console.error('Queue update failed:', error.message);
        return res.status(500).send('Queue could not be updated. Check the server log.');
    }
});

router.post('/queues/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        const result = await pool.query(
            'DELETE FROM queues WHERE id = $1 AND tenant_id = $2',
            [req.params.id, t]
        );

        if (!result.rowCount) {
            return res.status(404).send('Queue not found for this tenant.');
        }

        await writeAuditLog(t, req.session.user.id, 'QUEUE_DELETED', 'queue', req.params.id);
        res.redirect(queueFormRedirect(req));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This queue'));
    }
});

// ---------------- Trunks ----------------
router.get('/trunks', async (req, res) => {
    const t = req.effectiveTenant.id;
    const trunks = (await pool.query('SELECT * FROM trunks WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('admin/trunks', { pageTitle: 'Admin — SIP Trunks', trunks, editId: req.query.edit || null });
});

router.post('/trunks/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const authMode = b.auth_mode === 'credentials' ? 'credentials' : b.auth_mode === 'ip' ? 'ip' : null;
    if (!authMode) return res.status(400).send('Choose IP or username/password authentication.');
    const username = String(b.sip_username || '').trim();
    const password = String(b.sip_password || '');
    if (authMode === 'credentials' && (!username || !password)) {
        return res.status(400).send('SIP username and password are required for credential authentication.');
    }
    const passwordEnc = authMode === 'credentials' ? trunkCredentialCrypto.encrypt(password) : null;
    const saved = await pool.query(
        `INSERT INTO trunks
         (tenant_id, name, sip_server, transport, codec, max_calls, caller_id,
          auth_mode, sip_username, sip_password_enc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, is_active`,
        [t, b.name, b.sip_server, b.transport || 'udp', b.codec || null, b.max_calls || null,
         (b.caller_id || '').trim().slice(0, 80) || null,
         authMode, authMode === 'credentials' ? username : null, passwordEnc]
    );
    const trunkId = saved.rows[0].id;
    const safeAudit = { ...b };
    delete safeAudit.sip_password;
    await writeAuditLog(t, req.session.user.id, 'TRUNK_CREATED', 'trunk', trunkId, null, safeAudit);

    if (saved.rows[0].is_active) {
        let result;
        try {
            result = await wazoTrunkProvisioning.provisionTrunk(t, trunkId);
        } catch (error) {
            result = { ok: false, error: String(error.message || error) };
            await pool.query(
                `UPDATE trunks SET provisioning_status = 'failed',
                        provisioning_error = $1
                  WHERE id = $2 AND tenant_id = $3`,
                [result.error.slice(0, 2000), trunkId, t]
            ).catch(dbErr => console.error('Could not save trunk provisioning error:', dbErr.message));
        }

        await writeAuditLog(
            t, req.session.user.id,
            result && result.ok ? 'TRUNK_PROVISIONED' : 'TRUNK_PROVISION_FAILED',
            'trunk', trunkId, null,
            { ok: Boolean(result && result.ok), error: result && result.error || null }
        );
    }

    res.redirect('/admin/trunks' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/trunks/:id/provision', async (req, res) => {
    const tenantId = req.effectiveTenant.id;
    const trunkId = req.params.id;
    const redirectUrl = '/admin/trunks' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : '');

    try {
        // Confirm this trunk belongs to the tenant currently being managed.
        const owned = await pool.query(
            'SELECT id FROM trunks WHERE id = $1 AND tenant_id = $2',
            [trunkId, tenantId]
        );

        if (!owned.rowCount) {
            return res.status(404).send('Trunk not found for the selected tenant.');
        }

        console.error('[TRUNK-PROVISION] handler reached', {
            trunkId: String(trunkId),
            tenantId: String(tenantId),
            at: new Date().toISOString()
        });
        const result = await wazoTrunkProvisioning.provisionTrunk(tenantId, trunkId);
        console.error('[TRUNK-PROVISION] service returned', {
            trunkId: String(trunkId),
            ok: Boolean(result && result.ok),
            error: result && result.error ? String(result.error).slice(0, 500) : null
        });

        await writeAuditLog(
            tenantId,
            req.session.user.id,
            result.ok ? 'TRUNK_PROVISIONED' : 'TRUNK_PROVISION_FAILED',
            'trunk',
            trunkId,
            null,
            { ok: Boolean(result.ok), error: result.error || null }
        );

        return res.redirect(redirectUrl);
    } catch (err) {
        console.error('Trunk provisioning route failed:', err.message);
        await pool.query(
            `UPDATE trunks
                SET provisioning_status = 'failed',
                    provisioning_error = $1
              WHERE id = $2 AND tenant_id = $3`,
            [String(err.message || err).slice(0, 2000), trunkId, tenantId]
        ).catch(dbErr => console.error('Could not save trunk provisioning error:', dbErr.message));

        return res.redirect(redirectUrl);
    }
});

router.post('/trunks/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const authMode = b.auth_mode === 'credentials' ? 'credentials' : b.auth_mode === 'ip' ? 'ip' : null;
    if (!authMode) return res.status(400).send('Choose IP or username/password authentication.');
    const username = String(b.sip_username || '').trim();
    const password = String(b.sip_password || '');
    if (authMode === 'credentials' && !username) {
        return res.status(400).send('SIP username is required for credential authentication.');
    }
    const current = await pool.query(
        'SELECT sip_password_enc FROM trunks WHERE id = $1 AND tenant_id = $2',
        [req.params.id, t]
    );
    if (!current.rowCount) return res.status(404).send('Trunk not found.');
    let passwordEnc = authMode === 'credentials' ? current.rows[0].sip_password_enc : null;
    if (authMode === 'credentials' && password) passwordEnc = trunkCredentialCrypto.encrypt(password);
    if (authMode === 'credentials' && !passwordEnc) {
        return res.status(400).send('Enter a SIP password for this trunk.');
    }
    await pool.query(
        `UPDATE trunks SET name=$1, sip_server=$2, transport=$3, codec=$4, max_calls=$5,
            is_active=$6, caller_id=$7, auth_mode=$8, sip_username=$9, sip_password_enc=$10
         WHERE id=$11 AND tenant_id=$12`,
        [b.name, b.sip_server, b.transport, b.codec || null, b.max_calls || null,
         b.is_active === '1', (b.caller_id || '').trim().slice(0, 80) || null,
         authMode, authMode === 'credentials' ? username : null, passwordEnc, req.params.id, t]
    );
    const safeAudit = { ...b };
    delete safeAudit.sip_password;
    await writeAuditLog(t, req.session.user.id, 'TRUNK_UPDATED', 'trunk', req.params.id, null, safeAudit);

    const redirectUrl = '/admin/trunks' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : '');

    // Reconcile active trunks with Wazo after saving their settings.
    // Deactivation intentionally does not delete existing Wazo resources.
    if (b.is_active === '1') {
        let result;
        try {
            result = await wazoTrunkProvisioning.provisionTrunk(t, req.params.id);
        } catch (error) {
            result = { ok: false, error: String(error.message || error) };
            await pool.query(
                `UPDATE trunks SET provisioning_status = 'failed',
                        provisioning_error = $1
                  WHERE id = $2 AND tenant_id = $3`,
                [result.error.slice(0, 2000), req.params.id, t]
            ).catch(dbErr => console.error('Could not save trunk provisioning error:', dbErr.message));
        }

        await writeAuditLog(
            t, req.session.user.id,
            result && result.ok ? 'TRUNK_PROVISIONED' : 'TRUNK_PROVISION_FAILED',
            'trunk', req.params.id, null,
            { ok: Boolean(result && result.ok), error: result && result.error || null }
        );
    }

    res.redirect(redirectUrl);
});

router.post('/trunks/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM trunks WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'TRUNK_DELETED', 'trunk', req.params.id);
        res.redirect('/admin/trunks' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This trunk'));
    }
});


// ---------------- Outbound Prefixes ----------------
// PREFIX_SCOPE_PATCH_V1
// ---------------- Outbound Prefixes ----------------
router.get('/prefixes', async (req, res) => {
    const t = req.effectiveTenant.id;
    const [prefixResult, trunkResult, groupResult, agentResult, campaignResult] =
        await Promise.all([
            pool.query(
                `SELECT p.*,
                        tr.name AS trunk_name,
                        COALESCE(
                          string_agg(
                            tr2.name || ' (p' || pt.priority || ')',
                            ', ' ORDER BY pt.priority
                          ),
                          tr.name,
                          'Not selected'
                        ) AS trunk_names
                   FROM prefixes p
                   LEFT JOIN trunks tr
                     ON tr.id = p.trunk_id AND tr.tenant_id = p.tenant_id
                   LEFT JOIN prefix_trunks pt
                     ON pt.tenant_id = p.tenant_id AND pt.prefix_id = p.id
                    AND pt.is_active = TRUE
                   LEFT JOIN trunks tr2
                     ON tr2.id = pt.trunk_id AND tr2.tenant_id = pt.tenant_id
                  WHERE p.tenant_id = $1
                  GROUP BY p.id, tr.name
                  ORDER BY p.priority DESC, p.prefix_digits`,
                [t]
            ),
            pool.query(
                `SELECT id, name, sip_server, is_active, provisioning_status
                   FROM trunks WHERE tenant_id = $1 ORDER BY name`,
                [t]
            ),
            pool.query(
                `SELECT id, name FROM user_groups
                  WHERE tenant_id = $1 AND is_active = TRUE ORDER BY name`,
                [t]
            ),
            pool.query(
                `SELECT a.id, u.full_name, a.extension
                   FROM agents a
                   LEFT JOIN users u ON u.id = a.user_id
                  WHERE a.tenant_id = $1 AND a.is_active = TRUE
                  ORDER BY u.full_name, a.extension`,
                [t]
            ),
            pool.query(
                `SELECT id, name FROM campaigns
                  WHERE tenant_id = $1 ORDER BY name`,
                [t]
            )
        ]);

    res.render('admin/prefixes', {
        pageTitle: 'Admin — Outbound Prefixes',
        prefixes: prefixResult.rows,
        trunks: trunkResult.rows,
        userGroups: groupResult.rows,
        agents: agentResult.rows,
        campaigns: campaignResult.rows
    });
});

router.post('/prefixes/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const digits = String(b.prefix_digits || '').trim();
    const strip = Number(b.strip_digits || 0);
    const priority = Number(b.priority || 0);
    const prepend = String(b.prepend_digits || '').trim();
    const routeName = String(b.route_name || '').trim() || null;

    const scopeType = String(b.scope_type || 'tenant');
    const agentId = String(b.agent_id || '').trim() || null;
    const groupId = String(b.user_group_id || '').trim() || null;
    const campaignId = String(b.campaign_id || '').trim() || null;

    // Backup slots are positional: slot 1 is first failover, etc.
    const backupRaw = [
        b.backup_trunk_1,
        b.backup_trunk_2,
        b.backup_trunk_3
    ].map(v => String(v || '').trim()).filter(Boolean);
    const primaryTrunkId = String(b.primary_trunk_id || '').trim() || null;
    const orderedTrunkIds = [
        primaryTrunkId,
        ...backupRaw
    ].filter(Boolean);

    if (!/^[0-9*#+]+$/.test(digits) || digits.length > 32) {
        return res.status(400).send('Prefix must contain only digits, *, #, or + (max 32 characters).');
    }
    if (!Number.isInteger(strip) || strip < 0 || strip > digits.length) {
        return res.status(400).send('Strip digits must be between 0 and the prefix length.');
    }
    if (!/^[0-9*#+]*$/.test(prepend) || prepend.length > 32) {
        return res.status(400).send('Prepend digits may contain only digits, *, #, or + (max 32 characters).');
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
        return res.status(400).send('Priority must be a whole number between 0 and 100000.');
    }
    if (new Set(orderedTrunkIds).size !== orderedTrunkIds.length) {
        return res.status(400).send('Choose each trunk only once.');
    }
    if (scopeType === 'agent' && (!agentId || groupId || campaignId)) {
        return res.status(400).send('Select exactly one agent scope.');
    }
    if (scopeType === 'group' && (!groupId || agentId || campaignId)) {
        return res.status(400).send('Select exactly one user-group scope.');
    }
    if (scopeType === 'campaign' && (!campaignId || agentId || groupId)) {
        return res.status(400).send('Select exactly one campaign scope.');
    }
    if (scopeType === 'tenant' && (agentId || groupId || campaignId)) {
        return res.status(400).send('Tenant-wide scope cannot have a narrower target.');
    }
    if (!['tenant', 'agent', 'group', 'campaign'].includes(scopeType)) {
        return res.status(400).send('Invalid prefix scope.');
    }
    if (!orderedTrunkIds.length) {
        return res.status(400).send('Select a primary trunk.');
    }

    const scopeChecks = {
        agent: ['SELECT id FROM agents WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE', agentId],
        group: ['SELECT id FROM user_groups WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE', groupId],
        campaign: ['SELECT id FROM campaigns WHERE id=$1 AND tenant_id=$2', campaignId]
    };

    if (scopeType !== 'tenant') {
        const [sql, targetId] = scopeChecks[scopeType];
        const check = await pool.query(sql, [targetId, t]);
        if (!check.rowCount) {
            return res.status(400).send('Selected scope target was not found in this tenant or is inactive.');
        }
    }

    const trunkCheck = await pool.query(
        `SELECT id, is_active, provisioning_status
           FROM trunks
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [t, orderedTrunkIds]
    );
    if (trunkCheck.rowCount !== orderedTrunkIds.length) {
        return res.status(400).send('One or more selected trunks do not belong to this tenant.');
    }
    if (trunkCheck.rows.some(x => x.is_active !== true || x.provisioning_status !== 'provisioned')) {
        return res.status(400).send('Every selected trunk must be active and provisioned.');
    }

    // Campaign prefixes can be configured but are not activatable yet.
    const client = await pool.connect();
    let prefixId;
    try {
        await client.query('BEGIN');

        const inserted = await client.query(
            `INSERT INTO prefixes
                (tenant_id, trunk_id, prefix_digits, route_name, strip_digits,
                 prepend_digits, priority, is_active, agent_id, user_group_id, campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8,$9,$10)
             RETURNING id`,
            [
                t, primaryTrunkId, digits, routeName, strip,
                prepend || null, priority,
                scopeType === 'agent' ? agentId : null,
                scopeType === 'group' ? groupId : null,
                scopeType === 'campaign' ? campaignId : null
            ]
        );
        prefixId = inserted.rows[0].id;

        for (let i = 0; i < orderedTrunkIds.length; i++) {
            await client.query(
                `INSERT INTO prefix_trunks
                    (tenant_id, prefix_id, trunk_id, priority, is_active)
                 VALUES ($1,$2,$3,$4,TRUE)`,
                [t, prefixId, orderedTrunkIds[i], i]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    await writeAuditLog(t, req.session.user.id, 'PREFIX_CREATED', 'prefix',
        prefixId, null, {
            prefix_digits: digits, route_name: routeName,
            strip_digits: strip, prepend_digits: prepend,
            priority, trunk_ids: orderedTrunkIds,
            scope_type: scopeType, is_active: false
        });

    res.redirect('/admin/prefixes' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : ''));
});

router.post('/prefixes/:id/activate', async (req, res) => {
    const t = req.effectiveTenant.id;
    const result = await pool.query(
        `SELECT p.id, p.prefix_digits, p.trunk_id, p.agent_id, p.user_group_id,
                p.campaign_id, p.is_active, tr.name AS trunk_name
           FROM prefixes p
           LEFT JOIN trunks tr
             ON tr.id = p.trunk_id AND tr.tenant_id = p.tenant_id
          WHERE p.id = $1 AND p.tenant_id = $2`,
        [req.params.id, t]
    );

    if (!result.rowCount) {
        return res.status(404).send('Prefix not found in this tenant.');
    }

    const prefix = result.rows[0];

    if (prefix.is_active) {
        return res.status(409).send('Prefix is already active.');
    }

    if (prefix.campaign_id) {
        return res.status(409).send(
            'Campaign-scoped routing is configured but activation is blocked until campaign-specific runtime routing is implemented.'
        );
    }

    // Reject same-digit routes whose scopes overlap.
    // This is a safety guard, not a substitute for a runtime precedence resolver.
    const conflicts = await pool.query(
        `SELECT p.id, p.prefix_digits
           FROM prefixes p
          WHERE p.tenant_id = $1
            AND p.id <> $2
            AND p.is_active = TRUE
            AND p.prefix_digits = $3
            AND (
              -- Existing tenant-wide or unsupported campaign route.
              (p.agent_id IS NULL AND p.user_group_id IS NULL
               AND p.campaign_id IS NULL)
              OR p.campaign_id IS NOT NULL

              -- Candidate is tenant-wide: it overlaps every existing scope.
              OR ($4::uuid IS NULL AND $5::uuid IS NULL)

              -- Candidate is agent-specific.
              OR (
                $4::uuid IS NOT NULL
                AND (
                  p.agent_id = $4
                  OR EXISTS (
                    SELECT 1
                      FROM user_group_agents uga
                     WHERE uga.tenant_id = $1
                       AND uga.group_id = p.user_group_id
                       AND uga.agent_id = $4
                  )
                )
              )

              -- Candidate is group-specific.
              OR (
                $5::uuid IS NOT NULL
                AND (
                  EXISTS (
                    SELECT 1
                      FROM user_group_agents uga
                     WHERE uga.tenant_id = $1
                       AND uga.group_id = $5
                       AND uga.agent_id = p.agent_id
                  )
                  OR EXISTS (
                    SELECT 1
                      FROM user_group_agents candidate_member
                      JOIN user_group_agents existing_member
                        ON existing_member.tenant_id = candidate_member.tenant_id
                       AND existing_member.agent_id = candidate_member.agent_id
                     WHERE candidate_member.tenant_id = $1
                       AND candidate_member.group_id = $5
                       AND existing_member.group_id = p.user_group_id
                  )
                )
              )
            )
          LIMIT 1`,
        [t, prefix.id, prefix.prefix_digits, prefix.agent_id, prefix.user_group_id]
    );

    if (conflicts.rowCount) {
        return res.status(409).send(
            'An active prefix with the same digits overlaps this scope. ' +
            'Deactivate or resolve the conflicting route first.'
        );
    }

    try {
        await provisionPrefixOutboundRoute(prefix.id, t);

        await setPrefixOutboundRouteEnabled(prefix.id, t, true);
    } catch (error) {
        console.error('[prefix activation] Wazo provisioning/activation failed:', error.message);

        await pool.query(
            `UPDATE prefixes
                SET is_active = FALSE,
                    provisioning_status = 'failed',
                    provisioning_error = $3
              WHERE id = $1 AND tenant_id = $2`,
            [prefix.id, t, String(error.message || error).slice(0, 1500)]
        );

        return res.status(502).send(
            'Wazo outbound routing could not be configured and enabled: ' + error.message
        );
    }

    const activated = await pool.query(
        `UPDATE prefixes
            SET is_active = TRUE,
                provisioning_status = 'provisioned',
                provisioning_error = NULL,
                last_provisioned_at = NOW()
          WHERE id = $1
            AND tenant_id = $2
            AND is_active = FALSE
        RETURNING id`,
        [prefix.id, t]
    );

    if (!activated.rowCount) {
        try {
            await setPrefixOutboundRouteEnabled(prefix.id, t, false);
        } catch (disableError) {
            console.error(
                '[prefix activation] Could not disable outcall after DB activation failure:',
                disableError.message
            );
        }

        return res.status(409).send(
            'Prefix state changed during activation. The route was not marked active.'
        );
    }

    await writeAuditLog(t, req.session.user.id, 'PREFIX_ACTIVATED',
        'prefix', prefix.id, null, {
            prefix_digits: prefix.prefix_digits,
            trunk_id: prefix.trunk_id,
            is_active: true
        }
    );

    res.redirect('/admin/prefixes' +
        (req.query.as_tenant
            ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant)
            : ''));
});

router.post('/prefixes/:id/deactivate', async (req, res) => {
    const t = req.effectiveTenant.id;

    const found = await pool.query(
        `SELECT id, prefix_digits, wazo_outcall_id,
                wazo_pattern_extension_id, provisioning_status
           FROM prefixes
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, t]
    );

    if (!found.rowCount) {
        return res.status(404).send('Prefix not found in this tenant.');
    }

    const prefix = found.rows[0];

    // Only touch Wazo when this prefix has a dedicated pattern extension.
    // Legacy routes without one are left untouched in Wazo.
    if (prefix.wazo_outcall_id && prefix.wazo_pattern_extension_id) {
        try {
            await setPrefixOutboundRouteEnabled(prefix.id, t, false);
        } catch (error) {
            console.error('[prefix deactivation] Wazo disable failed:', error.message);
            return res.status(502).send(
                'Could not safely disable the Wazo route; the prefix remains unchanged: ' +
                error.message
            );
        }
    }

    const result = await pool.query(
        `UPDATE prefixes
            SET is_active = FALSE
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, prefix_digits`,
        [prefix.id, t]
    );

    if (!result.rowCount) {
        return res.status(404).send('Prefix not found in this tenant.');
    }

    await writeAuditLog(t, req.session.user.id, 'PREFIX_DEACTIVATED', 'prefix',
        result.rows[0].id, null, { prefix_digits: result.rows[0].prefix_digits });

    res.redirect('/admin/prefixes' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : ''));
});


// ---------------- DIDs ----------------
const DID_DESTINATIONS = new Set(['queue', 'ivr', 'agent', 'extension']);

async function validateDidTarget(t, b) {
    const type = b.destination_type || 'queue';
    if (!DID_DESTINATIONS.has(type)) throw new Error('Invalid DID destination type.');

    const fields = {
        queue: ['default_queue_id', 'queues'],
        ivr: ['default_ivr_id', 'ivr_menus'],
        agent: ['default_agent_id', 'agents'],
        extension: ['default_extension', null]
    };
    const [field, table] = fields[type];
    const target = (b[field] || '').trim();
    if (!target) throw new Error('Select a destination for this DID.');

    if (table) {
        const check = await pool.query(
            `SELECT id FROM ${table} WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
            [target, t]
        );
        if (!check.rows.length) throw new Error('Destination not found, inactive, or outside this tenant.');
    } else {
        const check = await pool.query(
            `SELECT id FROM agents WHERE tenant_id = $1 AND extension = $2 AND is_active = true
             UNION ALL
             SELECT id FROM dids WHERE tenant_id = $1 AND did_number = $2 AND is_active = true
             LIMIT 1`,
            [t, target]
        );
        if (!check.rows.length) throw new Error('Extension must belong to an active agent or DID in this tenant.');
    }

    if (b.campaign_id) {
        const c = await pool.query(
            'SELECT id FROM campaigns WHERE id = $1 AND tenant_id = $2',
            [b.campaign_id, t]
        );
        if (!c.rows.length) throw new Error('Campaign does not belong to this tenant.');
    }

    return {
        type,
        queue: type === 'queue' ? target : null,
        ivr: type === 'ivr' ? target : null,
        agent: type === 'agent' ? target : null,
        extension: type === 'extension' ? target : null
    };
}

router.get('/dids', async (req, res) => {
    const t = req.effectiveTenant.id;
    const dids = (await pool.query(
        `SELECT d.*, q.name AS queue_name, c.name AS campaign_name,
                i.name AS ivr_name, ag.extension AS agent_extension
         FROM dids d
         LEFT JOIN queues q ON q.id = d.default_queue_id AND q.tenant_id = d.tenant_id
         LEFT JOIN campaigns c ON c.id = d.campaign_id AND c.tenant_id = d.tenant_id
         LEFT JOIN ivr_menus i ON i.id = d.default_ivr_id AND i.tenant_id = d.tenant_id
         LEFT JOIN agents ag ON ag.id = d.default_agent_id AND ag.tenant_id = d.tenant_id
         WHERE d.tenant_id = $1 ORDER BY d.did_number`, [t]
    )).rows;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id=$1 AND is_active=true ORDER BY name', [t])).rows;
    const ivrs = (await pool.query('SELECT id, name FROM ivr_menus WHERE tenant_id=$1 AND is_active=true ORDER BY name', [t])).rows;
    const agents = (await pool.query('SELECT id, extension, agent_number FROM agents WHERE tenant_id=$1 AND is_active=true AND extension IS NOT NULL ORDER BY extension', [t])).rows;
    const campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id=$1 ORDER BY name', [t])).rows;
    const extensions = (await pool.query(
        `SELECT extension AS value, extension AS label FROM agents WHERE tenant_id=$1 AND is_active=true AND extension IS NOT NULL
         UNION SELECT did_number AS value, did_number AS label FROM dids WHERE tenant_id=$1 AND is_active=true
         ORDER BY label`, [t]
    )).rows;
    res.render('admin/dids', {
        pageTitle: 'Admin — DIDs', dids, queues, ivrs, agents, campaigns, extensions,
        editId: req.query.edit || null
    });
});

router.post('/dids/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    try {
        const d = await validateDidTarget(t, b);
        const saved = await pool.query(
            `INSERT INTO dids
             (tenant_id,did_number,description,destination_type,default_queue_id,default_ivr_id,default_agent_id,default_extension,campaign_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id`,
            [t, b.did_number.trim(), b.description || null, d.type, d.queue, d.ivr, d.agent, d.extension, b.campaign_id || null]
        );
        try {
            const result = await provisionInboundDid(saved.rows[0].id, t);
            console.log('[DID inbound provisioning]', result);
        } catch (error) {
            console.error('[DID inbound provisioning failed]', {
                didId: saved.rows[0].id,
                tenantId: t,
                error: String(error.message || error)
            });
        }
        await writeAuditLog(t, req.session.user.id, 'DID_CREATED', 'did', saved.rows[0].id, null, {
            did_number: b.did_number, destination_type: d.type
        });
        res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : ''));
    } catch (e) {
        res.status(400).send('DID was not saved: ' + e.message);
    }
});

router.post('/dids/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    try {
        const d = await validateDidTarget(t, b);
        const result = await pool.query(
            `UPDATE dids SET description=$1,destination_type=$2,default_queue_id=$3,default_ivr_id=$4,
             default_agent_id=$5,default_extension=$6,campaign_id=$7,is_active=$8
             WHERE id=$9 AND tenant_id=$10`,
            [b.description || null, d.type, d.queue, d.ivr, d.agent, d.extension,
             b.campaign_id || null, b.is_active === '1', req.params.id, t]
        );
        if (!result.rowCount) return res.status(404).send('DID not found in this tenant.');
        try {
            const provisionResult = await provisionInboundDid(req.params.id, t);
            console.log('[DID inbound provisioning]', provisionResult);
        } catch (error) {
            console.error('[DID inbound provisioning failed]', {
                didId: req.params.id,
                tenantId: t,
                error: String(error.message || error)
            });
        }
        await writeAuditLog(t, req.session.user.id, 'DID_UPDATED', 'did', req.params.id, null, {
            destination_type: d.type
        });
        res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : ''));
    } catch (e) {
        res.status(400).send('DID was not saved: ' + e.message);
    }
});

router.post('/dids/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM dids WHERE id=$1 AND tenant_id=$2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'DID_DELETED', 'did', req.params.id);
        res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${encodeURIComponent(req.query.as_tenant)}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This DID'));
    }
});

// ---------------- Campaigns (incl. robo/voice-blast script builder) ----------------
router.get('/campaigns', async (req, res) => {
    const t = req.effectiveTenant.id;
    const campaigns = (await pool.query('SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC', [t])).rows;
    const trunks = (await pool.query(
        'SELECT id, name, sip_server, caller_id FROM trunks WHERE tenant_id = $1 AND is_active = TRUE ORDER BY name',
        [t]
    )).rows;
    const scriptCampaignId = req.query.script || null;
    let scriptNodes = [];
    if (scriptCampaignId) {
        scriptNodes = (await pool.query('SELECT * FROM campaign_voice_content WHERE campaign_id = $1 ORDER BY step_number', [scriptCampaignId])).rows;
    }
    res.render('admin/campaigns', { pageTitle: 'Admin — Campaigns', campaigns, trunks, scriptCampaignId, scriptNodes, editId: req.query.edit || null });
});

router.post('/campaigns/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const callerId = String(b.caller_id || '').trim();
    const trunkId = String(b.trunk_id || '').trim() || null;

    if (callerId && (callerId.length > 30 || !/^[+0-9*#]+$/.test(callerId))) {
        return res.status(400).send('Campaign CLI must be up to 30 characters and contain only digits, +, * or #.');
    }
    if (trunkId) {
        const tr = await pool.query(
            'SELECT id FROM trunks WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE',
            [trunkId, t]
        );
        if (!tr.rowCount) return res.status(400).send('Selected trunk is invalid or inactive for this tenant.');
    }

    const isRobo = ['robo_survey', 'voice_blast'].includes(b.dialing_mode);
    const result = await pool.query(
        `INSERT INTO campaigns
            (tenant_id, name, channel, dialing_mode, dial_level, is_robo_campaign,
             max_concurrent_robo_calls, answering_machine_detection, start_date, end_date,
             caller_id, trunk_id)
         VALUES ($1,$2,'voice',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [t, b.name, b.dialing_mode, b.dial_level || 1.0, isRobo,
         b.max_concurrent_robo_calls || null, !!b.amd, b.start_date || null, b.end_date || null,
         callerId || null, trunkId]
    );
    const campaignId = result.rows[0].id;
    await writeAuditLog(t, req.session.user.id, 'CAMPAIGN_CREATED', 'campaign', campaignId, null, b);
    res.redirect(`/admin/campaigns?script=${campaignId}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/campaigns/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const callerId = String(b.caller_id || '').trim();
    const trunkId = String(b.trunk_id || '').trim() || null;

    if (callerId && (callerId.length > 30 || !/^[+0-9*#]+$/.test(callerId))) {
        return res.status(400).send('Campaign CLI must be up to 30 characters and contain only digits, +, * or #.');
    }
    if (trunkId) {
        const tr = await pool.query(
            'SELECT id FROM trunks WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE',
            [trunkId, t]
        );
        if (!tr.rowCount) return res.status(400).send('Selected trunk is invalid or inactive for this tenant.');
    }

    await pool.query(
        `UPDATE campaigns SET name = $1, dial_level = $2, max_concurrent_robo_calls = $3,
            answering_machine_detection = $4, start_date = $5, end_date = $6, is_active = $7,
            caller_id = $8, trunk_id = $9
         WHERE id = $10 AND tenant_id = $11`,
        [b.name, b.dial_level || 1.0, b.max_concurrent_robo_calls || null, !!b.amd,
         b.start_date || null, b.end_date || null, b.is_active === '1',
         callerId || null, trunkId, req.params.id, t]
    );
    await writeAuditLog(t, req.session.user.id, 'CAMPAIGN_UPDATED', 'campaign', req.params.id, null, b);
    res.redirect('/admin/campaigns' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/campaigns/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        // Voice-blast/survey script nodes belong entirely to this
        // campaign and carry no independent reporting value once the
        // campaign is gone -- safe to cascade those specifically.
        await pool.query('DELETE FROM campaign_voice_content WHERE campaign_id = $1 AND tenant_id = $2', [req.params.id, t]);
        await pool.query('DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'CAMPAIGN_DELETED', 'campaign', req.params.id);
        res.redirect('/admin/campaigns' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This campaign'));
    }
});

router.post('/campaigns/add-voice-node', (req, res, next) => {
    audioUpload.single('audio_upload')(req, res, (err) => {
        if (err) return res.status(400).send('Audio upload failed: ' + err.message);
        next();
    });
}, async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const stepRes = await pool.query('SELECT COALESCE(MAX(step_number),0)+1 AS n FROM campaign_voice_content WHERE campaign_id = $1', [b.campaign_id]);
    const step = stepRes.rows[0].n;

    // A real uploaded file always wins over a typed-in path -- the
    // upload writes to public/uploads/audio/<random>.<ext> and we store
    // the web-servable path so it can also be played back for review.
    const audioPath = req.file ? `/uploads/audio/${req.file.filename}` : (b.content_type === 'audio_file' ? b.audio_file_path : null);

    await pool.query(
        `INSERT INTO campaign_voice_content
            (tenant_id, campaign_id, step_number, node_name, content_type,
             audio_file_path, tts_text, tts_voice, tts_language, tts_speed,
             expects_response, response_type, valid_dtmf_options, max_response_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [t, b.campaign_id, step, b.node_name, b.content_type,
         audioPath,
         b.content_type === 'tts' ? b.tts_text : null,
         b.tts_voice || null, b.tts_language || 'en-US', b.tts_speed || 1.0,
         !!b.expects_response, b.response_type || null, b.valid_dtmf_options || null, b.max_response_seconds || 5]
    );
    res.redirect(`/admin/campaigns?script=${b.campaign_id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Lead upload (CSV) for auto-dial campaigns ----------------
router.get('/campaigns/:id/leads', async (req, res) => {
    const t = req.effectiveTenant.id;
    const campaignRes = await pool.query('SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
    const campaign = campaignRes.rows[0];
    if (!campaign) return res.status(404).send('Campaign not found');

    const leads = (await pool.query(
        `SELECT id, phone_number, status, priority, created_at FROM leads
         WHERE tenant_id = $1 AND campaign_id = $2 ORDER BY created_at DESC LIMIT 500`,
        [t, req.params.id]
    )).rows;
    const counts = (await pool.query(
        `SELECT status, COUNT(*) AS n FROM leads WHERE tenant_id = $1 AND campaign_id = $2 GROUP BY status`,
        [t, req.params.id]
    )).rows;

    res.render('admin/campaign_leads', { pageTitle: `Leads — ${campaign.name}`, campaign, leads, counts, importResult: req.query.imported ? JSON.parse(Buffer.from(req.query.imported, 'base64').toString()) : null });
});

router.post('/campaigns/:id/leads/upload', (req, res, next) => {
    leadsUpload.single('leads_csv')(req, res, (err) => {
        if (err) return res.status(400).send('CSV upload failed: ' + err.message);
        next();
    });
}, async (req, res) => {
    const t = req.effectiveTenant.id;
    const campaignId = req.params.id;
    if (!req.file) return res.status(400).send('No CSV file uploaded.');

    const raw = fs.readFileSync(req.file.path, 'utf8');
    fs.unlink(req.file.path, () => {}); // temp file no longer needed once parsed

    let records;
    try {
        records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
        return res.status(400).send('Could not parse CSV: ' + e.message);
    }

    // Accept a flexible set of header names for the phone column, since
    // exports from different CRMs/spreadsheets vary.
    const phoneKeys = ['phone', 'phone_number', 'mobile', 'number', 'contact_number'];
    const nameKeys = ['name', 'full_name', 'customer_name'];

    let imported = 0, duplicates = 0, invalid = 0;
    const seenThisFile = new Set();

    // Existing numbers already on this campaign, to skip true duplicates
    // rather than re-inserting the same lead twice.
    const existingRes = await pool.query('SELECT phone_number FROM leads WHERE tenant_id = $1 AND campaign_id = $2', [t, campaignId]);
    const existing = new Set(existingRes.rows.map((r) => r.phone_number));

    for (const row of records) {
        const lowerRow = {};
        for (const k of Object.keys(row)) lowerRow[k.toLowerCase().trim()] = row[k];

        let phone = null;
        for (const k of phoneKeys) { if (lowerRow[k]) { phone = String(lowerRow[k]).trim(); break; } }
        let name = null;
        for (const k of nameKeys) { if (lowerRow[k]) { name = String(lowerRow[k]).trim(); break; } }

        const digitsOnly = (phone || '').replace(/[^\d+]/g, '');
        if (!digitsOnly || digitsOnly.replace('+', '').length < 6) { invalid++; continue; }
        if (existing.has(digitsOnly) || seenThisFile.has(digitsOnly)) { duplicates++; continue; }
        seenThisFile.add(digitsOnly);

        const customFields = { ...lowerRow };
        delete customFields.phone; delete customFields.phone_number; delete customFields.mobile;
        delete customFields.number; delete customFields.contact_number; delete customFields.name;
        delete customFields.full_name; delete customFields.customer_name;

        await pool.query(
            `INSERT INTO leads (tenant_id, campaign_id, phone_number, status, custom_fields)
             VALUES ($1,$2,$3,'new',$4)`,
            [t, campaignId, digitsOnly, JSON.stringify(name ? { name, ...customFields } : customFields)]
        );
        imported++;
    }

    await writeAuditLog(t, req.session.user.id, 'LEADS_IMPORTED', 'campaign', campaignId, null, { imported, duplicates, invalid });

    const summary = Buffer.from(JSON.stringify({ imported, duplicates, invalid })).toString('base64');
    res.redirect(`/admin/campaigns/${campaignId}/leads?imported=${summary}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Caller ID / CLI Settings ----------------
router.get('/cli-settings', async (req, res) => {
    const t = req.effectiveTenant.id;

    const [settingsResult, agentsResult] = await Promise.all([
        pool.query(
            'SELECT default_caller_id, custom_caller_id_enabled FROM tenants WHERE id = $1',
            [t]
        ),
        pool.query(
            `SELECT ag.id AS agent_id, ag.extension, ag.caller_id,
                    ag.custom_caller_id_name,
                    u.full_name, u.username, u.email
             FROM agents ag
             JOIN users u ON u.id = ag.user_id AND u.tenant_id = ag.tenant_id
             WHERE ag.tenant_id = $1
             ORDER BY u.full_name, ag.extension`,
            [t]
        )
    ]);

    if (!settingsResult.rowCount) return res.status(404).send('Tenant not found.');

    res.render('admin/cli_settings', {
        pageTitle: 'Admin — Custom Caller ID',
        settings: settingsResult.rows[0],
        agents: agentsResult.rows,
        currentTenantId: t
    });
});

router.post('/cli-settings', async (req, res) => {
    const t = req.effectiveTenant.id;
    const raw = String(req.body.default_caller_id || '').trim();

    if (raw && (raw.length > 30 || !/^[+0-9*#]+$/.test(raw))) {
        return res.status(400).send(
            'CLI must be up to 30 characters and contain only digits, +, * or #.'
        );
    }

    const value = raw || null;
    await pool.query(
        'UPDATE tenants SET default_caller_id = $1 WHERE id = $2',
        [value, t]
    );
    await writeAuditLog(t, req.session.user.id, 'TENANT_DEFAULT_CLI_UPDATED',
        'tenant', t, null, { default_caller_id: value });

    res.redirect('/admin/cli-settings' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : ''));
});

router.post('/cli-settings/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;
    const enabled = req.body.enabled === '1';

    await pool.query(
        'UPDATE tenants SET custom_caller_id_enabled = $1 WHERE id = $2',
        [enabled, t]
    );
    await writeAuditLog(t, req.session.user.id, 'CUSTOM_CALLER_ID_TOGGLED',
        'tenant', t, null, { enabled });

    res.redirect('/admin/cli-settings' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : ''));
});

router.post('/cli-settings/agents/:id', async (req, res) => {
    const t = req.effectiveTenant.id;
    const agentId = req.params.id;
    const name = String(req.body.custom_caller_id_name || '').trim();
    const number = String(req.body.caller_id || '').trim();

    if (name.length > 80) {
        return res.status(400).send('Caller ID name must be 80 characters or fewer.');
    }
    if (number && (number.length > 30 || !/^[+0-9*#]+$/.test(number))) {
        return res.status(400).send(
            'Caller ID number must be up to 30 characters and contain only digits, +, * or #.'
        );
    }

    const updated = await pool.query(
        `UPDATE agents
         SET custom_caller_id_name = $1,
             caller_id = $2
         WHERE id = $3 AND tenant_id = $4
         RETURNING id`,
        [name || null, number || null, agentId, t]
    );

    if (!updated.rowCount) return res.status(404).send('Agent not found for this tenant.');

    await writeAuditLog(t, req.session.user.id, 'AGENT_CUSTOM_CALLER_ID_UPDATED',
        'agent', agentId, null, {
            custom_caller_id_name: name || null,
            caller_id: number || null
        });

    res.redirect('/admin/cli-settings' +
        (req.query.as_tenant ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant) : ''));
});

// ---------------- Privacy & Number Masking ----------------
router.get('/privacy-settings', async (req, res) => {
    const t = req.effectiveTenant.id;
    const settings = (await pool.query('SELECT mask_number_for_agents, mask_number_for_supervisors FROM tenants WHERE id = $1', [t])).rows[0];
    res.render('admin/privacy_settings', { pageTitle: 'Admin — Privacy & Number Masking', settings });
});

router.post('/privacy-settings/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;
    const field = req.body.field === 'agents' ? 'mask_number_for_agents' : 'mask_number_for_supervisors';
    const newValue = req.body.enabled === '1';
    await pool.query(`UPDATE tenants SET ${field} = $1 WHERE id = $2`, [newValue, t]);
    phoneMasker.invalidateCache(t);
    await writeAuditLog(t, req.session.user.id, 'NUMBER_MASKING_CHANGED', 'tenant', t, null, { [field]: newValue });
    res.redirect('/admin/privacy-settings' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- IVR Menus ----------------
router.get('/ivr', async (req, res) => {
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

router.post('/ivr/create', async (req, res) => {
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

router.post('/ivr/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE ivr_menus SET name = $1, greeting_type = $2, greeting_text = $3, invalid_retry_limit = $4, timeout_seconds = $5, is_active = $6
         WHERE id = $7 AND tenant_id = $8`,
        [b.name, b.greeting_type, b.greeting_text || null, b.invalid_retry_limit || 3, b.timeout_seconds || 5, b.is_active === '1', req.params.id, t]
    );
    res.redirect(`/admin/ivr?edit=${req.params.id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/ivr/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM ivr_menus WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'IVR_MENU_DELETED', 'ivr_menu', req.params.id);
        res.redirect('/admin/ivr' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This IVR menu'));
    }
});

router.post('/ivr/:id/options/create', async (req, res) => {
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

router.post('/ivr/:id/options/:optionId/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    await pool.query('DELETE FROM ivr_menu_options WHERE id = $1 AND tenant_id = $2', [req.params.optionId, t]);
    res.redirect(`/admin/ivr?edit=${req.params.id}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Omnichannel Webchat Widget + Chatbot ----------------
const crypto2 = require('crypto');
router.get('/chat-widget', async (req, res) => {
    const t = req.effectiveTenant.id;
    const widget = (await pool.query('SELECT * FROM chat_widget_configs WHERE tenant_id = $1', [t])).rows[0] || null;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const rules = (await pool.query('SELECT * FROM chatbot_rules WHERE tenant_id = $1 ORDER BY priority DESC', [t])).rows;
    res.render('admin/chat_widget', { pageTitle: 'Admin — Webchat & Chatbot', widget, queues, rules });
});

router.post('/chat-widget/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const publicKey = crypto2.randomBytes(16).toString('hex');
    await pool.query(
        `INSERT INTO chat_widget_configs (tenant_id, public_key, welcome_message, default_queue_id, bot_enabled, bot_fallback_message)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t, publicKey, b.welcome_message || 'Hi! How can we help you today?', b.default_queue_id || null, !!b.bot_enabled, b.bot_fallback_message || 'Let me connect you with an agent.']
    );
    res.redirect('/admin/chat-widget' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/chat-widget/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE chat_widget_configs SET welcome_message = $1, default_queue_id = $2, bot_enabled = $3, bot_fallback_message = $4, is_active = $5
         WHERE id = $6 AND tenant_id = $7`,
        [b.welcome_message, b.default_queue_id || null, !!b.bot_enabled, b.bot_fallback_message, b.is_active === '1', req.params.id, t]
    );
    res.redirect('/admin/chat-widget' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/chat-widget/rules/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `INSERT INTO chatbot_rules (tenant_id, trigger_keywords, response_text, priority) VALUES ($1,$2,$3,$4)`,
        [t, b.trigger_keywords, b.response_text, b.priority || 0]
    );
    res.redirect('/admin/chat-widget' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/chat-widget/rules/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    await pool.query('DELETE FROM chatbot_rules WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
    res.redirect('/admin/chat-widget' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Mattermost Bridge ----------------
router.get('/mattermost', async (req, res) => {
    const t = req.effectiveTenant.id;
    const integration = (await pool.query('SELECT * FROM mattermost_integrations WHERE tenant_id = $1', [t])).rows[0] || null;
    res.render('admin/mattermost', { pageTitle: 'Admin — Mattermost Bridge', integration });
});

router.post('/mattermost/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const secret = crypto2.randomBytes(16).toString('hex');
    await pool.query(
        `INSERT INTO mattermost_integrations (tenant_id, incoming_webhook_url, reply_shared_secret) VALUES ($1,$2,$3)`,
        [t, b.incoming_webhook_url, secret]
    );
    res.redirect('/admin/mattermost' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- CRM Integration ----------------
router.get('/crm-integration', async (req, res) => {
    const t = req.effectiveTenant.id;
    const integrations = (await pool.query('SELECT * FROM crm_integrations WHERE tenant_id = $1 ORDER BY created_at DESC', [t])).rows;
    res.render('admin/crm_integration', { pageTitle: 'Admin — CRM Integration', integrations });
});

router.post('/crm-integration/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `INSERT INTO crm_integrations
            (tenant_id, name, is_active, popup_enabled, trigger_event, popup_mode, url_template,
             webhook_enabled, webhook_url, webhook_secret, webhook_events)
         VALUES ($1,$2,TRUE,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t, b.name, !!b.popup_enabled, b.trigger_event || 'ringing', b.popup_mode || 'new_tab',
         b.url_template || null, !!b.webhook_enabled, b.webhook_url || null,
         b.webhook_secret || null, b.webhook_events || 'CALL_STARTED,CALL_ANSWERED,CALL_HANGUP']
    );
    await writeAuditLog(t, req.session.user.id, 'CRM_INTEGRATION_CREATED', 'crm_integration', null, null, b);
    res.redirect('/admin/crm-integration' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/crm-integration/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;
    await pool.query('UPDATE crm_integrations SET is_active = $1 WHERE tenant_id = $2 AND id = $3',
        [req.body.enabled === '1', t, req.body.id]);
    res.redirect('/admin/crm-integration' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});


// ---------------- Skill Routing Configuration ----------------
function parseAgentSkills(input) {
    const text = String(input || '').trim();
    if (!text) return [];

    const seen = new Set();
    return text.split(',').map((part) => {
        const pieces = part.trim().split(':');
        if (pieces.length > 2 || !pieces[0].trim()) {
            throw new Error('Use skill:level format, for example sales:3,support:2.');
        }

        const name = pieces[0].trim().toLowerCase();
        const level = pieces.length === 1 ? 1 : Number(pieces[1].trim());

        if (!/^[a-z0-9 _-]{1,60}$/.test(name)) {
            throw new Error('Skill names may contain letters, numbers, spaces, _ and - only.');
        }
        if (seen.has(name)) throw new Error('Duplicate skill: ' + name);
        if (!Number.isInteger(level) || level < 1 || level > 5) {
            throw new Error('Skill proficiency must be a whole number from 1 to 5.');
        }

        seen.add(name);
        return { name, level };
    });
}

function skillRoutingRedirect(req) {
    return '/admin/skill-routing' +
        (req.query.as_tenant
            ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant)
            : '');
}

router.get('/skill-routing', async (req, res) => {
    const t = req.effectiveTenant.id;

    const [queuesResult, agentsResult, membersResult] = await Promise.all([
        pool.query(
            `SELECT q.*,
                    (SELECT COUNT(*)::int FROM queue_agents qa
                      WHERE qa.queue_id = q.id AND qa.is_active = TRUE) AS active_members
               FROM queues q
              WHERE q.tenant_id = $1
              ORDER BY q.name`,
            [t]
        ),
        pool.query(
            `SELECT a.id, a.agent_number, a.extension, a.is_active,
                    a.skills_json, u.full_name, u.username
               FROM agents a
               JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
              WHERE a.tenant_id = $1
              ORDER BY u.full_name NULLS LAST, a.agent_number`,
            [t]
        ),
        pool.query(
            `SELECT qa.queue_id, qa.agent_id, qa.penalty, qa.is_active,
                    q.name AS queue_name, a.agent_number, a.extension,
                    u.full_name, u.username
               FROM queue_agents qa
               JOIN queues q ON q.id = qa.queue_id AND q.tenant_id = $1
               JOIN agents a ON a.id = qa.agent_id AND a.tenant_id = q.tenant_id
               JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
              ORDER BY q.name, u.full_name NULLS LAST, a.agent_number`,
            [t]
        )
    ]);

    const skillsText = (value) => {
        let skills = value;
        if (typeof skills === 'string') {
            try { skills = JSON.parse(skills); } catch (_) { skills = []; }
        }
        if (!Array.isArray(skills)) return '';
        return skills.map((s) => {
            if (typeof s === 'string') return s;
            if (s && typeof s === 'object') {
                const name = s.name || s.skill || '';
                const level = s.level ?? s.proficiency ?? 1;
                return name ? `${name}:${level}` : '';
            }
            return '';
        }).filter(Boolean).join(',');
    };

    res.render('admin/skill_routing', {
        pageTitle: 'Admin — Skill Routing',
        queues: queuesResult.rows,
        agents: agentsResult.rows.map(a => ({ ...a, skills_text: skillsText(a.skills_json) })),
        memberships: membersResult.rows
    });
});

router.post('/skill-routing/agents/:id/skills', async (req, res) => {
    const t = req.effectiveTenant.id;
    let skills;

    try {
        skills = parseAgentSkills(req.body.skills);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    try {
        const result = await pool.query(
            `UPDATE agents
                SET skills_json = $1::jsonb
              WHERE id = $2 AND tenant_id = $3
              RETURNING id`,
            [JSON.stringify(skills), req.params.id, t]
        );

        if (!result.rowCount) return res.status(404).send('Agent not found for this tenant.');

        await writeAuditLog(
            t, req.session.user.id, 'AGENT_SKILLS_UPDATED',
            'agent', req.params.id, null, { skills },
            req.ip || null
        );

        return res.redirect(skillRoutingRedirect(req));
    } catch (error) {
        console.error('Agent skill update failed:', error.message);
        return res.status(500).send('Agent skills could not be saved.');
    }
});

router.post('/skill-routing/queues/:id/members/add', async (req, res) => {
    const t = req.effectiveTenant.id;
    const queueId = req.params.id;
    const agentId = String(req.body.agent_id || '');
    const penalty = Number(req.body.penalty || 0);

    if (!Number.isInteger(penalty) || penalty < 0 || penalty > 1000) {
        return res.status(400).send('Queue penalty must be a whole number from 0 to 1000.');
    }

    try {
        const result = await pool.query(
            `INSERT INTO queue_agents (queue_id, agent_id, penalty, is_active)
             SELECT q.id, a.id, $4, TRUE
               FROM queues q
               JOIN agents a ON a.tenant_id = q.tenant_id
              WHERE q.id = $1 AND q.tenant_id = $2
                AND a.id = $3
             ON CONFLICT (queue_id, agent_id)
             DO UPDATE SET penalty = EXCLUDED.penalty, is_active = TRUE
             RETURNING queue_id, agent_id`,
            [queueId, t, agentId, penalty]
        );

        if (!result.rowCount) {
            return res.status(404).send('Queue or agent not found in the selected tenant.');
        }

        await writeAuditLog(
            t, req.session.user.id, 'QUEUE_AGENT_ADDED',
            'queue_agent', `${queueId}:${agentId}`, null, { penalty },
            req.ip || null
        );

        return res.redirect(skillRoutingRedirect(req));
    } catch (error) {
        console.error('Queue membership add failed:', error.message);
        return res.status(500).send('Queue membership could not be saved.');
    }
});

router.post('/skill-routing/queues/:queueId/members/:agentId/remove', async (req, res) => {
    const t = req.effectiveTenant.id;
    const { queueId, agentId } = req.params;

    try {
        const result = await pool.query(
            `DELETE FROM queue_agents qa
              USING queues q, agents a
              WHERE qa.queue_id = q.id
                AND qa.agent_id = a.id
                AND q.id = $1 AND q.tenant_id = $2
                AND a.id = $3
                AND a.tenant_id = q.tenant_id
              RETURNING qa.queue_id, qa.agent_id`,
            [queueId, t, agentId]
        );

        if (!result.rowCount) return res.status(404).send('Queue membership not found.');

        await writeAuditLog(
            t, req.session.user.id, 'QUEUE_AGENT_REMOVED',
            'queue_agent', `${queueId}:${agentId}`, result.rows[0], null,
            req.ip || null
        );

        return res.redirect(skillRoutingRedirect(req));
    } catch (error) {
        console.error('Queue membership removal failed:', error.message);
        return res.status(500).send('Queue membership could not be removed.');
    }
});




// ---------------- Skills Catalogue ----------------
function skillsRedirect(req) {
    return '/admin/skills' +
        (req.query.as_tenant
            ? '?as_tenant=' + encodeURIComponent(req.query.as_tenant)
            : '');
}

function validateSkillBody(body) {
    const name = String(body.name || '').trim().toLowerCase();
    const description = String(body.description || '').trim();

    if (!/^[a-z0-9][a-z0-9 _-]{0,59}$/.test(name)) {
        throw new Error(
            'Skill name must start with a letter or number and contain only lowercase letters, numbers, spaces, _ or - (maximum 60 characters).'
        );
    }
    if (description.length > 250) {
        throw new Error('Description must be 250 characters or fewer.');
    }
    return { name, description: description || null };
}

router.get('/skills', async (req, res) => {
    const t = req.effectiveTenant.id;
    const result = await pool.query(
        `SELECT id, name, description, is_active, created_at, updated_at
           FROM skills
          WHERE tenant_id = $1
          ORDER BY name`,
        [t]
    );

    res.render('admin/skills', {
        pageTitle: 'Admin — Skills',
        skills: result.rows,
        editId: String(req.query.edit || ''),
        errorMessage: String(req.query.error || '')
    });
});

router.post('/skills/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    let skill;
    try {
        skill = validateSkillBody(req.body);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    try {
        const result = await pool.query(
            `INSERT INTO skills (tenant_id, name, description)
             VALUES ($1, $2, $3)
             RETURNING id, name, description, is_active`,
            [t, skill.name, skill.description]
        );

        await writeAuditLog(
            t, req.session.user.id, 'SKILL_CREATED',
            'skill', result.rows[0].id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(skillsRedirect(req));
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).send('A skill with that name already exists for this tenant.');
        }
        console.error('Skill creation failed:', error.message);
        return res.status(500).send('Skill could not be created.');
    }
});

router.post('/skills/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    let skill;
    try {
        skill = validateSkillBody(req.body);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    try {
        const result = await pool.query(
            `UPDATE skills
                SET name = $1, description = $2, updated_at = NOW()
              WHERE id = $3 AND tenant_id = $4
              RETURNING id, name, description, is_active`,
            [skill.name, skill.description, req.params.id, t]
        );

        if (!result.rowCount) return res.status(404).send('Skill not found for this tenant.');

        await writeAuditLog(
            t, req.session.user.id, 'SKILL_UPDATED',
            'skill', req.params.id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(skillsRedirect(req));
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).send('A skill with that name already exists for this tenant.');
        }
        console.error('Skill update failed:', error.message);
        return res.status(500).send('Skill could not be updated.');
    }
});

router.post('/skills/:id/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;

    try {
        const result = await pool.query(
            `UPDATE skills
                SET is_active = NOT is_active, updated_at = NOW()
              WHERE id = $1 AND tenant_id = $2
              RETURNING id, name, description, is_active`,
            [req.params.id, t]
        );

        if (!result.rowCount) return res.status(404).send('Skill not found for this tenant.');

        await writeAuditLog(
            t, req.session.user.id, 'SKILL_STATUS_CHANGED',
            'skill', req.params.id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(skillsRedirect(req));
    } catch (error) {
        console.error('Skill status change failed:', error.message);
        return res.status(500).send('Skill status could not be changed.');
    }
});



// Tenant-scoped disposition hierarchy management.
const DISPOSITION_CHANNELS = [
    'voice', 'ivr', 'chat', 'email',
    'whatsapp', 'sms', 'social', 'video'
];

function dispositionRedirect(req, extra = '') {
    return '/admin/dispositions' + (extra ? '?' + extra : '');
}

function validateDispositionBody(body) {
    const code = String(body.code || '').trim().toUpperCase();
    const label = String(body.label || '').trim();
    const channel = String(body.channel || '').trim();
    const parentId = String(body.parent_id || '').trim() || null;
    const sortRaw = String(body.sort_order ?? '0').trim();
    const sortOrder = Number(sortRaw);
    const isConversion = body.is_conversion === 'on';
    
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
        throw new Error('Code must be 1–40 characters: letters, numbers, underscores or hyphens.');
    }
    if (!label || label.length > 160) {
        throw new Error('Label is required and must not exceed 160 characters.');
    }
    if (channel && !DISPOSITION_CHANNELS.includes(channel)) {
        throw new Error('Choose a valid disposition channel.');
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) {
        throw new Error('Sort order must be a non-negative whole number.');
    }
    if (parentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parentId)) {
        throw new Error('Choose a valid parent disposition.');
    }
    return { code, label, channel: channel || null, parentId, sortOrder, isConversion };
}

router.get('/dispositions', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        const result = await pool.query(
            `SELECT d.id, d.code, d.label, d.channel, d.is_conversion,
                    d.is_active, d.parent_id, d.hierarchy_level, d.sort_order,
                    p.code AS parent_code, p.label AS parent_label
               FROM dispositions d
               LEFT JOIN dispositions p
                 ON p.id = d.parent_id AND p.tenant_id = d.tenant_id
              WHERE d.tenant_id = $1
              ORDER BY d.hierarchy_level, d.sort_order, d.code`,
            [t]
        );

        const parents = await pool.query(
            `SELECT id, code, label, hierarchy_level
               FROM dispositions
              WHERE tenant_id = $1 AND is_active = TRUE
              ORDER BY hierarchy_level, sort_order, code`,
            [t]
        );

        res.render('admin/dispositions', {
            pageTitle: 'Admin — Dispositions',
            dispositions: result.rows,
            parents: parents.rows,
            editId: String(req.query.edit || ''),
            errorMessage: String(req.query.error || ''),
            channels: DISPOSITION_CHANNELS
        });
    } catch (error) {
        console.error('Disposition listing failed:', error.message);
        res.status(500).send('Dispositions could not be loaded.');
    }
});

router.post('/dispositions/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    let d;
    try {
        d = validateDispositionBody(req.body);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    try {
        const result = await pool.query(
            `INSERT INTO dispositions
                (tenant_id, code, label, channel, is_conversion,
                 parent_id, sort_order)
             VALUES ($1, $2, $3, $4::channel_type, $5, $6, $7)
             RETURNING id, code, label, channel, is_conversion,
                       parent_id, hierarchy_level, sort_order, is_active`,
            [t, d.code, d.label, d.channel, d.isConversion,
             d.parentId, d.sortOrder]
        );

        await writeAuditLog(
            t, req.session.user.id, 'DISPOSITION_CREATED',
            'disposition', result.rows[0].id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(dispositionRedirect(req));
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).send('That disposition code already exists for this tenant.');
        }
        if (['23503', '23514'].includes(error.code)) {
            return res.status(400).send('Invalid hierarchy: select a valid parent from this tenant and keep the hierarchy within three levels.');
        }
        console.error('Disposition creation failed:', error.message);
        return res.status(500).send('Disposition could not be created.');
    }
});

router.post('/dispositions/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    let d;
    try {
        d = validateDispositionBody(req.body);
    } catch (error) {
        return res.status(400).send(error.message);
    }

    try {
        const result = await pool.query(
            `UPDATE dispositions
                SET code = $1,
                    label = $2,
                    channel = $3::channel_type,
                    is_conversion = $4,
                    parent_id = $5,
                    sort_order = $6
              WHERE id = $7 AND tenant_id = $8
              RETURNING id, code, label, channel, is_conversion,
                        parent_id, hierarchy_level, sort_order, is_active`,
            [d.code, d.label, d.channel, d.isConversion, d.parentId,
             d.sortOrder, req.params.id, t]
        );

        if (!result.rowCount) {
            return res.status(404).send('Disposition not found for this tenant.');
        }

        await writeAuditLog(
            t, req.session.user.id, 'DISPOSITION_UPDATED',
            'disposition', req.params.id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(dispositionRedirect(req));
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).send('That disposition code already exists for this tenant.');
        }
        if (['23503', '23514'].includes(error.code)) {
            return res.status(400).send('Invalid hierarchy: the parent must belong to this tenant, cannot create a cycle, and cannot make the tree deeper than three levels.');
        }
        console.error('Disposition update failed:', error.message);
        return res.status(500).send('Disposition could not be updated.');
    }
});

router.post('/dispositions/:id/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        const result = await pool.query(
            `UPDATE dispositions
                SET is_active = NOT is_active
              WHERE id = $1 AND tenant_id = $2
              RETURNING id, code, label, is_active`,
            [req.params.id, t]
        );

        if (!result.rowCount) {
            return res.status(404).send('Disposition not found for this tenant.');
        }

        await writeAuditLog(
            t, req.session.user.id, 'DISPOSITION_STATUS_CHANGED',
            'disposition', req.params.id, null, result.rows[0],
            req.ip || null
        );
        return res.redirect(dispositionRedirect(req));
    } catch (error) {
        console.error('Disposition status change failed:', error.message);
        return res.status(500).send('Disposition status could not be changed.');
    }
});



// Tenant-scoped User Groups
function userGroupsRedirect(req, extra = '') {
    return '/admin/user-groups' + (extra ? '?' + extra : '');
}

router.get('/user-groups', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        const [groups, agents, editing] = await Promise.all([
            pool.query(`
                SELECT g.id, g.name, g.description, g.is_active, g.created_at,
                       COUNT(uga.agent_id)::int AS agent_count
                FROM user_groups g
                LEFT JOIN user_group_agents uga
                  ON uga.group_id = g.id AND uga.tenant_id = g.tenant_id
                WHERE g.tenant_id = $1
                GROUP BY g.id
                ORDER BY g.name`, [t]),
            pool.query(`
                SELECT a.id, COALESCE(NULLIF(u.full_name, ''), a.agent_number,
                       a.extension, a.id::text) AS display_name
                FROM agents a
                LEFT JOIN users u ON u.id = a.user_id
                WHERE a.tenant_id = $1
                ORDER BY display_name`, [t]),
            req.query.edit
                ? pool.query(`SELECT id, name, description, is_active
                              FROM user_groups WHERE id = $1 AND tenant_id = $2`,
                             [req.query.edit, t])
                : Promise.resolve({ rows: [] })
        ]);
        let selectedAgentIds = [];
        if (editing.rows.length) {
            const members = await pool.query(`
                SELECT agent_id FROM user_group_agents
                WHERE tenant_id = $1 AND group_id = $2`, [t, editing.rows[0].id]);
            selectedAgentIds = members.rows.map(r => r.agent_id);
        }
        res.render('admin/user-groups', {
            pageTitle: 'Admin — User Groups',
            groups: groups.rows, agents: agents.rows,
            editing: editing.rows[0] || null, selectedAgentIds,
            errorMessage: String(req.query.error || '')
        });
    } catch (error) {
        console.error('User Groups page failed:', error.message);
        res.status(500).send('User Groups could not be loaded.');
    }
});

router.post('/user-groups/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim() || null;
    if (!name || name.length > 100 || (description && description.length > 250)) {
        return res.redirect(userGroupsRedirect(req, 'error=invalid'));
    }
    try {
        const result = await pool.query(`
            INSERT INTO user_groups (tenant_id, name, description)
            VALUES ($1, $2, $3) RETURNING id, name, description, is_active`,
            [t, name, description]);
        await writeAuditLog(t, req.session.user.id, 'USER_GROUP_CREATED',
            'user_group', result.rows[0].id, null, result.rows[0], req.ip || null);
        res.redirect(userGroupsRedirect(req));
    } catch (error) {
        if (error.code === '23505') return res.redirect(userGroupsRedirect(req, 'error=duplicate'));
        console.error('User Group create failed:', error.message);
        res.status(500).send('User Group could not be created.');
    }
});

router.post('/user-groups/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim() || null;
    if (!name || name.length > 100 || (description && description.length > 250)) {
        return res.redirect(userGroupsRedirect(req, 'error=invalid'));
    }
    try {
        const result = await pool.query(`
            UPDATE user_groups SET name=$1, description=$2
            WHERE id=$3 AND tenant_id=$4
            RETURNING id, name, description, is_active`,
            [name, description, req.params.id, t]);
        if (!result.rowCount) return res.status(404).send('User Group not found for this tenant.');
        await writeAuditLog(t, req.session.user.id, 'USER_GROUP_UPDATED',
            'user_group', req.params.id, null, result.rows[0], req.ip || null);
        res.redirect(userGroupsRedirect(req));
    } catch (error) {
        if (error.code === '23505') return res.redirect(userGroupsRedirect(req, 'error=duplicate'));
        console.error('User Group update failed:', error.message);
        res.status(500).send('User Group could not be updated.');
    }
});

router.post('/user-groups/:id/toggle', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        const result = await pool.query(`
            UPDATE user_groups SET is_active = NOT is_active
            WHERE id=$1 AND tenant_id=$2
            RETURNING id, name, description, is_active`,
            [req.params.id, t]);
        if (!result.rowCount) return res.status(404).send('User Group not found for this tenant.');
        await writeAuditLog(t, req.session.user.id, 'USER_GROUP_STATUS_CHANGED',
            'user_group', req.params.id, null, result.rows[0], req.ip || null);
        res.redirect(userGroupsRedirect(req));
    } catch (error) {
        console.error('User Group status change failed:', error.message);
        res.status(500).send('User Group status could not be changed.');
    }
});

router.post('/user-groups/:id/agents', async (req, res) => {
    const t = req.effectiveTenant.id;
    const ids = [...new Set((Array.isArray(req.body.agent_ids)
        ? req.body.agent_ids : req.body.agent_ids ? [req.body.agent_ids] : [])
        .map(String))];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const group = await client.query(
            'SELECT id FROM user_groups WHERE id=$1 AND tenant_id=$2 FOR UPDATE',
            [req.params.id, t]);
        if (!group.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).send('User Group not found for this tenant.');
        }
        if (ids.length) {
            const valid = await client.query(
                'SELECT id FROM agents WHERE tenant_id=$1 AND id = ANY($2::uuid[])',
                [t, ids]);
            if (valid.rowCount !== ids.length) {
                await client.query('ROLLBACK');
                return res.redirect(userGroupsRedirect(req, 'error=invalid_agents'));
            }
        }
        await client.query(
            'DELETE FROM user_group_agents WHERE tenant_id=$1 AND group_id=$2',
            [t, req.params.id]);
        for (const id of ids) {
            await client.query(`
                INSERT INTO user_group_agents (tenant_id, group_id, agent_id)
                VALUES ($1, $2, $3)`, [t, req.params.id, id]);
        }
        await client.query('COMMIT');
        await writeAuditLog(t, req.session.user.id, 'USER_GROUP_MEMBERS_UPDATED',
            'user_group', req.params.id, null, { agent_ids: ids }, req.ip || null);
        res.redirect(userGroupsRedirect(req));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('User Group membership update failed:', error.message);
        res.status(500).send('User Group membership could not be updated.');
    } finally {
        client.release();
    }
});


// Tenant-scoped Pause Codes management
router.get('/pause-codes', async (req, res, next) => {
  try {
    const tenantId = req.effectiveTenant.id;
    const [codes, editResult] = await Promise.all([
      pool.query(
        `SELECT * FROM pause_codes
         WHERE tenant_id = $1
         ORDER BY sort_order, code`,
        [tenantId]
      ),
      req.query.edit
        ? pool.query(
            `SELECT * FROM pause_codes WHERE tenant_id = $1 AND id = $2`,
            [tenantId, req.query.edit]
          )
        : Promise.resolve({ rows: [] })
    ]);

    res.render('admin/pause-codes', {
      pageTitle: 'Pause Codes',
      codes: codes.rows,
      editing: editResult.rows[0] || null,
      errorMessage: req.query.error || null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/pause-codes/create', async (req, res, next) => {
  const tenantId = req.effectiveTenant.id;
  const userId = req.session.user.id;
  const code = String(req.body.code || '').trim().toUpperCase();
  const label = String(req.body.label || '').trim();
  const description = String(req.body.description || '').trim();
  const durationText = String(req.body.max_duration_seconds || '').trim();
  const sortText = String(req.body.sort_order || '0').trim();
  const isPaid = req.body.is_paid === 'on';
  const counts = req.body.counts_toward_productivity === 'on';

  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code) ||
      !label || label.length > 120 ||
      description.length > 500 ||
      (durationText && (!/^\d+$/.test(durationText) ||
        Number(durationText) < 1 || Number(durationText) > 86400)) ||
      !/^\d+$/.test(sortText) || Number(sortText) > 1000000) {
    return res.redirect('/admin/pause-codes?error=invalid');
  }

  try {
    const result = await pool.query(
      `INSERT INTO pause_codes
       (tenant_id, code, label, description, is_paid,
        counts_toward_productivity, max_duration_seconds, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tenantId, code, label, description || null, isPaid, counts,
       durationText ? Number(durationText) : null, Number(sortText)]
    );

    await writeAuditLog(
      tenantId, userId, 'PAUSE_CODE_CREATED',
      'pause_code', result.rows[0].id, null, result.rows[0],
      req.ip || null
    );
    return res.redirect('/admin/pause-codes');
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/admin/pause-codes?error=duplicate');
    }
    next(err);
  }
});

router.post('/pause-codes/:id/edit', async (req, res, next) => {
  const tenantId = req.effectiveTenant.id;
  const userId = req.session.user.id;
  const code = String(req.body.code || '').trim().toUpperCase();
  const label = String(req.body.label || '').trim();
  const description = String(req.body.description || '').trim();
  const durationText = String(req.body.max_duration_seconds || '').trim();
  const sortText = String(req.body.sort_order || '0').trim();
  const isPaid = req.body.is_paid === 'on';
  const counts = req.body.counts_toward_productivity === 'on';

  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code) ||
      !label || label.length > 120 ||
      description.length > 500 ||
      (durationText && (!/^\d+$/.test(durationText) ||
        Number(durationText) < 1 || Number(durationText) > 86400)) ||
      !/^\d+$/.test(sortText) || Number(sortText) > 1000000) {
    return res.redirect('/admin/pause-codes?error=invalid');
  }

  try {
    const oldResult = await pool.query(
      `SELECT * FROM pause_codes WHERE tenant_id = $1 AND id = $2`,
      [tenantId, req.params.id]
    );
    if (!oldResult.rows.length) {
      return res.redirect('/admin/pause-codes');
    }

    const result = await pool.query(
      `UPDATE pause_codes
       SET code = $3, label = $4, description = $5, is_paid = $6,
           counts_toward_productivity = $7, max_duration_seconds = $8,
           sort_order = $9, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, req.params.id, code, label, description || null,
       isPaid, counts, durationText ? Number(durationText) : null,
       Number(sortText)]
    );

    await writeAuditLog(
      tenantId, userId, 'PAUSE_CODE_UPDATED',
      'pause_code', req.params.id, oldResult.rows[0], result.rows[0],
      req.ip || null
    );
    return res.redirect('/admin/pause-codes');
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/admin/pause-codes?error=duplicate');
    }
    next(err);
  }
});

router.post('/pause-codes/:id/toggle', async (req, res, next) => {
  const tenantId = req.effectiveTenant.id;
  try {
    const oldResult = await pool.query(
      `SELECT * FROM pause_codes WHERE tenant_id = $1 AND id = $2`,
      [tenantId, req.params.id]
    );
    if (!oldResult.rows.length) {
      return res.redirect('/admin/pause-codes');
    }

    const result = await pool.query(
      `UPDATE pause_codes
       SET is_active = NOT is_active, updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
      [tenantId, req.params.id]
    );

    await writeAuditLog(
      tenantId, req.session.user.id, 'PAUSE_CODE_STATUS_CHANGED',
      'pause_code', req.params.id, oldResult.rows[0], result.rows[0],
      req.ip || null
    );
    return res.redirect('/admin/pause-codes');
  } catch (err) {
    next(err);
  }
});



// ---------------- Media Assets ----------------
router.get('/media-assets', async (req, res, next) => {
    try {
        const tenantId = req.effectiveTenant.id;
        const result = await pool.query(
            `SELECT id, name, description, storage_path, original_filename,
                    file_size_bytes, duration_seconds, checksum_sha256,
                    is_active, created_at
             FROM media_assets
             WHERE tenant_id = $1
             ORDER BY created_at DESC`,
            [tenantId]
        );

        res.render('admin/media-assets', {
            pageTitle: 'Admin — Media Assets',
            assets: result.rows,
            error: req.query.error || null,
            success: req.query.success || null
        });
    } catch (err) {
        next(err);
    }
});

router.post('/media-assets/upload', (req, res, next) => {
    audioUpload.single('audio_upload')(req, res, err => {
        if (err) {
            return res.redirect('/admin/media-assets?error=' +
                encodeURIComponent('Upload failed: ' + err.message));
        }
        next();
    });
}, async (req, res, next) => {
    const tenantId = req.effectiveTenant.id;
    const inputPath = req.file && req.file.path;
    let converted = null;
    let inserted = false;

    try {
        if (!req.file) {
            return res.redirect('/admin/media-assets?error=' +
                encodeURIComponent('Choose an audio file first.'));
        }

        const name = String(req.body.name || '').trim();
        const description = String(req.body.description || '').trim();

        if (!name || name.length > 160) {
            return res.redirect('/admin/media-assets?error=' +
                encodeURIComponent('Asset name is required and must be at most 160 characters.'));
        }
        if (description.length > 500) {
            return res.redirect('/admin/media-assets?error=' +
                encodeURIComponent('Description must be at most 500 characters.'));
        }

        converted = await convertToWav(inputPath);

        const hash = crypto.createHash('sha256');
        const fileStream = fs.createReadStream(converted.path);
        for await (const chunk of fileStream) hash.update(chunk);
        const checksum = hash.digest('hex');

        const result = await pool.query(
            `INSERT INTO media_assets
                (tenant_id, name, description, media_type, storage_path,
                 original_filename, mime_type, file_extension, file_size_bytes,
                 checksum_sha256, duration_seconds, is_active, uploaded_by)
             VALUES ($1,$2,$3,'audio',$4,$5,'audio/wav','wav',$6,$7,$8,true,$9)
             RETURNING id`,
            [
                tenantId,
                name,
                description || null,
                converted.publicPath,
                String(req.file.originalname || '').slice(0, 255),
                converted.fileSizeBytes,
                checksum,
                converted.durationSeconds,
                req.session && req.session.user ? req.session.user.id : null
            ]
        );
        inserted = true;

        try {
            await writeAuditLog(
                tenantId,
                req.session && req.session.user ? req.session.user.id : null,
                'MEDIA_ASSET_UPLOADED',
                'media_asset',
                result.rows[0].id,
                null,
                {
                    name,
                    storage_path: converted.publicPath,
                    checksum_sha256: checksum,
                    file_size_bytes: converted.fileSizeBytes,
                    duration_seconds: converted.durationSeconds
                },
                req.ip || null
            );
        } catch (auditErr) {
            // The asset is already saved; don't remove its file if audit logging fails.
            console.error('Media asset audit log failed:', auditErr.message);
        }

        return res.redirect('/admin/media-assets?success=' +
            encodeURIComponent('Audio converted and saved as 16-bit mono 8 kHz WAV.'));
    } catch (err) {
        console.error('Media asset upload failed:', err.message);
        if (!inserted && converted && converted.path) {
            await fs.promises.unlink(converted.path).catch(() => {});
        }
        return res.redirect('/admin/media-assets?error=' +
            encodeURIComponent('Audio could not be processed. Check that it contains valid playable audio.'));
    } finally {
        if (inputPath) {
            await fs.promises.unlink(inputPath).catch(() => {});
        }
    }
});

router.post('/media-assets/:id/toggle', async (req, res, next) => {
    const tenantId = req.effectiveTenant.id;

    try {
        const result = await pool.query(
            `UPDATE media_assets
             SET is_active = NOT is_active, updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2
             RETURNING id, name, is_active`,
            [tenantId, req.params.id]
        );

        if (!result.rows.length) {
            return res.redirect('/admin/media-assets?error=' +
                encodeURIComponent('Asset not found for this tenant.'));
        }

        await writeAuditLog(
            tenantId,
            req.session && req.session.user ? req.session.user.id : null,
            'MEDIA_ASSET_STATUS_CHANGED',
            'media_asset',
            result.rows[0].id,
            null,
            { name: result.rows[0].name, is_active: result.rows[0].is_active },
            req.ip || null
        );

        return res.redirect('/admin/media-assets?success=' +
            encodeURIComponent(result.rows[0].is_active ? 'Asset activated.' : 'Asset deactivated.'));
    } catch (err) {
        next(err);
    }
});


router.get('/appearance', async (req, res, next) => {
    try {
        const tenantId = req.effectiveTenant.id;
        const result = await pool.query(
            `SELECT portal_name, logo_path, theme, primary_color
             FROM tenant_appearance WHERE tenant_id = $1`,
            [tenantId]
        );
        const appearance = result.rows[0] || {
            portal_name: 'TECH-Life Contact-Center Solution',
            logo_path: null,
            theme: 'blue',
            primary_color: null
        };

        return res.render('admin/appearance', {
            pageTitle: 'Appearance Settings',
            appearance,
            tenant: req.effectiveTenant,
            success: req.query.success || '',
            error: req.query.error || ''
        });
    } catch (err) {
        return next(err);
    }
});

router.post('/appearance', async (req, res, next) => {
    const tenantId = req.effectiveTenant.id;
    const portalName = String(req.body.portal_name || '').trim();
    const theme = String(req.body.theme || 'blue').trim().toLowerCase();
    const colorInput = String(req.body.primary_color || '').trim();
    const useThemeAccent = req.body.use_theme_accent === '1';
    const allowedThemes = new Set(['blue', 'purple', 'green', 'yellow', 'light', 'dark']);

    if (portalName.length < 2 || portalName.length > 150) {
        return res.redirect('/admin/appearance?error=' +
            encodeURIComponent('Portal name must be between 2 and 150 characters.'));
    }
    if (!allowedThemes.has(theme)) {
        return res.redirect('/admin/appearance?error=' +
            encodeURIComponent('Select one of the available themes.'));
    }
    if (colorInput && !/^#[0-9a-fA-F]{6}$/.test(colorInput)) {
        return res.redirect('/admin/appearance?error=' +
            encodeURIComponent('Custom accent must be a valid six-digit hex color.'));
    }

    const primaryColor = useThemeAccent ? null : (colorInput || null);
    try {
        await pool.query(
            `INSERT INTO tenant_appearance
                (tenant_id, portal_name, theme, primary_color, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (tenant_id) DO UPDATE SET
                portal_name = EXCLUDED.portal_name,
                theme = EXCLUDED.theme,
                primary_color = EXCLUDED.primary_color,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()`,
            [
                tenantId,
                portalName,
                theme,
                primaryColor,
                req.session && req.session.user ? req.session.user.id : null
            ]
        );

        try {
            await writeAuditLog(
                tenantId,
                req.session && req.session.user ? req.session.user.id : null,
                'TENANT_APPEARANCE_UPDATED',
                'tenant',
                tenantId,
                null,
                { portal_name: portalName, theme, primary_color: primaryColor },
                req.ip || null
            );
        } catch (auditErr) {
            console.error('Appearance audit log failed:', auditErr.message);
        }

        return res.redirect('/admin/appearance?success=' +
            encodeURIComponent('Appearance settings saved.'));
    } catch (err) {
        return next(err);
    }
});


// ---------------- Supervisor access assignments (admin-only) ----------------
// The router is protected by requireRole(['admin']) above. Scope changes are
// persisted server-side; supervisors have no write route for these tables.
router.get('/supervisor-assignments', async (req, res, next) => {
    const t = req.effectiveTenant.id;
    try {
        const supervisors = (await pool.query(`
            SELECT u.id, COALESCE(NULLIF(u.full_name, ''), u.username) AS display_name
            FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            WHERE u.tenant_id = $1 AND r.role_type::text = 'supervisor'
              AND u.is_active = TRUE
            ORDER BY display_name`, [t])).rows;
        const agents = (await pool.query(`
            SELECT a.id, COALESCE(NULLIF(u.full_name, ''), a.agent_number,
                   a.extension, a.id::text) AS display_name
            FROM agents a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.tenant_id = $1 AND a.is_active = TRUE
            ORDER BY display_name`, [t])).rows;
        const groups = (await pool.query(`
            SELECT id, name FROM user_groups
            WHERE tenant_id = $1 AND is_active = TRUE ORDER BY name`, [t])).rows;
        const selectedSupervisor = supervisors.some(x => x.id === req.query.supervisor_id)
            ? req.query.supervisor_id : (supervisors[0]?.id || '');
        let assignedAgentIds = [];
        let assignedGroupIds = [];
        if (selectedSupervisor) {
            const [direct, group] = await Promise.all([
                pool.query(`SELECT agent_id FROM supervisor_agent_assignments
                            WHERE tenant_id=$1 AND supervisor_id=$2`, [t, selectedSupervisor]),
                pool.query(`SELECT group_id FROM supervisor_group_assignments
                            WHERE tenant_id=$1 AND supervisor_id=$2`, [t, selectedSupervisor])
            ]);
            assignedAgentIds = direct.rows.map(x => x.agent_id);
            assignedGroupIds = group.rows.map(x => x.group_id);
        }
        res.render('admin/supervisor-assignments', {
            pageTitle: 'Admin — Supervisor Assignments', supervisors, agents, groups,
            selectedSupervisor, assignedAgentIds, assignedGroupIds,
            saved: req.query.saved === '1', errorMessage: String(req.query.error || '')
        });
    } catch (err) { next(err); }
});

router.post('/supervisor-assignments', async (req, res, next) => {
    const t = req.effectiveTenant.id;
    const supervisorId = String(req.body.supervisor_id || '');
    const idsFrom = (value) => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(String))];
    const agentIds = idsFrom(req.body.agent_ids);
    const groupIds = idsFrom(req.body.group_ids);
    const redirectTo = (key) => res.redirect('/admin/supervisor-assignments?supervisor_id=' +
        encodeURIComponent(supervisorId) + '&' + key);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const supervisor = await client.query(`
            SELECT u.id FROM users u
            JOIN user_roles ur ON ur.user_id=u.id
            JOIN roles r ON r.id=ur.role_id
            WHERE u.id=$1 AND u.tenant_id=$2 AND u.is_active=TRUE
              AND r.role_type::text='supervisor' LIMIT 1 FOR UPDATE OF u`, [supervisorId, t]);
        if (!supervisor.rowCount) {
            await client.query('ROLLBACK');
            return redirectTo('error=invalid_supervisor');
        }
        const [validAgents, validGroups] = await Promise.all([
            agentIds.length ? client.query(
                'SELECT id FROM agents WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])',
                [t, agentIds]) : Promise.resolve({ rows: [] }),
            groupIds.length ? client.query(
                'SELECT id FROM user_groups WHERE tenant_id=$1 AND is_active=TRUE AND id = ANY($2::uuid[])',
                [t, groupIds]) : Promise.resolve({ rows: [] })
        ]);
        if (validAgents.rowCount !== agentIds.length || validGroups.rowCount !== groupIds.length) {
            await client.query('ROLLBACK');
            return redirectTo('error=invalid_selection');
        }
        await client.query(
            'DELETE FROM supervisor_agent_assignments WHERE tenant_id=$1 AND supervisor_id=$2',
            [t, supervisorId]);
        await client.query(
            'DELETE FROM supervisor_group_assignments WHERE tenant_id=$1 AND supervisor_id=$2',
            [t, supervisorId]);
        for (const agentId of agentIds) {
            await client.query(`INSERT INTO supervisor_agent_assignments
                (tenant_id, supervisor_id, agent_id, assigned_by) VALUES ($1,$2,$3,$4)`,
                [t, supervisorId, agentId, req.session.user.id]);
        }
        for (const groupId of groupIds) {
            await client.query(`INSERT INTO supervisor_group_assignments
                (tenant_id, supervisor_id, group_id, assigned_by) VALUES ($1,$2,$3,$4)`,
                [t, supervisorId, groupId, req.session.user.id]);
        }
        await client.query('COMMIT');
        await writeAuditLog(t, req.session.user.id, 'SUPERVISOR_ASSIGNMENTS_UPDATED',
            'user', supervisorId, null, { agent_ids: agentIds, group_ids: groupIds }, req.ip || null);
        return redirectTo('saved=1');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return next(err);
    } finally { client.release(); }
});


module.exports = router;
