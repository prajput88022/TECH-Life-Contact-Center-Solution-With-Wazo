const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireRole } = require('../src/auth');
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

// ---------------- Dashboard ----------------
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

router.post('/users/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
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
                `INSERT INTO agents (tenant_id, user_id, provisioning_status) VALUES ($1,$2,'pending') RETURNING id`,
                [t, newUserId]
            );
            newAgentId = agentRes.rows[0].id;
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
    const b = req.body;
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
    await writeAuditLog(t, req.session.user.id, 'USER_UPDATED', 'user', req.params.id, null, b);
    res.redirect('/admin/users' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

// ---------------- Queues ----------------
router.get('/queues', async (req, res) => {
    const t = req.effectiveTenant.id;
    const queues = (await pool.query('SELECT * FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('admin/queues', { pageTitle: 'Admin — Queues', queues, editId: req.query.edit || null });
});

router.post('/queues/create', async (req, res) => {
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

router.post('/queues/:id/edit', async (req, res) => {
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

router.post('/queues/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM queues WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'QUEUE_DELETED', 'queue', req.params.id);
        res.redirect('/admin/queues' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
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
    await pool.query(
        `INSERT INTO trunks (tenant_id, name, sip_server, transport, codec, max_calls)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t, b.name, b.sip_server, b.transport || 'udp', b.codec || null, b.max_calls || null]
    );
    await writeAuditLog(t, req.session.user.id, 'TRUNK_CREATED', 'trunk', null, null, b);
    res.redirect('/admin/trunks' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/trunks/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE trunks SET name = $1, sip_server = $2, transport = $3, codec = $4, max_calls = $5, is_active = $6
         WHERE id = $7 AND tenant_id = $8`,
        [b.name, b.sip_server, b.transport, b.codec || null, b.max_calls || null, b.is_active === '1', req.params.id, t]
    );
    await writeAuditLog(t, req.session.user.id, 'TRUNK_UPDATED', 'trunk', req.params.id, null, b);
    res.redirect('/admin/trunks' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
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

// ---------------- DIDs ----------------
router.get('/dids', async (req, res) => {
    const t = req.effectiveTenant.id;
    const dids = (await pool.query(
        `SELECT d.*, q.name AS queue_name, c.name AS campaign_name FROM dids d
         LEFT JOIN queues q ON q.id = d.default_queue_id
         LEFT JOIN campaigns c ON c.id = d.campaign_id
         WHERE d.tenant_id = $1 ORDER BY d.did_number`,
        [t]
    )).rows;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('admin/dids', { pageTitle: 'Admin — DIDs', dids, queues, campaigns, editId: req.query.edit || null });
});

router.post('/dids/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `INSERT INTO dids (tenant_id, did_number, description, default_queue_id, campaign_id) VALUES ($1,$2,$3,$4,$5)`,
        [t, b.did_number, b.description, b.default_queue_id || null, b.campaign_id || null]
    );
    res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/dids/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE dids SET description = $1, default_queue_id = $2, campaign_id = $3, is_active = $4
         WHERE id = $5 AND tenant_id = $6`,
        [b.description, b.default_queue_id || null, b.campaign_id || null, b.is_active === '1', req.params.id, t]
    );
    res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/dids/:id/delete', async (req, res) => {
    const t = req.effectiveTenant.id;
    try {
        await pool.query('DELETE FROM dids WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
        await writeAuditLog(t, req.session.user.id, 'DID_DELETED', 'did', req.params.id);
        res.redirect('/admin/dids' + (req.query.as_tenant ? `?as_tenant=${req.query.as_tenant}` : ''));
    } catch (e) {
        res.status(409).send(deleteBlockedMessage(e, 'This DID'));
    }
});

// ---------------- Campaigns (incl. robo/voice-blast script builder) ----------------
router.get('/campaigns', async (req, res) => {
    const t = req.effectiveTenant.id;
    const campaigns = (await pool.query('SELECT * FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC', [t])).rows;
    const scriptCampaignId = req.query.script || null;
    let scriptNodes = [];
    if (scriptCampaignId) {
        scriptNodes = (await pool.query('SELECT * FROM campaign_voice_content WHERE campaign_id = $1 ORDER BY step_number', [scriptCampaignId])).rows;
    }
    res.render('admin/campaigns', { pageTitle: 'Admin — Campaigns', campaigns, scriptCampaignId, scriptNodes, editId: req.query.edit || null });
});

router.post('/campaigns/create', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    const isRobo = ['robo_survey', 'voice_blast'].includes(b.dialing_mode);
    const result = await pool.query(
        `INSERT INTO campaigns
            (tenant_id, name, channel, dialing_mode, dial_level, is_robo_campaign,
             max_concurrent_robo_calls, answering_machine_detection, start_date, end_date)
         VALUES ($1,$2,'voice',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [t, b.name, b.dialing_mode, b.dial_level || 1.0, isRobo,
         b.max_concurrent_robo_calls || null, !!b.amd, b.start_date || null, b.end_date || null]
    );
    const campaignId = result.rows[0].id;
    await writeAuditLog(t, req.session.user.id, 'CAMPAIGN_CREATED', 'campaign', campaignId, null, b);
    res.redirect(`/admin/campaigns?script=${campaignId}` + (req.query.as_tenant ? `&as_tenant=${req.query.as_tenant}` : ''));
});

router.post('/campaigns/:id/edit', async (req, res) => {
    const t = req.effectiveTenant.id;
    const b = req.body;
    await pool.query(
        `UPDATE campaigns SET name = $1, dial_level = $2, max_concurrent_robo_calls = $3,
            answering_machine_detection = $4, start_date = $5, end_date = $6, is_active = $7
         WHERE id = $8 AND tenant_id = $9`,
        [b.name, b.dial_level || 1.0, b.max_concurrent_robo_calls || null, !!b.amd,
         b.start_date || null, b.end_date || null, b.is_active === '1', req.params.id, t]
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

module.exports = router;
