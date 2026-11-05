/**
 * TECH-Life Robo Agent Runtime -- Node port. Places outbound calls for
 * voice-blast / IVR-survey campaigns through Wazo calld, at the
 * campaign's configured dial_level, and drives each answered call
 * through its campaign_voice_content script.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../src/db');
const config = require('../config/config');
const { wazoFetch } = require('../src/wazoFetch');
const { tenantHasFeatures } = require('../src/tenantFeatures');

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
    return data?.data?.token || '';
}

async function getCampaign(tenantId, campaignId) {
    const res = await pool.query('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2', [tenantId, campaignId]);
    return res.rows[0] || null;
}

function withinCallingHours(campaign) {
    const hours = campaign.calling_hours_json || {};
    if (!hours || Object.keys(hours).length === 0) return true;
    const day = new Date().toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    if (!hours[day]) return false;
    const now = new Date().toTimeString().slice(0, 5);
    return now >= (hours[day].from || '00:00') && now <= (hours[day].to || '23:59');
}

function computeConcurrentCapacity(campaign) {
    if (campaign.max_concurrent_robo_calls) return parseInt(campaign.max_concurrent_robo_calls, 10);
    const dialLevel = parseFloat(campaign.dial_level || 1.0);
    return Math.min(20, Math.max(1, Math.round(dialLevel)));
}

async function countInFlightRoboCalls(tenantId, campaignId) {
    const res = await pool.query(
        `SELECT COUNT(*) AS n FROM calls WHERE tenant_id = $1 AND campaign_id = $2
         AND status IN ('ringing','answered') AND end_time IS NULL`,
        [tenantId, campaignId]
    );
    return parseInt(res.rows[0].n, 10);
}

async function nextLeadsToDial(tenantId, campaignId, limit) {
    const res = await pool.query(
        `SELECT l.*
           FROM leads l
          WHERE l.tenant_id = $1
            AND l.campaign_id = $2
            AND l.status IN ('new','in_progress')
            AND (
              SELECT COUNT(*)
                FROM lead_attempts la
               WHERE la.tenant_id = l.tenant_id
                 AND la.lead_id = l.id
            ) < COALESCE(
              (SELECT c.max_retry_attempts
                 FROM campaigns c
                WHERE c.tenant_id = l.tenant_id
                  AND c.id = l.campaign_id),
              3
            )
            AND NOT EXISTS (
              SELECT 1
                FROM do_not_call_entries d
               WHERE d.tenant_id = l.tenant_id
                 AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                     regexp_replace(l.phone_number, '\\D', '', 'g')
                 AND (d.campaign_id IS NULL OR d.campaign_id = l.campaign_id)
            )
          ORDER BY l.priority DESC NULLS LAST, l.created_at
          LIMIT $3`,
        [tenantId, campaignId, limit]
    );
    return res.rows;
}


// Atomically claim eligible leads across concurrent scheduler processes.
// A live call must renew its lease; expired claims can be recovered.
async function claimNextRoboLeads(tenantId, campaignId, limit) {
    const safeLimit = Math.max(0, Math.min(100, Number.parseInt(limit, 10) || 0));
    if (!safeLimit) return [];

    // Missing or disabled flags must never result in Robo lead claims.
    if (!(await tenantHasFeatures(tenantId, ['campaigns', 'robo_agents']))) {
        return [];
    }

    const result = await pool.query(
        `WITH claim_owner AS (SELECT gen_random_uuid() AS token),
        eligible AS (
            SELECT l.tenant_id, l.id AS lead_id, l.campaign_id,
                   (
                     SELECT COUNT(*)::int
                       FROM lead_attempts la
                      WHERE la.tenant_id = l.tenant_id
                        AND la.lead_id = l.id
                   ) + 1 AS next_attempt
              FROM leads l
              JOIN campaigns c
                ON c.id = l.campaign_id
               AND c.tenant_id = l.tenant_id
             WHERE l.tenant_id = $1
               AND l.campaign_id = $2
               AND c.is_active = TRUE
               AND c.is_robo_campaign = TRUE
               AND l.status IN ('new', 'in_progress')
               AND (
                   SELECT COUNT(*)::int
                     FROM lead_attempts la
                    WHERE la.tenant_id = l.tenant_id
                      AND la.lead_id = l.id
               ) < GREATEST(COALESCE(c.max_retry_attempts, 3), 0)
               AND NOT EXISTS (
                   SELECT 1
                     FROM do_not_call_entries d
                    WHERE d.tenant_id = l.tenant_id
                      AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                          regexp_replace(l.phone_number, '\\D', '', 'g')
                      AND (d.campaign_id IS NULL OR d.campaign_id = l.campaign_id)
               )
               AND (
                   NOT EXISTS (
                       SELECT 1
                         FROM robo_lead_claims rc
                        WHERE rc.tenant_id = l.tenant_id
                          AND rc.lead_id = l.id
                   )
                   OR EXISTS (
                       SELECT 1
                         FROM robo_lead_claims rc
                        WHERE rc.tenant_id = l.tenant_id
                          AND rc.lead_id = l.id
                          AND rc.lease_until < NOW()
                          AND rc.claim_status IN ('claimed', 'retry', 'failed')
                   )
               )
             ORDER BY l.priority DESC NULLS LAST, l.created_at, l.id
             LIMIT $3
             FOR UPDATE OF l SKIP LOCKED
        )
        INSERT INTO robo_lead_claims
            (tenant_id, lead_id, campaign_id, claim_status,
             attempt_number, claimed_at, lease_until, updated_at,
             last_error, call_id, claim_token)
        SELECT e.tenant_id, e.lead_id, e.campaign_id, 'claimed',
               e.next_attempt, NOW(), NOW() + INTERVAL '5 minutes',
               NOW(), NULL, NULL, owner.token
          FROM eligible e
          CROSS JOIN claim_owner owner
        ON CONFLICT (tenant_id, lead_id) DO UPDATE
            SET campaign_id = EXCLUDED.campaign_id,
                claim_status = 'claimed',
                attempt_number = EXCLUDED.attempt_number,
                claimed_at = NOW(),
                lease_until = NOW() + INTERVAL '5 minutes',
                updated_at = NOW(),
                last_error = NULL,
                call_id = NULL,
                claim_token = EXCLUDED.claim_token
            WHERE robo_lead_claims.lease_until < NOW()
              AND robo_lead_claims.claim_status IN
                  ('claimed', 'retry', 'failed')
        RETURNING tenant_id, lead_id, campaign_id, attempt_number, claim_token`,
        [tenantId, campaignId, safeLimit]
    );

    if (!result.rows.length) return [];

    const leadIds = result.rows.map(row => row.lead_id);
    const leads = await pool.query(
        `SELECT l.*
           FROM leads l
          WHERE l.tenant_id = $1
            AND l.campaign_id = $2
            AND l.id = ANY($3::uuid[])
            AND NOT EXISTS (
                SELECT 1
                  FROM do_not_call_entries d
                 WHERE d.tenant_id = l.tenant_id
                   AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                       regexp_replace(l.phone_number, '\\D', '', 'g')
                   AND (d.campaign_id IS NULL OR d.campaign_id = l.campaign_id)
            )`,
        [tenantId, campaignId, leadIds]
    );

    const returnedIds = new Set(leads.rows.map(lead => lead.id));
    const omittedIds = leadIds.filter(id => !returnedIds.has(id));

    // If a DNC entry appeared after claiming, release only claims
    // acquired by this call that failed the final eligibility check.
    if (omittedIds.length) {
        await pool.query(
            `UPDATE robo_lead_claims
                SET claim_status = 'retry',
                    lease_until = NOW(),
                    updated_at = NOW(),
                    last_error = 'Lead failed final DNC eligibility check'
              WHERE tenant_id = $1
                AND campaign_id = $2
                AND lead_id = ANY($3::uuid[])
                AND claim_status = 'claimed'
                AND claim_token = $4`,
            [tenantId, campaignId, omittedIds, result.rows[0].claim_token]
        );
    }

    return leads.rows;
}

async function originateRoboCall(campaign, lead) {
    if (!(await tenantHasFeatures(
        campaign.tenant_id, ['campaigns', 'robo_agents']
    ))) {
        return {
            ok: false,
            skipped: true,
            reason: 'tenant_feature_disabled'
        };
    }

    // Safe-by-default: the correct tenant outbound route and source user
    // must be configured and tested before this feature can place calls.
    if (process.env.ROBO_AGENT_LIVE_DIALING_ENABLED !== 'true') {
        return { ok: false, skipped: true, reason: 'live_dialing_disabled' };
    }

    if (!config.wazo.roboOriginateUserUuid) {
        throw new Error(
            'Missing WAZO_ROBO_ORIGINATE_UUID; refusing to originate a Robo call.'
        );
    }

    // Do not use a guessed or shared internal context. The campaign must
    // be routed through a validated tenant-specific outbound route.
    throw new Error(
        'Robo origination is blocked until tenant outbound-route resolution ' +
        'is wired into this runtime. No call was placed.'
    );
}

async function runTick(tenantId, campaignId) {
    const campaign = await getCampaign(tenantId, campaignId);
    if (!campaign || !campaign.is_robo_campaign || !campaign.is_active) {
        return { ok: true, skipped: true, reason: 'campaign_not_active' };
    }

    if (!(await tenantHasFeatures(tenantId, ['campaigns', 'robo_agents']))) {
        return {
            ok: true,
            skipped: true,
            reason: 'tenant_feature_disabled',
            features: ['campaigns', 'robo_agents']
        };
    }

    if (process.env.ROBO_AGENT_LIVE_DIALING_ENABLED !== 'true') {
        return { ok: true, skipped: true, reason: 'live_dialing_disabled' };
    }

    if (!withinCallingHours(campaign)) return {
        ok: true, skipped: true, reason: 'outside_calling_hours'
    };

    const capacity = computeConcurrentCapacity(campaign);
    const inFlight = await countInFlightRoboCalls(tenantId, campaignId);
    const slots = Math.max(0, capacity - inFlight);
    if (slots <= 0) return;

    const leads = await nextLeadsToDial(tenantId, campaignId, slots);
    for (const lead of leads) {
        await originateRoboCall(campaign, lead);
    }
}


// Read-only scheduler diagnostic. This function never claims leads,
// updates records, or originates calls.
async function dryRunTick(tenantId, campaignId, previewLimit = 10) {
    const limit = Math.max(0, Math.min(50, Number.parseInt(previewLimit, 10) || 0));
    const campaign = await getCampaign(tenantId, campaignId);

    if (!campaign) {
        return {
            ok: false,
            dryRun: true,
            eligible: false,
            reason: 'campaign_not_found_for_tenant'
        };
    }

    const capacity = computeConcurrentCapacity(campaign);
    const inFlight = await countInFlightRoboCalls(tenantId, campaignId);
    const slots = Math.max(0, capacity - inFlight);
    const callingHoursConfigured = Boolean(
        campaign.calling_hours_json &&
        Object.keys(campaign.calling_hours_json).length
    );
    const callingHoursAllowed = withinCallingHours(campaign);

    const stats = await pool.query(
        `WITH candidates AS (
            SELECT
                l.id,
                l.priority,
                l.created_at,
                l.phone_number,
                COALESCE(a.attempt_count, 0)::int AS attempt_count,
                a.next_retry_at
            FROM leads l
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*)::int AS attempt_count,
                    MAX(la.next_retry_at) FILTER (
                        WHERE la.next_retry_at IS NOT NULL
                    ) AS next_retry_at
                FROM lead_attempts la
                WHERE la.tenant_id = l.tenant_id
                  AND la.lead_id = l.id
            ) a ON TRUE
            WHERE l.tenant_id = $1
              AND l.campaign_id = $2
              AND l.status IN ('new', 'in_progress')
        ),
        classified AS (
            SELECT
                c.*,
                EXISTS (
                    SELECT 1
                    FROM do_not_call_entries d
                    WHERE d.tenant_id = $1
                      AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                          regexp_replace(c.phone_number, '\\D', '', 'g')
                      AND (d.campaign_id IS NULL OR d.campaign_id = $2)
                ) AS is_dnc,
                EXISTS (
                    SELECT 1
                    FROM robo_lead_claims rc
                    WHERE rc.tenant_id = $1
                      AND rc.lead_id = c.id
                      AND NOT (
                          rc.lease_until < NOW()
                          AND rc.claim_status IN ('claimed', 'retry', 'failed')
                      )
                ) AS is_claim_blocked,
                EXISTS (
                    SELECT 1
                    FROM robo_lead_claims rc
                    WHERE rc.tenant_id = $1
                      AND rc.lead_id = c.id
                ) AS has_claim
            FROM candidates c
            WHERE c.attempt_count < GREATEST(
                COALESCE(
                    (SELECT max_retry_attempts
                       FROM campaigns
                      WHERE tenant_id = $1 AND id = $2),
                    3
                ),
                0
            )
              AND (c.next_retry_at IS NULL OR c.next_retry_at <= NOW())
        ),
        eligible AS (
            SELECT *
            FROM classified
            WHERE NOT is_dnc
              AND NOT is_claim_blocked
        )
        SELECT
            (SELECT COUNT(*) FROM candidates) AS pending_status_count,
            COUNT(*) FILTER (WHERE is_dnc) AS dnc_excluded_count,
            COUNT(*) FILTER (
                WHERE NOT is_dnc AND is_claim_blocked
            ) AS claim_blocked_count,
            (SELECT COUNT(*) FROM eligible) AS eligible_count,
            COALESCE(
                (SELECT jsonb_agg(x.id ORDER BY x.priority DESC NULLS LAST,
                                               x.created_at, x.id)
                   FROM (
                       SELECT id, priority, created_at
                       FROM eligible
                       ORDER BY priority DESC NULLS LAST, created_at, id
                       LIMIT $3
                   ) x),
                '[]'::jsonb
            ) AS preview_lead_ids
        FROM classified`,
        [tenantId, campaignId, limit]
    );

    const row = stats.rows[0];
    const eligibleCount = Number(row.eligible_count || 0);

    let reason = 'ready_for_dry_run_review';
    if (!campaign.is_active) reason = 'campaign_inactive';
    else if (!campaign.is_robo_campaign) reason = 'not_a_robo_campaign';
    else if (!callingHoursAllowed) reason = 'outside_calling_hours';
    else if (slots <= 0) reason = 'capacity_full';
    else if (eligibleCount === 0) reason = 'no_eligible_leads';

    return {
        ok: true,
        dryRun: true,
        eligible: Boolean(
            campaign.is_active &&
            campaign.is_robo_campaign &&
            callingHoursAllowed &&
            slots > 0 &&
            eligibleCount > 0
        ),
        reason,
        campaign: {
            id: campaign.id,
            name: campaign.name,
            isActive: campaign.is_active,
            isRoboCampaign: campaign.is_robo_campaign,
            dialingMode: campaign.dialing_mode,
            callingHoursConfigured,
            callingHoursAllowed,
            maxRetryAttempts: campaign.max_retry_attempts
        },
        capacity: {
            maximum: capacity,
            inFlight,
            availableSlots: slots
        },
        leads: {
            pendingStatusCount: Number(row.pending_status_count || 0),
            eligibleCount,
            dncExcludedCount: Number(row.dnc_excluded_count || 0),
            claimBlockedCount: Number(row.claim_blocked_count || 0),
            previewIds: row.preview_lead_ids || []
        },
        liveDialingEnabled:
            process.env.ROBO_AGENT_LIVE_DIALING_ENABLED === 'true',
        actionsTaken: {
            leadsClaimed: 0,
            recordsModified: 0,
            callsOriginated: 0
        }
    };
}

async function getNode(tenantId, campaignId, stepNumber) {
    const res = await pool.query(
        `SELECT * FROM campaign_voice_content WHERE tenant_id = $1 AND campaign_id = $2 AND step_number = $3 AND is_active = TRUE`,
        [tenantId, campaignId, stepNumber]
    );
    return res.rows[0] || null;
}

function resolvePlaybackFile(node) {
    if (node.content_type === 'audio_file') return node.audio_file_path;
    return synthesizeTts(node);
}

function synthesizeTts(node) {
    const cacheKey = crypto.createHash('md5').update(`${node.tts_text}|${node.tts_voice}|${node.tts_language}|${node.tts_speed}`).digest('hex');
    const cacheDir = process.env.TTS_CACHE_DIR || '/var/lib/techlife/tts-cache';
    const cachePath = path.join(cacheDir, `${cacheKey}.wav`);
    if (fs.existsSync(cachePath)) return cachePath;
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Pluggable TTS provider call -- swap for Google Cloud TTS, Amazon
    // Polly, Azure Neural TTS, or a self-hosted engine. Contract: write
    // a WAV/PCM file to cachePath and return its path.
    throw new Error(
        `TTS audio is not cached and no synthesis provider is implemented ` +
        `(provider='${node.tts_provider || 'default'}').`
    );
}

async function recordResponse(tenantId, campaignId, callId, voiceContentId, nodeName, responseType, dtmf = null, recordingPath = null) {
    // Validate ownership before recording a response.
    const nodeRes = await pool.query(
        `SELECT next_step_map_json, step_number
           FROM campaign_voice_content
          WHERE id = $1 AND tenant_id = $2 AND campaign_id = $3`,
        [voiceContentId, tenantId, campaignId]
    );
    const node = nodeRes.rows[0];
    if (!node) return null;

    await pool.query(
        `INSERT INTO survey_responses
            (tenant_id, campaign_id, call_id, voice_content_id, node_name,
             response_type, response_dtmf, response_recording_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, campaignId, callId, voiceContentId, nodeName,
         responseType, dtmf, recordingPath]
    );

    if (dtmf === null) return null;

    const map = node.next_step_map_json || {};
    if (map[dtmf]) {
        return parseInt(String(map[dtmf]).replace('step_', ''), 10);
    }
    return parseInt(node.step_number, 10) + 1;
}

module.exports = { runTick, dryRunTick, getNode, resolvePlaybackFile, recordResponse };
