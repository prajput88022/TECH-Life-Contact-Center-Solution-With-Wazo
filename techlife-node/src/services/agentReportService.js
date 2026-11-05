const { pool } = require('../db');
const { agentAccessPredicate } = require('../supervisorScope');

function occupancy(r) {
    const busy = (Number(r.talk_seconds) || 0) + (Number(r.hold_seconds) || 0) + (Number(r.acw_seconds) || 0);
    const denom = busy + (Number(r.available_seconds) || 0);
    return denom > 0 ? Math.round((busy / denom) * 10000) / 10000 : 0;
}
function productivity(r) {
    const busy = (Number(r.talk_seconds) || 0) + (Number(r.hold_seconds) || 0) + (Number(r.acw_seconds) || 0);
    return (Number(r.login_seconds) || 0) > 0 ? Math.round((busy / r.login_seconds) * 10000) / 10000 : 0;
}

async function hourly(tenantId, agentId, from, to) {
    const res = await pool.query(
        `WITH status_hourly AS (
            SELECT
                tenant_id,
                agent_id,
                date_trunc('hour', started_at) AS hour_bucket,
                COALESCE(SUM(duration_seconds) FILTER (
                    WHERE status NOT IN ('login','logout','offline')
                ), 0)::bigint AS login_seconds,
                COALESCE(SUM(duration_seconds) FILTER (
                    WHERE status = 'available'
                ), 0)::bigint AS available_seconds,
                COALESCE(SUM(duration_seconds) FILTER (
                    WHERE status IN (
                        'break','lunch','tea','training','meeting',
                        'system_issue','personal_break','custom'
                    )
                ), 0)::bigint AS break_seconds,
                COALESCE(SUM(duration_seconds) FILTER (
                    WHERE status = 'after_call_work'
                ), 0)::bigint AS acw_seconds
            FROM agent_status_events
            WHERE tenant_id = $1
              AND agent_id = $2
              AND ended_at IS NOT NULL
              AND started_at >= $3::date
              AND started_at < ($4::date + INTERVAL '1 day')
            GROUP BY tenant_id, agent_id, date_trunc('hour', started_at)
        ),
        call_hourly AS (
            SELECT
                tenant_id,
                agent_id,
                date_trunc('hour', start_time) AS hour_bucket,
                COUNT(*)::int AS calls_offered,
                COUNT(*) FILTER (
                    WHERE status IN ('answered','completed')
                )::int AS calls_answered,
                COUNT(*) FILTER (
                    WHERE direction = 'outbound'
                )::int AS outbound_calls,
                COALESCE(SUM(talk_seconds), 0)::bigint AS talk_seconds,
                COALESCE(SUM(hold_seconds), 0)::bigint AS hold_seconds,
                COALESCE(SUM(acw_seconds), 0)::bigint AS call_acw_seconds
            FROM calls
            WHERE tenant_id = $1
              AND agent_id = $2
              AND start_time >= $3::date
              AND start_time < ($4::date + INTERVAL '1 day')
            GROUP BY tenant_id, agent_id, date_trunc('hour', start_time)
        )
        SELECT
            COALESCE(s.hour_bucket, c.hour_bucket) AS hour_bucket,
            COALESCE(s.login_seconds, 0)::bigint AS login_seconds,
            COALESCE(s.available_seconds, 0)::bigint AS available_seconds,
            COALESCE(s.break_seconds, 0)::bigint AS break_seconds,
            COALESCE(s.acw_seconds, 0)::bigint AS acw_seconds,
            COALESCE(c.calls_offered, 0)::int AS calls_offered,
            COALESCE(c.calls_answered, 0)::int AS calls_answered,
            COALESCE(c.outbound_calls, 0)::int AS outbound_calls,
            COALESCE(c.talk_seconds, 0)::bigint AS talk_seconds,
            COALESCE(c.hold_seconds, 0)::bigint AS hold_seconds,
            COALESCE(c.call_acw_seconds, 0)::bigint AS call_acw_seconds
        FROM status_hourly s
        FULL OUTER JOIN call_hourly c
          ON c.tenant_id = s.tenant_id
         AND c.agent_id = s.agent_id
         AND c.hour_bucket = s.hour_bucket
        ORDER BY hour_bucket`,
        [tenantId, agentId, from, to]
    );

    return res.rows.map(r => {
        const normalized = {
            ...r,
            // Status-event ACW and call-record ACW are separate measures.
            // Do not add them: they can describe the same after-call work.
            acw_seconds: Number(r.acw_seconds || 0),
            call_acw_seconds: Number(r.call_acw_seconds || 0)
        };
        return {
            ...normalized,
            occupancy: occupancy(normalized),
            productivity: productivity(normalized),
            total_interactions: Number(normalized.calls_answered || 0)
        };
    });
}

