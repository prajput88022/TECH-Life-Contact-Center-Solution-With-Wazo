const { pool } = require('../db');

async function hourly(tenantId, queueId, from, to) {
    const res = await pool.query(
        `SELECT * FROM mv_queue_hourly WHERE tenant_id = $1 AND queue_id = $2
         AND hour_bucket BETWEEN $3 AND $4 ORDER BY hour_bucket`,
        [tenantId, queueId, from, to]
    );
    return res.rows;
}

async function summary(tenantId, from, to) {
    const res = await pool.query(
        `SELECT q.id AS queue_id, q.name,
                SUM(m.calls_offered)   AS calls_offered,
                SUM(m.calls_answered)  AS calls_answered,
                SUM(m.calls_abandoned) AS calls_abandoned,
                SUM(m.calls_missed)    AS calls_missed,
                AVG(m.avg_wait_seconds) AS avg_wait_seconds,
                MAX(m.max_wait_seconds) AS max_wait_seconds,
                AVG(m.service_level)    AS service_level
         FROM queues q
         LEFT JOIN mv_queue_hourly m ON m.queue_id = q.id AND m.hour_bucket BETWEEN $2 AND $3
         WHERE q.tenant_id = $1 AND q.is_active = TRUE
         GROUP BY q.id, q.name ORDER BY q.name`,
        [tenantId, from, to]
    );
    return res.rows;
}

async function liveSnapshot(tenantId) {
    const res = await pool.query(
        `SELECT q.id AS queue_id, q.name,
                COUNT(c.id) AS calls_waiting,
                MAX(EXTRACT(EPOCH FROM (now() - c.start_time)))::INT AS longest_wait_seconds
         FROM queues q
         LEFT JOIN calls c ON c.queue_id = q.id AND c.status = 'ringing' AND c.end_time IS NULL
         WHERE q.tenant_id = $1 AND q.is_active = TRUE
         GROUP BY q.id, q.name ORDER BY q.name`,
        [tenantId]
    );
    return res.rows;
}

module.exports = { hourly, summary, liveSnapshot };
