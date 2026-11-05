'use strict';

const { pool } = require('../db');

async function hourly(tenantId, didId, from, to) {
    const res = await pool.query(
        `SELECT
            date_trunc('hour', c.start_time) AS hour_bucket,
            COUNT(*)::int AS calls_received,
            COUNT(*) FILTER (
                WHERE c.status IN ('answered','completed')
            )::int AS calls_answered,
            COUNT(*) FILTER (
                WHERE c.status = 'abandoned'
            )::int AS calls_abandoned,
            COUNT(*) FILTER (
                WHERE c.status = 'missed'
            )::int AS calls_missed,
            AVG(c.wait_seconds) AS avg_wait_seconds,
            COALESCE(SUM(c.talk_seconds),0)::bigint AS total_talk_seconds
         FROM calls c
         WHERE c.tenant_id = $1
           AND c.did_id = $2
           AND c.start_time >= $3::date
           AND c.start_time < ($4::date + INTERVAL '1 day')
         GROUP BY date_trunc('hour', c.start_time)
         ORDER BY hour_bucket`,
        [tenantId, didId, from, to]
    );
    return res.rows;
}

async function summary(tenantId, from, to) {
    const res = await pool.query(
        `SELECT
            d.id AS did_id,
            d.did_number,
            d.description,
            c.name AS campaign_name,
            COUNT(ca.id)::int AS calls_received,
            COUNT(ca.id) FILTER (
                WHERE ca.status IN ('answered','completed')
            )::int AS calls_answered,
            COUNT(ca.id) FILTER (
                WHERE ca.status = 'abandoned'
            )::int AS calls_abandoned,
            COUNT(ca.id) FILTER (
                WHERE ca.status = 'missed'
            )::int AS calls_missed,
            AVG(ca.wait_seconds) AS avg_wait_seconds,
            COALESCE(SUM(ca.talk_seconds),0)::bigint AS total_talk_seconds
         FROM dids d
         LEFT JOIN campaigns c
           ON c.id = d.campaign_id AND c.tenant_id = d.tenant_id
         LEFT JOIN calls ca
           ON ca.did_id = d.id
          AND ca.tenant_id = d.tenant_id
          AND ca.start_time >= $2::date
          AND ca.start_time < ($3::date + INTERVAL '1 day')
         WHERE d.tenant_id = $1
           AND d.is_active = TRUE
         GROUP BY d.id, d.did_number, d.description, c.name
         ORDER BY calls_received DESC, d.did_number`,
        [tenantId, from, to]
    );
    return res.rows;
}

module.exports = { hourly, summary };
