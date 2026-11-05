'use strict';

/**
 * Shared campaign dial engine.
 *
 * Phase 1:
 * - Read-only diagnostics
 * - Atomic campaign lead claims
 * - Per-claim tokens and attempt numbers
 * - Progressive agent reservations
 * - Robo claims without human-agent reservations
 * - Safe recovery of claims that never entered origination
 *
 * This module DOES NOT originate, connect, bridge, or hang up calls.
 */

const { pool } = require('./db');
const wazoAgentService = require('./wazoAgentService');
const { tenantHasFeatures } = require('./tenantFeatures');

const ACTIVE_CLAIM_STATUSES = ['claimed', 'originating', 'ringing', 'in_flight'];
const LIVE_AGENT_MODES = new Set(['progressive']);
const ROBO_MODES = new Set(['voice_blast', 'robo_survey']);

function positiveInt(value, fallback, maximum = 100) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, maximum);
}

function computeCapacity(campaign) {
    if (campaign.is_robo_campaign && campaign.max_concurrent_robo_calls) {
        return positiveInt(campaign.max_concurrent_robo_calls, 1, 100);
    }

    const level = Number(campaign.dial_level || 1);
    if (!Number.isFinite(level) || level < 1) return 1;

    return Math.min(100, Math.max(1, Math.ceil(level)));
}

function withinCallingHours(campaign) {
    const hours = campaign.calling_hours_json || {};
    if (!hours || Object.keys(hours).length === 0) return true;

    const day = new Date()
        .toLocaleDateString('en-US', { weekday: 'short' })
        .toLowerCase();

    if (!hours[day]) return false;

    const now = new Date().toTimeString().slice(0, 5);
    return now >= (hours[day].from || '00:00') &&
           now <= (hours[day].to || '23:59');
}

