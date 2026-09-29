/**
 * Creates (or reuses) a Wazo SIP line for an agent, so the browser-based
 * WebRTC workspace has something to register with. Port of the PHP
 * WazoProvisioningService -- same confd call sequence, same auto-numbering
 * range logic.
 */
const crypto = require('crypto');
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
    if (!data?.data?.token) {
        throw new Error('Unable to obtain wazo-auth token for provisioning');
    }
    return data.data.token;
}

async function confdRequest(method, path, token, body) {
    const resp = await wazoFetch(`${config.wazo.confdUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    if (resp.status >= 400) {
        const text = await resp.text().catch(() => '');
        throw new Error(`confd ${method} ${path} failed (${resp.status}): ${text}`);
    }
    return resp.status === 204 ? {} : resp.json().catch(() => ({}));
}

async function nextAvailableExtension(tenantId) {
    const rangeStart = config.wazo.agentExtensionRangeStart;
    const rangeEnd = config.wazo.agentExtensionRangeEnd;
    const res = await pool.query(
        `SELECT extension FROM agents
         WHERE tenant_id = $1 AND extension ~ '^[0-9]+$' AND extension::int BETWEEN $2 AND $3
         ORDER BY extension::int`,
        [tenantId, rangeStart, rangeEnd]
    );
    const used = new Set(res.rows.map((r) => parseInt(r.extension, 10)));
    for (let candidate = rangeStart; candidate <= rangeEnd; candidate++) {
        if (!used.has(candidate)) return String(candidate);
    }
    throw new Error('No free extension in configured range');
}

async function sipDomain(tenantId) {
    const res = await pool.query('SELECT sip_domain FROM tenants WHERE id = $1', [tenantId]);
    return res.rows[0]?.sip_domain || config.wazo.sipDomain || config.wazo.host;
}

async function provisionForAgent(tenantId, agentId, requestedExtension = null) {
    try {
        const extension = requestedExtension || (await nextAvailableExtension(tenantId));
        const token = await getToken();

        const sipUsername = 'agt' + extension;
        const sipPassword = crypto.randomBytes(12).toString('hex');

        const agentRes = await pool.query(
            `SELECT u.full_name FROM agents a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = $1 AND a.id = $2`,
            [tenantId, agentId]
        );
        const fullName = agentRes.rows[0]?.full_name || `Agent ${extension}`;

        const wazoUser = await confdRequest('POST', '/users', token, { firstname: fullName });
        const wazoLine = await confdRequest('POST', '/lines', token, {
            protocol: 'sip',
            device_slot: 1,
            endpoint_sip: {
                auth_section_options: [['username', sipUsername], ['password', sipPassword]],
                endpoint_section_options: [['webrtc', 'yes'], ['transport', 'wss']],
            },
        });
        const wazoExtension = await confdRequest('POST', '/extensions', token, {
            exten: extension,
            context: config.wazo.defaultContext,
        });
        await confdRequest('PUT', `/users/${wazoUser.id}/lines/${wazoLine.id}`, token, {});
        await confdRequest('PUT', `/lines/${wazoLine.id}/extensions/${wazoExtension.id}`, token, {});

        const domain = await sipDomain(tenantId);
        await pool.query(
            `UPDATE agents SET agent_number = $1, extension = $1, sip_username = $2, sip_password = $3,
                sip_domain = $4, wazo_user_id = $5, wazo_line_id = $6, wazo_extension_id = $7,
                provisioning_status = 'provisioned', provisioning_error = NULL
             WHERE tenant_id = $8 AND id = $9`,
            [extension, sipUsername, sipPassword, domain, wazoUser.id, wazoLine.id, wazoExtension.id, tenantId, agentId]
        );
        return { ok: true, extension, sip_username: sipUsername };
    } catch (e) {
        await pool.query(
            `UPDATE agents SET provisioning_status = 'failed', provisioning_error = $1 WHERE tenant_id = $2 AND id = $3`,
            [e.message, tenantId, agentId]
        );
        return { ok: false, error: e.message };
    }
}

async function attachManualLine(tenantId, agentId, extension, sipUsername, sipPassword) {
    const domain = await sipDomain(tenantId);
    await pool.query(
        `UPDATE agents SET agent_number = $1, extension = $1, sip_username = $2, sip_password = $3,
            sip_domain = $4, provisioning_status = 'manual', provisioning_error = NULL
         WHERE tenant_id = $5 AND id = $6`,
        [extension, sipUsername, sipPassword, domain, tenantId, agentId]
    );
}

module.exports = { provisionForAgent, attachManualLine };
