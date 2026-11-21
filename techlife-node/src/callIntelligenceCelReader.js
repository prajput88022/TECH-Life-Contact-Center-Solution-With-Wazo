'use strict';

const { Pool } = require('pg');
const config = require('../config/config');
const { CallIntelligenceIdentityResolver } =
    require('./callIntelligenceIdentityResolver');

const celPool = new Pool({
    host: config.db.host,
    port: Number(config.db.port || 5432),
    database: 'asterisk',
    user: config.db.user,
    password: config.db.password,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    options: '-c default_transaction_read_only=on',
    application_name: 'techlife-call-intelligence-cel-reader'
});

const resolver = new CallIntelligenceIdentityResolver();

let resolverRefreshPromise = null;
const RESOLVER_TTL_MS = 30000;
const MAX_CEL_EVENTS = 5000;

celPool.on('error', error => {
    console.error('[call-intelligence-cel] PostgreSQL pool error:', error.message);
});

function normalized(value) {
    return String(value || '').trim().toLowerCase();
}

function validDirection(value) {
    const direction = normalized(value);
    return ['inbound', 'outbound', 'internal'].includes(direction)
        ? direction
        : null;
}

async function refreshIdentityResolver() {
    const refreshedAt = resolver.refreshedAt
        ? new Date(resolver.refreshedAt).getTime()
        : 0;

    if (
        refreshedAt &&
        Date.now() - refreshedAt < RESOLVER_TTL_MS
    ) {
        return;
    }

    if (!resolverRefreshPromise) {
        resolverRefreshPromise = resolver.refresh().finally(() => {
            resolverRefreshPromise = null;
        });
    }

    await resolverRefreshPromise;
}

function resolveDirection(events, legs, fallbackDirection) {
    const hasOutboundMarker = events.some(event =>
        normalized(event.eventtype) === 'xivo_outcall' ||
        normalized(event.userdeftype) === 'xivo_outcall' ||
        normalized(event.context).includes('outcall')
    );

    if (hasOutboundMarker) return 'outbound';

    const agentNumbers = new Set(
        legs
            .filter(leg => leg.channelRole === 'agent')
            .map(leg => String(leg.agentNumber || leg.endpointName))
            .filter(Boolean)
    );

    if (agentNumbers.size >= 2) return 'internal';

    const hasInboundMarker = events.some(event =>
        normalized(event.eventtype) === 'xivo_incall' ||
        normalized(event.userdeftype) === 'xivo_incall' ||
        normalized(event.context).includes('incall')
    );

    if (hasInboundMarker) return 'inbound';

    const internalContext = events.some(event =>
        normalized(event.context).includes('internal')
    );

    if (internalContext && agentNumbers.size >= 2) return 'internal';

    return validDirection(fallbackDirection) || 'unknown';
}

function legNode(leg) {
    return {
        kind: 'leg',
        kindLabel: leg.channelRole === 'agent' ? 'Agent channel' : 'Trunk channel',
        title: leg.label,
        detail: leg.channelName,
        uniqueId: leg.uniqueId,
        meta: `${leg.eventCount} CEL events`
    };
}

