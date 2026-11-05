'use strict';

/**
 * Progressive campaign origination adapter.
 *
 * Disabled unless both independent flags are explicitly true:
 *   CAMPAIGN_DIALING_ENABLED=true
 *   CAMPAIGN_AGENT_PROGRESSIVE_ENABLED=true
 *
 * This module only originates progressive agent-first calls.
 * It does not implement predictive/power bridging or Robo media playback.
 */

const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');
const wazoAgentService = require('./wazoAgentService');

const { verifyOutboundRouteLive } = require('./outboundRouteResolver');
const correlation = require('./campaignDialCorrelation');
const { tenantHasFeatures } = require('./tenantFeatures');

function isEnabled() {
    return process.env.CAMPAIGN_DIALING_ENABLED === 'true' &&
        process.env.CAMPAIGN_AGENT_PROGRESSIVE_ENABLED === 'true';
}

async function getWazoToken() {
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
        throw new Error(`Wazo authentication failed (HTTP ${response.status})`);
    }

    return payload.data.token;
}

async function releaseNotSent(tenantId, claimId, claimToken, reason) {
    return correlation.releaseBeforeOrigination(
        tenantId, claimId, claimToken, reason
    );
}

async function verifyDialingFeatures(tenantId, claimId, claimToken) {
    const requiredFeatures = ['campaigns', 'auto_dialer'];

    let enabled;
    try {
        enabled = await tenantHasFeatures(tenantId, requiredFeatures);
    } catch (error) {
        await releaseNotSent(
            tenantId,
            claimId,
            claimToken,
            `Tenant feature verification failed before origination: ${error.message}`
        ).catch(() => {});

        return {
            ok: false,
            reason: 'tenant_feature_check_failed',
            features: requiredFeatures
        };
    }

    if (!enabled) {
        await releaseNotSent(
            tenantId,
            claimId,
            claimToken,
            'Campaign or auto-dialer feature is disabled for this tenant'
        ).catch(() => {});

        return {
            ok: false,
            reason: 'tenant_feature_disabled',
            features: requiredFeatures
        };
    }

    return { ok: true };
}

async function markUncertain(
    tenantId, claimId, claimToken, reason, wazoCallId = null
) {
    const result = await correlation.markOriginationUncertain(
        tenantId,
        claimId,
        claimToken,
        reason,
        undefined,
        wazoCallId
    );

    if (result.ok && wazoCallId) {
        try {
            result.reconciliation = await correlation.reconcileWazoCall(
                tenantId, wazoCallId
            );
        } catch (error) {
            result.reconciliationError = String(error.message || error).slice(0, 300);
        }
    }

    return result;
}

/**
 * Originate exactly one previously claimed progressive lead.
 * This function is deliberately not called by any scheduler yet.
 */
