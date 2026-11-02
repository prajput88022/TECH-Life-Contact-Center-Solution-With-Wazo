'use strict';

const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedToken;
    }

    const response = await wazoFetch(
        `${config.wazo.authUrl.replace(/\/$/, '')}/token`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(
                    `${config.wazo.authUsername}:${config.wazo.authPassword}`
                ).toString('base64')
            },
            body: JSON.stringify({
                backend: 'wazo_user',
                expiration: 600
            })
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.data?.token) {
        const error = new Error(`Wazo authentication failed (HTTP ${response.status})`);
        error.status = response.status;
        throw error;
    }

    cachedToken = data.data.token;
    tokenExpiresAt = Date.now() + 600 * 1000;
    return cachedToken;
}

async function request(method, path, tenantUuid, body) {
    if (!tenantUuid) throw new Error('Wazo tenant UUID is required');

    const headers = {
        'X-Auth-Token': await getToken(),
        'Wazo-Tenant': tenantUuid,
        Accept: 'application/json'
    };

    const options = { method, headers };

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const base = config.wazo.agentdInternalUrl.replace(/\/$/, '');
    const response = await wazoFetch(`${base}${path}`, options);
    const raw = await response.text();

    if (!response.ok) {
        const error = new Error(
            `Wazo agentd ${method} ${path} failed (HTTP ${response.status}): ${raw.slice(0, 500)}`
        );
        error.status = response.status;
        throw error;
    }

    let data = {};
    if (raw) {
        try { data = JSON.parse(raw); } catch (_) { data = {}; }
    }
    return { status: response.status, data };
}

async function getAgent(tenantUuid, agentNumber, expectedAgentId) {
    const path = `/agents/by-number/${encodeURIComponent(agentNumber)}`;
    const result = await request('GET', path, tenantUuid);
    const agent = result.data;

    if (
        Number(agent.id) !== Number(expectedAgentId) ||
        String(agent.number) !== String(agentNumber) ||
        String(agent.tenant_uuid).toLowerCase() !== String(tenantUuid).toLowerCase()
    ) {
        throw new Error('Wazo agent identity or tenant verification failed');
    }

    return agent;
}

async function pauseAgent(tenantUuid, agentNumber, expectedAgentId, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 80) {
        throw new Error('Invalid Wazo pause reason');
    }

    const agent = await getAgent(tenantUuid, agentNumber, expectedAgentId);
    if (!agent.logged) {
        const error = new Error('Wazo agent is not logged in');
        error.status = 409;
        throw error;
    }

    if (agent.paused) {
        if (agent.paused_reason === reason) return { changed: false, agent };
        const error = new Error('Wazo agent is already paused for another reason');
        error.status = 409;
        throw error;
    }

    await request(
        'POST',
        `/agents/by-number/${encodeURIComponent(agentNumber)}/pause`,
        tenantUuid,
        { reason }
    );

    const verified = await getAgent(tenantUuid, agentNumber, expectedAgentId);
    if (!verified.paused) {
        throw new Error('Wazo did not confirm the agent pause');
    }

    return { changed: true, agent: verified };
}

async function unpauseAgent(tenantUuid, agentNumber, expectedAgentId, expectedReason) {
    const agent = await getAgent(tenantUuid, agentNumber, expectedAgentId);

    if (!agent.logged) {
        const error = new Error('Wazo agent is not logged in');
        error.status = 409;
        throw error;
    }

    if (!agent.paused) return { changed: false, agent };

    if (!expectedReason || agent.paused_reason !== expectedReason) {
        const error = new Error('Wazo pause reason does not match the TECH-Life status');
        error.status = 409;
        throw error;
    }

    await request(
        'POST',
        `/agents/by-number/${encodeURIComponent(agentNumber)}/unpause`,
        tenantUuid
    );

    const verified = await getAgent(tenantUuid, agentNumber, expectedAgentId);
    if (verified.paused) {
        throw new Error('Wazo still reports the agent as paused');
    }

    return { changed: true, agent: verified };
}


