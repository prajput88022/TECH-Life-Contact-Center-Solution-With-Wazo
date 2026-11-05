'use strict';

const { pool } = require('../db');

const DATASETS = {
    call_outcomes: {
        label: 'Call Outcomes',
        features: ['voice'],
        columns: {
            day: 'Day',
            direction: 'Direction',
            status: 'Call Status',
            agent_name: 'Agent',
            queue_name: 'Queue',
            campaign_name: 'Campaign',
            calls: 'Calls',
            answered: 'Answered',
            missed: 'Missed',
            abandoned: 'Abandoned',
            talk_seconds: 'Talk Seconds',
            avg_wait_seconds: 'Average Wait Seconds'
        },
        sql: `
            SELECT
                c.start_time::date::text AS day,
                c.direction::text AS direction,
                c.status::text AS status,
                COALESCE(NULLIF(u.full_name,''), u.username, a.agent_number, 'Unassigned') AS agent_name,
                q.name AS queue_name,
                camp.name AS campaign_name,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE c.status IN ('answered','completed'))::int AS answered,
                COUNT(*) FILTER (WHERE c.status = 'missed')::int AS missed,
                COUNT(*) FILTER (WHERE c.status = 'abandoned')::int AS abandoned,
                COALESCE(SUM(c.talk_seconds),0)::bigint AS talk_seconds,
                AVG(c.wait_seconds) AS avg_wait_seconds
            FROM calls c
            LEFT JOIN agents a
              ON a.id = c.agent_id AND a.tenant_id = c.tenant_id
            LEFT JOIN users u
              ON u.id = a.user_id AND u.tenant_id = a.tenant_id
            LEFT JOIN queues q
              ON q.id = c.queue_id AND q.tenant_id = c.tenant_id
            LEFT JOIN campaigns camp
              ON camp.id = c.campaign_id AND camp.tenant_id = c.tenant_id
            WHERE c.tenant_id = $1
              AND c.start_time >= $2::date
              AND c.start_time < ($3::date + INTERVAL '1 day')
            GROUP BY 1,2,3,4,5,6
            ORDER BY day DESC, calls DESC
            LIMIT 5000`
    },

    agents: {
        label: 'Agent Performance Summary',
        features: ['voice'],
        columns: {
            agent_number: 'Agent Number',
            agent_name: 'Agent',
            calls: 'Calls',
            answered: 'Answered',
            inbound_calls: 'Inbound',
            outbound_calls: 'Outbound',
            talk_seconds: 'Talk Seconds',
            available_seconds: 'Available Seconds',
            break_seconds: 'Break Seconds',
            transfers: 'Transfers',
            conversions: 'Conversions'
        },
        sql: `
            WITH cs AS (
                SELECT
                    c.tenant_id, c.agent_id,
                    COUNT(*)::int AS calls,
                    COUNT(*) FILTER (WHERE c.status IN ('answered','completed'))::int AS answered,
                    COUNT(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound_calls,
                    COUNT(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound_calls,
                    COALESCE(SUM(c.talk_seconds),0)::bigint AS talk_seconds,
                    COUNT(*) FILTER (WHERE c.is_transfer)::int AS transfers,
                    COUNT(DISTINCT c.id) FILTER (WHERE d.is_conversion)::int AS conversions
                FROM calls c
                LEFT JOIN dispositions d
                  ON d.id = c.disposition_id AND d.tenant_id = c.tenant_id
                WHERE c.tenant_id = $1
                  AND c.start_time >= $2::date
                  AND c.start_time < ($3::date + INTERVAL '1 day')
                GROUP BY c.tenant_id, c.agent_id
            ),
            ss AS (
                SELECT
                    tenant_id, agent_id,
                    COALESCE(SUM(duration_seconds) FILTER (WHERE status = 'available'),0)::bigint AS available_seconds,
                    COALESCE(SUM(duration_seconds) FILTER (
                        WHERE status IN ('break','lunch','tea','training','meeting','system_issue','personal_break','custom')
                    ),0)::bigint AS break_seconds
                FROM agent_status_events
                WHERE tenant_id = $1
                  AND started_at >= $2::date
                  AND started_at < ($3::date + INTERVAL '1 day')
                  AND ended_at IS NOT NULL
                GROUP BY tenant_id, agent_id
            )
            SELECT
                a.agent_number,
                COALESCE(NULLIF(u.full_name,''),u.username,a.agent_number) AS agent_name,
                COALESCE(cs.calls,0)::int AS calls,
                COALESCE(cs.answered,0)::int AS answered,
                COALESCE(cs.inbound_calls,0)::int AS inbound_calls,
                COALESCE(cs.outbound_calls,0)::int AS outbound_calls,
                COALESCE(cs.talk_seconds,0)::bigint AS talk_seconds,
                COALESCE(ss.available_seconds,0)::bigint AS available_seconds,
                COALESCE(ss.break_seconds,0)::bigint AS break_seconds,
                COALESCE(cs.transfers,0)::int AS transfers,
                COALESCE(cs.conversions,0)::int AS conversions
            FROM agents a
            JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
            LEFT JOIN cs ON cs.tenant_id = a.tenant_id AND cs.agent_id = a.id
            LEFT JOIN ss ON ss.tenant_id = a.tenant_id AND ss.agent_id = a.id
            WHERE a.tenant_id = $1 AND a.is_active = TRUE
            ORDER BY agent_name
            LIMIT 5000`
    },

    queues: {
        label: 'Queue Performance',
        features: ['queues'],
        columns: {
            queue_name: 'Queue',
            calls: 'Offered',
            answered: 'Answered',
            abandoned: 'Abandoned',
            missed: 'Missed',
            avg_wait_seconds: 'Average Wait Seconds',
            max_wait_seconds: 'Maximum Wait Seconds',
            avg_talk_seconds: 'Average Talk Seconds',
            service_level: 'Service Level'
        },
        sql: `
            SELECT
                q.name AS queue_name,
                COUNT(c.id)::int AS calls,
                COUNT(c.id) FILTER (WHERE c.status IN ('answered','completed'))::int AS answered,
                COUNT(c.id) FILTER (WHERE c.status = 'abandoned')::int AS abandoned,
                COUNT(c.id) FILTER (WHERE c.status = 'missed')::int AS missed,
                AVG(c.wait_seconds) AS avg_wait_seconds,
                MAX(c.wait_seconds) AS max_wait_seconds,
                AVG(c.talk_seconds) AS avg_talk_seconds,
                COUNT(c.id) FILTER (
                    WHERE c.wait_seconds <= q.sla_seconds
                      AND c.status IN ('answered','completed')
                )::numeric / NULLIF(
                    COUNT(c.id) FILTER (
                        WHERE c.status IN ('answered','completed','abandoned')
                    ),0
                ) AS service_level
            FROM queues q
            LEFT JOIN calls c
              ON c.tenant_id = q.tenant_id
             AND c.queue_id = q.id
             AND c.start_time >= $2::date
             AND c.start_time < ($3::date + INTERVAL '1 day')
            WHERE q.tenant_id = $1
            GROUP BY q.id, q.name, q.sla_seconds
            ORDER BY q.name
            LIMIT 5000`
    },

    campaigns: {
        label: 'Campaign Performance',
        features: ['campaigns'],
        columns: {
            campaign_name: 'Campaign',
            dialing_mode: 'Dialing Mode',
            is_robo_campaign: 'Robo Campaign',
            leads: 'Leads Added',
            attempts: 'Lead Attempts',
            calls: 'Calls',
            answered: 'Answered',
            failed: 'Failed',
            conversions: 'Conversions'
        },
        sql: `
            WITH ls AS (
                SELECT tenant_id,campaign_id,COUNT(*)::int AS leads
                FROM leads
                WHERE tenant_id = $1
                  AND created_at >= $2::date
                  AND created_at < ($3::date + INTERVAL '1 day')
                GROUP BY tenant_id,campaign_id
            ),
            ats AS (
                SELECT l.tenant_id,l.campaign_id,COUNT(la.id)::int AS attempts
                FROM leads l
                JOIN lead_attempts la
                  ON la.tenant_id = l.tenant_id AND la.lead_id = l.id
                WHERE l.tenant_id = $1
                  AND la.attempted_at >= $2::date
                  AND la.attempted_at < ($3::date + INTERVAL '1 day')
                GROUP BY l.tenant_id,l.campaign_id
            ),
            cs AS (
                SELECT c.tenant_id,c.campaign_id,
                    COUNT(*)::int AS calls,
                    COUNT(*) FILTER (WHERE c.status IN ('answered','completed'))::int AS answered,
                    COUNT(*) FILTER (WHERE c.status = 'failed')::int AS failed,
                    COUNT(DISTINCT c.id) FILTER (WHERE d.is_conversion)::int AS conversions
                FROM calls c
                LEFT JOIN dispositions d
                  ON d.id = c.disposition_id AND d.tenant_id = c.tenant_id
                WHERE c.tenant_id = $1
                  AND c.start_time >= $2::date
                  AND c.start_time < ($3::date + INTERVAL '1 day')
                GROUP BY c.tenant_id,c.campaign_id
            )
            SELECT
                camp.name AS campaign_name,
                camp.dialing_mode,
                camp.is_robo_campaign,
                COALESCE(ls.leads,0)::int AS leads,
                COALESCE(ats.attempts,0)::int AS attempts,
                COALESCE(cs.calls,0)::int AS calls,
                COALESCE(cs.answered,0)::int AS answered,
                COALESCE(cs.failed,0)::int AS failed,
                COALESCE(cs.conversions,0)::int AS conversions
            FROM campaigns camp
            LEFT JOIN ls ON ls.tenant_id=camp.tenant_id AND ls.campaign_id=camp.id
            LEFT JOIN ats ON ats.tenant_id=camp.tenant_id AND ats.campaign_id=camp.id
            LEFT JOIN cs ON cs.tenant_id=camp.tenant_id AND cs.campaign_id=camp.id
            WHERE camp.tenant_id = $1
            ORDER BY camp.name
            LIMIT 5000`
    },

    lists: {
        label: 'List-wise Lead Performance',
        features: ['list_management'],
        columns: {
            list_name: 'List',
            list_type: 'Type',
            is_active: 'Active',
            members: 'Active Members Added',
            leads: 'Leads Added',
            attempts: 'Attempts',
            calls: 'Calls',
            answered: 'Answered',
            conversions: 'Converted Leads'
        },
        sql: `
            SELECT
                cl.name AS list_name,
                cl.list_type,
                cl.is_active,
                COUNT(DISTINCT lm.contact_id) FILTER (
                    WHERE lm.membership_status = 'active'
                      AND lm.added_at >= $2::date
                      AND lm.added_at < ($3::date + INTERVAL '1 day')
                )::int AS members,
                COUNT(DISTINCT l.id)::int AS leads,
                COUNT(DISTINCT la.id)::int AS attempts,
                COUNT(DISTINCT c.id)::int AS calls,
                COUNT(DISTINCT c.id) FILTER (
                    WHERE c.status IN ('answered','completed')
                )::int AS answered,
                COUNT(DISTINCT l.id) FILTER (
                    WHERE d.is_conversion = TRUE
                )::int AS conversions
            FROM contact_lists cl
            LEFT JOIN contact_list_members lm
              ON lm.tenant_id = cl.tenant_id
             AND lm.list_id = cl.id
            LEFT JOIN leads l
              ON l.tenant_id = lm.tenant_id
             AND l.contact_id = lm.contact_id
             AND (cl.campaign_id IS NULL OR l.campaign_id = cl.campaign_id)
             AND l.created_at >= $2::date
             AND l.created_at < ($3::date + INTERVAL '1 day')
            LEFT JOIN lead_attempts la
              ON la.tenant_id = l.tenant_id
             AND la.lead_id = l.id
             AND la.attempted_at >= $2::date
             AND la.attempted_at < ($3::date + INTERVAL '1 day')
            LEFT JOIN calls c
              ON c.tenant_id = la.tenant_id
             AND c.id = la.call_id
            LEFT JOIN dispositions d
              ON d.tenant_id = c.tenant_id
             AND d.id = c.disposition_id
            WHERE cl.tenant_id = $1
            GROUP BY cl.id, cl.name, cl.list_type, cl.is_active
            ORDER BY cl.name
            LIMIT 5000`
    },

    omnichannel: {
        label: 'Omnichannel Conversations',
        features: ['omnichannel'],
        columns: {
            channel: 'Channel',
            conversations: 'Conversations',
            responded: 'First Responses',
            closed: 'Closed',
            open: 'Open',
            avg_first_response_seconds: 'Average First Response Seconds',
            avg_duration_seconds: 'Average Duration Seconds',
            messages: 'Messages'
        },
        sql: `
            SELECT
                cv.channel::text AS channel,
                COUNT(*)::int AS conversations,
                COUNT(*) FILTER (WHERE cv.first_response_at IS NOT NULL)::int AS responded,
                COUNT(*) FILTER (WHERE cv.closed_at IS NOT NULL)::int AS closed,
                COUNT(*) FILTER (WHERE cv.closed_at IS NULL)::int AS open,
                AVG(EXTRACT(EPOCH FROM (
                    cv.first_response_at - cv.started_at
                ))) AS avg_first_response_seconds,
                AVG(cv.duration_seconds) AS avg_duration_seconds,
                COALESCE(SUM(msg.message_count),0)::int AS messages
            FROM conversations cv
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS message_count
                FROM conversation_messages cm
                WHERE cm.tenant_id = cv.tenant_id
                  AND cm.conversation_id = cv.id
                  AND cm.sent_at >= $2::date
                  AND cm.sent_at < ($3::date + INTERVAL '1 day')
            ) msg ON TRUE
            WHERE cv.tenant_id = $1
              AND cv.channel::text NOT IN ('voice','ivr')
              AND cv.started_at >= $2::date
              AND cv.started_at < ($3::date + INTERVAL '1 day')
            GROUP BY cv.channel
            ORDER BY cv.channel
            LIMIT 5000`
    },

    callbacks: {
        label: 'Callback Performance',
        features: ['callback_management'],
        columns: {
            agent_name: 'Agent',
            status: 'Callback Status',
            callbacks: 'Callbacks',
            overdue: 'Overdue',
            completed: 'Completed'
        },
        sql: `
            SELECT
                COALESCE(NULLIF(u.full_name,''),u.username,a.agent_number,'Agent') AS agent_name,
                cb.status,
                COUNT(*)::int AS callbacks,
                COUNT(*) FILTER (
                    WHERE cb.status = 'scheduled' AND cb.due_at < NOW()
                )::int AS overdue,
                COUNT(*) FILTER (WHERE cb.status = 'completed')::int AS completed
            FROM agent_callbacks cb
            JOIN agents a
              ON a.id = cb.agent_id AND a.tenant_id = cb.tenant_id
            JOIN users u
              ON u.id = a.user_id AND u.tenant_id = a.tenant_id
            WHERE cb.tenant_id = $1
              AND cb.created_at >= $2::date
              AND cb.created_at < ($3::date + INTERVAL '1 day')
            GROUP BY agent_name, cb.status
            ORDER BY agent_name, cb.status
            LIMIT 5000`
    },

    dids: {
        label: 'DID Performance',
        features: ['inbound'],
        columns: {
            did_number: 'DID',
            description: 'Description',
            calls: 'Received',
            answered: 'Answered',
            abandoned: 'Abandoned',
            missed: 'Missed',
            avg_wait_seconds: 'Average Wait Seconds',
            talk_seconds: 'Talk Seconds'
        },
        sql: `
            SELECT
                d.did_number,
                d.description,
                COUNT(c.id)::int AS calls,
                COUNT(c.id) FILTER (
                    WHERE c.status IN ('answered','completed')
                )::int AS answered,
                COUNT(c.id) FILTER (WHERE c.status = 'abandoned')::int AS abandoned,
                COUNT(c.id) FILTER (WHERE c.status = 'missed')::int AS missed,
                AVG(c.wait_seconds) AS avg_wait_seconds,
                COALESCE(SUM(c.talk_seconds),0)::bigint AS talk_seconds
            FROM dids d
            LEFT JOIN calls c
              ON c.tenant_id = d.tenant_id
             AND c.did_id = d.id
             AND c.start_time >= $2::date
             AND c.start_time < ($3::date + INTERVAL '1 day')
            WHERE d.tenant_id = $1
            GROUP BY d.id, d.did_number, d.description
            ORDER BY calls DESC, d.did_number
            LIMIT 5000`
    },

    ivr: {
        label: 'IVR Performance',
        features: ['ivr'],
        columns: {
            ivr_name: 'IVR Menu',
            sessions: 'Sessions',
            exited: 'Exited',
            abandoned: 'Abandoned',
            invalid_selections: 'Invalid Selections',
            timeouts: 'Timeouts',
            avg_duration_seconds: 'Average Duration Seconds'
        },
        sql: `
            SELECT
                COALESCE(m.name,'Unassigned IVR') AS ivr_name,
                COUNT(s.id)::int AS sessions,
                COUNT(s.id) FILTER (WHERE s.exit_time IS NOT NULL)::int AS exited,
                COUNT(s.id) FILTER (
                    WHERE s.exit_reason::text = 'abandoned'
                )::int AS abandoned,
                COALESCE(SUM(s.invalid_count),0)::int AS invalid_selections,
                COALESCE(SUM(s.timeout_count),0)::int AS timeouts,
                AVG(s.duration_seconds) AS avg_duration_seconds
            FROM ivr_sessions s
            LEFT JOIN ivr_menus m
              ON m.id = s.ivr_menu_id AND m.tenant_id = s.tenant_id
            WHERE s.tenant_id = $1
              AND s.entry_time >= $2::date
              AND s.entry_time < ($3::date + INTERVAL '1 day')
            GROUP BY m.id, m.name
            ORDER BY sessions DESC
            LIMIT 5000`
    },

    dispositions: {
        label: 'Disposition and Conversion Analysis',
        features: ['voice','dispositions'],
        columns: {
            disposition: 'Disposition',
            code: 'Code',
            is_conversion: 'Conversion',
            calls: 'Calls',
            talk_seconds: 'Talk Seconds',
            transfers: 'Transfers'
        },
        sql: `
            SELECT
                COALESCE(d.label,'Undisposed') AS disposition,
                COALESCE(d.code,'UNSET') AS code,
                COALESCE(d.is_conversion,FALSE) AS is_conversion,
                COUNT(c.id)::int AS calls,
                COALESCE(SUM(c.talk_seconds),0)::bigint AS talk_seconds,
                COUNT(c.id) FILTER (WHERE c.is_transfer)::int AS transfers
            FROM calls c
            LEFT JOIN dispositions d
              ON d.id = c.disposition_id AND d.tenant_id = c.tenant_id
            WHERE c.tenant_id = $1
              AND c.start_time >= $2::date
              AND c.start_time < ($3::date + INTERVAL '1 day')
            GROUP BY d.id, d.label, d.code, d.is_conversion
            ORDER BY calls DESC
            LIMIT 5000`
    }
};

