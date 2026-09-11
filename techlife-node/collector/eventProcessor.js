/**
 * The ONLY writer to the reporting database, mirroring the PHP
 * EventProcessor exactly. Takes a canonical event envelope and writes
 * to the specific event table AND omnichannel_events in one transaction,
 * keyed by event_uuid so re-delivery is a safe no-op.
 */
const crypto = require('crypto');
const { pool } = require('../src/db');
const crmNotifier = require('../src/crmNotifier');

async function process(envelope) {
    if (!envelope.tenant_id || !envelope.event_type) {
        console.error('EventProcessor: dropping malformed envelope', envelope);
        return;
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        switch (envelope.event_type) {
            case 'AGENT_LOGIN': case 'AGENT_LOGOUT': case 'AGENT_AVAILABLE':
            case 'AGENT_BREAK_START': case 'AGENT_BREAK_END': case 'AGENT_STATUS_CHANGE':
                await handleAgentStatus(client, envelope);
                break;
            case 'CALL_STARTED': case 'CALL_RINGING': case 'CALL_ANSWERED':
            case 'CALL_HOLD': case 'CALL_RESUME': case 'CALL_TRANSFER': case 'CALL_HANGUP':
                await handleCallEvent(client, envelope);
                break;
            case 'IVR_ENTERED': case 'IVR_OPTION_SELECTED': case 'IVR_TIMEOUT':
            case 'IVR_INVALID': case 'IVR_EXITED':
                await handleIvrEvent(client, envelope);
                break;
            case 'QUEUE_JOINED': case 'QUEUE_ABANDONED': case 'QUEUE_ANSWERED': case 'QUEUE_OVERFLOW':
                await handleQueueEvent(client, envelope);
                break;
            case 'CHAT_STARTED': case 'CHAT_ACCEPTED': case 'CHAT_MESSAGE': case 'CHAT_CLOSED':
                await handleChatEvent(client, envelope);
                break;
            default:
                break;
        }

        await writeOmnichannelEvent(client, envelope);
        await client.query('COMMIT');

        // CRM webhook push happens AFTER commit, outside the transaction,
        // since it's an external network call that must never hold a
        // DB transaction open (same rule as the PHP version).
        if (['CALL_STARTED', 'CALL_ANSWERED', 'CALL_HANGUP'].includes(envelope.event_type)) {
            await notifyCrmIfConfigured(envelope);
        }
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('EventProcessor error:', e.message, envelope);
    } finally {
        client.release();
    }
}

async function writeOmnichannelEvent(client, e) {
    const ids = e.entity_ids || {};
    await client.query(
        `INSERT INTO omnichannel_events
            (tenant_id, event_uuid, event_type, channel, conversation_id, contact_id,
             agent_id, queue_id, campaign_id, did_id, call_id, message_id, event_time, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (event_uuid, event_time) DO NOTHING`,
        [e.tenant_id, e.event_uuid || crypto.randomUUID(), e.event_type, e.channel || 'voice',
         ids.conversation_id || null, ids.contact_id || null, ids.agent_id || null, ids.queue_id || null,
         ids.campaign_id || null, ids.did_id || null, ids.call_id || null, ids.message_id || null,
         e.event_time, JSON.stringify(e.payload || {})]
    );
}

async function handleAgentStatus(client, e) {
    const agentId = e.entity_ids?.agent_id;
    if (!agentId) return;
    const statusMap = { AGENT_LOGIN: 'login', AGENT_LOGOUT: 'logout', AGENT_AVAILABLE: 'available', AGENT_BREAK_START: 'break', AGENT_BREAK_END: 'available' };
    const status = statusMap[e.event_type] || e.payload?.status || 'available';

    await client.query(
        `UPDATE agent_status_events SET ended_at = $1 WHERE tenant_id = $2 AND agent_id = $3 AND ended_at IS NULL`,
        [e.event_time, e.tenant_id, agentId]
    );
    if (e.event_type !== 'AGENT_LOGOUT') {
        await client.query(
            `INSERT INTO agent_status_events (tenant_id, agent_id, queue_id, status, reason_code, started_at, source)
             VALUES ($1,$2,$3,$4,$5,$6,'wazo_event')`,
            [e.tenant_id, agentId, e.entity_ids?.queue_id || null, status, e.payload?.reason_code || null, e.event_time]
        );
    }
}

