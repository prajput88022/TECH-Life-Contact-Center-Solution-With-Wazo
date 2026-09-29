const { pool } = require('../db');

async function hourly(tenantId, didId, from, to) {
    const res = await pool.query(
        `SELECT * FROM mv_did_hourly WHERE tenant_id = $1 AND did_id = $2
         AND hour_bucket BETWEEN $3 AND $4 ORDER BY hour_bucket`,
        [tenantId, didId, from, to]
    );
    return res.rows;
}

async function summary(tenantId, from, to) {
    const res = await pool.query(
        `SELECT d.id AS did_id, d.did_number, d.description, c.name AS campaign_name,
                SUM(m.calls_received)  AS calls_received,
                SUM(m.calls_answered)  AS calls_answered,
                SUM(m.calls_abandoned) AS calls_abandoned,
                SUM(m.calls_missed)    AS calls_missed,
                AVG(m.avg_wait_seconds) AS avg_wait_seconds,
                SUM(m.total_talk_seconds) AS total_talk_seconds
         FROM dids d
         LEFT JOIN campaigns c ON c.id = d.campaign_id
         LEFT JOIN mv_did_hourly m ON m.did_id = d.id AND m.hour_bucket BETWEEN $2 AND $3
         WHERE d.tenant_id = $1 AND d.is_active = TRUE
         GROUP BY d.id, d.did_number, d.description, c.name
         ORDER BY calls_received DESC NULLS LAST`,
        [tenantId, from, to]
    );
    return res.rows;
}

module.exports = { hourly, summary };
