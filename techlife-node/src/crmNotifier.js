/**
 * Pushes signed call-event webhooks to a tenant's configured CRM/CTI
 * endpoint. Called from the Event Processor on CALL_STARTED /
 * CALL_ANSWERED / CALL_HANGUP. Failures are logged, never thrown --
 * a slow/unreachable CRM endpoint must never block event processing.
 */
const crypto = require('crypto');
const { pool } = require('./db');

async function notify(tenantId, eventType, callContext) {
    const res = await pool.query(
        `SELECT * FROM crm_integrations WHERE tenant_id = $1 AND is_active = TRUE AND webhook_enabled = TRUE`,
        [tenantId]
    );
    for (const integration of res.rows) {
        const allowedEvents = (integration.webhook_events || '').split(',').map((s) => s.trim());
        if (!allowedEvents.includes(eventType)) continue;
        if (!integration.webhook_url) continue;
        await send(integration, eventType, callContext);
    }
}

async function send(integration, eventType, callContext) {
    const payload = JSON.stringify({
        event: eventType,
        call_id: callContext.call_id || null,
        timestamp: new Date().toISOString(),
        customer_number: callContext.customer_number || null,
        agent_extension: callContext.agent_extension || null,
        direction: callContext.direction || null,
        queue_name: callContext.queue_name || null,
        campaign_name: callContext.campaign_name || null,
        disposition_code: callContext.disposition_code || null,
    });
    const signature = 'sha256=' + crypto.createHmac('sha256', integration.webhook_secret || '').update(payload).digest('hex');

    let httpStatus = null;
    let errorMessage = null;
    let success = false;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(integration.webhook_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-TechLife-Signature': signature,
                'X-TechLife-Event': eventType,
            },
            body: payload,
            signal: controller.signal,
        });
        clearTimeout(timeout);
        httpStatus = resp.status;
        success = resp.status >= 200 && resp.status < 300;
    } catch (e) {
        errorMessage = e.message;
    }

    await pool.query(
        `INSERT INTO crm_webhook_deliveries (tenant_id, crm_integration_id, call_id, event_type, http_status, success, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [integration.tenant_id, integration.id, callContext.call_id || null, eventType, httpStatus, success, errorMessage]
    );
}

module.exports = { notify };
