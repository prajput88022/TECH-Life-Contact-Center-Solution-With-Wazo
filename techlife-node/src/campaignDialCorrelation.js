'use strict';

const { pool } = require('./db');

async function inTransaction(db, callback) {
    if (db && db !== pool) return callback(db);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

function normalizeWazoCallId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 150) {
        throw new Error('A valid Wazo call ID is required.');
    }
    return id;
}

/**
 * Persist the pre-origination state before any external Wazo request.
 * This module never sends that request itself.
 */
async function beginOrigination(tenantId, claimId, claimToken, db = pool) {
    return inTransaction(db, async client => {
        const result = await client.query(
            `SELECT
                 dc.*,
                 c.name AS campaign_name,
                 c.is_active AS campaign_active,
                 c.is_robo_campaign,
                 c.caller_id,
                 l.phone_number,
                 l.contact_id,
                 a.agent_number,
                 a.wazo_agent_id,
                 a.wazo_line_id,
                 a.wazo_extension_id,
                 a.provisioning_status,
                 a.is_active AS agent_is_active,
                 u.is_active AS user_is_active,
                 u.wazo_user_uuid,
                 t.wazo_tenant_uuid,
                 current_status.status AS current_agent_status
             FROM campaign_dial_claims dc
             JOIN campaigns c
               ON c.id = dc.campaign_id
              AND c.tenant_id = dc.tenant_id
             JOIN leads l
               ON l.id = dc.lead_id
              AND l.tenant_id = dc.tenant_id
              AND l.campaign_id = dc.campaign_id
             LEFT JOIN agents a
               ON a.id = dc.agent_id
              AND a.tenant_id = dc.tenant_id
             LEFT JOIN users u
               ON u.id = a.user_id
              AND u.tenant_id = a.tenant_id
             LEFT JOIN LATERAL (
                 SELECT ase.status::text AS status
                   FROM agent_status_events ase
                  WHERE ase.tenant_id = dc.tenant_id
                    AND ase.agent_id = dc.agent_id
                    AND ase.ended_at IS NULL
                  ORDER BY ase.started_at DESC
                  LIMIT 1
             ) current_status ON TRUE
             JOIN tenants t ON t.id = dc.tenant_id
             WHERE dc.tenant_id = $1
               AND dc.id = $2
               AND dc.claim_token = $3
             FOR UPDATE OF dc`,
            [tenantId, claimId, claimToken]
        );

        const claim = result.rows[0];
        if (!claim) {
            return { ok: false, reason: 'claim_not_found_or_token_mismatch' };
        }

        if (claim.claim_status !== 'claimed') {
            return {
                ok: false,
                reason: 'claim_not_in_claimed_state',
                claimStatus: claim.claim_status
            };
        }

        if (!claim.campaign_active) {
            await client.query(
                `UPDATE campaign_dial_claims
                    SET claim_status = 'cancelled',
                        updated_at = NOW(),
                        last_error = 'Campaign was disabled before origination'
                  WHERE id = $1 AND tenant_id = $2`,
                [claim.id, tenantId]
            );
            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'released',
                        released_at = NOW(),
                        release_reason = 'campaign_disabled',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status IN ('reserved', 'dialing')`,
                [claim.id]
            );
            return { ok: false, reason: 'campaign_inactive' };
        }

        if (new Date(claim.lease_until).getTime() <= Date.now()) {
            await client.query(
                `UPDATE campaign_dial_claims
                    SET claim_status = 'retry',
                        updated_at = NOW(),
                        last_error = 'Claim expired before origination'
                  WHERE id = $1 AND tenant_id = $2`,
                [claim.id, tenantId]
            );
            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'expired',
                        released_at = NOW(),
                        release_reason = 'claim_expired',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status IN ('reserved', 'dialing')`,
                [claim.id]
            );
            return { ok: false, reason: 'claim_lease_expired' };
        }

        if (claim.dialing_mode === 'preview') {
            return { ok: false, reason: 'preview_mode_never_auto_dials' };
        }

        const rejectBeforeRequest = async reason => {
            await client.query(
                `UPDATE campaign_dial_claims
                    SET claim_status = 'retry',
                        lease_until = NOW(),
                        last_error = $3,
                        updated_at = NOW()
                  WHERE tenant_id = $1 AND id = $2
                    AND claim_status = 'claimed'
                    AND wazo_call_id IS NULL`,
                [tenantId, claim.id, `NOT_SENT: ${reason}`]
            );

            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'failed',
                        released_at = NOW(),
                        release_reason = 'origination_preflight_rejected',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status IN ('reserved', 'dialing')`,
                [claim.id]
            );

            return { ok: false, reason };
        };

        if (
            !claim.agent_id ||
            claim.agent_is_active !== true ||
            claim.user_is_active !== true ||
            claim.provisioning_status !== 'provisioned' ||
            claim.current_agent_status !== 'available' ||
            !claim.wazo_agent_id ||
            !claim.wazo_user_uuid ||
            !claim.wazo_tenant_uuid ||
            !claim.wazo_line_id
        ) {
            return rejectBeforeRequest('agent_not_currently_eligible');
        }

        const activeAgentCall = await client.query(
            `SELECT 1
               FROM calls
              WHERE tenant_id = $1
                AND agent_id = $2
                AND status IN ('ringing', 'answered')
                AND end_time IS NULL
              LIMIT 1`,
            [tenantId, claim.agent_id]
        );

        if (activeAgentCall.rowCount) {
            return rejectBeforeRequest('agent_has_active_call');
        }

        if (claim.is_robo_campaign ||
            ['voice_blast', 'robo_survey'].includes(claim.dialing_mode)) {
            return {
                ok: false,
                reason: 'robo_media_executor_not_implemented'
            };
        }

        if (claim.dialing_mode !== 'progressive') {
            return {
                ok: false,
                reason: 'customer_first_strategy_not_implemented'
            };
        }

        if (
            !claim.agent_id ||
            !claim.wazo_user_uuid ||
            !claim.wazo_tenant_uuid ||
            !claim.wazo_line_id
        ) {
            return {
                ok: false,
                reason: 'assigned_agent_wazo_identity_incomplete'
            };
        }

        const dnc = await client.query(
            `SELECT 1
               FROM do_not_call_entries d
              WHERE d.tenant_id = $1
                AND regexp_replace(d.phone_number, '\\D', '', 'g') =
                    regexp_replace($2, '\\D', '', 'g')
                AND (d.campaign_id IS NULL OR d.campaign_id = $3)
              LIMIT 1`,
            [tenantId, claim.phone_number, claim.campaign_id]
        );

        if (dnc.rowCount) {
            await client.query(
                `UPDATE campaign_dial_claims
                    SET claim_status = 'cancelled',
                        updated_at = NOW(),
                        last_error = 'Lead entered DNC before origination'
                  WHERE id = $1 AND tenant_id = $2`,
                [claim.id, tenantId]
            );
            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'released',
                        released_at = NOW(),
                        release_reason = 'lead_dnc',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status IN ('reserved', 'dialing')`,
                [claim.id]
            );
            return { ok: false, reason: 'lead_is_dnc' };
        }

        const reservation = await client.query(
            `UPDATE campaign_agent_reservations
                SET reservation_status = 'dialing',
                    expires_at = NOW() + INTERVAL '3 minutes',
                    updated_at = NOW()
              WHERE tenant_id = $1
                AND campaign_id = $2
                AND agent_id = $3
                AND claim_id = $4
                AND reservation_status = 'reserved'
              RETURNING id`,
            [tenantId, claim.campaign_id, claim.agent_id, claim.id]
        );

        if (!reservation.rowCount) {
            return { ok: false, reason: 'agent_reservation_missing' };
        }

        const changed = await client.query(
            `UPDATE campaign_dial_claims
                SET claim_status = 'originating',
                    originating_at = COALESCE(originating_at, NOW()),
                    lease_until = NOW() + INTERVAL '3 minutes',
                    updated_at = NOW(),
                    last_error = NULL
              WHERE tenant_id = $1
                AND id = $2
                AND claim_token = $3
                AND claim_status = 'claimed'
              RETURNING id`,
            [tenantId, claim.id, claimToken]
        );

        if (!changed.rowCount) {
            throw new Error('Claim state changed during origination preparation.');
        }

        return {
            ok: true,
            claimId: claim.id,
            claimToken: claim.claim_token,
            tenantId,
            campaignId: claim.campaign_id,
            leadId: claim.lead_id,
            phoneNumber: claim.phone_number,
            callerId: claim.caller_id,
            contactId: claim.contact_id,
            attemptNumber: claim.attempt_number,
            agentId: claim.agent_id,
            agentNumber: claim.agent_number,
            wazoAgentId: claim.wazo_agent_id,
            wazoUserUuid: claim.wazo_user_uuid,
            wazoLineId: claim.wazo_line_id,
            wazoTenantUuid: claim.wazo_tenant_uuid
        };
    });
}

