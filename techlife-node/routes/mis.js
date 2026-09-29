const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const agentReportService = require('../src/services/agentReportService');
const queueReportService = require('../src/services/queueReportService');
const campaignReportService = require('../src/services/campaignReportService');
const didReportService = require('../src/services/didReportService');
const ivrReportService = require('../src/services/ivrReportService');

router.use(requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']));

router.get('/', async (req, res) => {
    const t = req.session.user.tenantId;
    const kpis = (await pool.query(
        `SELECT
            (SELECT COUNT(*) FROM calls WHERE tenant_id = $1 AND start_time::date = CURRENT_DATE) AS calls_today,
            (SELECT COUNT(*) FROM calls WHERE tenant_id = $1 AND start_time::date = CURRENT_DATE AND status IN ('answered','completed')) AS answered_today,
            (SELECT COUNT(*) FROM calls WHERE tenant_id = $1 AND start_time::date = CURRENT_DATE AND status = 'abandoned') AS abandoned_today,
            (SELECT COUNT(*) FROM conversations WHERE tenant_id = $1 AND started_at::date = CURRENT_DATE) AS conversations_today`,
        [t]
    )).rows[0];
    res.render('mis/index', { pageTitle: 'MIS — Reports', kpis });
});

router.get('/agent-hourly', async (req, res) => {
    const t = req.session.user.tenantId;
    const agents = (await pool.query(
        `SELECT a.id, u.full_name FROM agents a JOIN users u ON u.id = a.user_id
         WHERE a.tenant_id = $1 AND a.is_active ORDER BY u.full_name`, [t]
    )).rows;
    const agentId = req.query.agent_id || (agents[0] ? agents[0].id : null);
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const rows = agentId ? await agentReportService.hourly(t, agentId, from, to) : [];
    res.render('mis/agent_hourly', { pageTitle: 'MIS — Agent Hourly Report', agents, agentId, from, to, rows });
});

router.get('/queue-report', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const rows = await queueReportService.summary(t, from, to);
    res.render('mis/queue_report', { pageTitle: 'MIS — Queue Report', from, to, rows });
});

router.get('/did-report', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const rows = await didReportService.summary(t, from, to);
    res.render('mis/did_report', { pageTitle: 'MIS — DID Report', from, to, rows });
});

router.get('/campaign-report', async (req, res) => {
    const t = req.session.user.tenantId;
    const campaigns = await campaignReportService.listActive(t);
    const campaignId = req.query.campaign_id || (campaigns[0] ? campaigns[0].id : null);
    const from = req.query.from || new Date().toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    let voiceSummary = null, roboSummary = [], surveyResults = [];
    const selected = campaigns.find((c) => c.id === campaignId);

    if (campaignId) {
        const summary = await campaignReportService.summary(t, campaignId, from, to);
        voiceSummary = summary.voice;

        if (selected && selected.is_robo_campaign) {
            const r1 = await pool.query(
                `SELECT * FROM mv_robo_campaign_hourly WHERE tenant_id = $1 AND campaign_id = $2
                 AND hour_bucket BETWEEN $3 AND $4 ORDER BY hour_bucket`,
                [t, campaignId, from, to]
            );
            roboSummary = r1.rows;
            const r2 = await pool.query(
                `SELECT node_name, response_dtmf, SUM(response_count) AS total FROM mv_survey_response_summary
                 WHERE tenant_id = $1 AND campaign_id = $2 AND day_bucket BETWEEN $3 AND $4
                 GROUP BY node_name, response_dtmf ORDER BY node_name, response_dtmf`,
                [t, campaignId, from, to]
            );
            surveyResults = r2.rows;
        }
    }
    res.render('mis/campaign_report', { pageTitle: 'MIS — Campaign Report', campaigns, campaignId, from, to, voiceSummary, selected, roboSummary, surveyResults });
});

router.get('/ivr-journey', async (req, res) => {
    const t = req.session.user.tenantId;
    const callId = req.query.call_id || null;
    const recent = (await pool.query(
        `SELECT c.id, c.start_time, c.from_number, c.to_number FROM calls c
         JOIN ivr_sessions s ON s.call_id = c.id WHERE c.tenant_id = $1 ORDER BY c.start_time DESC LIMIT 25`,
        [t]
    )).rows;
    let journey = null;
    if (callId) journey = await ivrReportService.journeyForCall(t, callId);
    res.render('mis/ivr_journey', { pageTitle: 'MIS — IVR Journey Viewer', recent, callId, journey });
});