async function handleCallEvent(client, e) {
    const ids = e.entity_ids || {};
    const callRef = ids.wazo_call_id;
    if (!callRef) return;

    if (e.event_type === 'CALL_STARTED') {
        await client.query(
            `INSERT INTO calls (tenant_id, wazo_call_id, agent_id, queue_id, campaign_id, did_id, contact_id,
                direction, from_number, to_number, status, start_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ringing',$11)
             ON CONFLICT (tenant_id, wazo_call_id) DO NOTHING`,
            [e.tenant_id, callRef, ids.agent_id || null, ids.queue_id || null, ids.campaign_id || null,
             ids.did_id || null, ids.contact_id || null, e.payload?.direction || 'inbound',
             e.payload?.from_number || null, e.payload?.to_number || null, e.event_time]
        );
    } else if (e.event_type === 'CALL_ANSWERED') {
        await client.query(
            `UPDATE calls SET answer_time = $1, status = 'answered', agent_id = COALESCE($2, agent_id)
             WHERE tenant_id = $3 AND wazo_call_id = $4`,
            [e.event_time, ids.agent_id || null, e.tenant_id, callRef]
        );
    } else if (e.event_type === 'CALL_HANGUP') {
        await client.query(
            `UPDATE calls SET end_time = $1,
                status = CASE WHEN answer_time IS NOT NULL THEN 'completed' ELSE $2 END,
                hangup_cause = $3
             WHERE tenant_id = $4 AND wazo_call_id = $5`,
            [e.event_time, e.payload?.status || 'missed', e.payload?.hangup_cause || null, e.tenant_id, callRef]
        );
    } else if (['CALL_HOLD', 'CALL_RESUME'].includes(e.event_type)) {
        await appendCallEventRow(client, e, callRef);
        if (e.event_type === 'CALL_RESUME') await recomputeHoldSeconds(client, e.tenant_id, callRef);
        return;
    }
    await appendCallEventRow(client, e, callRef);
}

async function appendCallEventRow(client, e, callRef) {
    const callRes = await client.query('SELECT id FROM calls WHERE tenant_id = $1 AND wazo_call_id = $2', [e.tenant_id, callRef]);
    const call = callRes.rows[0];
    if (!call) return;
    await client.query(
        `INSERT INTO call_events (tenant_id, call_id, event_type, event_time, agent_id, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.tenant_id, call.id, e.event_type.replace('CALL_', ''), e.event_time, e.entity_ids?.agent_id || null, JSON.stringify(e.payload || {})]
    );
}

async function recomputeHoldSeconds(client, tenantId, callRef) {
    await client.query(
        `UPDATE calls c SET hold_seconds = sub.total
         FROM (
            SELECT call_id, SUM(hold_span) AS total FROM (
                SELECT call_id, EXTRACT(EPOCH FROM (
                    LEAD(event_time) OVER (PARTITION BY call_id ORDER BY event_time) - event_time
                ))::INT AS hold_span
                FROM call_events WHERE event_type IN ('HOLD','RESUME')
            ) x WHERE hold_span IS NOT NULL GROUP BY call_id
         ) sub WHERE c.id = sub.call_id AND c.tenant_id = $1 AND c.wazo_call_id = $2`,
        [tenantId, callRef]
    );
}

async function handleIvrEvent(client, e) {
    const ids = e.entity_ids || {};
    const callRef = ids.wazo_call_id;
    let sessionId;

    if (e.event_type === 'IVR_ENTERED' && ids.ivr_menu_id) {
        const callRes = await client.query('SELECT id FROM calls WHERE tenant_id = $1 AND wazo_call_id = $2', [e.tenant_id, callRef]);
        const call = callRes.rows[0];
        const insertRes = await client.query(
            `INSERT INTO ivr_sessions (tenant_id, call_id, contact_id, did_id, ivr_menu_id, entry_time)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [e.tenant_id, call?.id || null, ids.contact_id || null, ids.did_id || null, ids.ivr_menu_id, e.event_time]
        );
        sessionId = insertRes.rows[0].id;
    } else {
        const sessRes = await client.query(
            `SELECT s.id FROM ivr_sessions s JOIN calls c ON c.id = s.call_id
             WHERE c.tenant_id = $1 AND c.wazo_call_id = $2 AND s.exit_time IS NULL
             ORDER BY s.entry_time DESC LIMIT 1`,
            [e.tenant_id, callRef]
        );
        sessionId = sessRes.rows[0]?.id;
    }
    if (!sessionId) return;

    const stepRes = await client.query('SELECT COALESCE(MAX(step_number),0)+1 AS n FROM ivr_events WHERE ivr_session_id = $1', [sessionId]);
    const step = stepRes.rows[0].n;

    await client.query(
        `INSERT INTO ivr_events (tenant_id, ivr_session_id, step_number, node_name, event_type, dtmf_input, event_time, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.tenant_id, sessionId, step, e.payload?.node_name || 'unknown', e.event_type.replace('IVR_', ''),
         e.payload?.dtmf || null, e.event_time, JSON.stringify(e.payload || {})]
    );

    if (e.event_type === 'IVR_INVALID') {
        await client.query('UPDATE ivr_sessions SET invalid_count = invalid_count + 1, steps_count = steps_count + 1 WHERE id = $1', [sessionId]);
    } else if (e.event_type === 'IVR_TIMEOUT') {
        await client.query('UPDATE ivr_sessions SET timeout_count = timeout_count + 1, steps_count = steps_count + 1 WHERE id = $1', [sessionId]);
    } else if (e.event_type === 'IVR_EXITED') {
        await client.query(
            `UPDATE ivr_sessions SET exit_time = $1, exit_reason = $2, final_queue_id = $3, final_agent_id = $4, steps_count = steps_count + 1 WHERE id = $5`,
            [e.event_time, e.payload?.exit_reason || 'hangup', ids.queue_id || null, ids.agent_id || null, sessionId]
        );
    } else {
        await client.query('UPDATE ivr_sessions SET steps_count = steps_count + 1 WHERE id = $1', [sessionId]);
    }
}

async function handleQueueEvent(client, e) {
    const ids = e.entity_ids || {};
    if (!ids.queue_id) return;
    const callRes = await client.query('SELECT id FROM calls WHERE tenant_id = $1 AND wazo_call_id = $2', [e.tenant_id, ids.wazo_call_id || '']);
    await client.query(
        `INSERT INTO queue_events (tenant_id, queue_id, call_id, event_type, agent_id, event_time, wait_seconds, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [e.tenant_id, ids.queue_id, callRes.rows[0]?.id || null, e.event_type.replace('QUEUE_', ''),
         ids.agent_id || null, e.event_time, e.payload?.wait_seconds || null, JSON.stringify(e.payload || {})]
    );
}

