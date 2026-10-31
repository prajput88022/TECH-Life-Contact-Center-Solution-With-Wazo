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

async function confdRequest(method, path, token, body, tenantUuid) {
    const resp = await wazoFetch(`${config.wazo.confdUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'X-Auth-Token': token, 'Wazo-Tenant': tenantUuid, 'Content-Type': 'application/json' },
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

async function tenantSipUsername(tenantId, extension) {
    const res = await pool.query(
        'SELECT slug, id FROM tenants WHERE id = $1',
        [tenantId]
    );
    const tenant = res.rows[0];
    if (!tenant) throw new Error(`Unknown tenant ${tenantId}`);

    const tenantPrefix = String(tenant.slug || tenant.id)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    if (!tenantPrefix) {
        throw new Error(`Cannot generate SIP username for tenant ${tenantId}`);
    }

    const username = `${tenantPrefix}_agt${extension}`;
    if (username.length > 50) {
        throw new Error(`Generated SIP username exceeds 50 characters for tenant ${tenantId}`);
    }

    return username;
}

async function provisionForAgent(tenantId, agentId, requestedExtension = null, reuseWazoUserId = null) {
    try {
        const extension = requestedExtension || (await nextAvailableExtension(tenantId));
        const token = await getToken();

        const tenantRes = await pool.query(
            'SELECT wazo_tenant_uuid FROM tenants WHERE id = $1',
            [tenantId]
        );
        const tenantUuid = tenantRes.rows[0]?.wazo_tenant_uuid;
        if (!tenantUuid) throw new Error(`Missing Wazo tenant UUID for ${tenantId}`);

        const contextRes = await confdRequest('GET', '/contexts', token, undefined, tenantUuid);
        const contexts = contextRes.items || [];
        const internalContext = contexts.find(c =>
            c.type === 'internal' &&
            c.name === config.wazo.defaultContext &&
            (c.user_ranges || []).some(r =>
                Number(extension) >= Number(r.start) &&
                Number(extension) <= Number(r.end)
            )
        ) || contexts.find(c =>
            c.type === 'internal' &&
            (c.user_ranges || []).some(r =>
                Number(extension) >= Number(r.start) &&
                Number(extension) <= Number(r.end)
            )
        );

        if (!internalContext) {
            throw new Error(
                `No internal Wazo context accepts extension ${extension} for tenant ${tenantUuid}`
            );
        }

        const transportResponse = await confdRequest(
            'GET', '/sip/transports?limit=100&offset=0',
            token, undefined, tenantUuid
        );

        const transports = Array.isArray(transportResponse)
            ? transportResponse
            : Array.isArray(transportResponse?.items)
                ? transportResponse.items
                : [];

        const selectedWssTransport = transports.find(item =>
            Array.isArray(item.options) &&
            item.options.some(option =>
                Array.isArray(option) &&
                String(option[0]).toLowerCase() === 'protocol' &&
                String(option[1]).toLowerCase() === 'wss'
            )
        );

        if (!selectedWssTransport?.uuid) {
            throw new Error(
                'No configured WSS transport was found in Wazo for this tenant.'
            );
        }

        const sipUsername = await tenantSipUsername(tenantId, extension);
        const sipPassword = crypto.randomBytes(12).toString('hex');

        const agentRes = await pool.query(
            `SELECT u.id AS app_user_id, u.full_name
               FROM agents a
               JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
              WHERE a.tenant_id = $1 AND a.id = $2`,
            [tenantId, agentId]
        );
        const fullName = agentRes.rows[0]?.full_name || `Agent ${extension}`;

        let wazoUser;
        if (reuseWazoUserId !== null) {
            wazoUser = await confdRequest('GET', `/users/${reuseWazoUserId}`, token, undefined, tenantUuid);
            if (
                Number(wazoUser.id) !== Number(reuseWazoUserId) ||
                wazoUser.firstname !== fullName ||
                !Array.isArray(wazoUser.lines) ||
                wazoUser.lines.length !== 0 ||
                wazoUser.tenant_uuid !== tenantUuid
            ) {
                throw new Error(
                    `Refusing to reuse Wazo user ${reuseWazoUserId}: identity, tenant, or line checks failed`
                );
            }
        } else {
            wazoUser = await confdRequest('POST', '/users', token, { firstname: fullName }, tenantUuid);
        }

        // Persist the real Wazo UUID against this tenant-owned application user.
        const wazoUserUuid = String(wazoUser?.uuid || '').trim();
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(wazoUserUuid) ||
            String(wazoUser?.tenant_uuid || '').toLowerCase() !==
                String(tenantUuid).toLowerCase()
        ) {
            throw new Error(
                'Wazo user UUID is missing or belongs to another tenant; refusing to save the identity.'
            );
        }

        const identitySaved = await pool.query(
            `UPDATE users u
                SET wazo_user_uuid = $1::uuid
               FROM agents a
              WHERE a.id = $2
                AND a.tenant_id = $3
                AND a.user_id = u.id
                AND u.tenant_id = $3
                AND (
                    u.wazo_user_uuid IS NULL
                    OR u.wazo_user_uuid = $1::uuid
                )
              RETURNING u.id`,
            [wazoUserUuid, agentId, tenantId]
        );

        if (identitySaved.rowCount !== 1) {
            throw new Error(
                'Application user was not found in this tenant or already has a different Wazo UUID.'
            );
        }

        const wazoLine = await confdRequest('POST', '/lines', token, {
            context: internalContext.name,
            protocol: 'sip',
            device_slot: 1,
            endpoint_sip: {
                auth_section_options: [['username', sipUsername], ['password', sipPassword]],
                aor_section_options: [['max_contacts', '1'], ['remove_existing', 'yes']],
                transport: { uuid: selectedWssTransport.uuid },
                endpoint_section_options: [
        ['disallow', 'all'],
        ['allow', 'opus,ulaw,alaw,g722'],
        ['webrtc', 'yes'],
      ],
            },
        }, tenantUuid);
        const wazoExtension = await confdRequest('POST', '/extensions', token, {
            exten: extension,
            context: internalContext.name,
        }, tenantUuid);
        await confdRequest('PUT', `/users/${wazoUser.id}/lines/${wazoLine.id}`, token, {}, tenantUuid);
        await confdRequest('PUT', `/lines/${wazoLine.id}/extensions/${wazoExtension.id}`, token, {}, tenantUuid);

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


async function provisionWazoAgent(tenantId, agentId) {
    try {
        const local = await pool.query(
            `SELECT a.id, a.tenant_id, a.agent_number, a.extension,
                    a.wazo_agent_id, a.wazo_user_id, a.provisioning_status,
                    u.id AS app_user_id, u.wazo_user_uuid AS app_wazo_user_uuid,
                    u.full_name, t.wazo_tenant_uuid
               FROM agents a
               JOIN users u ON u.id = a.user_id
               JOIN tenants t ON t.id = a.tenant_id
              WHERE a.id = $1 AND a.tenant_id = $2`,
            [agentId, tenantId]
        );

        if (!local.rowCount) {
            throw new Error('Local agent was not found in the requested tenant.');
        }

        const row = local.rows[0];
        const number = String(row.agent_number || row.extension || '').trim();
        const userId = Number(row.wazo_user_id);
        const tenantUuid = row.wazo_tenant_uuid;

        if (!number || !/^\d+$/.test(number)) {
            throw new Error('Agent requires a numeric agent number before Wazo provisioning.');
        }
        if (!Number.isInteger(userId) || userId <= 0) {
            throw new Error('Wazo SIP user is missing; contact-centre agent was not created.');
        }
        if (!tenantUuid) {
            throw new Error('Tenant has no Wazo tenant UUID.');
        }

        const token = await getToken();

        // Verify that the SIP user belongs to this tenant before linking it.
        const user = await confdRequest(
            'GET', `/users/${userId}`, token, undefined, tenantUuid
        );

        if (Number(user.id) !== userId ||
            String(user.tenant_uuid || '').toLowerCase() !==
                String(tenantUuid).toLowerCase()) {
            throw new Error('Wazo user identity or tenant verification failed.');
        }

        const actualWazoUuid = String(user.uuid || '').trim();
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actualWazoUuid)
        ) {
            throw new Error('Wazo user has no valid UUID; refusing to persist its identity.');
        }

        if (
            row.app_wazo_user_uuid &&
            String(row.app_wazo_user_uuid).toLowerCase() !== actualWazoUuid.toLowerCase()
        ) {
            throw new Error(
                'Stored application Wazo UUID conflicts with the verified Wazo user.'
            );
        }

        const identitySaved = await pool.query(
            `UPDATE users
                SET wazo_user_uuid = $1::uuid
              WHERE id = $2
                AND tenant_id = $3
                AND (
                    wazo_user_uuid IS NULL
                    OR wazo_user_uuid = $1::uuid
                )
              RETURNING id`,
            [actualWazoUuid, row.app_user_id, tenantId]
        );

        if (identitySaved.rowCount !== 1) {
            throw new Error(
                'Could not persist the verified Wazo UUID to the matching application user.'
            );
        }

        const userAgents = Array.isArray(user.agents) ? user.agents : [];
        const linkedIds = userAgents
            .map(a => Number(typeof a === 'object' ? a.id : a))
            .filter(Number.isInteger);

        let wazoAgentId = Number(row.wazo_agent_id) || null;

        if (wazoAgentId) {
            // Verify saved IDs instead of trusting a potentially stale DB value.
            const existing = await confdRequest(
                'GET', `/agents/${wazoAgentId}`, token, undefined, tenantUuid
            );
            if (Number(existing.id) !== wazoAgentId ||
                String(existing.number) !== number) {
                throw new Error(
                    `Saved Wazo agent ID ${wazoAgentId} does not match agent number ${number}.`
                );
            }
        } else {
            const list = await confdRequest(
                'GET', '/agents', token, undefined, tenantUuid
            );
            const items = Array.isArray(list.items)
                ? list.items
                : (Array.isArray(list) ? list : []);

            const matches = items.filter(a => String(a.number) === number);

            if (matches.length > 1) {
                throw new Error(
                    `Multiple Wazo agents use number ${number}; refusing an ambiguous association.`
                );
            }

            if (matches.length === 1) {
                wazoAgentId = Number(matches[0].id);
            } else {
                const parts = String(row.full_name || `Agent ${number}`)
                    .trim().split(/\s+/);
                const firstname = parts.shift() || `Agent ${number}`;
                const lastname = parts.join(' ') || '';

                const created = await confdRequest(
                    'POST', '/agents', token,
                    {
                        number,
                        firstname,
                        lastname,
                        description: `TECH-Life local agent ${agentId}`
                    },
                    tenantUuid
                );

                wazoAgentId = Number(created.id);
            }

            if (!Number.isInteger(wazoAgentId) || wazoAgentId <= 0) {
                throw new Error('Wazo did not return a valid contact-centre agent ID.');
            }
        }

        // Never silently replace a user's existing different agent association.
        if (linkedIds.length && !linkedIds.includes(wazoAgentId)) {
            throw new Error(
                `Wazo user ${userId} is already associated with another contact-centre agent.`
            );
        }

        if (!linkedIds.includes(wazoAgentId)) {
            await confdRequest(
                'PUT', `/users/${userId}/agents/${wazoAgentId}`,
                token, {}, tenantUuid
            );
        }

        const saved = await pool.query(
            `UPDATE agents
                SET wazo_agent_id = $1,
                    provisioning_status = 'provisioned',
                    provisioning_error = NULL
              WHERE id = $2 AND tenant_id = $3
              RETURNING id`,
            [wazoAgentId, agentId, tenantId]
        );

        if (!saved.rowCount) {
            throw new Error('Wazo agent was created but local ID persistence failed.');
        }

        return { ok: true, wazo_agent_id: wazoAgentId, number };
    } catch (err) {
        await pool.query(
            `UPDATE agents
                SET provisioning_error = $1
              WHERE id = $2 AND tenant_id = $3`,
            [err.message, agentId, tenantId]
        ).catch(() => {});

        return { ok: false, error: err.message };
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

module.exports = { provisionForAgent, provisionWazoAgent, attachManualLine, tenantSipUsername };