function buildFlowNodes(direction, legs, linkedId, toNumber) {
    const agentLegs = legs.filter(leg => leg.channelRole === 'agent');
    const trunkLegs = legs.filter(leg => leg.channelRole === 'trunk');

    const nodes = [];

    const coreNode = {
        kind: 'core',
        kindLabel: 'Call processing',
        title: 'Asterisk / Wazo',
        detail: `Linkedid: ${linkedId}`,
        uniqueId: null,
        meta: 'Correlated by Asterisk CEL'
    };

    const missingNode = (role) => ({
        kind: 'missing',
        kindLabel: 'Unverified channel',
        title: role === 'trunk'
            ? 'Trunk channel not identified'
            : 'Agent channel not identified',
        detail: 'No tenant-verified PJSIP channel was found',
        uniqueId: null,
        meta: 'Not reconstructed or assumed'
    });

    if (direction === 'outbound') {
        nodes.push(
            ...(agentLegs.length
                ? agentLegs.map(legNode)
                : [missingNode('agent')])
        );

        nodes.push(coreNode);

        nodes.push(
            ...(trunkLegs.length
                ? trunkLegs.map(legNode)
                : [missingNode('trunk')])
        );

        if (toNumber) {
            nodes.push({
                kind: 'destination',
                kindLabel: 'Dialled destination',
                title: String(toNumber),
                detail: 'Number recorded by TECH-Life',
                uniqueId: null,
                meta: 'Remote carrier connection is not independently confirmed by this node'
            });
        }
    } else if (direction === 'inbound') {
        nodes.push(
            ...(trunkLegs.length
                ? trunkLegs.map(legNode)
                : [missingNode('trunk')])
        );

        nodes.push(coreNode);

        nodes.push(
            ...(agentLegs.length
                ? agentLegs.map(legNode)
                : [missingNode('agent')])
        );
    } else if (direction === 'internal') {
        const firstAgent = agentLegs.slice(0, 1);
        const secondAgent = agentLegs.slice(1);

        nodes.push(
            ...(firstAgent.length
                ? firstAgent.map(legNode)
                : [missingNode('agent')])
        );

        nodes.push(coreNode);

        nodes.push(
            ...(secondAgent.length
                ? secondAgent.map(legNode)
                : [missingNode('agent')])
        );
    } else {
        const observedLegs = [...legs].sort((a, b) =>
            new Date(a.firstEventTime || 0) - new Date(b.firstEventTime || 0)
        );

        nodes.push(...observedLegs.map(legNode));

        if (nodes.length > 1) {
            nodes.splice(1, 0, coreNode);
        }
    }

    return nodes;
}