// ---------------- Recordings ----------------
router.get('/recordings', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const agentId = req.query.agent_id || null;
    const queueId = req.query.queue_id || null;
    const campaignId = req.query.campaign_id || null;

    const where = ['r.tenant_id = $1', 'c.start_time BETWEEN $2 AND $3'];
    const params = [t, from, to];
    let idx = 4;
    if (agentId) { where.push(`c.agent_id = $${idx++}`); params.push(agentId); }
    if (queueId) { where.push(`c.queue_id = $${idx++}`); params.push(queueId); }
    if (campaignId) { where.push(`c.campaign_id = $${idx++}`); params.push(campaignId); }

    const recordings = (await pool.query(
        `SELECT r.id, r.duration_seconds, r.file_size_bytes, r.is_downloadable,
                c.id AS call_id, c.start_time, c.from_number, c.to_number, c.direction,
                u.full_name AS agent_name, q.name AS queue_name, camp.name AS campaign_name,
                disp.label AS disposition_label
         FROM recordings r
         JOIN calls c ON c.id = r.call_id
         LEFT JOIN agents ag ON ag.id = c.agent_id
         LEFT JOIN users u ON u.id = ag.user_id
         LEFT JOIN queues q ON q.id = c.queue_id
         LEFT JOIN campaigns camp ON camp.id = c.campaign_id
         LEFT JOIN dispositions disp ON disp.id = c.disposition_id
         WHERE ${where.join(' AND ')}
         ORDER BY c.start_time DESC LIMIT 200`,
        params
    )).rows;

    const agents = (await pool.query(
        `SELECT a.id, u.full_name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 ORDER BY u.full_name`, [t]
    )).rows;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id = $1 ORDER BY name', [t])).rows;

    res.render('mis/recordings', { pageTitle: 'MIS — Recordings', recordings, agents, queues, campaigns, from, to, agentId, queueId, campaignId });
});

// Streams a recording file to the browser, with a tenant ownership
// check so one tenant can never fetch another's recording by id.
router.get('/recordings/:id/play', async (req, res) => {
    const t = req.session.user.tenantId;
    const result = await pool.query('SELECT file_path, storage_backend FROM recordings WHERE id = $1 AND tenant_id = $2', [req.params.id, t]);
    const rec = result.rows[0];
    if (!rec) return res.status(404).send('Recording not found');
    if (rec.storage_backend !== 'local') {
        return res.status(501).send('Only local storage_backend recordings can be streamed by this build — extend routes/mis.js for s3/minio.');
    }
    res.sendFile(rec.file_path, (err) => {
        if (err && !res.headersSent) res.status(404).send('Recording file not found on disk: ' + rec.file_path);
    });
});

// ---------------- Agent Login/Logout Report ----------------
router.get('/login-activity', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const agentId = req.query.agent_id || null;

    const agents = (await pool.query(
        `SELECT a.id, u.full_name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 ORDER BY u.full_name`, [t]
    )).rows;

    // Each 'login' status_event paired with the NEXT 'logout' event for
    // that same agent (if any -- NULL means still logged in). Then sums
    // available/break/ACW time that actually fell within that span, so
    // the report reads as "agent X logged in at 9:00, logged out at
    // 17:30, spent Y on break within that session" -- not just raw
    // status rows.
    const where = ['login.tenant_id = $1', "login.status = 'login'", 'login.started_at BETWEEN $2 AND $3'];
    const params = [t, from, to];
    if (agentId) { where.push('login.agent_id = $4'); params.push(agentId); }

    const rows = (await pool.query(
        `SELECT login.agent_id, u.full_name,
                login.started_at AS login_at,
                (SELECT MIN(lo.started_at) FROM agent_status_events lo
                    WHERE lo.agent_id = login.agent_id AND lo.status = 'logout' AND lo.started_at > login.started_at) AS logout_at,
                (SELECT COALESCE(SUM(x.duration_seconds),0) FROM agent_status_events x
                    WHERE x.agent_id = login.agent_id AND x.status = 'available' AND x.ended_at IS NOT NULL
                      AND x.started_at >= login.started_at
                      AND x.started_at < COALESCE(
                        (SELECT MIN(lo2.started_at) FROM agent_status_events lo2
                            WHERE lo2.agent_id = login.agent_id AND lo2.status = 'logout' AND lo2.started_at > login.started_at),
                        now())) AS available_seconds,
                (SELECT COALESCE(SUM(x.duration_seconds),0) FROM agent_status_events x
                    WHERE x.agent_id = login.agent_id AND x.status IN ('break','lunch','tea','training','meeting','personal_break') AND x.ended_at IS NOT NULL
                      AND x.started_at >= login.started_at
                      AND x.started_at < COALESCE(
                        (SELECT MIN(lo2.started_at) FROM agent_status_events lo2
                            WHERE lo2.agent_id = login.agent_id AND lo2.status = 'logout' AND lo2.started_at > login.started_at),
                        now())) AS break_seconds
         FROM agent_status_events login
         JOIN agents a ON a.id = login.agent_id
         JOIN users u ON u.id = a.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY login.started_at DESC`,
        params
    )).rows;

    res.render('mis/login_activity', { pageTitle: 'MIS — Agent Login/Logout Report', agents, agentId, from, to, rows });
});

module.exports = router;
