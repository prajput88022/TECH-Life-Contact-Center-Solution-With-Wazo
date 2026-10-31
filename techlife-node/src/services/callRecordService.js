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

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePerPage = Math.min(500, Math.max(1, parseInt(perPage, 10) || 50));
    const offset = (safePage - 1) * safePerPage;

    const sql = `
        SELECT
            c.id AS call_uuid, c.id,
            LEFT(REPLACE(c.id::text, '-', ''), 8) AS short_id,
            c.tenant_id, t.name AS tenant_name,
            c.wazo_call_id, c.wazo_cdr_id,
            c.agent_id, u.full_name AS agent_name,
            ag.extension AS agent_extension,
            c.queue_id, q.name AS queue_name,
            c.campaign_id, camp.name AS campaign_name,
            c.did_id, d.did_number,
            c.direction, c.status, c.from_number, c.to_number,
            c.start_time, c.ring_time, c.answer_time, c.end_time,
            CASE
              WHEN c.start_time IS NOT NULL AND c.answer_time IS NOT NULL
              THEN GREATEST(0, EXTRACT(EPOCH FROM (c.answer_time - c.start_time)))::int
              ELSE NULL
            END AS setup_seconds,
            c.ring_seconds, c.wait_seconds, c.talk_seconds,
            c.hold_seconds, c.acw_seconds,
            c.hangup_cause, c.hangup_by,
            r.id AS recording_id,
            r.duration_seconds AS recording_duration_seconds,
            r.file_size_bytes AS recording_file_size_bytes,
            r.is_downloadable AS recording_downloadable,
            disp.label AS disposition_label
        FROM calls c
        LEFT JOIN tenants t ON t.id = c.tenant_id
        LEFT JOIN agents ag ON ag.id = c.agent_id
        LEFT JOIN users u ON u.id = ag.user_id
        LEFT JOIN queues q ON q.id = c.queue_id
        LEFT JOIN campaigns camp ON camp.id = c.campaign_id
        LEFT JOIN dids d ON d.id = c.did_id
        LEFT JOIN LATERAL (
            SELECT r0.id, r0.duration_seconds, r0.file_size_bytes,
                   r0.is_downloadable
            FROM recordings r0
            WHERE r0.tenant_id = c.tenant_id
              AND (r0.call_id = c.id OR r0.id = c.recording_id)
            ORDER BY (r0.id = c.recording_id) DESC NULLS LAST,
                     r0.created_at DESC
            LIMIT 1
        ) r ON TRUE
        LEFT JOIN dispositions disp ON disp.id = c.disposition_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.start_time DESC NULLS LAST
        LIMIT ${safePerPage} OFFSET ${offset}
    `;

    const result = await pool.query(sql, params);
    const shouldMask = await phoneMasker.shouldMask(tenantId, screenContext);

    return result.rows.map(row => {
        const output = { ...row, number_masked: shouldMask };
        if (shouldMask) {
            output.from_number = phoneMasker.mask(row.from_number);
            output.to_number = phoneMasker.mask(row.to_number);
        }
        return output;
    });
}

module.exports = { search };