async function originateProgressiveClaim(tenantId, claimId, claimToken) {
    if (!isEnabled()) {
        return {
            ok: false,
            skipped: true,
            reason: 'progressive_campaign_dialing_disabled'
        };
    }

    const prepared = await correlation.beginOrigination(
        tenantId, claimId, claimToken
    );

    if (!prepared.ok) return prepared;

    const initialFeatureCheck = await verifyDialingFeatures(
        tenantId, claimId, claimToken
    );
    if (!initialFeatureCheck.ok) {
        return { ...initialFeatureCheck, skipped: true };
    }

    // The route verifier is read-only. A failed route is a definite
    // preflight failure, so the claim may safely be released.
    let verifiedRoute;
    try {
        verifiedRoute = await verifyOutboundRouteLive(
            tenantId, prepared.phoneNumber
        );
    } catch (error) {
        await releaseNotSent(
            tenantId, claimId, claimToken,
            `Outbound route verification failed: ${error.message}`
        );
        return { ok: false, reason: 'outbound_route_verification_failed' };
    }

    if (!verifiedRoute?.ok || !verifiedRoute?.liveVerified) {
        await releaseNotSent(
            tenantId, claimId, claimToken,
            `Outbound route is not live verified: ${verifiedRoute?.stage || 'unknown'}`
        );

        return {
            ok: false,
            reason: 'outbound_route_not_live_verified',
            routeStage: verifiedRoute?.stage || null,
            failedChecks: verifiedRoute?.failedChecks || []
        };
    }

    // Recheck Wazo agent login/pause state after route verification.
    // calld performs the final SIP-line-availability validation itself.
    try {
        const agent = await wazoAgentService.getAgent(
            prepared.wazoTenantUuid,
            prepared.agentNumber,
            prepared.wazoAgentId
        );

        if (agent.logged !== true || agent.paused === true) {
            await releaseNotSent(
                tenantId, claimId, claimToken,
                'Wazo agent is not logged in and unpaused'
            );
            return { ok: false, reason: 'wazo_agent_not_available' };
        }
    } catch (error) {
        await releaseNotSent(
            tenantId, claimId, claimToken,
            `Wazo agent preflight failed: ${error.message}`
        );
        return { ok: false, reason: 'wazo_agent_preflight_failed' };
    }

    // Authentication failure occurs before the call request is sent.
    let token;
    try {
        token = await getWazoToken();
    } catch (error) {
        await releaseNotSent(
            tenantId, claimId, claimToken,
            `Wazo authentication failed before origination: ${error.message}`
        );
        return { ok: false, reason: 'wazo_authentication_failed' };
    }

    const requestBody = {
        source: {
            user: prepared.wazoUserUuid,
            line_id: prepared.wazoLineId
        },
        destination: {
            context: verifiedRoute.route.contextName,
            extension: verifiedRoute.route.phoneDigits,
            priority: 1
        },
        variables: {
            TECHLIFE_CAMPAIGN_CLAIM_ID: String(prepared.claimId),
            TECHLIFE_CAMPAIGN_ID: String(prepared.campaignId),
            TECHLIFE_LEAD_ID: String(prepared.leadId)
        }
    };

    // Recheck the tenant's entitlement at the last possible point before
    // making the Wazo request. A disabled feature must never originate a call.
    const finalFeatureCheck = await verifyDialingFeatures(
        tenantId, claimId, claimToken
    );
    if (!finalFeatureCheck.ok) {
        return { ...finalFeatureCheck, skipped: true };
    }

    // From this point, a transport error or ambiguous HTTP response is
    // uncertain: Wazo may have accepted the request. Never auto-redial it.
    let response;
    let rawBody;

    try {
        response = await wazoFetch(
            `${config.wazo.calldUrl.replace(/\/$/, '')}/calls`,
            {
                method: 'POST',
                headers: {
                    'X-Auth-Token': token,
                    'Wazo-Tenant': prepared.wazoTenantUuid,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify(requestBody)
            }
        );

        rawBody = await response.text();
    } catch (error) {
        const uncertain = await markUncertain(
            tenantId, claimId, claimToken,
            `Wazo request transport outcome uncertain: ${error.message}`
        );

        return {
            ok: false,
            uncertain: true,
            reason: 'wazo_request_outcome_uncertain',
            reconciliation: uncertain
        };
    }

    let payload = {};
    try {
        payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (_) {}

    if (!response.ok) {
        const detail = String(
            payload?.message ||
            payload?.error ||
            payload?.reason ||
            `HTTP ${response.status}`
        ).slice(0, 300);

        // These responses indicate a rejected request. Other statuses,
        // including 5xx, are treated conservatively as uncertain.
        const definiteRejection = [400, 401, 403, 404, 409, 422]
            .includes(response.status);

        if (definiteRejection) {
            await releaseNotSent(
                tenantId, claimId, claimToken,
                `Wazo rejected origination (${response.status}): ${detail}`
            );

            return {
                ok: false,
                reason: 'wazo_origination_rejected',
                httpStatus: response.status,
                detail
            };
        }

        const uncertain = await markUncertain(
            tenantId, claimId, claimToken,
            `Wazo HTTP ${response.status}: ${detail}`
        );

        return {
            ok: false,
            uncertain: true,
            reason: 'wazo_http_outcome_uncertain',
            httpStatus: response.status,
            reconciliation: uncertain
        };
    }

    const wazoCallId = payload?.call_id || payload?.data?.call_id || null;

    if (!wazoCallId) {
        const uncertain = await markUncertain(
            tenantId, claimId, claimToken,
            'Wazo returned success without a call_id'
        );

        return {
            ok: false,
            uncertain: true,
            reason: 'wazo_response_missing_call_id',
            reconciliation: uncertain
        };
    }

    try {
        const accepted = await correlation.recordAcceptedOrigination(
            tenantId, claimId, claimToken, wazoCallId
        );

        if (accepted.ok) {
            return {
                ok: true,
                originated: true,
                claimId,
                callId: accepted.callId,
                wazoCallId
            };
        }

        const uncertain = await markUncertain(
            tenantId, claimId, claimToken,
            `Wazo accepted call but claim correlation returned ${accepted.reason}`,
            wazoCallId
        );

        return {
            ok: false,
            uncertain: true,
            reason: 'wazo_accepted_but_claim_correlation_incomplete',
            wazoCallId,
            reconciliation: uncertain
        };
    } catch (error) {
        const uncertain = await markUncertain(
            tenantId, claimId, claimToken,
            `Wazo accepted call but database correlation failed: ${error.message}`,
            wazoCallId
        );

        return {
            ok: false,
            uncertain: true,
            reason: 'wazo_accepted_database_correlation_failed',
            wazoCallId,
            reconciliation: uncertain
        };
    }
}

module.exports = {
    isEnabled,
    originateProgressiveClaim
};