async function getAgentLoginTarget(tenantUuid, lineId, extension) {
    if (!lineId || !extension) {
        throw new Error('Wazo line ID and extension are required for agent login');
    }

    const response = await wazoFetch(
        `${config.wazo.confdUrl.replace(/\/$/, '')}/lines/${encodeURIComponent(lineId)}`,
        {
            headers: {
                'X-Auth-Token': await getToken(),
                'Wazo-Tenant': tenantUuid,
                Accept: 'application/json'
            }
        }
    );

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!response.ok) {
        const error = new Error(
            `Wazo line lookup failed (HTTP ${response.status})`
        );
        error.status = response.status;
        throw error;
    }

    const line = payload?.data?.data ?? payload?.data ?? payload;

    if (
        Number(line.id) !== Number(lineId) ||
        String(line.tenant_uuid || '').toLowerCase() !==
            String(tenantUuid).toLowerCase()
    ) {
        throw new Error('Wazo line identity or tenant verification failed');
    }

    if (String(line.protocol || '').toLowerCase() !== 'sip') {
        throw new Error('Wazo agent line is not a supported SIP line');
    }

    const endpointName = String(line.endpoint_sip?.name || '').trim();
    if (!endpointName || /[\s/@;]/.test(endpointName)) {
        throw new Error('Wazo SIP endpoint name is missing or invalid');
    }

    const extensionRecord = (line.extensions || []).find(
        item => String(item.exten) === String(extension)
    );

    if (
        !extensionRecord ||
        !extensionRecord.context ||
        String(extensionRecord.context) !== String(line.context)
    ) {
        throw new Error('Wazo line extension/context relationship is invalid');
    }

    return {
        extension: String(extensionRecord.exten),
        context: String(extensionRecord.context),
        endpoint: `PJSIP/${endpointName}`
    };
}

function verifyAgentLoginBinding(agent, target) {
    if (
        String(agent.extension) !== target.extension ||
        String(agent.context) !== target.context
    ) {
        const error = new Error(
            'Wazo agent is logged on a different extension or context'
        );
        error.status = 409;
        throw error;
    }
}

async function loginAgent(
    tenantUuid, agentNumber, expectedAgentId, lineId, extension
) {
    const target = await getAgentLoginTarget(
        tenantUuid, lineId, extension
    );

    const current = await getAgent(
        tenantUuid, agentNumber, expectedAgentId
    );

    if (current.logged) {
        verifyAgentLoginBinding(current, target);
        return { changed: false, agent: current };
    }

    try {
        await request(
            'POST',
            `/agents/by-id/${encodeURIComponent(expectedAgentId)}/login`,
            tenantUuid,
            target
        );
    } catch (err) {
        // A concurrent login is safe only if it is this same agent
        // on this same verified extension and context.
        if (err.status !== 409) throw err;

        const latest = await getAgent(
            tenantUuid, agentNumber, expectedAgentId
        );

        if (!latest.logged) throw err;
        verifyAgentLoginBinding(latest, target);
        return { changed: false, agent: latest };
    }

    const verified = await getAgent(
        tenantUuid, agentNumber, expectedAgentId
    );

    if (!verified.logged) {
        throw new Error('Wazo did not confirm agent login');
    }

    verifyAgentLoginBinding(verified, target);
    return { changed: true, agent: verified };
}

async function logoffAgent(
    tenantUuid, agentNumber, expectedAgentId, lineId, extension
) {
    const target = await getAgentLoginTarget(
        tenantUuid, lineId, extension
    );

    const current = await getAgent(
        tenantUuid, agentNumber, expectedAgentId
    );

    if (!current.logged) {
        return { changed: false, agent: current };
    }

    verifyAgentLoginBinding(current, target);

    try {
        await request(
            'POST',
            `/agents/by-id/${encodeURIComponent(expectedAgentId)}/logoff`,
            tenantUuid
        );
    } catch (err) {
        if (err.status !== 409) throw err;

        const latest = await getAgent(
            tenantUuid, agentNumber, expectedAgentId
        );

        if (latest.logged) throw err;
        return { changed: false, agent: latest };
    }

    const verified = await getAgent(
        tenantUuid, agentNumber, expectedAgentId
    );

    if (verified.logged) {
        throw new Error('Wazo did not confirm agent logoff');
    }

    return { changed: true, agent: verified };
}


module.exports = { getAgent, pauseAgent, unpauseAgent, loginAgent, logoffAgent };
