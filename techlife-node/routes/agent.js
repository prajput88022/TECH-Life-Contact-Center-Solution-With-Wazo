const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const callRecordService = require('../src/services/callRecordService');
const phoneMasker = require('../src/phoneMasker');

router.use(requireRole(['agent', 'supervisor', 'admin', 'superadmin']));

router.get('/', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) {
        return res.render('agent/no_profile', { pageTitle: 'Agent Workspace' });
    }
    const callsToday = (await pool.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(talk_seconds),0) AS talk
         FROM calls WHERE tenant_id = $1 AND agent_id = $2 AND start_time::date = CURRENT_DATE`,
        [u.tenantId, u.agentId]
    )).rows[0];
    res.render('agent/index', {
        pageTitle: 'Agent Workspace',
        callsToday,
        agentId: u.agentId,
        fullName: u.fullName,
        statuses: ['available','break','lunch','tea','training','meeting','system_issue','personal_break','after_call_work','offline'],
    });
});

// ---------------- Chat Inbox ----------------
router.get('/chat', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.render('agent/no_profile', { pageTitle: 'Chat Inbox' });

    const conversations = (await pool.query(
        `SELECT cv.id, cv.status, cv.started_at, cv.queue_id, q.name AS queue_name,
                c.full_name AS contact_name,
                (SELECT body FROM conversation_messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = cv.id) AS message_count
         FROM conversations cv
         LEFT JOIN queues q ON q.id = cv.queue_id
         LEFT JOIN contacts c ON c.id = cv.contact_id
         WHERE cv.tenant_id = $1 AND cv.channel = 'chat' AND cv.status = 'open'
           AND (cv.agent_id = $2 OR cv.agent_id IS NULL)
         ORDER BY cv.started_at DESC`,
        [u.tenantId, u.agentId]
    )).rows;

    res.render('agent/chat', { pageTitle: 'Chat Inbox', conversations, agentId: u.agentId });
});

router.get('/chat/:id', async (req, res) => {
    const u = req.session.user;
    const convRes = await pool.query(
        `SELECT cv.*, c.full_name AS contact_name FROM conversations cv
         LEFT JOIN contacts c ON c.id = cv.contact_id
         WHERE cv.id = $1 AND cv.tenant_id = $2`,
        [req.params.id, u.tenantId]
    );
    const conversation = convRes.rows[0];
    if (!conversation) return res.status(404).send('Conversation not found');

    const messages = (await pool.query(
        'SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY id', [req.params.id]
    )).rows;

    res.render('agent/chat_thread', { pageTitle: 'Chat', conversation, messages, agentId: u.agentId });
});

router.post('/chat/:id/claim', async (req, res) => {
    const u = req.session.user;
    await pool.query(
        `UPDATE conversations SET agent_id = $1, first_response_at = COALESCE(first_response_at, now())
         WHERE id = $2 AND tenant_id = $3 AND agent_id IS NULL`,
        [u.agentId, req.params.id, u.tenantId]
    );
    res.redirect(`/agent/chat/${req.params.id}`);
});

router.post('/chat/:id/reply', async (req, res) => {
    const u = req.session.user;
    await pool.query(
        `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, agent_id, body, sent_at)
         VALUES ($1,$2,'agent',$3,$4,now())`,
        [u.tenantId, req.params.id, u.agentId, req.body.body]
    );
    res.redirect(`/agent/chat/${req.params.id}`);
});

router.post('/chat/:id/close', async (req, res) => {
    const u = req.session.user;
    await pool.query(`UPDATE conversations SET status = 'closed', closed_at = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, u.tenantId]);
    res.redirect('/agent/chat');
});

// JSON endpoint for the chat thread page's polling refresh.
router.get('/chat/:id/messages.json', async (req, res) => {
    const u = req.session.user;
    const convCheck = await pool.query('SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2', [req.params.id, u.tenantId]);
    if (!convCheck.rows[0]) return res.status(404).json({ error: 'not_found' });
    const messages = (await pool.query('SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY id', [req.params.id])).rows;
    res.json({ messages });
});

router.get('/calls', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) {
        return res.render('agent/no_profile', { pageTitle: 'My Calls' });
    }
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const rows = await callRecordService.search(u.tenantId, 'agent', { from, to, restrict_to_agent_id: u.agentId });
    const isMasked = rows.length ? rows[0].number_masked : await phoneMasker.shouldMask(u.tenantId, 'agent');
    res.render('agent/calls', { pageTitle: 'My Calls', rows, from, to, isMasked });
});

module.exports = router;
