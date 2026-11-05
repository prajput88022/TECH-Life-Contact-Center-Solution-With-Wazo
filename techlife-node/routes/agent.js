const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const callRecordService = require('../src/services/callRecordService');
const phoneMasker = require('../src/phoneMasker');
const { loadTenantAppearance } = require('../src/tenantAppearance');
const { requireFeature, loadTenantFeatures } = require('../src/tenantFeatures');

router.use(requireRole(['agent', 'supervisor', 'admin', 'superadmin']));
router.use(loadTenantAppearance);
router.use(loadTenantFeatures);
router.use('/chat', requireFeature('omnichannel'));
router.use('/staff-chat', require('./staffChat')('agent'));

router.get('/', requireFeature('voice'), async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) {
        return res.render('agent/no_profile', { pageTitle: 'Agent Workspace' });
    }
    const callsToday = (await pool.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(talk_seconds),0) AS talk
         FROM calls WHERE tenant_id = $1 AND agent_id = $2 AND start_time::date = CURRENT_DATE`,
        [u.tenantId, u.agentId]
    )).rows[0];
    const pauseCodes = (await pool.query(
        `SELECT id, code, label, max_duration_seconds
         FROM pause_codes
         WHERE tenant_id = $1 AND is_active = TRUE
         ORDER BY sort_order, code`,
        [u.tenantId]
    )).rows;

    const callSettingsResult = await pool.query(
        `SELECT inbound_auto_answer_enabled
           FROM tenant_call_settings
          WHERE tenant_id = $1`,
        [u.tenantId]
    );
    const inboundAutoAnswerEnabled =
        callSettingsResult.rows[0]?.inbound_auto_answer_enabled === true;

    res.render('agent/index', {
        pageTitle: 'Agent Workspace',
        callsToday,
        agentId: u.agentId,
        fullName: u.fullName,
        pauseCodes,
        inboundAutoAnswerEnabled,
        statuses: ['available','break','lunch','tea','training','meeting','system_issue','personal_break','offline'],
    });
});

// ---------------- Customer Chat Inbox ----------------
router.get('/chat', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.render('agent/no_profile', { pageTitle: 'Chat Inbox' });

    const conversations = (await pool.query(
        `SELECT cv.id, cv.status, cv.started_at, cv.queue_id,
                q.name AS queue_name,
                c.full_name AS contact_name,
                (SELECT m.body FROM conversation_messages m
                  WHERE m.tenant_id = cv.tenant_id
                    AND m.conversation_id = cv.id
                  ORDER BY m.id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM conversation_messages m
                  WHERE m.tenant_id = cv.tenant_id
                    AND m.conversation_id = cv.id) AS message_count
         FROM conversations cv
         LEFT JOIN queues q
           ON q.tenant_id = cv.tenant_id AND q.id = cv.queue_id
         LEFT JOIN contacts c
           ON c.tenant_id = cv.tenant_id AND c.id = cv.contact_id
         WHERE cv.tenant_id = $1
           AND cv.channel = 'chat'
           AND cv.status = 'open'
           AND (
                cv.agent_id = $2
                OR (
                    cv.agent_id IS NULL
                    AND cv.queue_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM queue_agents qa
                        WHERE qa.tenant_id = cv.tenant_id
                          AND qa.queue_id = cv.queue_id
                          AND qa.agent_id = $2
                          AND qa.is_active = TRUE
                    )
                )
           )
         ORDER BY cv.started_at ASC`,
        [u.tenantId, u.agentId]
    )).rows;

    res.render('agent/chat', {
        pageTitle: 'Chat Inbox',
        conversations,
        agentId: u.agentId
    });
});

router.get('/chat/:id', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.status(403).send('Agent profile required');

    const convRes = await pool.query(
        `SELECT cv.*, c.full_name AS contact_name
         FROM conversations cv
         LEFT JOIN contacts c
           ON c.tenant_id = cv.tenant_id AND c.id = cv.contact_id
         WHERE cv.id = $1
           AND cv.tenant_id = $2
           AND cv.channel = 'chat'
           AND (
                cv.agent_id = $3
                OR (
                    cv.agent_id IS NULL
                    AND cv.status = 'open'
                    AND cv.queue_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM queue_agents qa
                        WHERE qa.tenant_id = cv.tenant_id
                          AND qa.queue_id = cv.queue_id
                          AND qa.agent_id = $3
                          AND qa.is_active = TRUE
                    )
                )
           )`,
        [req.params.id, u.tenantId, u.agentId]
    );

    const conversation = convRes.rows[0];
    if (!conversation) return res.status(404).send('Conversation not found');

    const messages = (await pool.query(
        `SELECT m.id, m.sender_type, m.body, m.sent_at
         FROM conversation_messages m
         WHERE m.tenant_id = $1 AND m.conversation_id = $2
         ORDER BY m.id`,
        [u.tenantId, req.params.id]
    )).rows;

    res.render('agent/chat_thread', {
        pageTitle: 'Chat',
        conversation,
        messages,
        agentId: u.agentId
    });
});

router.post('/chat/:id/claim', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.status(403).send('Agent profile required');

    const claimed = await pool.query(
        `UPDATE conversations cv
         SET agent_id = $1,
             first_response_at = COALESCE(cv.first_response_at, now())
         WHERE cv.id = $2
           AND cv.tenant_id = $3
           AND cv.channel = 'chat'
           AND cv.status = 'open'
           AND cv.agent_id IS NULL
           AND cv.queue_id IS NOT NULL
           AND EXISTS (
               SELECT 1
               FROM queue_agents qa
               WHERE qa.tenant_id = cv.tenant_id
                 AND qa.queue_id = cv.queue_id
                 AND qa.agent_id = $1
                 AND qa.is_active = TRUE
           )
         RETURNING cv.id`,
        [u.agentId, req.params.id, u.tenantId]
    );

    if (!claimed.rowCount) {
        return res.status(409).send(
            'This chat is no longer available to claim, or you are not an active member of its queue.'
        );
    }

    res.redirect(`/agent/chat/${req.params.id}`);
});

router.post('/chat/:id/reply', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.status(403).send('Agent profile required');

    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 4000) {
        return res.status(400).send('Message must contain between 1 and 4000 characters.');
    }

    const inserted = await pool.query(
        `INSERT INTO conversation_messages
            (tenant_id, conversation_id, sender_type, agent_id, body, sent_at)
         SELECT cv.tenant_id, cv.id, 'agent', $1, $4, now()
         FROM conversations cv
         WHERE cv.id = $2
           AND cv.tenant_id = $3
           AND cv.channel = 'chat'
           AND cv.status = 'open'
           AND cv.agent_id = $1
         RETURNING id`,
        [u.agentId, req.params.id, u.tenantId, body]
    );

    if (!inserted.rowCount) {
        return res.status(404).send('Open conversation not found or not assigned to you.');
    }

    await pool.query(
        `UPDATE conversations
         SET first_response_at = COALESCE(first_response_at, now())
         WHERE id = $1 AND tenant_id = $2 AND agent_id = $3`,
        [req.params.id, u.tenantId, u.agentId]
    );

    res.redirect(`/agent/chat/${req.params.id}`);
});

router.post('/chat/:id/close', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.status(403).send('Agent profile required');

    const closed = await pool.query(
        `UPDATE conversations
         SET status = 'closed', closed_at = now()
         WHERE id = $1
           AND tenant_id = $2
           AND channel = 'chat'
           AND status = 'open'
           AND agent_id = $3
         RETURNING id`,
        [req.params.id, u.tenantId, u.agentId]
    );

    if (!closed.rowCount) {
        return res.status(404).send('Open conversation not found or not assigned to you.');
    }

    res.redirect('/agent/chat');
});

// JSON polling uses the same ownership and queue-eligibility rules as the thread page.
router.get('/chat/:id/messages.json', async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) return res.status(403).json({ error: 'agent_profile_required' });

    const convCheck = await pool.query(
        `SELECT cv.id
         FROM conversations cv
         WHERE cv.id = $1
           AND cv.tenant_id = $2
           AND cv.channel = 'chat'
           AND (
                cv.agent_id = $3
                OR (
                    cv.agent_id IS NULL
                    AND cv.status = 'open'
                    AND cv.queue_id IS NOT NULL
                    AND EXISTS (
                        SELECT 1
                        FROM queue_agents qa
                        WHERE qa.tenant_id = cv.tenant_id
                          AND qa.queue_id = cv.queue_id
                          AND qa.agent_id = $3
                          AND qa.is_active = TRUE
                    )
                )
           )`,
        [req.params.id, u.tenantId, u.agentId]
    );

    if (!convCheck.rowCount) {
        return res.status(404).json({ error: 'not_found' });
    }

    const messages = (await pool.query(
        `SELECT id, sender_type, body, sent_at
         FROM conversation_messages
         WHERE tenant_id = $1 AND conversation_id = $2
         ORDER BY id`,
        [u.tenantId, req.params.id]
    )).rows;

    res.json({ messages });
});

router.get('/calls', requireFeature('voice'), async (req, res) => {
    const u = req.session.user;
    if (!u.agentId) {
        return res.render('agent/no_profile', { pageTitle: 'My Calls' });
    }
    const today = new Date().toISOString().slice(0, 10);
    const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
    const from = req.query.from || defaultFrom + ' 00:00:00';
    const to = req.query.to || today + ' 23:59:59';
    const rows = await callRecordService.search(u.tenantId, 'agent', { from, to, restrict_to_agent_id: u.agentId });
    const isMasked = rows.length ? rows[0].number_masked : await phoneMasker.shouldMask(u.tenantId, 'agent');
    res.render('agent/calls', { pageTitle: 'My Calls', rows, from, to, isMasked });
});

module.exports = router;
