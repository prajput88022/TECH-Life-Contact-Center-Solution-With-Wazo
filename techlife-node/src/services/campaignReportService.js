const { pool } = require('../db');

async function summary(tenantId, campaignId, from, to) {
    const byChannel = await pool.query(
        `SELECT channel, event_type, SUM(event_count) AS total FROM mv_campaign_daily
         WHERE tenant_id = $1 AND campaign_id = $2 AND day_bucket BETWEEN $3 AND $4
         GROUP BY channel, event_type ORDER BY channel, event_type`,
        [tenantId, campaignId, from, to]
    );
    const voice = await pool.query(
        `SELECT COUNT(*) AS attempted,
                COUNT(*) FILTER (WHERE status IN ('answered','completed')) AS connected,
                COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
                COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
                SUM(talk_seconds) AS talk_seconds,
                AVG(talk_seconds + COALESCE(hold_seconds,0) + COALESCE(acw_seconds,0)) AS aht_seconds
         FROM calls WHERE tenant_id = $1 AND campaign_id = $2 AND start_time BETWEEN $3 AND $4`,
        [tenantId, campaignId, from, to]
    );
    return { by_channel: byChannel.rows, voice: voice.rows[0] || {} };
}

async function listActive(tenantId) {
    const res = await pool.query(
        `SELECT id, name, channel, dialing_mode, start_date, end_date, is_active, is_robo_campaign
         FROM campaigns WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId]
    );
    return res.rows;
}

module.exports = { summary, listActive };
