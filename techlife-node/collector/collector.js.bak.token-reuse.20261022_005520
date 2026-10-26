#!/usr/bin/env node
/**
 * TECH-Life Wazo Event Collector -- Node.js edition.
 *
 * Run as a long-lived process:
 *   node collector/collector.js
 *
 * Authenticates against wazo-auth, opens a real WebSocket (the `ws`
 * package, not a hand-rolled client) to wazo-websocketd, subscribes to
 * calld/agentd/chatd bus events, translates each into the canonical
 * envelope described in ARCHITECTURE.md, and hands it to EventProcessor.
 *
 * Wazo bus event names vary by platform version -- `mapWazoEvent()`
 * below is the one function to adjust for your specific Wazo install;
 * everything else (auth, reconnect loop, EventProcessor call) is stable.
 */
const WebSocket = require('ws');
const config = require('../config/config');
const { wazoFetch } = require('../src/wazoFetch');
const entityResolver = require('./entityResolver');
const eventProcessor = require('./eventProcessor');

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function getWazoToken() {
    const resp = await wazoFetch(`${config.wazo.authUrl.replace(/\/$/, '')}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${config.wazo.authUsername}:${config.wazo.authPassword}`).toString('base64'),
        },
        body: JSON.stringify({ backend: 'wazo_user', expiration: 3600 }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data?.data?.token) throw new Error('wazo-auth did not return a token: ' + JSON.stringify(data));
    return data.data.token;
}

/** Translate one raw Wazo bus message into our canonical envelope, or null to ignore it. */
async function mapWazoEvent(msg) {
    const name = msg.name;
    const data = msg.data || {};
    if (!name) return null;

    const wazoTenantUuid = msg.origin_uuid || data.tenant_uuid;
    if (!wazoTenantUuid) return null;
    const tenantId = await entityResolver.tenantId(wazoTenantUuid);
    if (!tenantId) return null;

    const now = new Date().toISOString();

    switch (name) {
        case 'agentd_agent_status_update': {
            const typeMap = { logged_in: 'AGENT_LOGIN', logged_out: 'AGENT_LOGOUT', available: 'AGENT_AVAILABLE', paused: 'AGENT_BREAK_START' };
            const type = typeMap[data.status] || 'AGENT_STATUS_CHANGE';
            return {
                tenant_id: tenantId, event_type: type, channel: 'voice', event_time: data.timestamp || now,
                entity_ids: {
                    agent_id: await entityResolver.agentId(tenantId, data.agent_id),
                    queue_id: await entityResolver.queueId(tenantId, data.queue_id),
                },
                payload: { reason_code: data.pause_reason || null, status: data.status || null },
            };
        }
        case 'calld_call_created':
            return {
                tenant_id: tenantId, event_type: 'CALL_STARTED', channel: 'voice', event_time: data.creation_time || now,
                entity_ids: {
                    wazo_call_id: data.call_id,
                    agent_id: await entityResolver.agentId(tenantId, data.agent_id),
                    queue_id: await entityResolver.queueId(tenantId, data.queue_id),
                    did_id: await entityResolver.didId(tenantId, data.dialed_extension),
                    contact_id: await entityResolver.contactIdByPhone(tenantId, data.peer_caller_id_number),
                },
                payload: {
                    direction: (data.direction || 'to-extension') === 'from-extension' ? 'outbound' : 'inbound',
                    from_number: data.peer_caller_id_number || null,
                    to_number: data.dialed_extension || null,
                },
            };
        case 'calld_call_answered':
            return {
                tenant_id: tenantId, event_type: 'CALL_ANSWERED', channel: 'voice', event_time: data.timestamp || now,
                entity_ids: { wazo_call_id: data.call_id, agent_id: await entityResolver.agentId(tenantId, data.agent_id) },
                payload: {},
            };
        case 'calld_call_ended':
            return {
                tenant_id: tenantId, event_type: 'CALL_HANGUP', channel: 'voice', event_time: data.timestamp || now,
                entity_ids: { wazo_call_id: data.call_id },
                payload: { hangup_cause: data.hangup_cause || null, status: data.answered ? 'completed' : 'missed' },
            };
        case 'calld_call_hold':
        case 'calld_call_resume':
            return {
                tenant_id: tenantId, event_type: name === 'calld_call_hold' ? 'CALL_HOLD' : 'CALL_RESUME',
                channel: 'voice', event_time: data.timestamp || now,
                entity_ids: { wazo_call_id: data.call_id }, payload: {},
            };
        case 'chatd_message_created':
            return {
                tenant_id: tenantId, event_type: 'CHAT_MESSAGE', channel: 'chat', event_time: data.created_at || now,
                entity_ids: { conversation_id: data.conversation_uuid, agent_id: await entityResolver.agentId(tenantId, data.agent_id) },
                payload: { sender_type: data.sender_type || 'customer', body: data.content || '' },
            };
        default:
            return null;
    }
}

async function connectAndListen() {
    const token = await getWazoToken();
    log('Authenticated with wazo-auth, connecting to websocketd...');

    const ws = new WebSocket(config.wazo.websocketdUrl, {
        headers: { 'X-Auth-Token': token },
        rejectUnauthorized: config.wazo.tlsRejectUnauthorized,
    });

    return new Promise((resolve, reject) => {
        ws.on('open', () => log('Connected. Listening for bus events...'));
        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                const envelope = await mapWazoEvent(msg);
                if (envelope) await eventProcessor.process(envelope);
            } catch (e) {
                console.error('Error processing bus message:', e.message);
            }
        });
        ws.on('close', () => resolve());
        ws.on('error', (e) => reject(e));
    });
}

async function main() {
    log('TECH-Life Wazo Event Collector starting...');
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            await connectAndListen();
            log('Connection closed, reconnecting in 5s');
        } catch (e) {
            log(`Collector error: ${e.message} -- reconnecting in 5s`);
        }
        await new Promise((r) => setTimeout(r, 5000));
    }
}

if (require.main === module) {
    main();
}

module.exports = { mapWazoEvent };
