const { pool } = require('../db');

async function journeyForCall(tenantId, callId) {
    const sessRes = await pool.query(
        `SELECT s.id AS ivr_session_id, s.entry_time, s.exit_time, s.exit_reason,
                s.final_queue_id, s.final_agent_id, d.did_number, im.name AS ivr_name
         FROM ivr_sessions s JOIN dids d ON d.id = s.did_id
         LEFT JOIN ivr_menus im ON im.id = s.ivr_menu_id
         WHERE s.tenant_id = $1 AND s.call_id = $2`,
        [tenantId, callId]
    );
    const session = sessRes.rows[0];
    if (!session) return { session: null, steps: [] };

    const stepsRes = await pool.query(
        `SELECT step_number, node_name, event_type, dtmf_input, event_time
         FROM ivr_events WHERE tenant_id = $1 AND ivr_session_id = $2 ORDER BY step_number`,
        [tenantId, session.ivr_session_id]
    );
    return { session, steps: stepsRes.rows };
}

async function hourly(tenantId, ivrMenuId, from, to) {
    const res = await pool.query(
        `SELECT
            date_trunc('hour', entry_time) AS hour_bucket,
            COUNT(*)::int AS sessions_entered,
            COUNT(*) FILTER (
                WHERE exit_time IS NOT NULL
            )::int AS sessions_exited,
            COUNT(*) FILTER (
                WHERE exit_reason::text = 'abandoned'
            )::int AS sessions_abandoned,
            COUNT(*) FILTER (
                WHERE exit_reason::text = 'queue_transfer'
            )::int AS transferred_to_queue,
            COUNT(*) FILTER (
                WHERE exit_reason::text = 'agent_transfer'
            )::int AS transferred_to_agent,
            AVG(duration_seconds) AS avg_duration_seconds,
            COALESCE(SUM(invalid_count),0)::int AS invalid_selections,
            COALESCE(SUM(timeout_count),0)::int AS timeouts
         FROM ivr_sessions
         WHERE tenant_id = $1
           AND ivr_menu_id = $2
           AND entry_time >= $3::date
           AND entry_time < ($4::date + INTERVAL '1 day')
         GROUP BY date_trunc('hour', entry_time)
         ORDER BY hour_bucket`,
        [tenantId, ivrMenuId, from, to]
    );
    return res.rows;
}

async function optionPopularity(tenantId, ivrMenuId, from, to) {
    const res = await pool.query(
        `SELECT e.node_name, e.dtmf_input, COUNT(*) AS selections
         FROM ivr_events e JOIN ivr_sessions s ON s.id = e.ivr_session_id
         WHERE e.tenant_id = $1 AND s.ivr_menu_id = $2 AND e.event_type = 'OPTION_SELECTED'
           AND e.event_time BETWEEN $3 AND $4
         GROUP BY e.node_name, e.dtmf_input ORDER BY selections DESC`,
        [tenantId, ivrMenuId, from, to]
    );
    return res.rows;
}

module.exports = { journeyForCall, hourly, optionPopularity };