async function getCampaign(tenantId, campaignId, db = pool) {
    const result = await db.query(
        `SELECT *
           FROM campaigns
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, campaignId]
    );
    return result.rows[0] || null;
}

/**
 * Database-side availability is intentionally conservative.
 * Wazo's logged/paused state is checked separately before reservation.
 */
async function getAvailableAgentCandidates(tenantId, campaignId, db = pool) {
    const result = await db.query(
        `SELECT
             a.id AS agent_id,
             a.agent_number,
             a.wazo_agent_id,
             a.wazo_line_id,
             a.wazo_extension_id,
             u.wazo_user_uuid,
             t.wazo_tenant_uuid,
             current_status.started_at AS available_since
         FROM campaign_agents ca
         JOIN agents a
           ON a.id = ca.agent_id
          AND a.tenant_id = ca.tenant_id
         JOIN users u
           ON u.id = a.user_id
          AND u.tenant_id = a.tenant_id
         JOIN tenants t ON t.id = a.tenant_id
         JOIN LATERAL (
             SELECT ase.status::text AS status, ase.started_at
               FROM agent_status_events ase
              WHERE ase.tenant_id = a.tenant_id
                AND ase.agent_id = a.id
                AND ase.ended_at IS NULL
              ORDER BY ase.started_at DESC
              LIMIT 1
         ) current_status ON current_status.status = 'available'
         WHERE ca.tenant_id = $1
           AND ca.campaign_id = $2
           AND a.is_active = TRUE
           AND a.provisioning_status = 'provisioned'
           AND a.wazo_agent_id IS NOT NULL
           AND a.wazo_line_id IS NOT NULL
           AND a.wazo_extension_id IS NOT NULL
           AND a.agent_number IS NOT NULL
           AND u.is_active = TRUE
           AND u.wazo_user_uuid IS NOT NULL
           AND t.is_active = TRUE
           AND t.wazo_tenant_uuid IS NOT NULL
           AND NOT EXISTS (
               SELECT 1
                 FROM calls c
                WHERE c.tenant_id = a.tenant_id
                  AND c.agent_id = a.id
                  AND c.status IN ('ringing', 'answered')
                  AND c.end_time IS NULL
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM campaign_agent_reservations r
                WHERE r.tenant_id = a.tenant_id
                  AND r.agent_id = a.id
                  AND r.reservation_status IN
                      ('reserved', 'dialing', 'connected')
                  AND (
                      r.reservation_status = 'connected'
                      OR r.expires_at > NOW()
                  )
           )
         ORDER BY current_status.started_at, a.agent_number, a.id`,
        [tenantId, campaignId]
    );

    return result.rows;
}

async function checkWazoAgentAvailability(candidate) {
    try {
        const agent = await wazoAgentService.getAgent(
            candidate.wazo_tenant_uuid,
            candidate.agent_number,
            candidate.wazo_agent_id
        );

        return {
            available: agent.logged === true && agent.paused !== true,
            logged: agent.logged === true,
            paused: agent.paused === true
        };
    } catch (error) {
        return {
            available: false,
            logged: false,
            paused: false,
            error: error.message
        };
    }
}

async function getWazoAvailableAgents(candidates) {
    const results = [];

    // Sequential calls avoid flooding agentd with parallel requests.
    for (const candidate of candidates.slice(0, 50)) {
        const state = await checkWazoAgentAvailability(candidate);
        if (state.available) results.push(candidate);
    }

    return results;
}

/**
 * Read-only diagnostic. It does not claim leads, reserve agents,
 * alter retries, or originate calls.
 */
async function dryRunCampaign(tenantId, campaignId, previewLimit = 10) {
    const limit = positiveInt(previewLimit, 10, 50);
    const campaign = await getCampaign(tenantId, campaignId);

    if (!campaign) {
        return {
            ok: false,
            dryRun: true,
            eligible: false,
            reason: 'campaign_not_found_for_tenant'
        };
    }

    const capacity = computeCapacity(campaign);

    const counts = await pool.query(
        `WITH candidates AS (
            SELECT
                l.id,
                l.priority,
                l.created_at,
                (SELECT COALESCE(MAX(la.attempt_number), 0)::int + 1
                   FROM lead_attempts la
                  WHERE la.tenant_id = l.tenant_id
                    AND la.lead_id = l.id) AS next_attempt,
                (
                    SELECT la.next_retry_at
                      FROM lead_attempts la
                     WHERE la.tenant_id = l.tenant_id
                       AND la.lead_id = l.id
                     ORDER BY la.attempted_at DESC, la.id DESC
                     LIMIT 1
                ) AS next_retry_at,
                EXISTS (
                    SELECT 1
                      FROM do_not_call_entries d
                     WHERE d.tenant_id = l.tenant_id
                       AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                           regexp_replace(l.phone_number, '\\D', '', 'g')
                       AND (d.campaign_id IS NULL OR d.campaign_id = l.campaign_id)
                ) AS is_dnc,
                EXISTS (
                    SELECT 1
                      FROM campaign_dial_claims dc
                     WHERE dc.tenant_id = l.tenant_id
                       AND dc.lead_id = l.id
                       AND dc.claim_status = ANY($3::varchar[])
                ) AS is_claimed
            FROM leads l
            WHERE l.tenant_id = $1
              AND l.campaign_id = $2
              AND l.status IN ('new', 'in_progress')
        )
        SELECT
            COUNT(*)::int AS pending_count,
            COUNT(*) FILTER (WHERE is_dnc)::int AS dnc_count,
            COUNT(*) FILTER (WHERE is_claimed)::int AS claimed_count,
            COUNT(*) FILTER (
                WHERE NOT is_dnc
                  AND NOT is_claimed
                  AND next_attempt <= GREATEST($4, 0)
                  AND (next_retry_at IS NULL OR next_retry_at <= NOW())
            )::int AS eligible_count,
            COALESCE(
                jsonb_agg(id ORDER BY priority DESC NULLS LAST, created_at, id)
                    FILTER (
                        WHERE NOT is_dnc
                          AND NOT is_claimed
                          AND next_attempt <= GREATEST($4, 0)
                          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
                    ),
                '[]'::jsonb
            ) AS eligible_ids
        FROM candidates`,
        [
            tenantId,
            campaignId,
            ACTIVE_CLAIM_STATUSES,
            Number(campaign.max_retry_attempts ?? 3)
        ]
    );

    const activeCalls = await pool.query(
        `SELECT COUNT(*)::int AS in_flight
           FROM (
               SELECT dc.id AS item_id
                 FROM campaign_dial_claims dc
                WHERE dc.tenant_id = $1
                  AND dc.campaign_id = $2
                  AND dc.claim_status = ANY($3::varchar[])
               UNION ALL
               SELECT c.id AS item_id
                 FROM calls c
                WHERE c.tenant_id = $1
                  AND c.campaign_id = $2
                  AND c.status IN ('ringing', 'answered')
                  AND c.end_time IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                        FROM campaign_dial_claims dc
                       WHERE dc.tenant_id = c.tenant_id
                         AND dc.call_id = c.id
                         AND dc.claim_status = ANY($3::varchar[])
                  )
           ) occupied_slots`,
        [tenantId, campaignId, ACTIVE_CLAIM_STATUSES]
    );

    const row = counts.rows[0];
    const inFlight = Number(activeCalls.rows[0].in_flight || 0);
    const slots = Math.max(0, capacity - inFlight);

    let dbAvailableAgents = 0;
    if (!campaign.is_robo_campaign) {
        const agents = await getAvailableAgentCandidates(tenantId, campaignId);
        dbAvailableAgents = agents.length;
    }

    let reason = 'ready_for_simulation';

    if (!campaign.is_active) reason = 'campaign_inactive';
    else if (campaign.dialing_mode === 'preview') reason = 'preview_mode_never_auto_dials';
    else if (
        !campaign.is_robo_campaign &&
        !LIVE_AGENT_MODES.has(campaign.dialing_mode)
    ) reason = 'live_agent_strategy_not_yet_implemented';
    else if (
        campaign.is_robo_campaign &&
        !ROBO_MODES.has(campaign.dialing_mode)
    ) reason = 'invalid_robo_campaign_mode';
    else if (!withinCallingHours(campaign)) reason = 'outside_calling_hours';
    else if (slots <= 0) reason = 'capacity_full';
    else if (Number(row.eligible_count || 0) <= 0) reason = 'no_eligible_leads';
    else if (!campaign.is_robo_campaign && dbAvailableAgents <= 0) {
        reason = 'no_database_available_assigned_agents';
    }

    return {
        ok: true,
        dryRun: true,
        eligible: reason === 'ready_for_simulation',
        reason,
        campaign: {
            id: campaign.id,
            name: campaign.name,
            isActive: campaign.is_active,
            isRoboCampaign: campaign.is_robo_campaign,
            dialingMode: campaign.dialing_mode,
            maxRetryAttempts: campaign.max_retry_attempts
        },
        capacity: {
            maximum: capacity,
            inFlight,
            availableSlots: slots
        },
        leads: {
            pendingCount: Number(row.pending_count || 0),
            eligibleCount: Number(row.eligible_count || 0),
            dncExcludedCount: Number(row.dnc_count || 0),
            alreadyClaimedCount: Number(row.claimed_count || 0),
            previewIds: (row.eligible_ids || []).slice(0, limit)
        },
        agents: {
            databaseAvailableCount: dbAvailableAgents,
            wazoAvailabilityChecked: false
        },
        liveDialingEnabled:
            process.env.CAMPAIGN_DIALING_ENABLED === 'true',
        actionsTaken: {
            leadsClaimed: 0,
            agentsReserved: 0,
            recordsModified: 0,
            callsOriginated: 0
        }
    };
}

/**
 * Transition only expired 'claimed' records to retry.
 *
 * Never auto-release 'originating' claims: a network timeout may mean
 * Wazo accepted the call even though TECH-Life did not receive its ID.
 * Such records require call-ID reconciliation instead of redialing.
 */
async function recoverExpiredClaims(db, tenantId, campaignId) {
    const result = await db.query(
        `UPDATE campaign_dial_claims
            SET claim_status = 'retry',
                updated_at = NOW(),
                last_error = COALESCE(
                    last_error,
                    'Claim lease expired before origination began'
                )
          WHERE tenant_id = $1
            AND campaign_id = $2
            AND claim_status = 'claimed'
            AND lease_until < NOW()
          RETURNING id`,
        [tenantId, campaignId]
    );

    if (result.rowCount) {
        await db.query(
            `UPDATE campaign_agent_reservations
                SET reservation_status = 'expired',
                    released_at = NOW(),
                    release_reason = 'claim_lease_expired',
                    updated_at = NOW()
              WHERE claim_id = ANY($1::uuid[])
                AND reservation_status IN ('reserved', 'dialing')`,
            [result.rows.map(row => row.id)]
        );
    }

    const uncertain = await db.query(
        `SELECT COUNT(*)::int AS count
           FROM campaign_dial_claims
          WHERE tenant_id = $1
            AND campaign_id = $2
            AND claim_status = 'originating'
            AND lease_until < NOW()
            AND wazo_call_id IS NULL`,
        [tenantId, campaignId]
    );

    return {
        recovered: result.rowCount,
        uncertainOriginationCount: uncertain.rows[0].count
    };
}

/**
 * Create DB claims only. This function does not call Wazo calld.
 * A separate, verified origination adapter must later consume these claims.
 */
async function claimCampaignLeads(tenantId, campaignId, requestedLimit = 5) {
    const limit = positiveInt(requestedLimit, 5, 20);

    if (process.env.CAMPAIGN_DIALING_ENABLED !== 'true') {
        return { ok: false, claimed: [], reason: 'campaign_dialing_disabled' };
    }

    const campaignSnapshot = await getCampaign(tenantId, campaignId);
    if (!campaignSnapshot || !campaignSnapshot.is_active) {
        return { ok: false, claimed: [], reason: 'campaign_not_active' };
    }

    const runtimeFeature = campaignSnapshot.is_robo_campaign
        ? 'robo_agents'
        : 'auto_dialer';
    const requiredFeatures = ['campaigns', runtimeFeature];

    if (!(await tenantHasFeatures(tenantId, requiredFeatures))) {
        return {
            ok: false,
            claimed: [],
            reason: 'tenant_feature_disabled',
            features: requiredFeatures
        };
    }

    if (campaignSnapshot.dialing_mode === 'preview') {
        return { ok: false, claimed: [], reason: 'preview_mode_never_auto_dials' };
    }

    if (campaignSnapshot.is_robo_campaign) {
        if (!ROBO_MODES.has(campaignSnapshot.dialing_mode)) {
            return { ok: false, claimed: [], reason: 'unsupported_robo_mode' };
        }
        if (process.env.ROBO_AGENT_LIVE_DIALING_ENABLED !== 'true') {
            return { ok: false, claimed: [], reason: 'robo_dialing_disabled' };
        }
    } else if (!LIVE_AGENT_MODES.has(campaignSnapshot.dialing_mode)) {
        return {
            ok: false,
            claimed: [],
            reason: 'customer_first_or_predictive_strategy_not_implemented'
        };
    } else if (
        campaignSnapshot.dialing_mode === 'progressive' &&
        process.env.CAMPAIGN_AGENT_PROGRESSIVE_ENABLED !== 'true'
    ) {
        return {
            ok: false,
            claimed: [],
            reason: 'progressive_campaign_dialing_disabled'
        };
    }

    let wazoAvailableAgents = [];
    if (!campaignSnapshot.is_robo_campaign) {
        const candidates = await getAvailableAgentCandidates(tenantId, campaignId);
        wazoAvailableAgents = await getWazoAvailableAgents(candidates);
        if (!wazoAvailableAgents.length) {
            return { ok: true, claimed: [], reason: 'no_wazo_available_assigned_agents' };
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Serialize ticks for this campaign. Different campaigns can still
        // work concurrently; lead and agent unique indexes protect overlap.
        const locked = await client.query(
            `SELECT *
               FROM campaigns
              WHERE tenant_id = $1 AND id = $2
              FOR UPDATE`,
            [tenantId, campaignId]
        );

        const campaign = locked.rows[0];
        if (!campaign || !campaign.is_active) {
            await client.query('ROLLBACK');
            return { ok: false, claimed: [], reason: 'campaign_not_active' };
        }

        if (
            campaign.dialing_mode !== campaignSnapshot.dialing_mode ||
            campaign.is_robo_campaign !== campaignSnapshot.is_robo_campaign
        ) {
            await client.query('ROLLBACK');
            return { ok: false, claimed: [], reason: 'campaign_configuration_changed' };
        }

        // Recheck while holding the campaign transaction. Existing feature
        // rows are share-locked so a concurrent toggle cannot race this claim.
        const lockedRuntimeFeature = campaign.is_robo_campaign
            ? 'robo_agents'
            : 'auto_dialer';
        const lockedRequiredFeatures = ['campaigns', lockedRuntimeFeature];

        if (!(await tenantHasFeatures(
            tenantId, lockedRequiredFeatures, client, true
        ))) {
            await client.query('ROLLBACK');
            return {
                ok: false,
                claimed: [],
                reason: 'tenant_feature_disabled',
                features: lockedRequiredFeatures
            };
        }

        if (campaign.dialing_mode === 'preview' || !withinCallingHours(campaign)) {
            await client.query('ROLLBACK');
            return { ok: false, claimed: [], reason: 'campaign_not_dialable_now' };
        }

        const recovery = await recoverExpiredClaims(client, tenantId, campaignId);

        const capacity = computeCapacity(campaign);
        const inFlight = await client.query(
            `SELECT COUNT(*)::int AS n
               FROM (
                   SELECT dc.id AS item_id
                     FROM campaign_dial_claims dc
                    WHERE dc.tenant_id = $1
                      AND dc.campaign_id = $2
                      AND dc.claim_status = ANY($3::varchar[])
                   UNION ALL
                   SELECT c.id AS item_id
                     FROM calls c
                    WHERE c.tenant_id = $1
                      AND c.campaign_id = $2
                      AND c.status IN ('ringing', 'answered')
                      AND c.end_time IS NULL
                      AND NOT EXISTS (
                          SELECT 1
                            FROM campaign_dial_claims dc
                           WHERE dc.tenant_id = c.tenant_id
                             AND dc.call_id = c.id
                             AND dc.claim_status = ANY($3::varchar[])
                      )
               ) occupied_slots`,
            [tenantId, campaignId, ACTIVE_CLAIM_STATUSES]
        );

        const slots = Math.max(0, capacity - Number(inFlight.rows[0].n || 0));
        const take = Math.min(
            limit,
            slots,
            campaign.is_robo_campaign ? limit : wazoAvailableAgents.length
        );
        if (!take) {
            await client.query('COMMIT');
            return { ok: true, claimed: [], reason: 'capacity_full', recovery };
        }

        const leads = await client.query(
            `SELECT
                 l.id AS lead_id,
                 l.phone_number,
                 (SELECT COALESCE(MAX(la.attempt_number), 0)::int + 1
                    FROM lead_attempts la
                   WHERE la.tenant_id = l.tenant_id
                     AND la.lead_id = l.id) AS next_attempt
             FROM leads l
             WHERE l.tenant_id = $1
               AND l.campaign_id = $2
               AND l.status IN ('new', 'in_progress')
               AND (
                   SELECT COALESCE(MAX(la.attempt_number), 0)::int
                     FROM lead_attempts la
                    WHERE la.tenant_id = l.tenant_id
                      AND la.lead_id = l.id
               ) < GREATEST(COALESCE($3::integer, 3), 0)
               AND NOT EXISTS (
                   SELECT 1
                     FROM lead_attempts latest
                    WHERE latest.tenant_id = l.tenant_id
                      AND latest.lead_id = l.id
                      AND latest.id = (
                          SELECT la.id
                            FROM lead_attempts la
                           WHERE la.tenant_id = l.tenant_id
                             AND la.lead_id = l.id
                           ORDER BY la.attempted_at DESC, la.id DESC
                           LIMIT 1
                      )
                      AND latest.next_retry_at IS NOT NULL
                      AND latest.next_retry_at > NOW()
               )
               AND NOT EXISTS (
                   SELECT 1
                     FROM do_not_call_entries d
                    WHERE d.tenant_id = l.tenant_id
                      AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                          regexp_replace(l.phone_number, '\\D', '', 'g')
                      AND (d.campaign_id IS NULL OR d.campaign_id = l.campaign_id)
               )
               AND NOT EXISTS (
                   SELECT 1
                     FROM campaign_dial_claims dc
                    WHERE dc.tenant_id = l.tenant_id
                      AND dc.lead_id = l.id
                      AND dc.claim_status = ANY($4::varchar[])
               )
             ORDER BY l.priority DESC NULLS LAST, l.created_at, l.id
             LIMIT $5
             FOR UPDATE OF l SKIP LOCKED`,
            [
                tenantId,
                campaignId,
                campaign.max_retry_attempts,
                ACTIVE_CLAIM_STATUSES,
                take
            ]
        );

        if (!leads.rowCount) {
            await client.query('COMMIT');
            return { ok: true, claimed: [], reason: 'no_eligible_leads', recovery };
        }

        let reservedAgents = [];
        if (!campaign.is_robo_campaign) {
            const preflightIds = wazoAvailableAgents.map(agent => agent.agent_id);
            const lockedAgents = await client.query(
                `SELECT a.id
                   FROM agents a
                   JOIN campaign_agents ca
                     ON ca.tenant_id = a.tenant_id
                    AND ca.campaign_id = $2
                    AND ca.agent_id = a.id
                   JOIN LATERAL (
                       SELECT ase.status::text AS status
                         FROM agent_status_events ase
                        WHERE ase.tenant_id = a.tenant_id
                          AND ase.agent_id = a.id
                          AND ase.ended_at IS NULL
                        ORDER BY ase.started_at DESC
                        LIMIT 1
                   ) current_status ON current_status.status = 'available'
                  WHERE a.tenant_id = $1
                    AND a.id = ANY($3::uuid[])
                    AND a.is_active = TRUE
                    AND a.provisioning_status = 'provisioned'
                    AND NOT EXISTS (
                        SELECT 1 FROM calls c
                         WHERE c.tenant_id = a.tenant_id
                           AND c.agent_id = a.id
                           AND c.status IN ('ringing', 'answered')
                           AND c.end_time IS NULL
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM campaign_agent_reservations r
                         WHERE r.tenant_id = a.tenant_id
                           AND r.agent_id = a.id
                           AND r.reservation_status IN ('reserved','dialing','connected')
                           AND (
                               r.reservation_status = 'connected'
                               OR r.expires_at > NOW()
                           )
                    )
                  ORDER BY a.id
                  FOR UPDATE OF a SKIP LOCKED`,
                [tenantId, campaignId, preflightIds]
            );
            reservedAgents = lockedAgents.rows.map(row => row.id);
        }

        if (!campaign.is_robo_campaign && !reservedAgents.length) {
            await client.query('COMMIT');
            return { ok: true, claimed: [], reason: 'agent_reservation_unavailable', recovery };
        }

        const claimed = [];

        // One progressive agent can own at most one lead per tick.
        const claimableLeads = campaign.is_robo_campaign
            ? leads.rows
            : leads.rows.slice(0, reservedAgents.length);

        for (let i = 0; i < claimableLeads.length; i++) {
            const lead = claimableLeads[i];
            const agentId = campaign.is_robo_campaign
                ? null
                : reservedAgents[i];

            const inserted = await client.query(
                `INSERT INTO campaign_dial_claims
                    (tenant_id, campaign_id, lead_id, agent_id,
                     dialing_mode, claim_status, attempt_number,
                     lease_until)
                 VALUES ($1,$2,$3,$4,$5,'claimed',$6,NOW() + INTERVAL '2 minutes')
                 ON CONFLICT DO NOTHING
                 RETURNING id, claim_token, lead_id, agent_id, attempt_number`,
                [
                    tenantId,
                    campaignId,
                    lead.lead_id,
                    agentId,
                    campaign.dialing_mode,
                    lead.next_attempt
                ]
            );

            if (!inserted.rowCount) continue;

            const claim = inserted.rows[0];

            if (agentId) {
                const reservation = await client.query(
                    `INSERT INTO campaign_agent_reservations
                        (tenant_id, campaign_id, agent_id, claim_id, expires_at)
                     VALUES ($1,$2,$3,$4,NOW() + INTERVAL '2 minutes')
                     ON CONFLICT DO NOTHING
                     RETURNING id`,
                    [tenantId, campaignId, agentId, claim.id]
                );

                if (!reservation.rowCount) {
                    await client.query(
                        `UPDATE campaign_dial_claims
                            SET claim_status = 'retry',
                                updated_at = NOW(),
                                last_error = 'Agent reservation conflict'
                          WHERE id = $1 AND tenant_id = $2`,
                        [claim.id, tenantId]
                    );
                    continue;
                }
            }

            claimed.push({
                claimId: claim.id,
                claimToken: claim.claim_token,
                leadId: claim.lead_id,
                agentId: claim.agent_id,
                attemptNumber: claim.attempt_number
            });
        }

        await client.query('COMMIT');

        return {
            ok: true,
            claimed,
            recovery,
            callsOriginated: 0,
            note: 'Claims only; no Wazo calls were originated.'
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    dryRunCampaign,
    claimCampaignLeads,
    recoverExpiredClaims,
    getAvailableAgentCandidates,
    checkWazoAgentAvailability
};
