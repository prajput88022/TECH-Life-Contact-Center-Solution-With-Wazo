const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const callRecordService = require('../src/services/callRecordService');
const phoneMasker = require('../src/phoneMasker');

router.use(requireRole(['supervisor', 'manager', 'admin', 'superadmin', 'reports_only']));

router.get('/', async (req, res) => {
    const t = req.session.user.tenantId;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('supervisor/index', { pageTitle: 'Supervisor — Live Dashboard', queues, campaigns });
});

router.get('/queue-monitor', async (req, res) => {
    const t = req.session.user.tenantId;

    const [queuesRes, agentsRes, ivrRes] = await Promise.all([
        pool.query(`
            SELECT q.id, q.name, q.strategy,
                   COUNT(c.id) FILTER (WHERE c.end_time IS NULL) AS active_calls,
                   COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - c.start_time))), 0)::INT AS longest_wait_seconds
            FROM queues q
            LEFT JOIN calls c ON c.tenant_id = q.tenant_id AND c.queue_id = q.id AND c.end_time IS NULL
            WHERE q.tenant_id = $1
            GROUP BY q.id, q.name, q.strategy
            ORDER BY q.name
        `, [t]),
        pool.query(`
            SELECT a.id, u.full_name AS agent_name,
                   COALESCE((
                       SELECT ase.status
                       FROM agent_status_events ase
                       WHERE ase.tenant_id = $1 AND ase.agent_id = a.id
                       ORDER BY ase.started_at DESC
                       LIMIT 1
                   ), 'offline') AS status,
                   COALESCE((
                       SELECT q.name
                       FROM agent_status_events ase
                       LEFT JOIN queues q ON q.id = ase.queue_id
                       WHERE ase.tenant_id = $1 AND ase.agent_id = a.id
                       ORDER BY ase.started_at DESC
                       LIMIT 1
                   ), 'Unassigned') AS queue_name,
                   COALESCE((
                       SELECT ase.started_at
                       FROM agent_status_events ase
                       WHERE ase.tenant_id = $1 AND ase.agent_id = a.id
                       ORDER BY ase.started_at DESC
                       LIMIT 1
                   ), NOW()) AS last_status_at
            FROM agents a
            LEFT JOIN users u ON u.id = a.user_id
            WHERE a.tenant_id = $1
            ORDER BY u.full_name
        `, [t]),
        pool.query(`
            SELECT im.id, im.name,
                   COUNT(isess.id) AS sessions_24h,
                   COUNT(isess.id) FILTER (WHERE isess.exit_reason = 'queue_transfer') AS transferred_to_queue,
                   COUNT(isess.id) FILTER (WHERE isess.exit_reason = 'agent_transfer') AS transferred_to_agent,
                   COALESCE(MAX(isess.entry_time), NOW() - INTERVAL '1 day') AS last_activity
            FROM ivr_menus im
            LEFT JOIN ivr_sessions isess
                ON isess.tenant_id = im.tenant_id AND isess.ivr_menu_id = im.id
               AND isess.entry_time > NOW() - INTERVAL '24 hours'
            WHERE im.tenant_id = $1
            GROUP BY im.id, im.name
            ORDER BY im.name
        `, [t])
    ]);

    res.render('supervisor/queue_monitor', {
        pageTitle: 'Supervisor — Queue Monitor',
        queues: queuesRes.rows,
        agents: agentsRes.rows,
        ivrMenus: ivrRes.rows
    });
});

router.get('/queue-monitor-data', async (req, res) => {
    const t = req.session.user.tenantId;

    const [queuesRes, agentsRes, ivrRes] = await Promise.all([
        pool.query(`
            SELECT q.id, q.name, q.strategy,
                   COUNT(c.id) FILTER (WHERE c.end_time IS NULL) AS active_calls,
                   COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - c.start_time))), 0)::INT AS longest_wait_seconds
            FROM queues q
            LEFT JOIN calls c ON c.tenant_id = q.tenant_id AND c.queue_id = q.id AND c.end_time IS NULL
            WHERE q.tenant_id = $1
            GROUP BY q.id, q.name, q.strategy
            ORDER BY q.name
        `, [t]),
        pool.query(`
            SELECT a.id, u.full_name AS agent_name,
                   COALESCE((SELECT status FROM agent_status_events WHERE tenant_id = $1 AND agent_id = a.id ORDER BY started_at DESC LIMIT 1), 'offline') AS status,
                   COALESCE((SELECT q.name FROM agent_status_events ase LEFT JOIN queues q ON q.id = ase.queue_id WHERE ase.tenant_id = $1 AND ase.agent_id = a.id ORDER BY ase.started_at DESC LIMIT 1), 'Unassigned') AS queue_name
            FROM agents a
            LEFT JOIN users u ON u.id = a.user_id
            WHERE a.tenant_id = $1
            ORDER BY u.full_name
        `, [t]),
        pool.query(`
            SELECT im.id, im.name,
                   COUNT(isess.id) AS sessions_24h,
                   COUNT(isess.id) FILTER (WHERE isess.exit_reason = 'queue_transfer') AS transferred_to_queue,
                   COUNT(isess.id) FILTER (WHERE isess.exit_reason = 'agent_transfer') AS transferred_to_agent
            FROM ivr_menus im
            LEFT JOIN ivr_sessions isess ON isess.tenant_id = im.tenant_id AND isess.ivr_menu_id = im.id AND isess.entry_time > NOW() - INTERVAL '24 hours'
            WHERE im.tenant_id = $1
            GROUP BY im.id, im.name
            ORDER BY im.name
        `, [t])
    ]);

    res.json({
        queues: queuesRes.rows,
        agents: agentsRes.rows,
        ivr: ivrRes.rows
    });
});

router.get('/chat', async (req, res) => {
    const t = req.session.user.tenantId;
    const conversations = (await pool.query(
        `SELECT cv.id, cv.status, cv.started_at, cv.closed_at,
                q.name AS queue_name, c.full_name AS contact_name, u.full_name AS agent_name,
                (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = cv.id) AS message_count,
                EXTRACT(EPOCH FROM (COALESCE(cv.first_response_at, now()) - cv.started_at))::INT AS wait_seconds
         FROM conversations cv
         LEFT JOIN queues q ON q.id = cv.queue_id
         LEFT JOIN contacts c ON c.id = cv.contact_id
         LEFT JOIN agents ag ON ag.id = cv.agent_id
         LEFT JOIN users u ON u.id = ag.user_id
         WHERE cv.tenant_id = $1 AND cv.channel = 'chat'
         ORDER BY cv.status = 'open' DESC, cv.started_at DESC LIMIT 100`,
        [t]
    )).rows;
    res.render('supervisor/chat', { pageTitle: 'Supervisor — Chat Monitor', conversations });
});

router.get('/calls', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));

    const rows = await callRecordService.search(t, 'supervisor', { from, to }, page);
    const isMasked = rows.length ? rows[0].number_masked : await phoneMasker.shouldMask(t, 'supervisor');

    res.render('supervisor/calls', { pageTitle: 'Supervisor — Call Records', rows, from, to, page, isMasked });
});

module.exports = router;
