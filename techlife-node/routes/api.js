/**
 * TECH-Life REST API (Node/Express edition). Same route contract as the
 * previous PHP api/v1/index.php -- every handler calls into the
 * Reporting Services, never writes its own ad-hoc aggregation SQL.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../src/db');
const { requireAuth } = require('../src/auth');
const agentReportService = require('../src/services/agentReportService');
const queueReportService = require('../src/services/queueReportService');
const didReportService = require('../src/services/didReportService');
const campaignReportService = require('../src/services/campaignReportService');
const ivrReportService = require('../src/services/ivrReportService');
const config = require('../config/config');

router.use(requireAuth);

function dateRange(req) {
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    return [from, to];
}

// ---- SIP credentials for the WebRTC workspace ----
router.get('/agents/:id/sip-credentials', async (req, res) => {
    const u = req.session.user;
    const isSelf = u.agentId === req.params.id;
    const isPrivileged = ['supervisor', 'admin', 'superadmin'].some((r) => u.roles.includes(r));
    if (!isSelf && !isPrivileged) return res.status(403).json({ error: 'forbidden' });

    const result = await pool.query(
        `SELECT ag.extension, ag.sip_username, ag.sip_password, ag.provisioning_status,
                COALESCE(t.sip_domain, $3) AS sip_domain
         FROM agents ag JOIN tenants t ON t.id = ag.tenant_id
         WHERE ag.tenant_id = $1 AND ag.id = $2`,
        [u.tenantId, req.params.id, config.wazo.sipDomain]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'agent_not_found' });
    if (row.provisioning_status !== 'provisioned' && row.provisioning_status !== 'manual') {
        return res.status(409).json({ error: 'not_provisioned', status: row.provisioning_status });
    }
    res.json({
        extension: row.extension,
        sip_username: row.sip_username,
        sip_password: row.sip_password,
        sip_domain: row.sip_domain,
        ws_uri: config.wazo.sipWsUri,
    });
});

// ---- CRM screen-pop config, for the agent workspace to fetch on load ----
router.get('/crm/config', async (req, res) => {
    const u = req.session.user;
    const result = await pool.query(
        `SELECT popup_enabled, trigger_event, popup_mode, url_template
         FROM crm_integrations WHERE tenant_id = $1 AND is_active = TRUE AND popup_enabled = TRUE
         ORDER BY created_at LIMIT 1`,
        [u.tenantId]
    );
    res.json(result.rows[0] || { popup_enabled: false });
});

// ---- Agent status ----
router.get('/agents/:id/status', async (req, res) => {
    const u = req.session.user;
    const result = await pool.query(
        `SELECT status, started_at FROM agent_status_events
         WHERE tenant_id = $1 AND agent_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        [u.tenantId, req.params.id]
    );
    res.json(result.rows[0] || { status: 'offline' });
});

router.post('/agents/:id/status', async (req, res) => {
    const u = req.session.user;
    const { status, reason_code, queue_id } = req.body;
    const validStatuses = ['login','logout','available','break','lunch','tea','training',
        'meeting','system_issue','personal_break','after_call_work','offline','custom'];
    if (!validStatuses.includes(status)) return res.status(422).json({ error: 'invalid_status' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE agent_status_events SET ended_at = now() WHERE tenant_id = $1 AND agent_id = $2 AND ended_at IS NULL`,
            [u.tenantId, req.params.id]
        );
        await client.query(
            `INSERT INTO agent_status_events (tenant_id, agent_id, queue_id, status, reason_code, started_at, source)
             VALUES ($1,$2,$3,$4,$5,now(),'node_ui')`,
            [u.tenantId, req.params.id, queue_id || null, status, reason_code || null]
        );
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'server_error' });
    } finally {
        client.release();
    }
});

// ---- Reports ----
router.get('/reports/agents/hourly', async (req, res) => {
    const u = req.session.user;
    const [from, to] = dateRange(req);
    res.json(await agentReportService.hourly(u.tenantId, req.query.agent_id || '', from, to));
});

router.get('/reports/agents/live', async (req, res) => {
    res.json(await agentReportService.liveStatuses(req.session.user.tenantId));
});

router.get('/reports/agents/:id/performance', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await agentReportService.performance(req.session.user.tenantId, req.params.id, from, to));
});

router.get('/reports/queues', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await queueReportService.summary(req.session.user.tenantId, from, to));
});
router.get('/reports/queues/live', async (req, res) => {
    res.json(await queueReportService.liveSnapshot(req.session.user.tenantId));
});

// Active calls right now (ringing/answered, not yet ended), with enough
// context for the supervisor dashboard to show Listen/Whisper/Barge
// buttons and filter by queue/campaign.
router.get('/reports/calls/live', async (req, res) => {
    const t = req.session.user.tenantId;
    const { queue_id, campaign_id } = req.query;
    const where = ["c.tenant_id = $1", "c.status IN ('ringing','answered')", 'c.end_time IS NULL'];
    const params = [t];
    let idx = 2;
    if (queue_id) { where.push(`c.queue_id = $${idx++}`); params.push(queue_id); }
    if (campaign_id) { where.push(`c.campaign_id = $${idx++}`); params.push(campaign_id); }

    const result = await pool.query(
        `SELECT c.id, c.status, c.direction, c.start_time, c.from_number, c.to_number,
                u.full_name AS agent_name, q.name AS queue_name, camp.name AS campaign_name
         FROM calls c
         LEFT JOIN agents ag ON ag.id = c.agent_id
         LEFT JOIN users u ON u.id = ag.user_id
         LEFT JOIN queues q ON q.id = c.queue_id
         LEFT JOIN campaigns camp ON camp.id = c.campaign_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.start_time DESC`,
        params
    );
    res.json(result.rows);
});
router.get('/reports/queues/:id/hourly', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await queueReportService.hourly(req.session.user.tenantId, req.params.id, from, to));
});

router.get('/reports/campaigns/:id', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await campaignReportService.summary(req.session.user.tenantId, req.params.id, from, to));
});

router.get('/reports/dids', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await didReportService.summary(req.session.user.tenantId, from, to));
});
router.get('/reports/dids/:id/hourly', async (req, res) => {
    const [from, to] = dateRange(req);
    res.json(await didReportService.hourly(req.session.user.tenantId, req.params.id, from, to));
});

router.get('/ivr-sessions/call/:callId/journey', async (req, res) => {
    res.json(await ivrReportService.journeyForCall(req.session.user.tenantId, req.params.callId));
});
router.get('/reports/ivr/:menuId', async (req, res) => {
    const [from, to] = dateRange(req);
    const t = req.session.user.tenantId;
    res.json({
        hourly: await ivrReportService.hourly(t, req.params.menuId, from, to),
        options: await ivrReportService.optionPopularity(t, req.params.menuId, from, to),
    });
});

// ---- Call Monitoring: Listen / Whisper / Barge ----
// Supervisor/admin only. See src/callMonitoring.js for the important
// caveat: this requires a specific Wazo dialplan (ChanSpy) context that
// can't be verified from this environment -- see INSTALL.md.
router.post('/calls/:id/monitor', async (req, res) => {
    const u = req.session.user;
    if (!['supervisor', 'admin', 'superadmin'].some((r) => u.roles.includes(r))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const mode = req.body.mode;
    try {
        const callMonitoring = require('../src/callMonitoring');
        const result = await callMonitoring.startMonitoring(u.tenantId, u.id, req.params.id, mode);
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.post('/monitoring-sessions/:id/stop', async (req, res) => {
    const u = req.session.user;
    if (!['supervisor', 'admin', 'superadmin'].some((r) => u.roles.includes(r))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    try {
        const callMonitoring = require('../src/callMonitoring');
        await callMonitoring.stopMonitoring(u.tenantId, req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ---- Calls list (JSON) ----
router.get('/calls', async (req, res) => {
    const u = req.session.user;
    const [from, to] = dateRange(req);
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 50;
    const offset = (page - 1) * perPage;

    const where = ['tenant_id = $1', 'start_time BETWEEN $2 AND $3'];
    const params = [u.tenantId, from, to];
    let idx = 4;
    for (const f of ['agent_id', 'queue_id', 'campaign_id', 'did_id', 'status', 'direction']) {
        if (req.query[f]) { where.push(`${f} = $${idx++}`); params.push(req.query[f]); }
    }
    const result = await pool.query(
        `SELECT id, agent_id, queue_id, campaign_id, did_id, direction, status,
                start_time, answer_time, end_time, talk_seconds, wait_seconds, hangup_cause
         FROM calls WHERE ${where.join(' AND ')} ORDER BY start_time DESC LIMIT ${perPage} OFFSET ${offset}`,
        params
    );
    res.json({ page, results: result.rows });
});

module.exports = router;
