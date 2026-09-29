const { pool } = require('../db');

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
        `SELECT
            COALESCE(s.hour_bucket, c.hour_bucket) AS hour_bucket,
            COALESCE(s.login_seconds, 0)     AS login_seconds,
            COALESCE(s.available_seconds, 0) AS available_seconds,
            COALESCE(s.break_seconds, 0)     AS break_seconds,
            COALESCE(s.acw_seconds, 0)       AS acw_seconds,
            COALESCE(c.calls_offered, 0)     AS calls_offered,
            COALESCE(c.calls_answered, 0)    AS calls_answered,
            COALESCE(c.outbound_calls, 0)    AS outbound_calls,
            COALESCE(c.talk_seconds, 0)      AS talk_seconds,
            COALESCE(c.hold_seconds, 0)      AS hold_seconds
         FROM mv_agent_hourly s
         FULL OUTER JOIN mv_agent_hourly_calls c
            ON c.tenant_id = s.tenant_id AND c.agent_id = s.agent_id AND c.hour_bucket = s.hour_bucket
         WHERE COALESCE(s.tenant_id, c.tenant_id) = $1
           AND COALESCE(s.agent_id, c.agent_id) = $2
           AND COALESCE(s.hour_bucket, c.hour_bucket) BETWEEN $3 AND $4
         ORDER BY hour_bucket`,
        [tenantId, agentId, from, to]
    );
    return res.rows.map((r) => ({
        ...r,
        occupancy: occupancy(r),
        productivity: productivity(r),
        total_interactions: Number(r.calls_answered),
    }));
}

async function performance(tenantId, agentId, from, to) {
    const statusRes = await pool.query(
        `SELECT
            SUM(duration_seconds) FILTER (WHERE status NOT IN ('login','logout','offline')) AS total_logged_in,
            SUM(duration_seconds) FILTER (WHERE status = 'available') AS available_seconds,
            SUM(duration_seconds) FILTER (WHERE status IN ('break','lunch','tea','training','meeting','personal_break')) AS break_seconds,
            SUM(duration_seconds) FILTER (WHERE status = 'after_call_work') AS acw_seconds,
            SUM(duration_seconds) FILTER (WHERE status = 'offline') AS offline_seconds
         FROM agent_status_events
         WHERE tenant_id = $1 AND agent_id = $2 AND started_at BETWEEN $3 AND $4 AND ended_at IS NOT NULL`,
        [tenantId, agentId, from, to]
    );
    const statusRow = statusRes.rows[0] || {};

    const voiceRes = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE direction = 'inbound')  AS inbound_calls,
            COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound_calls,
            COUNT(*) FILTER (WHERE status IN ('answered','completed')) AS answered_calls,
            SUM(talk_seconds) AS talk_seconds,
            SUM(hold_seconds) AS hold_seconds,
            SUM(acw_seconds)  AS acw_seconds,
            AVG(talk_seconds + COALESCE(hold_seconds,0) + COALESCE(acw_seconds,0)) AS aht_seconds,
            COUNT(*) FILTER (WHERE is_transfer) AS transfers
         FROM calls WHERE tenant_id = $1 AND agent_id = $2 AND start_time BETWEEN $3 AND $4`,
        [tenantId, agentId, from, to]
    );
    const voiceRow = voiceRes.rows[0] || {};

    const omniRes = await pool.query(
        `SELECT channel, COUNT(*) AS handled,
            AVG(EXTRACT(EPOCH FROM (first_response_at - started_at))) AS avg_first_response_seconds,
            AVG(duration_seconds) AS avg_duration_seconds,
            COUNT(*) FILTER (WHERE status = 'closed') AS closed
         FROM conversations
         WHERE tenant_id = $1 AND agent_id = $2 AND started_at BETWEEN $3 AND $4 AND channel IN ('chat','email')
         GROUP BY channel`,
        [tenantId, agentId, from, to]
    );

    const convRes = await pool.query(
        `SELECT COUNT(*) AS conversions FROM (
            SELECT c.id FROM calls c JOIN dispositions d ON d.id = c.disposition_id
             WHERE c.tenant_id = $1 AND c.agent_id = $2 AND c.start_time BETWEEN $3 AND $4 AND d.is_conversion
            UNION ALL
            SELECT cv.id FROM conversations cv JOIN dispositions d ON d.id = cv.disposition_id
             WHERE cv.tenant_id = $1 AND cv.agent_id = $2 AND cv.started_at BETWEEN $3 AND $4 AND d.is_conversion
         ) x`,
        [tenantId, agentId, from, to]
    );
    const conversions = Number(convRes.rows[0]?.conversions || 0);

    let totalInteractions = Number(voiceRow.answered_calls || 0);
    for (const r of omniRes.rows) totalInteractions += Number(r.handled);

    const busy = (Number(voiceRow.talk_seconds) || 0) + (Number(voiceRow.hold_seconds) || 0) + (Number(voiceRow.acw_seconds) || 0);
    const occ = busy + (Number(statusRow.available_seconds) || 0) > 0
        ? busy / (busy + Number(statusRow.available_seconds)) : 0;
    const prod = Number(statusRow.total_logged_in) > 0 ? busy / Number(statusRow.total_logged_in) : 0;

    return {
        status: statusRow,
        voice: voiceRow,
        omni: omniRes.rows,
        total_interactions: totalInteractions,
        total_conversions: conversions,
        conversion_rate: totalInteractions > 0 ? Math.round((conversions / totalInteractions) * 10000) / 10000 : 0,
        occupancy: Math.round(occ * 10000) / 10000,
        productivity: Math.round(prod * 10000) / 10000,
    };
}

async function liveStatuses(tenantId) {
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
         ORDER BY u.full_name`,
        [tenantId]
    );
    return res.rows;
}

module.exports = { hourly, performance, liveStatuses, occupancy, productivity };