async function getCallTrace({
    tenantId,
    wazoCallId,
    fallbackDirection,
    toNumber
}) {
    if (!tenantId || !wazoCallId) {
        return {
            available: false,
            reason: 'missing_call_identity'
        };
    }

    try {
        await refreshIdentityResolver();

        // First find the exact CEL channel Uniqueid belonging to the
        // TECH-Life call. The Linkedid then identifies the complete call.
        const seedResult = await celPool.query(
            `SELECT DISTINCT linkedid
               FROM public.cel
              WHERE (uniqueid = $1 OR linkedid = $1)
                AND linkedid IS NOT NULL
                AND linkedid <> ''
              LIMIT 3`,
            [String(wazoCallId)]
        );

        if (!seedResult.rows.length) {
            return {
                available: false,
                reason: 'cel_call_not_found'
            };
        }

        if (seedResult.rows.length !== 1) {
            return {
                available: false,
                reason: 'ambiguous_cel_linkedid'
            };
        }

        const linkedId = String(seedResult.rows[0].linkedid);

        const celResult = await celPool.query(
            `SELECT
                id,
                eventtype,
                eventtime,
                userdeftype,
                cid_name,
                cid_num,
                cid_ani,
                cid_rdnis,
                cid_dnid,
                exten,
                context,
                channame,
                appname,
                appdata,
                amaflags,
                accountcode,
                peeraccount,
                uniqueid,
                linkedid,
                userfield,
                peer,
                extra::text AS extra_text,
                call_log_id
             FROM public.cel
             WHERE linkedid = $1
             ORDER BY eventtime ASC, id ASC
             LIMIT $2`,
            [linkedId, MAX_CEL_EVENTS]
        );

        const allEvents = celResult.rows;

        if (!allEvents.length) {
            return {
                available: false,
                reason: 'cel_events_not_found'
            };
        }

        // Resolve each distinct PJSIP channel against the existing
        // Wazo/TECH-Life endpoint identity maps.
        const channelGroups = new Map();

        for (const event of allEvents) {
            const channel = String(event.channame || '').trim();

            if (!channel || !channel.startsWith('PJSIP/')) continue;

            if (!channelGroups.has(channel)) {
                channelGroups.set(channel, []);
            }

            channelGroups.get(channel).push(event);
        }

        const identityByChannel = new Map();
        const targetTenantId = String(tenantId).trim().toLowerCase();

        for (const [channel, channelEvents] of channelGroups.entries()) {
            const contexts = [
                ...new Set(
                    channelEvents
                        .map(event => String(event.context || '').trim())
                        .filter(Boolean)
                )
            ];

            // Try the observed contexts individually. An endpoint is
            // accepted only when the resolver verifies its tenant.
            for (const context of contexts.length ? contexts : ['']) {
                const identity = resolver.resolveChannel(
                    channel,
                    context ? { CONTEXT: context } : {}
                );

                if (
                    identity?.verified === true &&
                    String(identity.tenantId || '').trim().toLowerCase() === targetTenantId
                ) {
                    identityByChannel.set(channel, identity);
                    break;
                }
            }
        }

        // Never show linkedid events merely because the call ID was
        // supplied by a tenant-scoped call record. At least one PJSIP
        // endpoint must verify against this exact tenant.
        if (!identityByChannel.size) {
            return {
                available: false,
                reason: 'tenant_identity_not_verified'
            };
        }

        // Filter CEL rows to channels positively mapped to this tenant.
        const tenantEvents = allEvents.filter(event =>
            identityByChannel.has(String(event.channame || '').trim())
        );

        if (!tenantEvents.length) {
            return {
                available: false,
                reason: 'no_tenant_verified_events'
            };
        }

        const legMap = new Map();

        for (const event of tenantEvents) {
            const channel = String(event.channame || '').trim();
            const identity = identityByChannel.get(channel);

            if (!identity) continue;

            const uniqueId = String(event.uniqueid || '').trim();
            const key = uniqueId || `channel:${channel}`;

            const eventTime = event.eventtime
                ? new Date(event.eventtime)
                : null;

            let leg = legMap.get(key);

            if (!leg) {
                const isAgent = identity.channelRole === 'agent';

                leg = {
                    uniqueId: uniqueId || null,
                    linkedId: String(event.linkedid || linkedId),
                    channelName: channel,
                    channelNames: [],
                    endpointName: identity.endpointName,
                    channelRole: identity.channelRole,
                    agentId: identity.agentId || null,
                    agentNumber: identity.agentNumber || null,
                    trunkId: identity.trunkId || null,
                    trunkName: identity.trunkName || null,
                    label: isAgent
                        ? `Agent ${identity.agentNumber || identity.endpointName}`
                        : `Trunk ${identity.trunkName || identity.endpointName}`,
                    firstEventTime: eventTime,
                    lastEventTime: eventTime,
                    eventCount: 0,
                    eventTypes: [],
                    contexts: []
                };

                legMap.set(key, leg);
            }

            if (!leg.channelNames.includes(channel)) {
                leg.channelNames.push(channel);
            }

            if (
                eventTime &&
                (!leg.firstEventTime || eventTime < leg.firstEventTime)
            ) {
                leg.firstEventTime = eventTime;
            }

            if (
                eventTime &&
                (!leg.lastEventTime || eventTime > leg.lastEventTime)
            ) {
                leg.lastEventTime = eventTime;
            }

            leg.eventCount += 1;

            if (event.eventtype && !leg.eventTypes.includes(event.eventtype)) {
                leg.eventTypes.push(event.eventtype);
            }

            if (event.context && !leg.contexts.includes(event.context)) {
                leg.contexts.push(event.context);
            }
        }

        const legs = [...legMap.values()].sort((a, b) =>
            new Date(a.firstEventTime || 0) -
            new Date(b.firstEventTime || 0)
        );

        const direction = resolveDirection(
            tenantEvents,
            legs,
            fallbackDirection
        );

        const events = tenantEvents.map(event => {
            const identity = identityByChannel.get(
                String(event.channame || '').trim()
            );

            return {
                id: event.id,
                eventType: event.eventtype,
                eventTime: event.eventtime,
                userdefType: event.userdeftype,
                channelName: event.channame,
                channelRole: identity?.channelRole || 'unknown',
                channelLabel: identity?.channelRole === 'agent'
                    ? `Agent ${identity.agentNumber || identity.endpointName}`
                    : `Trunk ${identity?.trunkName || identity?.endpointName || ''}`,
                callerName: event.cid_name,
                callerNumber: event.cid_num,
                extension: event.exten,
                context: event.context,
                appName: event.appname,
                appData: event.appdata,
                peer: event.peer,
                uniqueId: event.uniqueid,
                linkedId: event.linkedid,
                callLogId: event.call_log_id,
                extra: event.extra_text
            };
        });

        return {
            available: true,
            source: 'asterisk_cel',
            linkedId,
            direction,
            eventCount: events.length,
            legCount: legs.length,
            omittedEventCount: Math.max(0, allEvents.length - tenantEvents.length),
            legs,
            events,
            flowNodes: buildFlowNodes(
                direction,
                legs,
                linkedId,
                toNumber
            )
        };
    } catch (error) {
        console.error(
            '[call-intelligence-cel] Trace lookup failed:',
            error.message
        );

        return {
            available: false,
            reason: 'cel_trace_lookup_failed'
        };
    }
}

module.exports = {
    getCallTrace
};