async function handleChatEvent(client, e) {
    const ids = e.entity_ids || {};
    if (e.event_type === 'CHAT_STARTED') {
        await client.query(
            `INSERT INTO conversations (tenant_id, channel, contact_id, queue_id, direction, status, started_at)
             VALUES ($1,'chat',$2,$3,'inbound','open',$4)`,
            [e.tenant_id, ids.contact_id || null, ids.queue_id || null, e.event_time]
        );
        return;
    }
    if (!ids.conversation_id) return;
    if (e.event_type === 'CHAT_ACCEPTED') {
        await client.query(
            `UPDATE conversations SET agent_id = $1, first_response_at = COALESCE(first_response_at, $2) WHERE id = $3`,
            [ids.agent_id || null, e.event_time, ids.conversation_id]
        );
    } else if (e.event_type === 'CHAT_MESSAGE') {
        await client.query(
            `INSERT INTO conversation_messages (tenant_id, conversation_id, sender_type, agent_id, body, sent_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [e.tenant_id, ids.conversation_id, e.payload?.sender_type || 'customer', ids.agent_id || null, e.payload?.body || '', e.event_time]
        );
    } else if (e.event_type === 'CHAT_CLOSED') {
        await client.query(`UPDATE conversations SET status = 'closed', closed_at = $1 WHERE id = $2`, [e.event_time, ids.conversation_id]);
    }
}

async function notifyCrmIfConfigured(e) {
    const callRes = await pool.query(
        `SELECT c.id, c.from_number, c.to_number, c.direction,
                ag.extension AS agent_extension, q.name AS queue_name, camp.name AS campaign_name,
                disp.code AS disposition_code
         FROM calls c
         LEFT JOIN agents ag ON ag.id = c.agent_id
         LEFT JOIN queues q ON q.id = c.queue_id
         LEFT JOIN campaigns camp ON camp.id = c.campaign_id
         LEFT JOIN dispositions disp ON disp.id = c.disposition_id
         WHERE c.tenant_id = $1 AND c.wazo_call_id = $2`,
        [e.tenant_id, e.entity_ids?.wazo_call_id]
    );
    const call = callRes.rows[0];
    if (!call) return;
    await crmNotifier.notify(e.tenant_id, e.event_type, {
        call_id: call.id,
        customer_number: call.direction === 'inbound' ? call.from_number : call.to_number,
        agent_extension: call.agent_extension,
        direction: call.direction,
        queue_name: call.queue_name,
        campaign_name: call.campaign_name,
        disposition_code: call.disposition_code,
    });
}

module.exports = { process };
