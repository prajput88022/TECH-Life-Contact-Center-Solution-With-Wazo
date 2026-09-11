/**
 * Listen / Whisper / Barge -- supervisor call monitoring.
 *
 * This is a genuine telephony feature that requires a specific Wazo
 * dialplan context using Asterisk's ChanSpy application (Wazo Platform
 * doesn't currently expose a single public REST "spy" endpoint the way
 * calld exposes call control -- monitoring is done by originating the
 * SUPERVISOR's own leg into a dialplan context that ChanSpy's the
 * target agent's channel). The code here is correct against Wazo's
 * documented calld /calls origination API and standard ChanSpy option
 * conventions, but it has NOT been (and can't be, from this sandbox)
 * verified against a live call on a real Wazo box -- see INSTALL.md
 * for the exact dialplan snippet you need to add and how to verify it.
 *
 * ChanSpy option reference (used in the dialplan snippet, not here):
 *   (no options)  -- listen only
 *   w             -- whisper (supervisor heard by agent only)
 *   B             -- barge (supervisor joins the conversation, heard by both)
 */
const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');

async function getToken() {
    const resp = await wazoFetch(`${config.wazo.authUrl.replace(/\/$/, '')}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${config.wazo.authUsername}:${config.wazo.authPassword}`).toString('base64'),
        },
        body: JSON.stringify({ backend: 'wazo_user', expiration: 300 }),
    });
    const data = await resp.json().catch(() => ({}));
    return data?.data?.token || '';
}

/**
 * Originates the supervisor's monitoring leg. Requires the supervisor's
 * own Wazo user/line to already be set up (same provisioning as an
 * agent -- a supervisor who wants to listen/whisper/barge needs a SIP
 * line too, since the ChanSpy target rings THEM).
 */
async function startMonitoring(tenantId, supervisorUserId, callId, mode) {
    if (!['listen', 'whisper', 'barge'].includes(mode)) {
        throw new Error('mode must be listen, whisper, or barge');
    }

    const callRes = await pool.query(
        'SELECT wazo_call_id FROM calls WHERE id = $1 AND tenant_id = $2', [callId, tenantId]
    );
    const call = callRes.rows[0];
    if (!call || !call.wazo_call_id) throw new Error('Call not found or has no active Wazo channel');

    // Supervisor's own SIP line -- reuses the same wazo_user_id concept
    // as agents; a supervisor monitoring calls needs to be provisioned
    // the same way (see WazoProvisioningService). If your supervisors
    // share a generic "monitor" extension instead, adjust this lookup.
    const supRes = await pool.query(
        `SELECT ag.wazo_user_id FROM agents ag WHERE ag.tenant_id = $1 AND ag.user_id = $2`,
        [tenantId, supervisorUserId]
    );
    const supervisorWazoUserId = supRes.rows[0]?.wazo_user_id;
    if (!supervisorWazoUserId) {
        throw new Error('Supervisor has no provisioned SIP line -- monitoring requires one, same as an agent (see Admin -> Users)');
    }

    const token = await getToken();
    const resp = await wazoFetch(`${config.wazo.calldUrl.replace(/\/$/, '')}/calls`, {
        method: 'POST',
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            source: { user: supervisorWazoUserId },
            destination: { context: 'supervisor-monitor', extension: 's', priority: 1 },
            variables: {
                TECHLIFE_TARGET_CHANNEL: call.wazo_call_id,
                TECHLIFE_SPY_MODE: mode,
            },
        }),
    });
    const originateResult = await resp.json().catch(() => ({}));

    const insertRes = await pool.query(
        `INSERT INTO call_monitoring_sessions (tenant_id, call_id, supervisor_id, mode, wazo_monitor_call_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, callId, supervisorUserId, mode, originateResult.call_id || null]
    );
    return { monitoringSessionId: insertRes.rows[0].id, wazoCallId: originateResult.call_id || null };
}

async function stopMonitoring(tenantId, monitoringSessionId) {
    const sessRes = await pool.query(
        'SELECT wazo_monitor_call_id FROM call_monitoring_sessions WHERE id = $1 AND tenant_id = $2',
        [monitoringSessionId, tenantId]
    );
    const session = sessRes.rows[0];
    await pool.query('UPDATE call_monitoring_sessions SET ended_at = now() WHERE id = $1', [monitoringSessionId]);

    if (session?.wazo_monitor_call_id) {
        const token = await getToken();
        await wazoFetch(`${config.wazo.calldUrl.replace(/\/$/, '')}/calls/${session.wazo_monitor_call_id}`, {
            method: 'DELETE',
            headers: { 'X-Auth-Token': token },
        }).catch(() => {}); // best-effort hangup; the row is closed either way
    }
}

module.exports = { startMonitoring, stopMonitoring };
