'use strict';

const { pool } = require('../db');

async function hourly(tenantId, queueId, from, to) {
    const res = await pool.query(
        `SELECT
            date_trunc('hour', c.start_time) AS hour_bucket,
            COUNT(*)::int AS calls_offered,
            COUNT(*) FILTER (
                WHERE c.status IN ('answered','completed')
            )::int AS calls_answered,
            COUNT(*) FILTER (WHERE c.status = 'abandoned')::int AS calls_abandoned,
            COUNT(*) FILTER (WHERE c.status = 'missed')::int AS calls_missed,
            AVG(c.wait_seconds) AS avg_wait_seconds,
            MAX(c.wait_seconds) AS max_wait_seconds,
            AVG(c.talk_seconds) AS avg_talk_seconds,
            (
                COUNT(*) FILTER (
                    WHERE c.wait_seconds <= q.sla_seconds
                      AND c.status IN ('answered','completed')
                )::numeric /
                NULLIF(
                    COUNT(*) FILTER (
                        WHERE c.status IN (
                            'answered','completed','abandoned'
                        )
                    ), 0
                )
            ) AS service_level
         FROM calls c
         JOIN queues q
           ON q.id = c.queue_id AND q.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1
           AND c.queue_id = $2
           AND c.start_time >= $3::date
           AND c.start_time < ($4::date + INTERVAL '1 day')
         GROUP BY q.id, q.sla_seconds, date_trunc('hour', c.start_time)
         ORDER BY hour_bucket`,
        [tenantId, queueId, from, to]
    );
    return res.rows;
}

async function summary(tenantId, from, to) {
    const res = await pool.query(
        `SELECT
            q.id AS queue_id,
            q.name,
            COUNT(c.id)::int AS calls_offered,
            COUNT(c.id) FILTER (
                WHERE c.status IN ('answered','completed')
            )::int AS calls_answered,
            COUNT(c.id) FILTER (
                WHERE c.status = 'abandoned'
            )::int AS calls_abandoned,
            COUNT(c.id) FILTER (
                WHERE c.status = 'missed'
            )::int AS calls_missed,
            AVG(c.wait_seconds) AS avg_wait_seconds,
            MAX(c.wait_seconds) AS max_wait_seconds,
            AVG(c.talk_seconds) AS avg_talk_seconds,
            (
                COUNT(c.id) FILTER (
                    WHERE c.wait_seconds <= q.sla_seconds
                      AND c.status IN ('answered','completed')
                )::numeric /
                NULLIF(
                    COUNT(c.id) FILTER (
                        WHERE c.status IN (
                            'answered','completed','abandoned'
                        )
                    ), 0
                )
            ) AS service_level
         FROM queues q
         LEFT JOIN calls c
           ON c.queue_id = q.id
          AND c.tenant_id = q.tenant_id
          AND c.start_time >= $2::date
          AND c.start_time < ($3::date + INTERVAL '1 day')
         WHERE q.tenant_id = $1
           AND q.is_active = TRUE
         GROUP BY q.id, q.name, q.sla_seconds
         ORDER BY q.name`,
        [tenantId, from, to]
    );
    return res.rows;
}

async function liveSnapshot(tenantId) {
    const res = await pool.query(
        `SELECT
            q.id AS queue_id,
            q.name,
            COUNT(c.id)::int AS calls_waiting,
            MAX(EXTRACT(EPOCH FROM (NOW() - c.start_time)))::int
                AS longest_wait_seconds
         FROM queues q
         LEFT JOIN calls c
           ON c.queue_id = q.id
          AND c.tenant_id = q.tenant_id
          AND c.status = 'ringing'
          AND c.end_time IS NULL
         WHERE q.tenant_id = $1
           AND q.is_active = TRUE
         GROUP BY q.id, q.name
         ORDER BY q.name`,
        [tenantId]
    );
    return res.rows;
}

module.exports = { hourly, summary, liveSnapshot };