async function performance(tenantId, agentId, from, to, options = {}) {
    const includeOmni = options.includeOmni === true;

    const statusRes = await pool.query(
        `SELECT
            COALESCE(SUM(duration_seconds) FILTER (
                WHERE status NOT IN ('login','logout','offline')
            ), 0)::bigint AS total_logged_in,
            COALESCE(SUM(duration_seconds) FILTER (
                WHERE status = 'available'
            ), 0)::bigint AS available_seconds,
            COALESCE(SUM(duration_seconds) FILTER (
                WHERE status IN (
                    'break','lunch','tea','training','meeting',
                    'system_issue','personal_break','custom'
                )
            ), 0)::bigint AS break_seconds,
            COALESCE(SUM(duration_seconds) FILTER (
                WHERE status = 'after_call_work'
            ), 0)::bigint AS acw_seconds,
            COALESCE(SUM(duration_seconds) FILTER (
                WHERE status = 'offline'
            ), 0)::bigint AS offline_seconds
         FROM agent_status_events
         WHERE tenant_id = $1
           AND agent_id = $2
           AND started_at >= $3::date
           AND started_at < ($4::date + INTERVAL '1 day')
           AND ended_at IS NOT NULL`,
        [tenantId, agentId, from, to]
    );
    const statusRow = statusRes.rows[0] || {};

    const voiceRes = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE direction = 'inbound')::int AS inbound_calls,
            COUNT(*) FILTER (WHERE direction = 'outbound')::int AS outbound_calls,
            COUNT(*) FILTER (
                WHERE status IN ('answered','completed')
            )::int AS answered_calls,
            COUNT(*) FILTER (WHERE status = 'missed')::int AS missed_calls,
            COUNT(*) FILTER (WHERE status = 'abandoned')::int AS abandoned_calls,
            COALESCE(SUM(talk_seconds), 0)::bigint AS talk_seconds,
            COALESCE(SUM(hold_seconds), 0)::bigint AS hold_seconds,
            COALESCE(SUM(acw_seconds), 0)::bigint AS acw_seconds,
            AVG(
                talk_seconds + COALESCE(hold_seconds,0) +
                COALESCE(acw_seconds,0)
            ) AS aht_seconds,
            COUNT(*) FILTER (WHERE is_transfer)::int AS transfers
         FROM calls
         WHERE tenant_id = $1
           AND agent_id = $2
           AND start_time >= $3::date
           AND start_time < ($4::date + INTERVAL '1 day')`,
        [tenantId, agentId, from, to]
    );
    const voiceRow = voiceRes.rows[0] || {};

    let omniRes = { rows: [] };
    if (includeOmni) {
        omniRes = await pool.query(
            `SELECT
                channel::text AS channel,
                COUNT(*)::int AS handled,
                COUNT(*) FILTER (
                    WHERE first_response_at IS NOT NULL
                )::int AS responded,
                AVG(EXTRACT(EPOCH FROM (
                    first_response_at - started_at
                ))) AS avg_first_response_seconds,
                AVG(duration_seconds) AS avg_duration_seconds,
                COUNT(*) FILTER (
                    WHERE closed_at IS NOT NULL
                )::int AS closed
             FROM conversations
             WHERE tenant_id = $1
               AND agent_id = $2
               AND started_at >= $3::date
               AND started_at < ($4::date + INTERVAL '1 day')
               AND channel::text NOT IN ('voice','ivr')
             GROUP BY channel
             ORDER BY channel`,
            [tenantId, agentId, from, to]
        );
    }

    let conversionsQuery = `
        SELECT COUNT(DISTINCT c.id)::int AS conversions
          FROM calls c
          JOIN dispositions d
            ON d.id = c.disposition_id AND d.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1
           AND c.agent_id = $2
           AND c.start_time >= $3::date
           AND c.start_time < ($4::date + INTERVAL '1 day')
           AND d.is_conversion = TRUE`;

    if (includeOmni) {
        conversionsQuery = `
            SELECT COUNT(*)::int AS conversions FROM (
                SELECT c.id
                  FROM calls c
                  JOIN dispositions d
                    ON d.id = c.disposition_id AND d.tenant_id = c.tenant_id
                 WHERE c.tenant_id = $1
                   AND c.agent_id = $2
                   AND c.start_time >= $3::date
                   AND c.start_time < ($4::date + INTERVAL '1 day')
                   AND d.is_conversion = TRUE
                UNION
                SELECT cv.id
                  FROM conversations cv
                  JOIN dispositions d
                    ON d.id = cv.disposition_id AND d.tenant_id = cv.tenant_id
                 WHERE cv.tenant_id = $1
                   AND cv.agent_id = $2
                   AND cv.started_at >= $3::date
                   AND cv.started_at < ($4::date + INTERVAL '1 day')
                   AND d.is_conversion = TRUE
            ) converted`;
    }

    const convRes = await pool.query(
        conversionsQuery, [tenantId, agentId, from, to]
    );
    const conversions = Number(convRes.rows[0]?.conversions || 0);

    let totalInteractions = Number(voiceRow.answered_calls || 0);
    for (const row of omniRes.rows) {
        totalInteractions += Number(row.handled || 0);
    }

    const busy =
        (Number(voiceRow.talk_seconds) || 0) +
        (Number(voiceRow.hold_seconds) || 0) +
        (Number(voiceRow.acw_seconds) || 0);

    const available = Number(statusRow.available_seconds) || 0;
    const login = Number(statusRow.total_logged_in) || 0;
    const occupancyRate = busy + available > 0
        ? busy / (busy + available) : 0;
    const productivityRate = login > 0 ? busy / login : 0;

    return {
        status: statusRow,
        voice: voiceRow,
        omni: omniRes.rows,
        total_interactions: totalInteractions,
        total_conversions: conversions,
        conversion_rate: totalInteractions > 0
            ? Math.round((conversions / totalInteractions) * 10000) / 10000
            : 0,
        occupancy: Math.round(occupancyRate * 10000) / 10000,
        productivity: Math.round(productivityRate * 10000) / 10000
    };
}

async function liveStatuses(tenantId, supervisorUserId = null) {
    const scopeClause = supervisorUserId ? `AND ${agentAccessPredicate('a', '$1', '$2')}` : '';
    const res = await pool.query(
        `SELECT a.id AS agent_id, u.full_name, ase.status, ase.started_at, q.name AS queue_name, a.skills_json
         FROM agents a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN LATERAL (
            SELECT * FROM agent_status_events WHERE agent_id = a.id AND ended_at IS NULL
            ORDER BY started_at DESC LIMIT 1
         ) ase ON TRUE
         LEFT JOIN queues q ON q.id = ase.queue_id
         WHERE a.tenant_id = $1 AND a.is_active = TRUE
         ${scopeClause}
         ORDER BY u.full_name`,
        supervisorUserId ? [tenantId, supervisorUserId] : [tenantId]
    );
    return res.rows;
}

module.exports = { hourly, performance, liveStatuses, occupancy, productivity };
