const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const callRecordService = require('../src/services/callRecordService');
const phoneMasker = require('../src/phoneMasker');

router.use(requireRole(['supervisor', 'admin', 'superadmin']));

router.get('/', async (req, res) => {
    const t = req.session.user.tenantId;
    const queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    const campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    res.render('supervisor/index', { pageTitle: 'Supervisor — Live Dashboard', queues, campaigns });
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
