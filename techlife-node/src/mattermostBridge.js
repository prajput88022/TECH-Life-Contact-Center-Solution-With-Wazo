/**
 * Mattermost bridge: pushes new customer chat messages to a Mattermost
 * channel via Mattermost's own "incoming webhook" integration (a
 * standard, well-documented Mattermost feature -- just a POST of
 * {text: "..."} to a URL Mattermost gives you when you add an incoming
 * webhook in its System Console). Replies come back via a Mattermost
 * "outgoing webhook" or slash command configured on the Mattermost
 * side to POST to /mattermost/reply (routes/mattermostReply.js) with a
 * shared secret.
 *
 * Threading: Mattermost's incoming webhooks don't return a post id we
 * could reference for a real reply-to-thread, so we embed a short
 * [CONV-XXXXXX] marker in the message text and match on that when a
 * reply comes back (see mattermost_conversation_links).
 */
const crypto = require('crypto');
const { pool } = require('./db');

async function pushCustomerMessage(tenantId, conversationId, messageBody, contactName) {
    const integrationRes = await pool.query(
        'SELECT * FROM mattermost_integrations WHERE tenant_id = $1 AND is_active = TRUE',
        [tenantId]
    );
    const integration = integrationRes.rows[0];
    if (!integration) return; // no Mattermost bridge configured for this tenant

    let linkRes = await pool.query(
        'SELECT thread_marker FROM mattermost_conversation_links WHERE conversation_id = $1',
        [conversationId]
    );
    let marker = linkRes.rows[0]?.thread_marker;
    if (!marker) {
        marker = crypto.randomBytes(3).toString('hex').toUpperCase();
        await pool.query(
            'INSERT INTO mattermost_conversation_links (tenant_id, conversation_id, thread_marker) VALUES ($1,$2,$3)',
            [tenantId, conversationId, marker]
        );
    }

    const text = `**New chat message** [CONV-${marker}]\n**From:** ${contactName || 'Website visitor'}\n**Message:** ${messageBody}\n\n_Reply with_ \`/techlife-reply CONV-${marker} your message\` _to respond._`;

    try {
        await fetch(integration.incoming_webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        });
    } catch (e) {
        console.error('Mattermost push failed:', e.message);
    }
}

/** Called by routes/mattermostReply.js when Mattermost posts a reply back. */
async function handleReply(tenantId, threadMarker, replyBody) {
    const linkRes = await pool.query(
        'SELECT conversation_id FROM mattermost_conversation_links WHERE tenant_id = $1 AND thread_marker = $2',
        [tenantId, threadMarker]
    );
    const conversationId = linkRes.rows[0]?.conversation_id;
    if (!conversationId) throw new Error(`No conversation found for marker CONV-${threadMarker}`);

    await pool.query(
        `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, body, sent_at)
         VALUES ($1,$2,'agent',$3,now())`,
        [tenantId, conversationId, replyBody]
    );
    return conversationId;
}

module.exports = { pushCustomerMessage, handleReply };
