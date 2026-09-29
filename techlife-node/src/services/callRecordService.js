/**
 * The single place that queries individual call records for display or
 * CDR export -- used by the Supervisor "Call Records" page, the Agent
 * "My Calls" page, and the CDR export handler, so masking is enforced
 * exactly once. screenContext is 'agent' or 'supervisor'.
 */
const { pool } = require('../db');
const phoneMasker = require('../phoneMasker');

async function search(tenantId, screenContext, filters = {}, page = 1, perPage = 50) {
    const where = ['c.tenant_id = $1'];
    const params = [tenantId];
    let idx = 2;

    const from = filters.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = filters.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    where.push(`c.start_time BETWEEN $${idx++} AND $${idx++}`);
    params.push(from, to);

    for (const f of ['agent_id', 'queue_id', 'campaign_id', 'did_id', 'status', 'direction']) {
        if (filters[f]) {
            where.push(`c.${f} = $${idx++}`);
            params.push(filters[f]);
        }
    }
    if (screenContext === 'agent' && filters.restrict_to_agent_id) {
        where.push(`c.agent_id = $${idx++}`);
        params.push(filters.restrict_to_agent_id);
    }

    const offset = (page - 1) * perPage;
    const sql = `SELECT c.id, u.full_name AS agent_name, q.name AS queue_name, camp.name AS campaign_name,
                        d.did_number, c.direction, c.status, c.start_time, c.answer_time, c.end_time,
                        c.talk_seconds, c.wait_seconds, c.hangup_cause, c.from_number, c.to_number,
                        r.id AS recording_id, disp.label AS disposition_label
                 FROM calls c
                 LEFT JOIN agents ag ON ag.id = c.agent_id
                 LEFT JOIN users u ON u.id = ag.user_id
                 LEFT JOIN queues q ON q.id = c.queue_id
                 LEFT JOIN campaigns camp ON camp.id = c.campaign_id
                 LEFT JOIN dids d ON d.id = c.did_id
                 LEFT JOIN recordings r ON r.call_id = c.id
                 LEFT JOIN dispositions disp ON disp.id = c.disposition_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY c.start_time DESC
                 LIMIT ${perPage} OFFSET ${offset}`;

    const res = await pool.query(sql, params);
    const shouldMask = await phoneMasker.shouldMask(tenantId, screenContext);

    return res.rows.map((row) => {
        const shortId = row.id.replace(/-/g, '').slice(0, 8).toUpperCase();
        const masked = { ...row, short_id: shortId, number_masked: shouldMask };
        if (shouldMask) {
            masked.from_number = phoneMasker.mask(row.from_number);
            masked.to_number = phoneMasker.mask(row.to_number);
        }
        return masked;
    });
}

module.exports = { search };
