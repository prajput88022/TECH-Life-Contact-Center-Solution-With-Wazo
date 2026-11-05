const { pool } = require('../db');

async function getOwnedCampaign(tenantId, campaignId) {
    if (!tenantId || !campaignId) {
        const err = new Error('A campaign is required.');
        err.status = 400;
        throw err;
    }

    const result = await pool.query(
        `SELECT id, name, channel, dialing_mode, is_active, is_robo_campaign
           FROM campaigns
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1`,
        [tenantId, campaignId]
    );

    if (!result.rows.length) {
        const err = new Error('Campaign not found for this tenant.');
        err.status = 404;
        throw err;
    }

    return result.rows[0];
}

async function summary(tenantId, campaignId, from, to) {
    const campaign = await getOwnedCampaign(tenantId, campaignId);

    const byChannel = await pool.query(
        `WITH voice_outcomes AS (
            SELECT
                'voice'::text AS channel,
                c.status::text AS event_type,
                COUNT(*)::bigint AS total
            FROM calls c
            WHERE c.tenant_id = $1
              AND c.campaign_id = $2
              AND c.start_time >= $3::date
              AND c.start_time < ($4::date + INTERVAL '1 day')
            GROUP BY c.status
        ),
        recorded_events AS (
            SELECT
                ce.channel::text AS channel,
                ce.event_type,
                COUNT(*)::bigint AS total
            FROM campaign_events ce
            WHERE ce.tenant_id = $1
              AND ce.campaign_id = $2
              AND ce.event_time >= $3::date
              AND ce.event_time < ($4::date + INTERVAL '1 day')
            GROUP BY ce.channel, ce.event_type
        )
        SELECT channel, event_type, total FROM voice_outcomes
        UNION ALL
        SELECT channel, event_type, total FROM recorded_events
        ORDER BY channel, event_type`,
        [tenantId, campaignId, from, to]
    );

    const voice = await pool.query(
        `SELECT
            COUNT(*)::int AS attempted,
            COUNT(*) FILTER (
                WHERE status IN ('answered','completed')
            )::int AS connected,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'abandoned')::int AS abandoned,
            COUNT(*) FILTER (WHERE status = 'busy')::int AS busy,
            COALESCE(SUM(talk_seconds),0)::bigint AS talk_seconds,
            AVG(
                talk_seconds + COALESCE(hold_seconds,0) +
                COALESCE(acw_seconds,0)
            ) AS aht_seconds,
            COUNT(*) FILTER (WHERE is_transfer)::int AS transfers
         FROM calls
         WHERE tenant_id = $1
           AND campaign_id = $2
           AND start_time >= $3::date
           AND start_time < ($4::date + INTERVAL '1 day')`,
        [tenantId, campaignId, from, to]
    );

    const leads = await pool.query(
        `SELECT COUNT(*)::int AS leads,
                COUNT(*) FILTER (WHERE status = 'new')::int AS new_leads,
                COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_leads
           FROM leads
          WHERE tenant_id = $1
            AND campaign_id = $2
            AND created_at >= $3::date
            AND created_at < ($4::date + INTERVAL '1 day')`,
        [tenantId, campaignId, from, to]
    );

    return {
        campaign,
        by_channel: byChannel.rows,
        voice: voice.rows[0] || {},
        leads: leads.rows[0] || {}
    };
}

/*
 * Live equivalent of the former mv_robo_campaign_hourly.
 * Survey rows are aggregated per tenant/campaign/call before joining,
 * so multiple DTMF responses never inflate call counts or message averages.
 * The report date range applies to call start time, matching the old view:
 * all responses linked to those calls are counted, regardless of response time.
 * NULL talk_seconds are excluded from the likely-hangup metric.
 */
async function roboHourly(tenantId, campaignId, from, to) {
    const campaign = await getOwnedCampaign(tenantId, campaignId);

    if (!campaign.is_robo_campaign) {
        return [];
    }

    const result = await pool.query(
        `WITH survey_counts AS (
            SELECT
                sr.tenant_id,
                sr.campaign_id,
                sr.call_id,
                COUNT(*)::int AS response_count
            FROM survey_responses sr
            WHERE sr.tenant_id = $1
              AND sr.campaign_id = $2
            GROUP BY sr.tenant_id, sr.campaign_id, sr.call_id
        )
        SELECT
            date_trunc('hour', c.start_time) AS hour_bucket,
            COUNT(*)::int AS calls_attempted,
            COUNT(*) FILTER (
                WHERE c.status IN ('answered','completed')
            )::int AS calls_connected,
            COUNT(*) FILTER (
                WHERE c.status = 'failed'
            )::int AS calls_failed,
            COUNT(*) FILTER (
                WHERE c.status = 'busy'
            )::int AS calls_busy,
            COUNT(*) FILTER (
                WHERE c.hangup_by = 'customer'
                  AND c.talk_seconds < 3
            )::int AS likely_hangups,
            AVG(c.talk_seconds)::numeric AS avg_message_seconds,
            COALESCE(SUM(sc.response_count), 0)::int
                AS survey_responses_captured
        FROM calls c
        LEFT JOIN survey_counts sc
               ON sc.tenant_id = c.tenant_id
              AND sc.campaign_id = c.campaign_id
              AND sc.call_id = c.id
        WHERE c.tenant_id = $1
          AND c.campaign_id = $2
          AND c.start_time >= $3::date
          AND c.start_time < ($4::date + INTERVAL '1 day')
        GROUP BY date_trunc('hour', c.start_time)
        ORDER BY hour_bucket`,
        [tenantId, campaignId, from, to]
    );

    return result.rows;
}

async function surveyDistribution(tenantId, campaignId, from, to) {
    await getOwnedCampaign(tenantId, campaignId);

    const result = await pool.query(
        `SELECT
            node_name,
            response_dtmf,
            COUNT(*)::int AS total
         FROM survey_responses
         WHERE tenant_id = $1
           AND campaign_id = $2
           AND response_type = 'dtmf'
           AND responded_at >= $3::date
           AND responded_at < ($4::date + INTERVAL '1 day')
         GROUP BY node_name, response_dtmf
         ORDER BY node_name, response_dtmf`,
        [tenantId, campaignId, from, to]
    );

    return result.rows;
}

async function listActive(tenantId) {
    const result = await pool.query(
        `SELECT id, name, channel, dialing_mode, start_date, end_date,
                is_active, is_robo_campaign
           FROM campaigns
          WHERE tenant_id = $1
          ORDER BY created_at DESC`,
        [tenantId]
    );

    return result.rows;
}

module.exports = {
    summary,
    listActive,
    roboHourly,
    surveyDistribution
};