function getDataset(key) {
    return DATASETS[String(key || '')] || null;
}

function availableDatasets(featureFlags) {
    return Object.entries(DATASETS)
        .filter(([, definition]) =>
            !featureFlags ||
            definition.features.every(feature => featureFlags[feature] === true)
        )
        .map(([key, definition]) => ({
            key,
            label: definition.label,
            features: definition.features,
            columns: Object.entries(definition.columns).map(([name, label]) => ({
                name,
                label
            }))
        }));
}

async function run(tenantId, key, selectedColumns, from, to, db = pool) {
    if (!tenantId) throw new Error('Tenant context is required.');

    const definition = getDataset(key);
    if (!definition) throw new Error('Unknown custom report dataset.');

    const allColumns = Object.keys(definition.columns);
    const requested = Array.isArray(selectedColumns)
        ? selectedColumns
        : selectedColumns ? [selectedColumns] : allColumns;

    const columns = [...new Set(requested)]
        .filter(column => allColumns.includes(column));

    if (!columns.length) {
        throw new Error('Select at least one valid report column.');
    }

    const result = await db.query(definition.sql, [tenantId, from, to]);

    return {
        dataset: key,
        label: definition.label,
        features: definition.features,
        columns,
        headers: columns.map(column => definition.columns[column]),
        rows: result.rows.map(row => {
            const output = {};
            for (const column of columns) output[column] = row[column];
            return output;
        })
    };
}

module.exports = {
    getDataset,
    availableDatasets,
    run
};
