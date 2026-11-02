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

module.exports = { getAgent, pauseAgent, unpauseAgent };