/**
 * Release a claim only when we know no Wazo originate request was sent.
 * This does not create a lead_attempt and therefore does not consume a retry.
 */
async function releaseBeforeOrigination(
    tenantId, claimId, claimToken, reason, db = pool
) {
    const message = String(reason || 'Origination preflight rejected').slice(0, 450);

    return inTransaction(db, async client => {
        const result = await client.query(
            `UPDATE campaign_dial_claims
                SET claim_status = 'retry',
                    lease_until = NOW(),
                    last_error = $4,
                    updated_at = NOW()
              WHERE tenant_id = $1
                AND id = $2
                AND claim_token = $3
                AND claim_status IN ('claimed', 'originating')
                AND wazo_call_id IS NULL
              RETURNING id`,
            [tenantId, claimId, claimToken, `NOT_SENT: ${message}`]
        );

        if (result.rowCount) {
            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'failed',
                        released_at = NOW(),
                        release_reason = 'origination_preflight_rejected',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status IN ('reserved', 'dialing')`,
                [claimId]
            );
        }

        return { ok: result.rowCount === 1, released: result.rowCount === 1 };
    });
}

/**
 * Mark an uncertain HTTP result. Never turn it into a retry automatically:
 * Wazo may have accepted the call before the connection timed out.
 */
async function markOriginationUncertain(
    tenantId, claimId, claimToken, errorMessage, db = pool, wazoCallId = null
) {
    const message = String(errorMessage || 'Unknown origination outcome').slice(0, 500);

    return inTransaction(db, async client => {
        const updated = await client.query(
            `UPDATE campaign_dial_claims
                SET wazo_call_id = COALESCE(wazo_call_id, $5),
                    lease_until = NOW() + INTERVAL '1 day',
                    last_error = $4,
                    updated_at = NOW()
              WHERE tenant_id = $1
                AND id = $2
                AND claim_token = $3
                AND claim_status = 'originating'
                AND (wazo_call_id IS NULL OR $5 IS NULL OR wazo_call_id = $5)
              RETURNING id`,
            [
                tenantId,
                claimId,
                claimToken,
                `ORIGINATION_UNCERTAIN: ${message}`,
                wazoCallId
            ]
        );

        if (updated.rowCount) {
            await client.query(
                `UPDATE campaign_agent_reservations
                    SET reservation_status = 'dialing',
                        expires_at = NOW() + INTERVAL '1 day',
                        updated_at = NOW()
                  WHERE claim_id = $1
                    AND reservation_status = 'dialing'`,
                [claimId]
            );
        }

        return {
            ok: updated.rowCount === 1,
            uncertain: updated.rowCount === 1,
            reason: updated.rowCount ? 'manual_reconciliation_required' : 'claim_not_originating'
        };
    });
}

/**
 * Synchronize a correlated claim from the canonical calls row.
 * Safe to call repeatedly from event handling and the origination response.
 */
async function syncClaimForWazoCall(client, tenantId, wazoCallId) {
    if (!tenantId || !wazoCallId) return { matched: false };

    const result = await client.query(
        `SELECT
             dc.id AS claim_id,
             dc.lead_id,
             dc.campaign_id,
             dc.agent_id,
             dc.attempt_number,
             dc.claim_status,
             c.id AS call_id,
             c.start_time AS call_start_time,
             c.status::text AS call_status,
             c.answer_time,
             c.end_time,
             cp.retry_on_no_answer,
             cp.retry_on_busy,
             cp.max_retry_attempts
         FROM campaign_dial_claims dc
         JOIN calls c
           ON c.tenant_id = dc.tenant_id
          AND c.wazo_call_id = dc.wazo_call_id
         JOIN campaigns cp
           ON cp.tenant_id = dc.tenant_id
          AND cp.id = dc.campaign_id
         WHERE dc.tenant_id = $1
           AND dc.wazo_call_id = $2
         FOR UPDATE OF dc`,
        [tenantId, wazoCallId]
    );

    const row = result.rows[0];
    if (!row) return { matched: false };

    // A call event may arrive before the HTTP response is committed.
    // Once the claim has its Wazo ID, this safely links the local call
    // and creates the one actual lead attempt. The unique claim index
    // makes repeated event/response reconciliation idempotent.
    await client.query(
        `UPDATE campaign_dial_claims
            SET call_id = COALESCE(call_id, $1),
                originated_at = COALESCE(originated_at, $2),
                updated_at = NOW()
          WHERE tenant_id = $3 AND id = $4`,
        [row.call_id, row.call_start_time, tenantId, row.claim_id]
    );

    await client.query(
        `INSERT INTO lead_attempts
            (tenant_id, lead_id, call_id, attempt_number,
             attempted_at, outcome, claim_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (claim_id)
             WHERE claim_id IS NOT NULL
         DO NOTHING`,
        [
            tenantId,
            row.lead_id,
            row.call_id,
            row.attempt_number,
            row.call_start_time,
            row.end_time ? row.call_status : null,
            row.claim_id
        ]
    );

    if (row.end_time) {
        const status = String(row.call_status || '').toLowerCase();
        const maxAttempts = Number(row.max_retry_attempts ?? 3);

        const retryAllowed =
            row.attempt_number < maxAttempts &&
            (
                (status === 'busy' && row.retry_on_busy === true) ||
                (['missed', 'abandoned'].includes(status) &&
                    row.retry_on_no_answer === true)
            );

        const claimStatus = retryAllowed
            ? 'retry'
            : status === 'completed' ? 'completed' : 'failed';

        await client.query(
            `UPDATE lead_attempts
                SET outcome = $2,
                    next_retry_at = CASE
                        WHEN $3 THEN NOW() + INTERVAL '5 minutes'
                        ELSE NULL
                    END
              WHERE tenant_id = $1
                AND claim_id = $4`,
            [tenantId, status, retryAllowed, row.claim_id]
        );

        await client.query(
            `UPDATE campaign_dial_claims
                SET claim_status = $2,
                    ended_at = COALESCE(ended_at, $3),
                    updated_at = NOW()
              WHERE tenant_id = $1 AND id = $4`,
            [tenantId, claimStatus, row.end_time, row.claim_id]
        );

        await client.query(
            `UPDATE campaign_agent_reservations
                SET reservation_status = $2,
                    released_at = COALESCE(released_at, $3),
                    release_reason = 'call_ended',
                    updated_at = NOW()
              WHERE claim_id = $1
                AND reservation_status IN ('reserved', 'dialing', 'connected')`,
            [
                row.claim_id,
                status === 'completed' ? 'completed' : 'failed',
                row.end_time
            ]
        );

        return {
            matched: true,
            claimId: row.claim_id,
            claimStatus,
            retryAllowed
        };
    }

    if (row.answer_time || row.call_status === 'answered') {
        await client.query(
            `UPDATE campaign_dial_claims
                SET claim_status = 'in_flight',
                    answered_at = COALESCE(answered_at, $3, NOW()),
                    updated_at = NOW()
              WHERE tenant_id = $1 AND id = $2
                AND claim_status IN ('originating', 'ringing', 'in_flight')`,
            [tenantId, row.claim_id, row.answer_time]
        );

        await client.query(
            `UPDATE campaign_agent_reservations
                SET reservation_status = 'connected',
                    expires_at = NOW() + INTERVAL '2 hours',
                    updated_at = NOW()
              WHERE claim_id = $1
                AND reservation_status IN ('reserved', 'dialing', 'connected')`,
            [row.claim_id]
        );

        return { matched: true, claimId: row.claim_id, claimStatus: 'in_flight' };
    }

    await client.query(
        `UPDATE campaign_dial_claims
            SET claim_status = 'ringing',
                updated_at = NOW()
          WHERE tenant_id = $1 AND id = $2
            AND claim_status IN ('originating', 'ringing')`,
        [tenantId, row.claim_id]
    );

    await client.query(
        `UPDATE campaign_agent_reservations
            SET reservation_status = 'dialing',
                expires_at = NOW() + INTERVAL '3 minutes',
                updated_at = NOW()
          WHERE claim_id = $1
            AND reservation_status IN ('reserved', 'dialing')`,
        [row.claim_id]
    );

    return { matched: true, claimId: row.claim_id, claimStatus: 'ringing' };
}

/**
 * Persist a successful Wazo response and reconcile any earlier bus events.
 * Repeated calls with the same claim token and Wazo call ID are idempotent.
 */
async function recordAcceptedOrigination(
    tenantId, claimId, claimToken, rawWazoCallId, db = pool
) {
    const wazoCallId = normalizeWazoCallId(rawWazoCallId);

    return inTransaction(db, async client => {
        const result = await client.query(
            `SELECT dc.*, l.phone_number, l.contact_id, cp.caller_id
               FROM campaign_dial_claims dc
               JOIN leads l
                 ON l.id = dc.lead_id
                AND l.tenant_id = dc.tenant_id
                AND l.campaign_id = dc.campaign_id
               JOIN campaigns cp
                 ON cp.id = dc.campaign_id
                AND cp.tenant_id = dc.tenant_id
              WHERE dc.tenant_id = $1
                AND dc.id = $2
                AND dc.claim_token = $3
              FOR UPDATE OF dc`,
            [tenantId, claimId, claimToken]
        );

        const claim = result.rows[0];
        if (!claim) {
            return { ok: false, reason: 'claim_not_found_or_token_mismatch' };
        }

        if (claim.wazo_call_id && claim.wazo_call_id !== wazoCallId) {
            throw new Error('Claim is already linked to a different Wazo call ID.');
        }

        if (
            !claim.wazo_call_id &&
            !['originating'].includes(claim.claim_status)
        ) {
            return {
                ok: false,
                reason: 'claim_not_in_originating_state',
                claimStatus: claim.claim_status
            };
        }

        const existing = await client.query(
            `SELECT id, campaign_id, agent_id
               FROM calls
              WHERE tenant_id = $1
                AND wazo_call_id = $2
              FOR UPDATE`,
            [tenantId, wazoCallId]
        );

        if (existing.rowCount) {
            const call = existing.rows[0];
            if (call.campaign_id && call.campaign_id !== claim.campaign_id) {
                throw new Error('Wazo call ID is already attached to another campaign.');
            }
            if (call.agent_id && claim.agent_id && call.agent_id !== claim.agent_id) {
                throw new Error('Wazo call ID is already attached to another agent.');
            }
        }

        const callResult = await client.query(
            `INSERT INTO calls
                (tenant_id, wazo_call_id, agent_id, campaign_id, contact_id,
                 direction, from_number, to_number, status, start_time)
             VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,'ringing',NOW())
             ON CONFLICT (tenant_id, wazo_call_id)
                 WHERE wazo_call_id IS NOT NULL
             DO UPDATE SET
                 campaign_id = EXCLUDED.campaign_id,
                 agent_id = COALESCE(EXCLUDED.agent_id, calls.agent_id),
                 contact_id = COALESCE(calls.contact_id, EXCLUDED.contact_id),
                 direction = 'outbound',
                 from_number = COALESCE(NULLIF(EXCLUDED.from_number, ''), calls.from_number),
                 to_number = EXCLUDED.to_number
             RETURNING id, status::text, start_time, answer_time, end_time`,
            [
                tenantId,
                wazoCallId,
                claim.agent_id,
                claim.campaign_id,
                claim.contact_id,
                claim.caller_id || null,
                claim.phone_number
            ]
        );

        const call = callResult.rows[0];

        await client.query(
            `UPDATE campaign_dial_claims
                SET call_id = $1,
                    wazo_call_id = $2,
                    originated_at = COALESCE(originated_at, NOW()),
                    updated_at = NOW(),
                    last_error = NULL
              WHERE tenant_id = $3 AND id = $4`,
            [call.id, wazoCallId, tenantId, claim.id]
        );

        await client.query(
            `INSERT INTO lead_attempts
                (tenant_id, lead_id, call_id, attempt_number,
                 attempted_at, outcome, claim_id)
             VALUES ($1,$2,$3,$4,$5,NULL,$6)
             ON CONFLICT (claim_id)
                 WHERE claim_id IS NOT NULL
             DO NOTHING`,
            [
                tenantId,
                claim.lead_id,
                call.id,
                claim.attempt_number,
                call.start_time || new Date(),
                claim.id
            ]
        );

        const lifecycle = await syncClaimForWazoCall(
            client, tenantId, wazoCallId
        );

        return {
            ok: true,
            claimId: claim.id,
            callId: call.id,
            wazoCallId,
            lifecycle
        };
    });
}

async function reconcileWazoCall(tenantId, wazoCallId) {
    return inTransaction(pool, async client =>
        syncClaimForWazoCall(client, tenantId, wazoCallId)
    );
}

module.exports = {
    beginOrigination,
    reconcileWazoCall,
    releaseBeforeOrigination,
    markOriginationUncertain,
    recordAcceptedOrigination,
    syncClaimForWazoCall
};
