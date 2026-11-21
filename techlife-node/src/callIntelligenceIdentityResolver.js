'use strict';

const config = require('../config/config');
const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function unwrap(data) {
    return data?.data?.data || data?.data || data || {};
}

function readOption(options, name) {
    if (!Array.isArray(options)) return null;
    const found = options.find(item =>
        Array.isArray(item) &&
        String(item[0]).toLowerCase() === name.toLowerCase()
    );
    return found ? String(found[1]) : null;
}

class CallIntelligenceIdentityResolver {
    constructor() {
        this.tenantByUuid = new Map();
        this.endpointByName = new Map();
        this.agentByUser = new Map();
        this.agentByLine = new Map();
        this.refreshedAt = null;
        this.refreshErrors = [];
    }

    async getToken() {
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
                    expiration: 300
                })
            }
        );

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.data?.token) {
            throw new Error(`Wazo authentication failed (HTTP ${response.status}).`);
        }
        return payload.data.token;
    }

    async apiGet(path, token, tenantUuid) {
        const response = await wazoFetch(
            `${config.wazo.confdUrl.replace(/\/$/, '')}${path}`,
            {
                headers: {
                    'X-Auth-Token': token,
                    'Wazo-Tenant': tenantUuid,
                    'Content-Type': 'application/json'
                }
            }
        );

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`Wazo GET ${path} failed (HTTP ${response.status}).`);
        }
        return unwrap(body);
    }

    async fetchTrunkEndpoint(token, tenantUuid, endpointUuid) {
        const endpoint = await this.apiGet(
            `/endpoints/sip/${encodeURIComponent(endpointUuid)}`,
            token,
            tenantUuid
        );

        if (normalize(endpoint.uuid) !== normalize(endpointUuid)) {
            throw new Error('Wazo endpoint UUID did not match the configured trunk.');
        }

        const endpointName = String(endpoint.name || '').trim();
        if (!endpointName) {
            throw new Error('Wazo trunk endpoint has no Asterisk endpoint name.');
        }

        return {
            endpointName,
            endpointUuid: endpoint.uuid,
            label: endpoint.label || null,
            context: readOption(endpoint.endpoint_section_options, 'context')
        };
    }

    async fetchAgentEndpoint(token, tenantUuid, userUuid, lineId) {
        const path =
            `/users/${encodeURIComponent(userUuid)}` +
            `/lines/${encodeURIComponent(lineId)}/associated/endpoints/sip`;

        const raw = await this.apiGet(path, token, tenantUuid);
        const endpoint = Array.isArray(raw) ? raw[0] : raw;

        if (!endpoint || typeof endpoint !== 'object') {
            throw new Error('Wazo returned no SIP endpoint for this agent line.');
        }

        const endpointName = String(
            endpoint.name || endpoint.endpoint?.name || ''
        ).trim();

        if (!endpointName) {
            throw new Error('Associated agent SIP endpoint has no Asterisk name.');
        }

        const endpointUuid =
            endpoint.uuid || endpoint.endpoint?.uuid || null;

        const options =
            endpoint.endpoint_section_options ||
            endpoint.endpoint?.endpoint_section_options;

        return {
            endpointName,
            endpointUuid,
            label: endpoint.label || endpoint.endpoint?.label || null,
            context: readOption(options, 'context')
        };
    }

    addEndpoint(map, name, record, errors) {
        const key = normalize(name);
        if (!key) throw new Error('Cannot register an empty endpoint name.');

        if (map.has(key)) {
            errors.push(`Duplicate Asterisk endpoint name: ${name}`);
            map.set(key, { ambiguous: true });
            return;
        }

        map.set(key, record);
    }

    async refresh() {
        const token = await this.getToken();

        const [tenantResult, trunkResult, agentResult] = await Promise.all([
            pool.query(`
                SELECT id, name, wazo_tenant_uuid, wazo_context_name,
                       is_active, timezone
                  FROM tenants
                 WHERE wazo_tenant_uuid IS NOT NULL
            `),
            pool.query(`
                SELECT tr.id, tr.tenant_id, tr.name, tr.is_active,
                       tr.provisioning_status, tr.wazo_endpoint_uuid,
                       t.wazo_tenant_uuid
                  FROM trunks tr
                  JOIN tenants t ON t.id = tr.tenant_id
                 WHERE tr.wazo_endpoint_uuid IS NOT NULL
                   AND t.wazo_tenant_uuid IS NOT NULL
            `),
            pool.query(`
                SELECT a.id, a.tenant_id, a.agent_number,
                       a.wazo_line_id, a.is_active,
                       u.wazo_user_uuid
                  FROM agents a
                  LEFT JOIN users u
                    ON u.id = a.user_id
                   AND u.tenant_id = a.tenant_id
            `)
        ]);

        const tenants = new Map();
        const endpoints = new Map();
        const agentsByUser = new Map();
        const agentsByLine = new Map();
        const errors = [];

        for (const tenant of tenantResult.rows) {
            const key = normalize(tenant.wazo_tenant_uuid);
            if (!key) continue;

            if (tenants.has(key)) {
                tenants.set(key, { ambiguous: true });
                errors.push(`Duplicate Wazo tenant UUID: ${key}`);
                continue;
            }

            tenants.set(key, {
                tenantId: tenant.id,
                tenantName: tenant.name,
                wazoTenantUuid: tenant.wazo_tenant_uuid,
                contextName: tenant.wazo_context_name,
                active: tenant.is_active === true,
                timezone: tenant.timezone || 'UTC'
            });
        }

        for (const agent of agentResult.rows) {
            const record = {
                agentId: agent.id,
                tenantId: agent.tenant_id,
                agentNumber: agent.agent_number,
                lineId: agent.wazo_line_id,
                userUuid: agent.wazo_user_uuid,
                active: agent.is_active === true
            };

            if (agent.wazo_user_uuid) {
                const key =
                    `${agent.tenant_id}:${normalize(agent.wazo_user_uuid)}`;

                if (agentsByUser.has(key)) {
                    agentsByUser.set(key, { ambiguous: true });
                } else {
                    agentsByUser.set(key, record);
                }
            }

            if (agent.wazo_line_id != null) {
                const key = `${agent.tenant_id}:${agent.wazo_line_id}`;

                if (agentsByLine.has(key)) {
                    agentsByLine.set(key, { ambiguous: true });
                } else {
                    agentsByLine.set(key, record);
                }
            }
        }

        // Discover each trunk endpoint from its tenant-scoped Wazo UUID.
        for (const trunk of trunkResult.rows) {
            const tenant = tenants.get(normalize(trunk.wazo_tenant_uuid));

            if (!tenant || tenant.ambiguous) {
                errors.push(`Tenant identity unavailable for trunk ${trunk.name}.`);
                continue;
            }

            try {
                const endpoint = await this.fetchTrunkEndpoint(
                    token,
                    trunk.wazo_tenant_uuid,
                    trunk.wazo_endpoint_uuid
                );

                this.addEndpoint(endpoints, endpoint.endpointName, {
                    channelRole: 'trunk',
                    tenantId: trunk.tenant_id,
                    tenantName: tenant.tenantName,
                    wazoTenantUuid: trunk.wazo_tenant_uuid,
                    trunkId: trunk.id,
                    trunkName: trunk.name,
                    endpointName: endpoint.endpointName,
                    endpointUuid: endpoint.endpointUuid,
                    endpointContext: endpoint.context,
                    trunkActive: trunk.is_active === true,
                    provisioned: trunk.provisioning_status === 'provisioned',
                    captureEligible:
                        tenant.active === true &&
                        trunk.is_active === true &&
                        trunk.provisioning_status === 'provisioned'
                }, errors);
            } catch (error) {
                errors.push(`Trunk ${trunk.name}: ${error.message}`);
            }
        }

        // Discover each agent endpoint through the confirmed user/line API.
        for (const agent of agentResult.rows) {
            if (!agent.wazo_user_uuid || agent.wazo_line_id == null) continue;

            const tenantRow = tenantResult.rows.find(
                t => t.id === agent.tenant_id
            );
            if (!tenantRow?.wazo_tenant_uuid) continue;

            const tenant = tenants.get(normalize(tenantRow.wazo_tenant_uuid));
            if (!tenant || tenant.ambiguous) continue;

            try {
                const endpoint = await this.fetchAgentEndpoint(
                    token,
                    tenantRow.wazo_tenant_uuid,
                    agent.wazo_user_uuid,
                    agent.wazo_line_id
                );

                this.addEndpoint(endpoints, endpoint.endpointName, {
                    channelRole: 'agent',
                    tenantId: agent.tenant_id,
                    tenantName: tenant.tenantName,
                    wazoTenantUuid: tenantRow.wazo_tenant_uuid,
                    agentId: agent.id,
                    agentNumber: agent.agent_number,
                    agentActive: agent.is_active === true,
                    agentUserUuid: agent.wazo_user_uuid,
                    agentLineId: agent.wazo_line_id,
                    endpointName: endpoint.endpointName,
                    endpointUuid: endpoint.endpointUuid,
                    endpointContext: endpoint.context,
                    captureEligible:
                        tenant.active === true &&
                        agent.is_active === true
                }, errors);
            } catch (error) {
                errors.push(
                    `Agent ${agent.agent_number} (${tenant.tenantName}): ${error.message}`
                );
            }
        }

        // Replace all maps only after the discovery cycle is complete.
        this.tenantByUuid = tenants;
        this.endpointByName = endpoints;
        this.agentByUser = agentsByUser;
        this.agentByLine = agentsByLine;
        this.refreshErrors = errors;
        this.refreshedAt = new Date();

        return this.getSnapshot();
    }

    resolveChannel(channelName, variables = {}) {
        const channel = String(channelName || '').trim();
        if (!channel) {
            return { verified: false, reason: 'missing_channel' };
        }

        if (!channel.startsWith('PJSIP/')) {
            return { verified: false, reason: 'not_a_pjsip_endpoint_channel' };
        }

        const resource = channel.slice('PJSIP/'.length);
        let endpoint = null;

        for (const [name, record] of this.endpointByName.entries()) {
            if (resource === name || resource.startsWith(`${name}-`)) {
                endpoint = record;
                break;
            }
        }

        if (!endpoint) {
            return { verified: false, reason: 'unknown_pjsip_endpoint' };
        }

        if (endpoint.ambiguous) {
            return { verified: false, reason: 'ambiguous_pjsip_endpoint' };
        }

        const suppliedTenantUuid = String(
            variables.WAZO_TENANT_UUID || ''
        ).trim();

        let tenant = null;

        if (suppliedTenantUuid) {
            tenant = this.tenantByUuid.get(normalize(suppliedTenantUuid));

            if (!tenant || tenant.ambiguous) {
                return {
                    verified: false,
                    reason: 'unknown_or_ambiguous_wazo_tenant'
                };
            }

            if (tenant.tenantId !== endpoint.tenantId) {
                return {
                    verified: false,
                    reason: 'tenant_identity_conflict'
                };
            }
        } else {
            tenant = {
                tenantId: endpoint.tenantId,
                tenantName: endpoint.tenantName,
                wazoTenantUuid: endpoint.wazoTenantUuid,
                active: true
            };
        }

        const userUuid = String(variables.WAZO_USERUUID || '').trim();
        const lineId = variables.WAZO_LINE_ID == null ||
            String(variables.WAZO_LINE_ID).trim() === ''
                ? null
                : Number(variables.WAZO_LINE_ID);

        let agentByUser = null;
        let agentByLine = null;

        if (userUuid) {
            agentByUser = this.agentByUser.get(
                `${tenant.tenantId}:${normalize(userUuid)}`
            ) || null;

            if (agentByUser?.ambiguous) {
                return { verified: false, reason: 'ambiguous_wazo_user' };
            }
        }

        if (lineId !== null && Number.isSafeInteger(lineId)) {
            agentByLine = this.agentByLine.get(
                `${tenant.tenantId}:${lineId}`
            ) || null;

            if (agentByLine?.ambiguous) {
                return { verified: false, reason: 'ambiguous_wazo_line' };
            }
        }

        if (agentByUser && agentByLine &&
            agentByUser.agentId !== agentByLine.agentId) {
            return { verified: false, reason: 'agent_identity_conflict' };
        }

        if (endpoint.channelRole === 'agent') {
            const endpointAgentId = endpoint.agentId;

            if (agentByUser && agentByUser.agentId !== endpointAgentId) {
                return { verified: false, reason: 'agent_user_endpoint_conflict' };
            }

            if (agentByLine && agentByLine.agentId !== endpointAgentId) {
                return { verified: false, reason: 'agent_line_endpoint_conflict' };
            }
        }

        const agent = endpoint.channelRole === 'agent'
            ? {
                agentId: endpoint.agentId,
                agentNumber: endpoint.agentNumber,
                active: endpoint.agentActive,
                userUuid: endpoint.agentUserUuid,
                lineId: endpoint.agentLineId
            }
            : agentByUser || agentByLine;

        const eventContext = String(
            variables.CONTEXT || variables.Context || ''
        ).trim();

        if (
            endpoint.endpointContext &&
            eventContext &&
            normalize(endpoint.endpointContext) !== normalize(eventContext)
        ) {
            return { verified: false, reason: 'endpoint_context_conflict' };
        }

        return {
            verified: true,
            tenantId: endpoint.tenantId,
            tenantName: endpoint.tenantName,
            wazoTenantUuid: endpoint.wazoTenantUuid,
            channelRole: endpoint.channelRole,
            endpointName: endpoint.endpointName,
            endpointUuid: endpoint.endpointUuid,

            trunkId: endpoint.channelRole === 'trunk'
                ? endpoint.trunkId
                : null,
            trunkName: endpoint.channelRole === 'trunk'
                ? endpoint.trunkName
                : null,
            trunkCaptureEligible:
                endpoint.channelRole === 'trunk' &&
                endpoint.captureEligible === true,

            agentId: agent?.agentId || null,
            agentNumber: agent?.agentNumber || null,
            agentActive: agent?.active === true,
            agentCaptureEligible:
                endpoint.channelRole === 'agent' &&
                endpoint.captureEligible === true,

            wazoUserUuid: userUuid || agent?.userUuid || null,
            wazoLineId: lineId ?? agent?.lineId ?? null
        };
    }

    getSnapshot() {
        const values = [...this.endpointByName.values()];

        return {
            refreshedAt: this.refreshedAt,
            tenantCount: [...this.tenantByUuid.values()]
                .filter(x => !x.ambiguous).length,
            endpointCount: values.filter(x => !x.ambiguous).length,
            trunkEndpointCount: values.filter(
                x => !x.ambiguous && x.channelRole === 'trunk'
            ).length,
            agentEndpointCount: values.filter(
                x => !x.ambiguous && x.channelRole === 'agent'
            ).length,
            agentUserCount: [...this.agentByUser.values()]
                .filter(x => !x.ambiguous).length,
            agentLineCount: [...this.agentByLine.values()]
                .filter(x => !x.ambiguous).length,
            eligibleTrunkCount: values.filter(
                x => !x.ambiguous &&
                     x.channelRole === 'trunk' &&
                     x.captureEligible
            ).length,
            eligibleAgentEndpointCount: values.filter(
                x => !x.ambiguous &&
                     x.channelRole === 'agent' &&
                     x.captureEligible
            ).length,
            errors: [...this.refreshErrors]
        };
    }
}

module.exports = { CallIntelligenceIdentityResolver };
