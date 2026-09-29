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
    const body = req.body;
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE wazo_tenant_uuid = $1', [body.tenant_wazo_uuid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(422).json({ error: 'unknown_tenant' });

    const callRes = await pool.query('SELECT id FROM calls WHERE tenant_id = $1 AND wazo_call_id = $2', [tenantId, body.wazo_call_id]);
    const call = callRes.rows[0];
    if (!call) return res.status(404).json({ error: 'call_not_found_yet', hint: 'AGI fired before calld CALL_STARTED was processed; retry' });

    const fields = [];
    const params = [];
    let idx = 1;
    if (body.campaign_id) { fields.push(`campaign_id = $${idx++}`); params.push(body.campaign_id); }
    if (body.disposition_code) {
        const d = await pool.query('SELECT id FROM dispositions WHERE tenant_id = $1 AND code = $2', [tenantId, body.disposition_code]);
        if (d.rows[0]) { fields.push(`disposition_id = $${idx++}`); params.push(d.rows[0].id); }
    }
    if (body.transfer_reason) { fields.push(`transfer_to_type = $${idx++}`); params.push(body.transfer_reason); }
    if (fields.length) {
        params.push(call.id);
        await pool.query(`UPDATE calls SET ${fields.join(', ')} WHERE id = $${idx}`, params);
    }

    if (body.lead_id && body.campaign_id) {
        await pool.query(
            `INSERT INTO lead_attempts (tenant_id, lead_id, call_id, attempt_number, attempted_at, outcome)
             VALUES ($1,$2,$3,1,now(),$4)`,
            [tenantId, body.lead_id, call.id, body.disposition_code || null]
        );
    }

    if (body.ivr_selection) {
        const sess = await pool.query(
            `SELECT id FROM ivr_sessions WHERE tenant_id = $1 AND call_id = $2 AND exit_time IS NULL ORDER BY entry_time DESC LIMIT 1`,
            [tenantId, call.id]
        );
        if (sess.rows[0]) {
            const stepRes = await pool.query('SELECT COALESCE(MAX(step_number),0)+1 AS n FROM ivr_events WHERE ivr_session_id = $1', [sess.rows[0].id]);
            await pool.query(
                `INSERT INTO ivr_events (tenant_id, ivr_session_id, step_number, node_name, event_type, dtmf_input, event_time, payload_json)
                 VALUES ($1,$2,$3,$4,'OPTION_SELECTED',$5,now(),$6)`,
                [tenantId, sess.rows[0].id, stepRes.rows[0].n, body.ivr_selection.node || 'business', body.ivr_selection.value || null, JSON.stringify(body.ivr_selection)]
            );
        }
    }
    res.json({ ok: true });
});

router.post('/cdr', checkSecret, async (req, res) => {
    const cdr = req.body;
    const tenantRes = await pool.query('SELECT id FROM tenants WHERE wazo_tenant_uuid = $1', [cdr.tenant_uuid]);
    const tenantId = tenantRes.rows[0]?.id;
    if (!tenantId) return res.status(422).json({ error: 'unknown_tenant' });

    await pool.query(
        `INSERT INTO calls (tenant_id, wazo_call_id, wazo_cdr_id, direction, from_number, to_number, status, start_time, answer_time, end_time, hangup_cause)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id, wazo_call_id) DO UPDATE SET
            wazo_cdr_id = EXCLUDED.wazo_cdr_id, start_time = EXCLUDED.start_time,
            answer_time = EXCLUDED.answer_time, end_time = EXCLUDED.end_time,
            status = EXCLUDED.status, hangup_cause = EXCLUDED.hangup_cause`,
        [tenantId, cdr.call_id || cdr.linkedid || `cdr_${Date.now()}`, cdr.id || null,
         cdr.direction || 'internal', cdr.source_extension || null, cdr.destination_extension || null,
         cdr.answered ? 'completed' : 'missed', cdr.start || null, cdr.answer || null, cdr.end || null,
         cdr.requested_context || null]
    );
    res.json({ ok: true });
});

module.exports = router;
