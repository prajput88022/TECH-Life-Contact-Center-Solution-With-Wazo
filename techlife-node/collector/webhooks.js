/**
 * HTTP endpoints hit by Wazo/AGI: the AGI bridge (business fields not
 * native to Wazo) and the CDR webhook (authoritative call timing). Both
 * require the X-Ingest-Secret header to match config.wazo.ingestSecret.
 * Mounted at /webhooks in app.js.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../src/db');
const config = require('../config/config');

function checkSecret(req, res, next) {
    const provided = req.headers['x-ingest-secret'];
    if (provided !== config.wazo.ingestSecret) {
        return res.status(401).json({ error: 'invalid_ingest_secret' });
    }
    next();
}

router.post('/agi-events', checkSecret, async (req, res) => {
    const body = req.body || {};
    const tenantRes = await pool.query(
        'SELECT id FROM tenants WHERE wazo_tenant_uuid = $1',
        [body.tenant_wazo_uuid]
    );
    const tenantId = tenantRes.rows[0]?.id;

    if (!tenantId) {
        return res.status(422).json({ error: 'unknown_tenant' });
    }

    if (typeof body.wazo_call_id !== 'string' ||
        !body.wazo_call_id.trim() ||
        body.wazo_call_id.length > 150) {
        return res.status(422).json({ error: 'invalid_wazo_call_id' });
    }

    const hasCampaign = body.campaign_id !== undefined &&
        body.campaign_id !== null && String(body.campaign_id).trim() !== '';
    const hasLead = body.lead_id !== undefined &&
        body.lead_id !== null && String(body.lead_id).trim() !== '';

    if (hasLead && !hasCampaign) {
        return res.status(422).json({
            error: 'campaign_id_required_for_lead_attempt'
        });
    }

    const client = await pool.connect();
    let transactionOpen = false;

    const reject = async (status, payload) => {
        if (transactionOpen) {
            await client.query('ROLLBACK');
            transactionOpen = false;
        }
        return res.status(status).json(payload);
    };

    try {
        await client.query('BEGIN');
        transactionOpen = true;

        // Lock the call before validating or changing any business fields.
        const callRes = await client.query(
            `SELECT id, campaign_id
               FROM calls
              WHERE tenant_id = $1 AND wazo_call_id = $2
              FOR UPDATE`,
            [tenantId, body.wazo_call_id.trim()]
        );

        const call = callRes.rows[0];
        if (!call) {
            return await reject(404, {
                error: 'call_not_found_yet',
                hint: 'AGI fired before call correlation; retry'
            });
        }

        let correlatedClaimId = null;

        if (hasCampaign) {
            const campaignRes = await client.query(
                `SELECT id
                   FROM campaigns
                  WHERE tenant_id = $1 AND id = $2`,
                [tenantId, body.campaign_id]
            );

            if (!campaignRes.rowCount) {
                return await reject(422, {
                    error: 'campaign_not_found_for_tenant'
                });
            }

            if (hasLead) {
                // A lead attempt requires the call to already be linked
                // to the same campaign. Never assign it speculatively.
                if (String(call.campaign_id || '').toLowerCase() !==
                    String(body.campaign_id).toLowerCase()) {
                    return await reject(409, {
                        error: 'campaign_call_not_correlated',
                        retry: true
                    });
                }

                const ownership = await client.query(
                    `SELECT 1
                       FROM leads l
                       JOIN campaigns c
                         ON c.id = l.campaign_id
                        AND c.tenant_id = l.tenant_id
                      WHERE l.tenant_id = $1
                        AND l.campaign_id = $2
                        AND l.id = $3
                      LIMIT 1`,
                    [tenantId, body.campaign_id, body.lead_id]
                );

                if (!ownership.rowCount) {
                    return await reject(422, {
                        error: 'lead_campaign_not_found_for_tenant'
                    });
                }

                const claim = await client.query(
                    `SELECT dc.id
                       FROM campaign_dial_claims dc
                      WHERE dc.tenant_id = $1
                        AND dc.campaign_id = $2
                        AND dc.lead_id = $3
                        AND dc.call_id = $4
                        AND dc.wazo_call_id = $5
                      FOR UPDATE`,
                    [
                        tenantId,
                        body.campaign_id,
                        body.lead_id,
                        call.id,
                        body.wazo_call_id.trim()
                    ]
                );

                if (!claim.rowCount) {
                    return await reject(409, {
                        error: 'campaign_claim_not_correlated',
                        retry: true
                    });
                }

                correlatedClaimId = claim.rows[0].id;

                const attempt = await client.query(
                    `SELECT id
                       FROM lead_attempts
                      WHERE tenant_id = $1
                        AND lead_id = $2
                        AND call_id = $3
                        AND claim_id = $4
                      FOR UPDATE`,
                    [tenantId, body.lead_id, call.id, correlatedClaimId]
                );

                if (!attempt.rowCount) {
                    return await reject(409, {
                        error: 'claim_linked_attempt_not_ready',
                        retry: true
                    });
                }
            } else if (
                call.campaign_id &&
                String(call.campaign_id).toLowerCase() !==
                    String(body.campaign_id).toLowerCase()
            ) {
                return await reject(409, {
                    error: 'campaign_call_mismatch'
                });
            }
        }

        // All tenant, campaign, lead, claim and attempt checks have passed.
        // Only now construct and execute call updates.
        const fields = [];
        const params = [];
        let idx = 1;

        if (hasCampaign && !call.campaign_id) {
            fields.push(`campaign_id = $${idx++}`);
            params.push(body.campaign_id);
        }

        if (body.disposition_code) {
            const disposition = await client.query(
                `SELECT id
                   FROM dispositions
                  WHERE tenant_id = $1 AND code = $2`,
                [tenantId, body.disposition_code]
            );

            if (disposition.rows[0]) {
                fields.push(`disposition_id = $${idx++}`);
                params.push(disposition.rows[0].id);
            }
        }

        if (body.transfer_reason) {
            fields.push(`transfer_to_type = $${idx++}`);
            params.push(body.transfer_reason);
        }

        if (fields.length) {
            params.push(call.id);
            await client.query(
                `UPDATE calls SET ${fields.join(', ')}
                  WHERE tenant_id = $${idx + 1} AND id = $${idx}`,
                [...params, tenantId]
            );
        }

        if (correlatedClaimId) {
            await client.query(
                `UPDATE lead_attempts
                    SET outcome = COALESCE(NULLIF($1, ''), outcome)
                  WHERE tenant_id = $2
                    AND lead_id = $3
                    AND call_id = $4
                    AND claim_id = $5`,
                [
                    body.disposition_code || null,
                    tenantId,
                    body.lead_id,
                    call.id,
                    correlatedClaimId
                ]
            );
        }

        if (body.ivr_selection) {
            const sess = await client.query(
                `SELECT id
                   FROM ivr_sessions
                  WHERE tenant_id = $1
                    AND call_id = $2
                    AND exit_time IS NULL
                  ORDER BY entry_time DESC
                  LIMIT 1`,
                [tenantId, call.id]
            );

            if (sess.rows[0]) {
                const stepRes = await client.query(
                    `SELECT COALESCE(MAX(step_number), 0) + 1 AS n
                       FROM ivr_events
                      WHERE ivr_session_id = $1`,
                    [sess.rows[0].id]
                );

                await client.query(
                    `INSERT INTO ivr_events
                        (tenant_id, ivr_session_id, step_number, node_name,
                         event_type, dtmf_input, event_time, payload_json)
                     VALUES ($1,$2,$3,$4,'OPTION_SELECTED',$5,now(),$6)`,
                    [
                        tenantId,
                        sess.rows[0].id,
                        stepRes.rows[0].n,
                        body.ivr_selection.node || 'business',
                        body.ivr_selection.value || null,
                        JSON.stringify(body.ivr_selection)
                    ]
                );
            }
        }

        await client.query('COMMIT');
        transactionOpen = false;
        return res.json({ ok: true });
    } catch (error) {
        if (transactionOpen) {
            await client.query('ROLLBACK').catch(() => {});
            transactionOpen = false;
        }

        console.error('AGI webhook failed:', error.message);
        return res.status(500).json({ error: 'agi_event_processing_failed' });
    } finally {
        client.release();
    }
});

router.post('/cdr', checkSecret, async (req, res) => {
    const cdr = req.body;
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE wazo_tenant_uuid = $1', [cdr.tenant_uuid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(422).json({ error: 'unknown_tenant' });

    await pool.query(
        `INSERT INTO calls (tenant_id, wazo_call_id, wazo_cdr_id, direction, from_number, to_number, status, start_time, answer_time, end_time, hangup_cause)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, wazo_call_id)
                 WHERE wazo_call_id IS NOT NULL
             DO UPDATE SET
            wazo_cdr_id = EXCLUDED.wazo_cdr_id, start_time = EXCLUDED.start_time,
            answer_time = EXCLUDED.answer_time, end_time = EXCLUDED.end_time,
            status = EXCLUDED.status, hangup_cause = COALESCE(NULLIF(EXCLUDED.hangup_cause, ''), calls.hangup_cause)`,
        [tenantId, cdr.call_id || cdr.linkedid || `cdr_${Date.now()}`, cdr.id || null,
         cdr.direction || 'internal', cdr.source_extension || null, cdr.destination_extension || null,
         cdr.answered ? 'completed' : 'missed', cdr.start || null, cdr.answer || null, cdr.end || null,
         cdr.reason_code ?? cdr.hangup_cause ?? cdr.hangupcause ?? null]
    );
    res.json({ ok: true });
});

module.exports = router;
