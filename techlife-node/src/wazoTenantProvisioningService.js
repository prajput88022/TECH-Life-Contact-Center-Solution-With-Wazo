'use strict';

const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');

const MASTER_TENANT_UUID = '317ac2b9-335c-406f-9b23-e86d327b4461';
const CONTEXT_TYPES = ['internal', 'outcall', 'incall', 'services'];

async function authToken() {
    const response = await wazoFetch(
        `${config.wazo.authUrl.replace(/\/$/, '')}/token`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(
                    `${config.wazo.authUsername}:${config.wazo.authPassword}`
                ).toString('base64'),
            },
            body: JSON.stringify({ backend: 'wazo_user', expiration: 300 }),
        }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.data?.token) {
        throw new Error(`Wazo authentication failed (HTTP ${response.status})`);
    }
    return payload.data.token;
}

async function requestJson(base, path, token, tenantUuid, method = 'GET', body) {
    const response = await wazoFetch(`${base.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
            'X-Auth-Token': token,
            'Wazo-Tenant': tenantUuid,
            'Content-Type': 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });

    const raw = await response.text().catch(() => '');
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!response.ok) {
        // Do not include request headers or credentials in errors.
        throw new Error(
            `Wazo API ${method} ${path} failed (HTTP ${response.status}): ` +
            String(payload?.message || payload?.error || raw || 'no response body').slice(0, 500)
        );
    }
    return payload;
}

function unwrap(payload) {
    return payload?.data?.data || payload?.data || payload;
}

async function provisionWazoTenant(tenantId) {
    const dbTenant = await pool.query(
        `SELECT id, name, slug, wazo_tenant_uuid,
                sip_domain, sip_ws_uri
           FROM tenants
          WHERE id = $1 AND is_active = TRUE`,
        [tenantId]
    );

    if (!dbTenant.rowCount) {
        throw new Error('Active application tenant was not found');
    }

    const tenant = dbTenant.rows[0];
    if (!tenant.slug || tenant.slug.length > 10) {
        throw new Error('Tenant slug must be 1–10 characters for Wazo');
    }

    await pool.query(
        `UPDATE tenants
            SET wazo_context_status = 'provisioning',
                wazo_context_error = NULL,
                wazo_outcall_context_status = 'provisioning',
                wazo_outcall_context_error = NULL
          WHERE id = $1`,
        [tenantId]
    );

    try {
        const token = await authToken();
        const authBase = config.wazo.authUrl.replace(/\/$/, '');
        const confdBase = config.wazo.confdUrl.replace(/\/$/, '');
        let wazoTenantUuid = tenant.wazo_tenant_uuid;

        if (!wazoTenantUuid) {
            // First look for an existing child tenant to avoid duplicate creation.
            const listed = unwrap(await requestJson(
                authBase, '/tenants?limit=100&offset=0',
                token, MASTER_TENANT_UUID
            ));
            const items = Array.isArray(listed?.items) ? listed.items :
                (Array.isArray(listed) ? listed : []);
            const existing = items.find((item) =>
                String(item.slug || '').toLowerCase() === tenant.slug.toLowerCase() ||
                String(item.name || '').toLowerCase() === tenant.name.toLowerCase()
            );

            let created = existing;
            if (!created) {
                created = unwrap(await requestJson(
                    authBase, '/tenants', token, MASTER_TENANT_UUID, 'POST',
                    { name: tenant.name, slug: tenant.slug }
                ));
            }

            wazoTenantUuid = created?.uuid;
            if (!wazoTenantUuid) {
                throw new Error('Wazo tenant API did not return a tenant UUID');
            }

            await pool.query(
                `UPDATE tenants SET wazo_tenant_uuid = $1 WHERE id = $2`,
                [wazoTenantUuid, tenantId]
            );
        }

        // Wazo Confd assigns new contexts to the tenant selected by Wazo-Tenant.
        const contextList = unwrap(await requestJson(
            confdBase, '/contexts?limit=100&offset=0',
            token, wazoTenantUuid
        ));
        const contexts = Array.isArray(contextList?.items) ? contextList.items :
            (Array.isArray(contextList) ? contextList : []);

        const mapped = {};
        for (const type of CONTEXT_TYPES) {
            let context = contexts.find((item) =>
                item.type === type &&
                String(item.tenant_uuid || '').toLowerCase() === wazoTenantUuid.toLowerCase()
            );

            if (!context) {
                const label = `${tenant.name} ${type}`;
                context = unwrap(await requestJson(
                    confdBase, '/contexts', token, wazoTenantUuid, 'POST',
                    { label, type, description: `Tech-Life tenant ${tenant.slug}: ${type}` }
                ));
            }

            if (!context?.id || !context?.name || context.type !== type) {
                throw new Error(`Wazo did not return a valid ${type} context`);
            }
            mapped[type] = context;
        }

        // Ensure the internal context accepts the configured agent extension
        // range. Wazo requires start/end to have equal digit lengths.
        const rangeStart = Number(config.wazo.agentExtensionRangeStart);
        const rangeEnd = Number(config.wazo.agentExtensionRangeEnd);
        if (
            !Number.isSafeInteger(rangeStart) ||
            !Number.isSafeInteger(rangeEnd) ||
            rangeStart < 0 ||
            rangeEnd < rangeStart
        ) {
            throw new Error('Invalid configured agent extension range');
        }

        const requiredRanges = [];
        for (let start = rangeStart; start <= rangeEnd;) {
            const digits = String(start).length;
            const digitLimit = (10 ** digits) - 1;
            const end = Math.min(rangeEnd, digitLimit);
            requiredRanges.push({ start: String(start), end: String(end) });
            start = end + 1;
        }

        const internal = mapped.internal;
        const existingRanges = Array.isArray(internal.user_ranges)
            ? internal.user_ranges.map(r => ({
                start: String(r.start),
                end: String(r.end ?? r.start),
            }))
            : [];

        const covered = (n) => existingRanges.some(r =>
            Number(n) >= Number(r.start) && Number(n) <= Number(r.end)
        );

        // Add only uncovered portions of the required range; preserve all
        // existing ranges and do not replace the context with a bare payload.
        for (const required of requiredRanges) {
            const start = Number(required.start);
            const end = Number(required.end);
            let segmentStart = null;

            for (let n = start; n <= end; n++) {
                const isCovered = covered(n);
                if (!isCovered && segmentStart === null) segmentStart = n;

                if ((isCovered || n === end) && segmentStart !== null) {
                    const segmentEnd = isCovered ? n - 1 : n;
                    existingRanges.push({
                        start: String(segmentStart),
                        end: String(segmentEnd),
                    });
                    segmentStart = null;
                }
            }
        }

        const rangeUpdate = unwrap(await requestJson(
            confdBase,
            `/contexts/${internal.id}`,
            token,
            wazoTenantUuid,
            'PUT',
            {
                label: internal.label || internal.name,
                type: 'internal',
                description: internal.description || `Tech-Life tenant ${tenant.slug}: internal`,
                enabled: internal.enabled !== false,
                user_ranges: existingRanges,
            }
        ));

        // Verify the saved Wazo context actually accepts both range endpoints.
        const verifiedContext = unwrap(await requestJson(
            confdBase,
            `/contexts/${internal.id}`,
            token,
            wazoTenantUuid
        ));
        const savedRanges = Array.isArray(verifiedContext.user_ranges)
            ? verifiedContext.user_ranges
            : [];

        for (const endpoint of [rangeStart, rangeEnd]) {
            if (!savedRanges.some(r =>
                endpoint >= Number(r.start) &&
                endpoint <= Number(r.end ?? r.start)
            )) {
                throw new Error(
                    `Wazo internal context ${internal.name} did not save extension range endpoint ${endpoint}`
                );
            }
        }

        mapped.internal = verifiedContext;

        await pool.query(
            `UPDATE tenants
                SET wazo_tenant_uuid = $1,
                    wazo_context_id = $2,
                    wazo_context_name = $3,
                    wazo_context_label = $4,
                    wazo_context_status = 'provisioned',
                    wazo_context_error = NULL,
                    wazo_outcall_context_id = $5,
                    wazo_outcall_context_name = $6,
                    wazo_outcall_context_status = 'provisioned',
                    wazo_outcall_context_error = NULL,
                    sip_domain = COALESCE(NULLIF(sip_domain, ''), $8),
                    sip_ws_uri = COALESCE(NULLIF(sip_ws_uri, ''), $9)
              WHERE id = $7`,
            [
                wazoTenantUuid,
                mapped.internal.id,
                mapped.internal.name,
                mapped.internal.label,
                mapped.outcall.id,
                mapped.outcall.name,
                tenantId,
                config.wazo.sipDomain || config.wazo.host,
                config.wazo.sipWsUri,
            ]
        );

        return {
            ok: true,
            tenant: tenant.name,
            wazo_tenant_uuid: wazoTenantUuid,
            contexts: Object.fromEntries(
                Object.entries(mapped).map(([type, value]) =>
                    [type, { id: value.id, name: value.name }]
                )
            ),
        };
    } catch (error) {
        await pool.query(
            `UPDATE tenants
                SET wazo_context_status = 'failed',
                    wazo_context_error = $1,
                    wazo_outcall_context_status = 'failed',
                    wazo_outcall_context_error = $1
              WHERE id = $2`,
            [String(error.message || error).slice(0, 2000), tenantId]
        );
        throw error;
    }
}

module.exports = { provisionWazoTenant };
