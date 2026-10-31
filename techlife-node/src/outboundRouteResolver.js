'use strict';

const { pool } = require('./db');
const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');

function normalizePhone(value) {
    return String(value || '').replace(/\D/g, '');
}

function validPositiveInteger(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function failure(code, message, details = {}) {
    return {
        ok: false,
        code,
        message,
        ...details
    };
}

/**
 * Read-only outbound route resolver.
 *
 * Resolution:
 *  - tenant-isolated
 *  - active tenant-wide prefixes only
 *  - longest matching prefix wins
 *  - lower numeric prefix priority wins for equal prefixes
 *  - explicit prefix_trunks assignments take precedence over legacy trunk_id
 *  - incomplete routes and unhealthy trunks fail closed
 *
 * This function does NOT contact Wazo and does NOT originate calls.
 */
async function resolveOutboundRouteForNumber(tenantId, phoneNumber) {
    if (!tenantId) {
        return failure('TENANT_REQUIRED', 'Tenant ID is required.');
    }

    const digits = normalizePhone(phoneNumber);

    if (digits.length < 7 || digits.length > 15) {
        return failure(
            'INVALID_PHONE',
            'Phone number must contain between 7 and 15 digits.'
        );
    }

    // Retrieve all active tenant-wide prefixes matching this number.
    // Do not filter provisioning_status here: if the most-specific
    // active route is broken, we must reject it rather than silently
    // falling back to a shorter prefix.
    const candidates = await pool.query(
        `SELECT
             p.id AS prefix_id,
             p.tenant_id,
             p.prefix_digits,
             p.strip_digits,
             p.prepend_digits,
             p.priority,
             p.trunk_id AS legacy_trunk_id,
             p.provisioning_status AS prefix_status,
             p.provisioning_error AS prefix_error,
             p.wazo_outcall_id,
             p.wazo_pattern_extension_id,
             t.wazo_tenant_uuid,
             t.wazo_outcall_context_id,
             t.wazo_outcall_context_name,
             t.wazo_outcall_context_status
         FROM prefixes p
         JOIN tenants t ON t.id = p.tenant_id
         WHERE p.tenant_id = $1
           AND p.is_active = TRUE
           AND p.campaign_id IS NULL
           AND p.agent_id IS NULL
           AND p.user_group_id IS NULL
           AND p.prefix_digits ~ '^[0-9]{1,20}$'
           AND $2 LIKE p.prefix_digits || '%'
         ORDER BY
             LENGTH(p.prefix_digits) DESC,
             p.priority ASC,
             p.id ASC`,
        [tenantId, digits]
    );

    if (!candidates.rowCount) {
        return failure(
            'NO_ACTIVE_TENANT_ROUTE',
            'No active tenant-wide outbound prefix matches this number.',
            { tenantId, phoneDigits: digits }
        );
    }

    const prefix = candidates.rows[0];

    // Multiple records with identical matching prefix and priority
    // are ambiguous. Do not guess which outcall should be used.
    const samePriorityMatches = candidates.rows.filter(row =>
        row.prefix_digits === prefix.prefix_digits &&
        Number(row.priority) === Number(prefix.priority)
    );

    if (samePriorityMatches.length > 1) {
        return failure(
            'AMBIGUOUS_PREFIX_ROUTE',
            'Multiple active routes have the same prefix and priority.',
            {
                tenantId,
                prefixDigits: prefix.prefix_digits,
                prefixIds: samePriorityMatches.map(row => row.prefix_id)
            }
        );
    }

    if (prefix.prefix_status !== 'provisioned') {
        return failure(
            'PREFIX_NOT_PROVISIONED',
            'The most-specific active prefix is not provisioned.',
            {
                prefixId: prefix.prefix_id,
                prefixStatus: prefix.prefix_status,
                provisioningError: prefix.prefix_error || null
            }
        );
    }

    const outcallId = validPositiveInteger(prefix.wazo_outcall_id);
    const patternExtensionId =
        validPositiveInteger(prefix.wazo_pattern_extension_id);
    const contextId =
        validPositiveInteger(prefix.wazo_outcall_context_id);

    if (!outcallId || !patternExtensionId) {
        return failure(
            'WAZO_ROUTE_RESOURCE_MISSING',
            'The prefix has no valid Wazo outcall or pattern-extension ID.',
            { prefixId: prefix.prefix_id }
        );
    }

    if (
        prefix.wazo_outcall_context_status !== 'provisioned' ||
        !contextId ||
        !prefix.wazo_outcall_context_name ||
        !prefix.wazo_tenant_uuid
    ) {
        return failure(
            'TENANT_OUTBOUND_CONTEXT_NOT_READY',
            'The tenant outbound context is not fully provisioned.',
            { prefixId: prefix.prefix_id }
        );
    }

    const stripDigits = Number(prefix.strip_digits || 0);
    const prependDigits = String(prefix.prepend_digits || '');

    if (
        !Number.isSafeInteger(stripDigits) ||
        stripDigits < 0 ||
        stripDigits > 20 ||
        (prependDigits && !/^\d{1,20}$/.test(prependDigits))
    ) {
        return failure(
            'INVALID_ROUTE_TRANSFORMATION',
            'The prefix digit transformation is invalid.',
            { prefixId: prefix.prefix_id }
        );
    }

    // Determine whether this prefix has ever used explicit trunk assignments.
    const history = await pool.query(
        `SELECT EXISTS (
             SELECT 1
             FROM prefix_trunks
             WHERE tenant_id = $1
               AND prefix_id = $2
         ) AS has_explicit_assignments`,
        [tenantId, prefix.prefix_id]
    );

    const hasExplicitAssignments =
        history.rows[0].has_explicit_assignments === true;

    let trunkRows = [];
    let assignmentSource = 'explicit';

    if (hasExplicitAssignments) {
        // LEFT JOIN deliberately exposes broken or cross-tenant references.
        const assigned = await pool.query(
            `SELECT
                 pt.trunk_id,
                 pt.priority,
                 tr.id AS matched_trunk_id,
                 tr.name AS trunk_name,
                 tr.is_active AS trunk_active,
                 tr.provisioning_status AS trunk_status,
                 tr.wazo_trunk_id
             FROM prefix_trunks pt
             LEFT JOIN trunks tr
               ON tr.id = pt.trunk_id
              AND tr.tenant_id = pt.tenant_id
             WHERE pt.tenant_id = $1
               AND pt.prefix_id = $2
               AND pt.is_active = TRUE
             ORDER BY pt.priority ASC, pt.created_at ASC, pt.trunk_id ASC`,
            [tenantId, prefix.prefix_id]
        );

        if (!assigned.rowCount) {
            return failure(
                'NO_ACTIVE_TRUNK_ASSIGNMENTS',
                'This prefix has explicit trunk assignments but none are active.',
                { prefixId: prefix.prefix_id }
            );
        }

        for (const row of assigned.rows) {
            if (!row.matched_trunk_id) {
                return failure(
                    'TRUNK_TENANT_MISMATCH',
                    'An assigned trunk is missing or belongs to another tenant.',
                    {
                        prefixId: prefix.prefix_id,
                        trunkId: row.trunk_id
                    }
                );
            }

            trunkRows.push(row);
        }
    } else {
        assignmentSource = 'legacy';

        if (!prefix.legacy_trunk_id) {
            return failure(
                'NO_TRUNK_ASSIGNMENT',
                'The prefix has no explicit or legacy trunk assignment.',
                { prefixId: prefix.prefix_id }
            );
        }

        const legacy = await pool.query(
            `SELECT
                 id AS matched_trunk_id,
                 id AS trunk_id,
                 name AS trunk_name,
                 is_active AS trunk_active,
                 provisioning_status AS trunk_status,
                 wazo_trunk_id,
                 0 AS priority
             FROM trunks
             WHERE id = $1
               AND tenant_id = $2`,
            [prefix.legacy_trunk_id, tenantId]
        );

        trunkRows = legacy.rows;

        if (!trunkRows.length) {
            return failure(
                'LEGACY_TRUNK_TENANT_MISMATCH',
                'The legacy trunk is missing or belongs to another tenant.',
                { prefixId: prefix.prefix_id }
            );
        }
    }

    const seenWazoIds = new Set();
    const trunks = [];

    for (const trunk of trunkRows) {
        const wazoTrunkId = validPositiveInteger(trunk.wazo_trunk_id);

        if (
            trunk.trunk_active !== true ||
            trunk.trunk_status !== 'provisioned' ||
            !wazoTrunkId
        ) {
            return failure(
                'TRUNK_NOT_READY',
                `Trunk "${trunk.trunk_name || trunk.trunk_id}" is not active and provisioned.`,
                {
                    prefixId: prefix.prefix_id,
                    trunkId: trunk.trunk_id,
                    trunkActive: trunk.trunk_active,
                    trunkStatus: trunk.trunk_status
                }
            );
        }

        if (seenWazoIds.has(wazoTrunkId)) {
            return failure(
                'DUPLICATE_WAZO_TRUNK_ID',
                'Multiple assigned trunks have the same Wazo trunk ID.',
                { prefixId: prefix.prefix_id, wazoTrunkId }
            );
        }

        seenWazoIds.add(wazoTrunkId);

        trunks.push({
            id: trunk.trunk_id,
            name: trunk.trunk_name,
            wazoTrunkId,
            priority: Number(trunk.priority)
        });
    }

    return {
        ok: true,
        tenantId,
        phoneDigits: digits,
        route: {
            prefixId: prefix.prefix_id,
            prefixDigits: prefix.prefix_digits,
            prefixPriority: Number(prefix.priority),
            provisioningStatus: prefix.prefix_status,
            assignmentSource,
            outcallId,
            patternExtensionId,
            contextId,
            contextName: prefix.wazo_outcall_context_name,
            wazoTenantUuid: prefix.wazo_tenant_uuid,
            stripDigits,
            prependDigits
        },
        trunks,
        // Wazo should receive the original normalized dial string.
        // Its verified extension/outcall association applies strip/prepend.
        destination: {
            context: prefix.wazo_outcall_context_name,
            extension: digits,
            priority: 1
        },
        verification: {
            databaseOwnershipChecked: true,
            tenantContextDatabaseStatusChecked: true,
            trunkAssignmentsChecked: true,
            liveWazoResourceRecheckPerformed: false,
            callOriginated: false
        }
    };
}


/**
 * Verify a database-resolved route against live Wazo resources.
 *
 * Read-only: authenticates and performs GET requests only.
 * It never creates, enables, disables, or modifies Wazo resources.
 */
async function verifyOutboundRouteLive(tenantId, phoneNumber) {
    const databaseRoute = await resolveOutboundRouteForNumber(
        tenantId,
        phoneNumber
    );

    if (!databaseRoute.ok) {
        return {
            ok: false,
            liveVerified: false,
            stage: 'database_resolution',
            databaseRoute
        };
    }

    const expectedTenant = String(
        databaseRoute.route.wazoTenantUuid
    ).toLowerCase();

    async function authenticate() {
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
            throw new Error(
                `Wazo authentication failed (HTTP ${response.status})`
            );
        }

        return payload.data.token;
    }

    async function getResource(token, resourcePath) {
        const response = await wazoFetch(
            `${config.wazo.confdUrl.replace(/\/$/, '')}${resourcePath}`,
            {
                method: 'GET',
                headers: {
                    'X-Auth-Token': token,
                    'Wazo-Tenant': databaseRoute.route.wazoTenantUuid,
                    'Content-Type': 'application/json'
                }
            }
        );

        const raw = await response.text().catch(() => '');
        let payload = {};

        try {
            payload = raw ? JSON.parse(raw) : {};
        } catch (_) {}

        if (!response.ok) {
            throw new Error(
                `Wazo GET ${resourcePath} failed (HTTP ${response.status}): ` +
                String(
                    payload?.message ||
                    payload?.error ||
                    raw ||
                    'empty response'
                ).slice(0, 250)
            );
        }

        return payload?.data?.data || payload?.data || payload;
    }

    try {
        const token = await authenticate();
        const route = databaseRoute.route;

        const context = await getResource(
            token,
            `/contexts/${route.contextId}`
        );

        const outcall = await getResource(
            token,
            `/outcalls/${route.outcallId}`
        );

        const extension = await getResource(
            token,
            `/extensions/${route.patternExtensionId}`
        );

        const expectedTrunkIds = databaseRoute.trunks
            .map(trunk => Number(trunk.wazoTrunkId))
            .sort((a, b) => a - b);

        const outcallTrunks = Array.isArray(outcall.trunks)
            ? outcall.trunks.map(item => Number(item?.id)).sort((a, b) => a - b)
            : [];

        const outcallExtension = Array.isArray(outcall.extensions)
            ? outcall.extensions.find(
                item => Number(item?.id) === route.patternExtensionId
            )
            : null;

        const expectedExternalPrefix =
            route.prependDigits || null;

        const checks = {
            contextIdMatches:
                Number(context.id) === route.contextId,

            contextNameMatches:
                context.name === route.contextName,

            contextTypeIsOutcall:
                String(context.type || '').toLowerCase() === 'outcall',

            contextTenantMatches:
                String(context.tenant_uuid || '').toLowerCase() === expectedTenant,

            contextEnabled:
                context.enabled === true,

            outcallIdMatches:
                Number(outcall.id) === route.outcallId,

            outcallTenantMatches:
                String(outcall.tenant_uuid || '').toLowerCase() === expectedTenant,

            outcallEnabled:
                outcall.enabled === true,

            outcallTrunksMatch:
                JSON.stringify(outcallTrunks) === JSON.stringify(expectedTrunkIds),

            extensionIdMatches:
                Number(extension.id) === route.patternExtensionId,

            extensionPatternMatches:
                extension.exten === `_${route.prefixDigits}.`,

            extensionContextMatches:
                extension.context === route.contextName,

            extensionTenantMatches:
                String(extension.tenant_uuid || '').toLowerCase() === expectedTenant,

            extensionOutcallMatches:
                Number(extension.outcall?.id) === route.outcallId,

            extensionHasNoLines:
                Array.isArray(extension.lines) && extension.lines.length === 0,

            outcallExtensionAssociationPresent:
                Boolean(outcallExtension),

            wazoStripDigitsMatch:
                Boolean(outcallExtension) &&
                Number(outcallExtension.strip_digits) === route.stripDigits,

            wazoExternalPrefixMatches:
                Boolean(outcallExtension) &&
                (outcallExtension.external_prefix || null) === expectedExternalPrefix
        };

        const trunkDetails = [];

        for (const expected of databaseRoute.trunks) {
            const trunk = await getResource(
                token,
                `/trunks/${expected.wazoTrunkId}`
            );

            const reverseOutcallIds = Array.isArray(trunk.outcalls)
                ? trunk.outcalls.map(item => Number(item?.id ?? item))
                : [];

            const trunkChecks = {
                trunkIdMatches:
                    Number(trunk.id) === expected.wazoTrunkId,

                tenantMatches:
                    String(trunk.tenant_uuid || '').toLowerCase() === expectedTenant,

                reverseOutcallAssociationPresent:
                    reverseOutcallIds.includes(route.outcallId)
            };

            trunkDetails.push({
                expectedWazoTrunkId: expected.wazoTrunkId,
                name: expected.name,
                checks: trunkChecks
            });

            checks[`trunk_${expected.wazoTrunkId}_id_matches`] =
                trunkChecks.trunkIdMatches;

            checks[`trunk_${expected.wazoTrunkId}_tenant_matches`] =
                trunkChecks.tenantMatches;

            checks[`trunk_${expected.wazoTrunkId}_reverse_association_matches`] =
                trunkChecks.reverseOutcallAssociationPresent;
        }

        const failedChecks = Object.entries(checks)
            .filter(([, passed]) => passed !== true)
            .map(([name]) => name);

        return {
            ok: failedChecks.length === 0,
            liveVerified: failedChecks.length === 0,
            stage: 'live_wazo_resource_verification',
            route: {
                tenantId,
                phoneDigits: databaseRoute.phoneDigits,
                prefixId: route.prefixId,
                prefixDigits: route.prefixDigits,
                outcallId: route.outcallId,
                contextId: route.contextId,
                contextName: route.contextName,
                patternExtensionId: route.patternExtensionId,
                stripDigits: route.stripDigits,
                prependDigits: route.prependDigits
            },
            trunks: trunkDetails,
            checks,
            failedChecks,
            callOriginated: false,
            configurationChanged: false
        };
    } catch (error) {
        return {
            ok: false,
            liveVerified: false,
            stage: 'live_wazo_resource_verification',
            error: String(error.message || error).slice(0, 500),
            callOriginated: false,
            configurationChanged: false
        };
    }
}

module.exports = {
    resolveOutboundRouteForNumber,
    verifyOutboundRouteLive
};
