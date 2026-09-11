/**
 * Public-facing webchat endpoints -- no login required, since these are
 * called by the customer-facing widget (public/assets/webchat-widget.js)
 * embedded on a tenant's own website. Identified by a public_key, never
 * a session/tenant login. Everything writes into the SAME
 * conversations/conversation_messages tables used by the rest of the
 * omnichannel model -- no parallel chat data store.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../src/db');
const chatbot = require('../src/chatbot');
const mattermostBridge = require('../src/mattermostBridge');

async function getWidgetConfig(publicKey) {
    const res = await pool.query('SELECT * FROM chat_widget_configs WHERE public_key = $1 AND is_active = TRUE', [publicKey]);
    return res.rows[0] || null;
}

router.post('/:publicKey/start', async (req, res) => {
    const widget = await getWidgetConfig(req.params.publicKey);
    if (!widget) return res.status(404).json({ error: 'widget_not_found' });

    const { name, email } = req.body;
    let contactId = null;
    if (email) {
        const existing = await pool.query('SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2 LIMIT 1', [widget.tenant_id, email]);
        if (existing.rows[0]) {
            contactId = existing.rows[0].id;
        } else {
            const created = await pool.query(
                'INSERT INTO contacts (tenant_id, full_name, email) VALUES ($1,$2,$3) RETURNING id',
                [widget.tenant_id, name || null, email]
            );
            contactId = created.rows[0].id;
        }
    }

    const convRes = await pool.query(
        `INSERT INTO conversations (tenant_id, channel, contact_id, queue_id, direction, status, started_at)
         VALUES ($1,'chat',$2,$3,'inbound','open',now()) RETURNING id`,
        [widget.tenant_id, contactId, widget.default_queue_id]
    );
    const conversationId = convRes.rows[0].id;

    await pool.query(
        `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, body, sent_at)
         VALUES ($1,$2,'system',$3,now())`,
        [widget.tenant_id, conversationId, widget.welcome_message]
    );

    res.json({ conversation_id: conversationId, welcome_message: widget.welcome_message });
});

router.post('/:publicKey/message', async (req, res) => {
    const widget = await getWidgetConfig(req.params.publicKey);
    if (!widget) return res.status(404).json({ error: 'widget_not_found' });

    const { conversation_id, body } = req.body;
    if (!conversation_id || !body) return res.status(400).json({ error: 'conversation_id and body are required' });

    const convCheck = await pool.query('SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2', [conversation_id, widget.tenant_id]);
    if (!convCheck.rows[0]) return res.status(404).json({ error: 'conversation_not_found' });

    await pool.query(
        `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, body, sent_at)
         VALUES ($1,$2,'customer',$3,now())`,
        [widget.tenant_id, conversation_id, body]
    );

    let botReplied = false;
    if (widget.bot_enabled) {
        const reply = await chatbot.getReply(widget.tenant_id, body);
        const replyText = reply.matched ? reply.response : widget.bot_fallback_message;
        await pool.query(
            `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, body, sent_at)
             VALUES ($1,$2,'bot',$3,now())`,
            [widget.tenant_id, conversation_id, replyText]
        );
        botReplied = true;
    }

    // Push to Mattermost (if bridged) regardless of bot handling, so a
    // human can jump in on any conversation from Mattermost -- the bot
    // reply above doesn't end the conversation, just answers one message.
    const contactRes = await pool.query(
        `SELECT c.full_name FROM conversations cv LEFT JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = $1`,
        [conversation_id]
    );
    await mattermostBridge.pushCustomerMessage(widget.tenant_id, conversation_id, body, contactRes.rows[0]?.full_name);

    res.json({ ok: true, bot_replied: botReplied });
});

// Simple poll: returns messages after a given message id (or all, if
// omitted). The widget calls this every few seconds -- fine for a
// contact-center-scale chat volume; swap for a websocket push later if
// needed without changing the data model.
router.get('/:publicKey/poll', async (req, res) => {
    const widget = await getWidgetConfig(req.params.publicKey);
    if (!widget) return res.status(404).json({ error: 'widget_not_found' });

    const { conversation_id, after_id } = req.query;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id is required' });

    const convCheck = await pool.query('SELECT id, status FROM conversations WHERE id = $1 AND tenant_id = $2', [conversation_id, widget.tenant_id]);
    if (!convCheck.rows[0]) return res.status(404).json({ error: 'conversation_not_found' });

    const params = [conversation_id];
    let sql = 'SELECT id, sender_type, body, sent_at FROM conversation_messages WHERE conversation_id = $1';
    if (after_id) { sql += ' AND id > $2'; params.push(after_id); }
    sql += ' ORDER BY id';

    const messages = (await pool.query(sql, params)).rows;
    res.json({ messages, status: convCheck.rows[0].status });
});

module.exports = router;
