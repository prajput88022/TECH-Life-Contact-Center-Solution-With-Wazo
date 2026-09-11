/**
 * Receives replies posted back from Mattermost (configured on the
 * Mattermost side as an outgoing webhook or slash command pointed at
 * this URL). Verified by a per-tenant shared secret, not a login
 * session -- Mattermost itself is the caller, not a browser.
 *
 * Expected POST body (Mattermost's standard outgoing-webhook/slash-
 * command form-encoded fields): token=<shared secret>, text=<message>
 * where text starts with the CONV-XXXXXX marker, e.g.:
 *   "CONV-A1B2C3 Sure, I can help with that!"
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../src/db');
const mattermostBridge = require('../src/mattermostBridge');

router.post('/reply', async (req, res) => {
    const { token, text } = req.body;
    if (!token || !text) return res.status(400).json({ text: 'Missing token or text' });

    const match = text.match(/CONV-([A-F0-9]{6})\s+([\s\S]+)/i);
    if (!match) {
        return res.json({ text: 'Could not find a CONV-XXXXXX marker at the start of your message. Format: `CONV-A1B2C3 your reply`' });
    }
    const [, marker, replyBody] = match;

    // Find which tenant this marker belongs to, then verify the secret
    // against THAT tenant's configured Mattermost integration.
    const linkRes = await pool.query(
        'SELECT tenant_id FROM mattermost_conversation_links WHERE thread_marker = $1',
        [marker.toUpperCase()]
    );
    if (!linkRes.rows[0]) {
        return res.json({ text: `No conversation found for CONV-${marker}.` });
    }
    const tenantId = linkRes.rows[0].tenant_id;

    const integrationRes = await pool.query(
        'SELECT reply_shared_secret FROM mattermost_integrations WHERE tenant_id = $1 AND is_active = TRUE',
        [tenantId]
    );
    const integration = integrationRes.rows[0];
    if (!integration || integration.reply_shared_secret !== token) {
        return res.status(401).json({ text: 'Invalid token.' });
    }

    try {
        await mattermostBridge.handleReply(tenantId, marker.toUpperCase(), replyBody.trim());
        res.json({ text: `Reply sent to CONV-${marker}.` });
    } catch (e) {
        res.json({ text: 'Error: ' + e.message });
    }
});

module.exports = router;
