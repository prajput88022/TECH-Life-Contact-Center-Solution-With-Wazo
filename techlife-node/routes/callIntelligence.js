'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../src/db');
const { writeAuditLog } = require('../src/auditLog');
const { getCallTrace } = require('../src/callIntelligenceCelReader');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function validDate(value) {
    if (!DATE_RE.test(value || '')) return false;
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) &&
        d.toISOString().slice(0, 10) === value;
}

function tenantId(req) {
    return req.effectiveTenant?.id || null;
}

function csrfToken(req) {
    if (!req.session.callIntelligenceCsrf) {
        req.session.callIntelligenceCsrf = crypto.randomBytes(32).toString('hex');
    }
    return req.session.callIntelligenceCsrf;
}

function validCsrf(req) {
    const expected = String(req.session.callIntelligenceCsrf || '');
    const supplied = String(req.body?._ci_csrf || '');

    if (!/^[a-f0-9]{64}$/i.test(expected) ||
        !/^[a-f0-9]{64}$/i.test(supplied)) {
        return false;
    }

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(supplied, 'hex');

    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function flash(req, type, message) {
    req.session.ciFlash = { type, message };
}

function consumeFlash(req) {
    const value = req.session.ciFlash || null;
    delete req.session.ciFlash;
    return value;
}

function redirectIndex(res) {
    return res.redirect('/admin/call-intelligence');
}


function sipPayloadPreview(base64, truncated) {
    if (!base64) return '';

    try {
        let value = Buffer.from(base64, 'base64').toString('utf8');

        value = value.replace(
            /^(Authorization|Proxy-Authorization|WWW-Authenticate|Proxy-Authenticate)\s*:\s*.*$/gim,
            '$1: [REDACTED]'
        );

        value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (truncated) {
            value += '\n[Packet payload preview truncated by TECH-Life]';
        }

        return value.slice(0, 12000);
    } catch (_) {
        return '[SIP payload could not be decoded]';
    }
}


function parseSipHeaderDetails(preview) {
    const text = String(preview || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');
    const startLine = lines.shift() || '';
    const unfolded = [];

    for (const line of lines) {
        if (/^[ \t]/.test(line) && unfolded.length) {
            unfolded[unfolded.length - 1] += ' ' + line.trim();
        } else {
            unfolded.push(line);
        }
    }

    const wanted = new Set([
        'via', 'v', 'contact', 'm', 'route', 'record-route',
        'user-agent', 'server', 'allow', 'supported', 'require',
        'content-type', 'content-length', 'expires',
        'session-expires', 'min-se', 'max-forwards'
    ]);

    const headers = [];
    let viaBranch = '';

    for (const line of unfolded) {
        const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
        if (!match) continue;

        const name = match[1].toLowerCase();
        const value = match[2].trim();

        if (name === 'via' || name === 'v') {
            const branch = value.match(/(?:^|;)\s*branch\s*=\s*([^;\s]+)/i);
            if (branch && !viaBranch) viaBranch = branch[1];
        }

        if (wanted.has(name)) {
            headers.push({
                name: name === 'v' ? 'Via' :
                      name === 'm' ? 'Contact' :
                      name.replace(/(^|-)\w/g, x => x.toUpperCase()),
                value
            });
        }
    }

    return { startLine, viaBranch, headers };
}

function buildSipLadder(rows) {
    const packets = (Array.isArray(rows) ? rows : [])
        .filter(packet => String(packet.record_type || '').toLowerCase() === 'sip');

    const participants = [];
    const participantMap = new Map();

    function addParticipant(ip, port) {
        const address = String(ip || 'Unknown IP').trim();
        const portValue = port == null ? '?' : String(port);
        const key = `${address.toLowerCase()}|${portValue}`;

        if (!participantMap.has(key)) {
            const displayAddress = address.includes(':') &&
                !address.startsWith('[')
                ? `[${address}]`
                : address;

            const participant = {
                index: participants.length,
                ip: address,
                port: portValue,
                label: `${displayAddress}:${portValue}`
            };

            participantMap.set(key, participant.index);
            participants.push(participant);
        }

        return participantMap.get(key);
    }

    const indexed = packets.map(packet => ({
        packet,
        sourceIndex: addParticipant(
            packet.source_ip,
            packet.source_port
        ),
        destinationIndex: addParticipant(
            packet.destination_ip,
            packet.destination_port
        )
    }));

    const firstTime = indexed.reduce((earliest, item) => {
        const value = new Date(
            item.packet.packet_time || item.packet.received_at || 0
        ).getTime();

        return Number.isFinite(value) && value > 0
            ? Math.min(earliest, value)
            : earliest;
    }, Number.POSITIVE_INFINITY);

    const count = participants.length;

    const messages = indexed.map(({ packet, sourceIndex, destinationIndex }) => {
        const status = Number(packet.sip_status_code || 0);
        const method = String(packet.sip_method || '').trim();
        const reason = String(packet.sip_reason || '').trim();

        const label = method
            ? method
            : `${status || 'SIP'} ${reason}`.trim();

        const methodUpper = method.toUpperCase();

        const lineColor = status >= 300
            ? '#ef6476'
            : status >= 200
                ? '#31c48d'
                : status >= 100
                    ? '#45c6a8'
                    : methodUpper === 'BYE' || methodUpper === 'CANCEL'
                        ? '#ef6476'
                        : methodUpper === 'ACK'
                            ? '#a78bfa'
                            : '#49c5e8';

        const packetTime = packet.packet_time || packet.received_at || null;
        const packetMillis = packetTime
            ? new Date(packetTime).getTime()
            : NaN;

        const sourceX = count
            ? ((sourceIndex + 0.5) / count) * 1000
            : 0;

        const destinationX = count
            ? ((destinationIndex + 0.5) / count) * 1000
            : 0;

        return {
            id: packet.id,
            packetTime,
            elapsedMs: Number.isFinite(packetMillis) &&
                Number.isFinite(firstTime)
                ? Math.max(0, packetMillis - firstTime)
                : null,

            sourceIndex,
            destinationIndex,
            sourceX,
            destinationX,
            labelLeftPercent: count
                ? ((sourceIndex + destinationIndex + 1) / (2 * count)) * 100
                : 50,
            lineColor,
            label: label || 'SIP message',

            sourceLabel: participants[sourceIndex]?.label || 'Unknown source',
            destinationLabel: participants[destinationIndex]?.label || 'Unknown destination',

            sourceIp: packet.source_ip,
            destinationIp: packet.destination_ip,
            sourcePort: packet.source_port,
            destinationPort: packet.destination_port,

            transportLabel:
                Number(packet.transport_protocol) === 6 ? 'TCP'
                : Number(packet.transport_protocol) === 17 ? 'UDP'
                : `Protocol ${packet.transport_protocol ?? 'unknown'}`,

            method: method || null,
            statusCode: status || null,
            reason: reason || null,
            cseq: packet.sip_cseq,
            callId: packet.call_id,
            requestUri: packet.sip_request_uri,
            fromUri: packet.sip_from_uri,
            toUri: packet.sip_to_uri,
            channelName: packet.channel_name,
            channelRole: packet.channel_role,

            payloadPreview: sipPayloadPreview(
                packet.payload_base64,
                packet.payload_truncated
            ),
            payloadTruncated: packet.payload_truncated === true
        };
    });

    // Extract useful headers from the already-redacted SIP preview.
    for (const message of messages) {
        const parsed = parseSipHeaderDetails(message.payloadPreview);
        message.startLine = parsed.startLine;
        message.viaBranch = parsed.viaBranch;
        message.sipHeaders = parsed.headers;
        message.packetIds = [message.id];
        message.packetTimes = message.packetTime ? [message.packetTime] : [];
        message.retransmissionCount = 0;
    }

    // Group only packets with a complete transaction identity.
    // Missing Via branches are deliberately not guessed or grouped.
    const groupedMessages = [];
    const transactionMap = new Map();

    for (const message of messages) {
        const direction = `${message.sourceLabel}>${message.destinationLabel}`;
        const cseq = String(message.cseq || '').trim().toLowerCase();
        const callId = String(message.callId || '').trim();
        const branch = String(message.viaBranch || '').trim();

        const transactionKey = callId && cseq && branch
            ? [
                callId,
                cseq,
                branch,
                direction,
                String(message.startLine || '').trim().toLowerCase()
            ].join('|')
            : null;

        const existing = transactionKey
            ? transactionMap.get(transactionKey)
            : null;

        if (existing) {
            existing.retransmissionCount++;
            existing.packetIds.push(message.id);
            if (message.packetTime) existing.packetTimes.push(message.packetTime);
            continue;
        }

        if (transactionKey) transactionMap.set(transactionKey, message);
        groupedMessages.push(message);
    }

    return {
        participants,
        messages: groupedMessages,
        packetCount: messages.length,
        firstPacketTime: messages[0]?.packetTime || null,
        lastPacketTime: messages[messages.length - 1]?.packetTime || null,
        minWidth: Math.max(950, participants.length * 230),
        rtcpCount: (Array.isArray(rows) ? rows : []).filter(
            packet => String(packet.record_type || '').toLowerCase() === 'rtcp'
        ).length
    };
}

async function loadCapturePageData(req) {
    const t = tenantId(req);
    const timezone = String(req.effectiveTenant?.timezone || 'UTC');

    const [trunks, agents, sessions, defaultTime] = await Promise.all([
        pool.query(
            `SELECT id, name
               FROM trunks
              WHERE tenant_id = $1
                AND is_active = TRUE
                AND provisioning_status = 'provisioned'
                AND wazo_endpoint_uuid IS NOT NULL
              ORDER BY name`,
            [t]
        ),
        pool.query(
            `SELECT id, agent_number, extension
               FROM agents
              WHERE tenant_id = $1
                AND is_active = TRUE
              ORDER BY agent_number NULLS LAST, extension`,
            [t]
        ),
        pool.query(
            `SELECT s.id, s.capture_scope, s.capture_mode,
                    s.capture_profile, s.status, s.timezone,
                    s.scheduled_start_at, s.scheduled_stop_at,
                    s.actual_start_at, s.actual_stop_at,
                    s.max_duration_seconds, s.max_storage_bytes,
                    s.retention_days, s.bytes_written,
                    s.packets_received, s.packets_persisted,
                    s.packets_rejected, s.stop_reason, s.last_error,
                    s.created_at, tr.name AS trunk_name,
                    ag.agent_number,
                    (SELECT COUNT(*)::int
                       FROM call_intelligence_packets p
                      WHERE p.tenant_id = s.tenant_id
                        AND p.session_id = s.id) AS packet_count,
                    (SELECT COUNT(*)::int
                       FROM call_intelligence_ami_events e
                      WHERE e.tenant_id = s.tenant_id
                        AND e.session_id = s.id) AS ami_event_count,
                    (SELECT COUNT(*)::int
                       FROM call_intelligence_call_legs l
                      WHERE l.tenant_id = s.tenant_id
                        AND l.session_id = s.id) AS leg_count
               FROM call_intelligence_capture_sessions s
               LEFT JOIN trunks tr
                 ON tr.tenant_id = s.tenant_id
                AND tr.id = s.trunk_id
               LEFT JOIN agents ag
                 ON ag.tenant_id = s.tenant_id
                AND ag.id = s.agent_id
              WHERE s.tenant_id = $1
              ORDER BY s.created_at DESC
              LIMIT 50`,
            [t]
        ),
        pool.query(
            `SELECT
                to_char(
                    (NOW() AT TIME ZONE $1) + interval '10 minutes',
                    'YYYY-MM-DD"T"HH24:MI'
                ) AS local_start,
                to_char(
                    (NOW() AT TIME ZONE $1) + interval '20 minutes',
                    'YYYY-MM-DD"T"HH24:MI'
                ) AS local_stop`,
            [timezone]
        )
    ]);

    return {
        trunks: trunks.rows,
        agents: agents.rows,
        captureSessions: sessions.rows,
        defaultScheduledStart: defaultTime.rows[0]?.local_start || '',
        defaultScheduledStop: defaultTime.rows[0]?.local_stop || '',
        timezone
    };
}

async function audit(req, action, session, extra = {}) {
    try {
        await writeAuditLog(
            tenantId(req),
            req.session?.user?.id || null,
            action,
            'call_intelligence_capture_session',
            session.id,
            null,
            {
                capture_scope: session.capture_scope,
                capture_mode: session.capture_mode,
                status: session.status,
                ...extra
            },
            req.ip
        );
    } catch (error) {
        console.error(
            '[call-intelligence] Audit write failed:',
            error.message
        );
    }
}

/*
 * Capture management
 * All reads and writes are constrained by the effective tenant.
 */

router.post('/sessions', async (req, res) => {
    const t = tenantId(req);

    if (!t) return res.status(403).send('Tenant context unavailable.');
    if (!validCsrf(req)) return res.status(403).send('Invalid form token. Reload the page and try again.');

    const mode = String(req.body.capture_mode || '');
    const scope = String(req.body.capture_scope || '');
    const profile = String(req.body.capture_profile || 'sip_rtcp');

    const durationMinutes = Number(req.body.duration_minutes);
    const storageMb = Number(req.body.storage_mb);
    const retentionDays = Number(req.body.retention_days);

    const selectedTrunk = String(req.body.trunk_id || '').trim();
    const selectedAgent = String(req.body.agent_id || '').trim();
    const localStart = String(req.body.scheduled_start_at || '').trim();
    const localStop = String(req.body.scheduled_stop_at || '').trim();

    if (!['live', 'scheduled'].includes(mode)) {
        flash(req, 'error', 'Choose Live or Scheduled capture.');
        return redirectIndex(res);
    }

    if (!['tenant', 'trunk', 'agent'].includes(scope)) {
        flash(req, 'error', 'Choose a valid capture scope.');
        return redirectIndex(res);
    }

    if (!['sip', 'sip_rtcp'].includes(profile)) {
        flash(req, 'error', 'Only SIP and SIP plus RTCP profiles are currently supported.');
        return redirectIndex(res);
    }

    if (mode === 'live' && (
        !Number.isInteger(durationMinutes) ||
        durationMinutes < 1 || durationMinutes > 240
    )) {
        flash(req, 'error', 'Live capture duration must be between 1 and 240 minutes.');
        return redirectIndex(res);
    }

    if (!Number.isInteger(storageMb) ||
        storageMb < 1 || storageMb > 2048) {
        flash(req, 'error', 'Storage limit must be between 1 and 2048 MB.');
        return redirectIndex(res);
    }

    if (!Number.isInteger(retentionDays) ||
        retentionDays < 1 || retentionDays > 30) {
        flash(req, 'error', 'Retention must be between 1 and 30 days.');
        return redirectIndex(res);
    }

    if (scope === 'trunk' && !UUID_RE.test(selectedTrunk)) {
        flash(req, 'error', 'Select a valid trunk for trunk capture.');
        return redirectIndex(res);
    }

    if (scope === 'agent' && !UUID_RE.test(selectedAgent)) {
        flash(req, 'error', 'Select a valid agent for agent capture.');
        return redirectIndex(res);
    }

    if (
        scope === 'agent' &&
        selectedTrunk &&
        !UUID_RE.test(selectedTrunk)
    ) {
        flash(req, 'error', 'Invalid optional trunk selection.');
        return redirectIndex(res);
    }

    if (mode === 'scheduled' && (
        !LOCAL_DATETIME_RE.test(localStart) ||
        !LOCAL_DATETIME_RE.test(localStop)
    )) {
        flash(req, 'error', 'Enter both scheduled start and stop date/time.');
        return redirectIndex(res);
    }

    const trunkId = scope === 'trunk'
        ? selectedTrunk
        : scope === 'agent' && selectedTrunk
            ? selectedTrunk
            : null;

    const agentId = scope === 'agent' ? selectedAgent : null;
    let durationSeconds = mode === 'live' ? durationMinutes * 60 : 0;
    const storageBytes = storageMb * 1024 * 1024;

    const client = await pool.connect();
    let created = null;

    try {
        await client.query('BEGIN');

        const tenantResult = await client.query(
            `SELECT id, is_active, timezone
               FROM tenants
              WHERE id = $1
              FOR SHARE`,
            [t]
        );

        if (!tenantResult.rowCount ||
            tenantResult.rows[0].is_active !== true) {
            throw new Error('The selected tenant is not active.');
        }

        const timezone = String(tenantResult.rows[0].timezone || 'UTC');

        const timezoneResult = await client.query(
            `SELECT name
               FROM pg_timezone_names
              WHERE name = $1
              LIMIT 1`,
            [timezone]
        );

        if (!timezoneResult.rowCount) {
            throw new Error('The tenant timezone is not a valid IANA timezone.');
        }

        if (agentId) {
            const agentResult = await client.query(
                `SELECT id
                   FROM agents
                  WHERE tenant_id = $1
                    AND id = $2
                    AND is_active = TRUE
                  FOR SHARE`,
                [t, agentId]
            );

            if (!agentResult.rowCount) {
                throw new Error('Selected agent is not active in this tenant.');
            }
        }

        const trunkResult = await client.query(
            `SELECT id
               FROM trunks
              WHERE tenant_id = $1
                AND is_active = TRUE
                AND provisioning_status = 'provisioned'
                AND wazo_endpoint_uuid IS NOT NULL
                AND ($2::uuid IS NULL OR id = $2)
              ORDER BY name
              LIMIT 1
              FOR SHARE`,
            [t, trunkId]
        );

        if (!trunkResult.rowCount) {
            throw new Error(
                scope === 'trunk'
                    ? 'Selected trunk is not active and provisioned.'
                    : 'This tenant has no active, provisioned SIP trunk.'
            );
        }

        let startResult;

        if (mode === 'live') {
            startResult = await client.query(
                `SELECT
                    NOW() AS start_at,
                    NOW() + make_interval(secs => $1) AS stop_at,
                    NOW() AS now_at`,
                [durationMinutes * 60]
            );
        } else {
            startResult = await client.query(
                `SELECT
                    ($1::timestamp without time zone AT TIME ZONE $3) AS start_at,
                    ($2::timestamp without time zone AT TIME ZONE $3) AS stop_at,
                    NOW() AS now_at`,
                [localStart, localStop, timezone]
            );
        }

        const startsAt = startResult.rows[0].start_at;
        const stopsAt = startResult.rows[0].stop_at;
        const nowAt = startResult.rows[0].now_at;

        const startMillis = new Date(startsAt).getTime();
        const stopMillis = new Date(stopsAt).getTime();
        const nowMillis = new Date(nowAt).getTime();

        if (!Number.isFinite(startMillis) ||
            startMillis <= nowMillis + (mode === 'scheduled' ? 10000 : -1000)) {
            throw new Error(
                mode === 'scheduled'
                    ? 'Scheduled capture must start at least 10 seconds in the future.'
                    : 'Could not calculate the live capture start time.'
            );
        }

        if (!Number.isFinite(stopMillis) || stopMillis <= startMillis) {
            throw new Error('Capture stop time must be later than its start time.');
        }

        durationSeconds = Math.ceil((stopMillis - startMillis) / 1000);

        if (durationSeconds < 10 || durationSeconds > 14400) {
            throw new Error('Capture window must be between 10 seconds and 4 hours.');
        }

        const insert = await client.query(
            `INSERT INTO call_intelligence_capture_sessions (
                tenant_id, trunk_id, agent_id, requested_by,
                capture_mode, capture_profile, status, timezone,
                scheduled_start_at, scheduled_stop_at,
                max_duration_seconds, max_storage_bytes,
                retention_days, capture_scope
            ) VALUES (
                $1,$2,$3,$4,
                $5,$6,$7,$8,
                $9,$10,
                $11,$12,$13,$14
            )
            RETURNING id, tenant_id, trunk_id, agent_id,
                      capture_mode, capture_profile, status,
                      capture_scope`,
            [
                t,
                trunkId,
                agentId,
                req.session?.user?.id || null,
                mode,
                profile,
                mode === 'live' ? 'starting' : 'scheduled',
                timezone,
                startsAt,
                stopsAt,
                durationSeconds,
                storageBytes,
                retentionDays,
                scope
            ]
        );

        created = insert.rows[0];

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        flash(req, 'error', error.message || 'Could not create capture session.');
        return redirectIndex(res);
    } finally {
        client.release();
    }

    await audit(req, 'CALL_INTELLIGENCE_CAPTURE_CREATED', created, {
        duration_seconds: durationSeconds,
        storage_bytes: storageBytes,
        retention_days: retentionDays
    });

    flash(
        req,
        'success',
        mode === 'live'
            ? 'Live capture requested. The worker will validate and start it.'
            : 'Scheduled capture created.'
    );

    return res.redirect(`/admin/call-intelligence/sessions/${created.id}`);
});

router.post('/sessions/:id/stop', async (req, res) => {
    const t = tenantId(req);
    const id = String(req.params.id || '');

    if (!t) return res.status(403).send('Tenant context unavailable.');
    if (!UUID_RE.test(id)) return res.status(400).send('Invalid session ID.');
    if (!validCsrf(req)) return res.status(403).send('Invalid form token.');

    const result = await pool.query(
        `UPDATE call_intelligence_capture_sessions
            SET status = 'stopping',
                stop_reason = 'ADMIN_STOP_REQUEST',
                updated_at = NOW()
          WHERE tenant_id = $1
            AND id = $2
            AND status = 'active'
        RETURNING id, capture_scope, capture_mode, status`,
        [t, id]
    );

    if (!result.rowCount) {
        flash(req, 'error', 'Active capture session was not found. It may already be stopping or completed.');
        return redirectIndex(res);
    }

    await audit(req, 'CALL_INTELLIGENCE_CAPTURE_STOPPED', result.rows[0]);
    flash(req, 'success', 'Stop requested. The worker will close the capture safely.');
    return redirectIndex(res);
});

router.post('/sessions/:id/cancel', async (req, res) => {
    const t = tenantId(req);
    const id = String(req.params.id || '');

    if (!t) return res.status(403).send('Tenant context unavailable.');
    if (!UUID_RE.test(id)) return res.status(400).send('Invalid session ID.');
    if (!validCsrf(req)) return res.status(403).send('Invalid form token.');

    const result = await pool.query(
        `UPDATE call_intelligence_capture_sessions
            SET status = 'cancelled',
                actual_stop_at = CASE
                    WHEN actual_start_at IS NOT NULL THEN NOW()
                    ELSE NULL
                END,
                stop_reason = 'ADMIN_CANCELLED',
                updated_at = NOW()
          WHERE tenant_id = $1
            AND id = $2
            AND status IN ('scheduled','starting')
        RETURNING id, capture_scope, capture_mode, status`,
        [t, id]
    );

    if (!result.rowCount) {
        flash(req, 'error', 'Scheduled or starting capture was not found. Active sessions must be stopped instead.');
        return redirectIndex(res);
    }

    await audit(req, 'CALL_INTELLIGENCE_CAPTURE_CANCELLED', result.rows[0]);
    flash(req, 'success', 'Capture session cancelled.');
    return redirectIndex(res);
});

/* CALL_INTELLIGENCE_LIVE_DATA_API_V1
 * Tenant-scoped incremental packet feed for the live Call Intelligence view.
 */
router.get('/sessions/:id/live-data', async (req, res, next) => {
    try {
        const t = tenantId(req);
        const id = String(req.params.id || '');
        const afterId = String(req.query.after_id || '0');

        if (!t) return res.status(403).json({ error: 'Tenant context unavailable.' });
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid session ID.' });
        if (!/^\d{1,20}$/.test(afterId)) {
            return res.status(400).json({ error: 'Invalid packet cursor.' });
        }

        const sessionResult = await pool.query(
            `SELECT id, status, capture_mode, capture_profile, capture_scope,
                    packets_received, packets_persisted, packets_rejected,
                    bytes_written, max_storage_bytes, actual_start_at,
                    actual_stop_at, scheduled_stop_at, last_error
               FROM call_intelligence_capture_sessions
              WHERE tenant_id = $1 AND id = $2
              LIMIT 1`,
            [t, id]
        );
        if (!sessionResult.rowCount) {
            return res.status(404).json({ error: 'Capture session not found.' });
        }

        const packetColumns = `
            SELECT p.id::text AS id,
                   p.app_call_id::text AS app_call_id,
                   p.packet_time, p.received_at, p.record_type,
                   p.correlation_id, p.call_id, p.channel_name,
                   p.source_ip::text AS source_ip,
                   p.destination_ip::text AS destination_ip,
                   p.source_port, p.destination_port, p.transport_protocol,
                   p.sip_method, p.sip_status_code, p.sip_reason, p.sip_cseq,
                   p.sip_request_uri, p.sip_from_uri, p.sip_to_uri,
                   p.channel_role,
                   octet_length(p.payload)::int AS payload_bytes,
                   CASE WHEN p.record_type = 'sip'
                        THEN encode(substring(p.payload FROM 1 FOR 12000), 'base64')
                        ELSE NULL END AS payload_base64,
                   CASE WHEN p.record_type = 'sip'
                        THEN octet_length(p.payload) > 12000
                        ELSE FALSE END AS payload_truncated
              FROM call_intelligence_packets p
             WHERE p.tenant_id = $1 AND p.session_id = $2`;

        let packetResult;
        if (afterId === '0') {
            packetResult = await pool.query(
                `${packetColumns} ORDER BY p.id DESC LIMIT 3000`, [t, id]
            );
            packetResult.rows.reverse();
        } else {
            packetResult = await pool.query(
                `${packetColumns} AND p.id > $3::bigint ORDER BY p.id ASC LIMIT 500`,
                [t, id, afterId]
            );
        }

        const legsResult = await pool.query(
            `SELECT app_call_id::text AS app_call_id, channel_role,
                    endpoint_name, direction, caller_id_number,
                    connected_line_number, started_at, answered_at, ended_at
               FROM call_intelligence_call_legs
              WHERE tenant_id = $1 AND session_id = $2
                AND app_call_id IS NOT NULL
              ORDER BY started_at NULLS LAST, id
              LIMIT 1000`,
            [t, id]
        );

        let nextAfterId = afterId;
        for (const packet of packetResult.rows) {
            if (/^\d+$/.test(String(packet.id))) {
                try {
                    if (BigInt(packet.id) > BigInt(nextAfterId)) nextAfterId = String(packet.id);
                } catch (_) { /* retain the last valid cursor */ }
            }
        }

        res.set('Cache-Control', 'no-store');
        return res.json({
            session: sessionResult.rows[0],
            packets: packetResult.rows,
            legs: legsResult.rows,
            next_after_id: nextAfterId
        });
    } catch (error) {
        next(error);
    }
});

/*
 * Capture session details: only rows owned by the effective tenant.
 */
router.get('/sessions/:id', async (req, res, next) => {
    try {
        const t = tenantId(req);
        const id = String(req.params.id || '');

        if (!t) return res.status(403).send('Tenant context unavailable.');
        if (!UUID_RE.test(id)) return res.status(400).send('Invalid session ID.');

        const sessionResult = await pool.query(
            `SELECT s.*, tr.name AS trunk_name,
                    ag.agent_number
               FROM call_intelligence_capture_sessions s
               LEFT JOIN trunks tr
                 ON tr.tenant_id = s.tenant_id
                AND tr.id = s.trunk_id
               LEFT JOIN agents ag
                 ON ag.tenant_id = s.tenant_id
                AND ag.id = s.agent_id
              WHERE s.tenant_id = $1
                AND s.id = $2
              LIMIT 1`,
            [t, id]
        );

        if (!sessionResult.rowCount) {
            return res.status(404).send('Capture session not found for this tenant.');
        }

        const [legs, packets, amiEvents, artifacts] = await Promise.all([
            pool.query(
                `SELECT l.*, tr.name AS trunk_name,
                        ag.agent_number
                   FROM call_intelligence_call_legs l
                   LEFT JOIN trunks tr
                     ON tr.tenant_id = l.tenant_id
                    AND tr.id = l.trunk_id
                   LEFT JOIN agents ag
                     ON ag.tenant_id = l.tenant_id
                    AND ag.id = l.agent_id
                  WHERE l.tenant_id = $1
                    AND l.session_id = $2
                  ORDER BY COALESCE(l.started_at, l.created_at), l.id
                  LIMIT 1000`,
                [t, id]
            ),
            pool.query(
                `SELECT id, packet_time, received_at, record_type,
                        correlation_id, call_id, channel_name,
                        source_ip::text AS source_ip,
                        destination_ip::text AS destination_ip,
                        source_port, destination_port, transport_protocol,
                        sip_method, sip_status_code, sip_reason, sip_cseq,
                        sip_request_uri, sip_from_uri, sip_to_uri,
                        channel_role, parsed_json
                   FROM call_intelligence_packets
                  WHERE tenant_id = $1
                    AND session_id = $2
                  ORDER BY COALESCE(packet_time, received_at), id
                  LIMIT 2000`,
                [t, id]
            ),
            pool.query(
                `SELECT id, event_time, event_type, channel_name,
                        peer_channel, unique_id, linked_id, context_name,
                        extension, caller_id_number, connected_line_number,
                        cause, cause_text, digit, duration_ms, direction,
                        channel_role, payload_json
                   FROM call_intelligence_ami_events
                  WHERE tenant_id = $1
                    AND session_id = $2
                  ORDER BY event_time, id
                  LIMIT 3000`,
                [t, id]
            ),
            pool.query(
                `SELECT id, artifact_type, file_name, content_type,
                        byte_size, sha256, expires_at, created_at
                   FROM call_intelligence_artifacts
                  WHERE tenant_id = $1
                    AND session_id = $2
                  ORDER BY created_at DESC`,
                [t, id]
            )
        ]);

        res.render('admin/call_intelligence', {
            pageTitle: 'Admin — Capture Session',
            calls: [],
            total: 0,
            from: '',
            to: '',
            q: '',
            selectedCall: null,
            events: [],
            selectedSession: sessionResult.rows[0],
            captureLegs: legs.rows,
            capturePackets: packets.rows,
            captureAmiEvents: amiEvents.rows,
            sipLadder: {
                participants: [], messages: [], packetCount: 0,
                firstPacketTime: null, lastPacketTime: null, rtcpCount: 0
            },
            artifacts: artifacts.rows,
            captureSessions: [],
            trunks: [],
            agents: [],
            timezone: req.effectiveTenant?.timezone || 'UTC',
            defaultScheduledStart: '',
            defaultScheduledStop: '',
            csrfToken: csrfToken(req),
            notice: consumeFlash(req)
        });
    } catch (error) {
        next(error);
    }
});

/*
 * Existing call search, extended with observed capture data.
 */
router.get('/', async (req, res, next) => {
    try {
        const t = tenantId(req);
        if (!t) return res.status(403).send('Tenant context unavailable.');

        const today = new Date().toISOString().slice(0, 10);
        const defaultFrom = new Date(Date.now() - 29 * 86400000)
            .toISOString().slice(0, 10);

        const from = validDate(String(req.query.from || ''))
            ? String(req.query.from) : defaultFrom;
        const to = validDate(String(req.query.to || ''))
            ? String(req.query.to) : today;
        const q = String(req.query.q || '').trim().slice(0, 120);

        if (from > to) {
            return res.status(400).send('The From date must not be after the To date.');
        }

        const values = [t, from, to];
        const where = [
            'c.tenant_id = $1',
            "COALESCE(c.wazo_call_id, '') <> 'SYNTHETIC_DEMO_ONLY'",
            'c.start_time >= $2::date',
            "c.start_time < ($3::date + interval '1 day')"
        ];

        if (q) {
            values.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
            const n = values.length;

            where.push(`(
                COALESCE(c.wazo_call_id, '') ILIKE $${n} ESCAPE '\\'
                OR c.id::text ILIKE $${n} ESCAPE '\\'
                OR COALESCE(c.from_number, '') ILIKE $${n} ESCAPE '\\'
                OR COALESCE(c.to_number, '') ILIKE $${n} ESCAPE '\\'
                OR COALESCE(u.full_name, '') ILIKE $${n} ESCAPE '\\'
                OR COALESCE(u.username, '') ILIKE $${n} ESCAPE '\\'
                OR COALESCE(ag.agent_number, '') ILIKE $${n} ESCAPE '\\'
            )`);
        }

        const whereSql = where.join(' AND ');

        const [countResult, result, uiData] = await Promise.all([
            pool.query(
                `SELECT COUNT(*)::int AS total
                   FROM calls c
                   LEFT JOIN agents ag
                     ON ag.id = c.agent_id AND ag.tenant_id = c.tenant_id
                   LEFT JOIN users u
                     ON u.id = ag.user_id AND u.tenant_id = ag.tenant_id
                  WHERE ${whereSql}`,
                values
            ),
            pool.query(
                `SELECT c.id, c.wazo_call_id, c.direction::text AS direction,
                        c.status::text AS status, c.from_number, c.to_number,
                        c.start_time, c.ring_time, c.answer_time, c.end_time,
                        c.ring_seconds, c.wait_seconds, c.talk_seconds,
                        c.hold_seconds, c.hangup_cause, c.hangup_by,
                        c.is_transfer, c.transfer_to_type,
                        COALESCE(NULLIF(u.full_name, ''),
                                 NULLIF(u.username, ''),
                                 ag.agent_number,
                                 '—') AS agent_name,
                        (SELECT COUNT(*)::int
                           FROM call_events e
                          WHERE e.tenant_id = c.tenant_id
                            AND e.call_id = c.id
                            AND e.event_time >= (c.start_time - interval '5 minutes')
                            AND e.event_time <= (COALESCE(c.end_time, now()) + interval '5 minutes')
                        ) AS event_count
                   FROM calls c
                   LEFT JOIN agents ag
                     ON ag.id = c.agent_id AND ag.tenant_id = c.tenant_id
                   LEFT JOIN users u
                     ON u.id = ag.user_id AND u.tenant_id = ag.tenant_id
                  WHERE ${whereSql}
                  ORDER BY c.start_time DESC
                  LIMIT 100`,
                values
            ),
            loadCapturePageData(req)
        ]);

        res.render('admin/call_intelligence', {
            pageTitle: 'Admin — Call Intelligence',
            calls: result.rows,
            total: countResult.rows[0].total,
            from, to, q,
            selectedCall: null,
            selectedSession: null,
            events: [],
            captureLegs: [],
            capturePackets: [],
            captureAmiEvents: [],
            artifacts: [],
            ...uiData,
            sipLadder: {
                participants: [], messages: [], packetCount: 0,
                firstPacketTime: null, lastPacketTime: null, rtcpCount: 0
            },
            csrfToken: csrfToken(req),
            notice: consumeFlash(req)
        });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const t = tenantId(req);
        const id = String(req.params.id || '');

        if (!t) return res.status(403).send('Tenant context unavailable.');
        if (!UUID_RE.test(id)) return res.status(400).send('Invalid call ID.');

        const callResult = await pool.query(
            `SELECT c.id, c.wazo_call_id, c.direction::text AS direction,
                    c.status::text AS status, c.from_number, c.to_number,
                    c.start_time, c.ring_time, c.answer_time, c.end_time,
                    c.ring_seconds, c.wait_seconds, c.talk_seconds,
                    c.hold_seconds, c.acw_seconds, c.hangup_cause, c.hangup_by,
                    c.is_transfer, c.transfer_to_type, c.transfer_to_id,
                    COALESCE(NULLIF(u.full_name, ''),
                             NULLIF(u.username, ''),
                             ag.agent_number,
                             '—') AS agent_name,
                    ag.agent_number
               FROM calls c
               LEFT JOIN agents ag
                 ON ag.id = c.agent_id AND ag.tenant_id = c.tenant_id
               LEFT JOIN users u
                 ON u.id = ag.user_id AND u.tenant_id = ag.tenant_id
              WHERE c.tenant_id = $1
                AND c.id = $2
                AND COALESCE(c.wazo_call_id, '') <> 'SYNTHETIC_DEMO_ONLY'
              LIMIT 1`,
            [t, id]
        );

        if (!callResult.rows.length) {
            return res.status(404).send('Call not found for this tenant.');
        }

        const call = callResult.rows[0];

        const [eventResult, legResult, packetResult, amiResult, celTrace, uiData] =
            await Promise.all([
                pool.query(
                    `SELECT e.id, e.event_type, e.event_time, e.agent_id,
                            e.payload_json,
                            COALESCE(NULLIF(u.full_name, ''),
                                     NULLIF(u.username, ''),
                                     ag.agent_number,
                                     '—') AS event_agent_name
                       FROM call_events e
                       LEFT JOIN agents ag
                         ON ag.id = e.agent_id AND ag.tenant_id = e.tenant_id
                       LEFT JOIN users u
                         ON u.id = ag.user_id AND u.tenant_id = ag.tenant_id
                      WHERE e.tenant_id = $1
                        AND e.call_id = $2
                        AND e.event_time >= ($3::timestamptz - interval '5 minutes')
                        AND e.event_time <= (COALESCE($4::timestamptz, now()) + interval '5 minutes')
                      ORDER BY e.event_time ASC, e.id ASC`,
                    [t, id, call.start_time, call.end_time]
                ),
                pool.query(
                    `SELECT l.*, tr.name AS trunk_name, ag.agent_number
                       FROM call_intelligence_call_legs l
                       LEFT JOIN trunks tr
                         ON tr.tenant_id = l.tenant_id AND tr.id = l.trunk_id
                       LEFT JOIN agents ag
                         ON ag.tenant_id = l.tenant_id AND ag.id = l.agent_id
                      WHERE l.tenant_id = $1 AND l.app_call_id = $2
                      ORDER BY COALESCE(l.started_at, l.created_at), l.id`,
                    [t, id]
                ),
                pool.query(
                    `SELECT id, packet_time, received_at, record_type,
                            correlation_id, call_id, channel_name,
                            source_ip::text AS source_ip,
                            destination_ip::text AS destination_ip,
                            source_port, destination_port, transport_protocol,
                            sip_method, sip_status_code, sip_reason, sip_cseq,
                            sip_request_uri, sip_from_uri, sip_to_uri,
                            channel_role, parsed_json,
                            CASE WHEN record_type = 'sip'
                                 THEN encode(
                                     substring(payload FROM 1 FOR 12000),
                                     'base64'
                                 )
                                 ELSE NULL
                            END AS payload_base64,
                            CASE WHEN record_type = 'sip'
                                 THEN octet_length(payload) > 12000
                                 ELSE FALSE
                            END AS payload_truncated
                       FROM call_intelligence_packets
                      WHERE tenant_id = $1 AND app_call_id = $2
                      ORDER BY COALESCE(packet_time, received_at), id
                      LIMIT 500`,
                    [t, id]
                ),
                pool.query(
                    `SELECT id, event_time, event_type, channel_name,
                            peer_channel, unique_id, linked_id, digit,
                            duration_ms, cause, cause_text, channel_role
                       FROM call_intelligence_ami_events
                      WHERE tenant_id = $1 AND app_call_id = $2
                      ORDER BY event_time, id
                      LIMIT 2000`,
                    [t, id]
                ),
                getCallTrace({
                    tenantId: t,
                    wazoCallId: call.wazo_call_id,
                    fallbackDirection: call.direction,
                    toNumber: call.to_number
                }),
                loadCapturePageData(req)
            ]);


        // CEL has already verified these exact full PJSIP channel names
        // against the effective tenant. Use them to retrieve packets for
        // both call legs, including packets whose app_call_id is NULL.
        const verifiedChannels = celTrace && celTrace.available
            ? [...new Set(
                celTrace.legs.flatMap(leg => [
                    ...(Array.isArray(leg.channelNames) ? leg.channelNames : []),
                    leg.channelName
                ])
                .map(value => String(value || '').trim())
                .filter(Boolean)
            )]
            : [];

        let detailPackets = packetResult.rows;
        let detailAmiEvents = amiResult.rows;

        if (verifiedChannels.length) {
            const [correlatedPackets, correlatedAmi] = await Promise.all([
                pool.query(
                    `SELECT id, packet_time, received_at, record_type,
                            correlation_id, call_id, channel_name,
                            source_ip::text AS source_ip,
                            destination_ip::text AS destination_ip,
                            source_port, destination_port, transport_protocol,
                            sip_method, sip_status_code, sip_reason, sip_cseq,
                            sip_request_uri, sip_from_uri, sip_to_uri,
                            channel_role, parsed_json,
                            CASE WHEN record_type = 'sip'
                                 THEN encode(
                                     substring(payload FROM 1 FOR 12000),
                                     'base64'
                                 )
                                 ELSE NULL
                            END AS payload_base64,
                            CASE WHEN record_type = 'sip'
                                 THEN octet_length(payload) > 12000
                                 ELSE FALSE
                            END AS payload_truncated
                       FROM call_intelligence_packets
                      WHERE tenant_id = $1
                        AND channel_name = ANY($2::text[])
                      ORDER BY COALESCE(packet_time, received_at), id
                      LIMIT 2000`,
                    [t, verifiedChannels]
                ),
                pool.query(
                    `SELECT id, event_time, event_type, channel_name,
                            peer_channel, unique_id, linked_id, digit,
                            duration_ms, cause, cause_text, channel_role
                       FROM call_intelligence_ami_events
                      WHERE tenant_id = $1
                        AND (
                            channel_name = ANY($2::text[])
                            OR peer_channel = ANY($2::text[])
                        )
                      ORDER BY event_time, id
                      LIMIT 3000`,
                    [t, verifiedChannels]
                )
            ]);

            const packetMap = new Map();
            for (const row of [...packetResult.rows, ...correlatedPackets.rows]) {
                packetMap.set(String(row.id), row);
            }

            detailPackets = [...packetMap.values()].sort((a, b) =>
                new Date(a.packet_time || a.received_at || 0) -
                new Date(b.packet_time || b.received_at || 0) ||
                Number(a.id) - Number(b.id)
            );

            const amiMap = new Map();
            for (const row of [...amiResult.rows, ...correlatedAmi.rows]) {
                amiMap.set(String(row.id), row);
            }

            detailAmiEvents = [...amiMap.values()].sort((a, b) =>
                new Date(a.event_time || 0) - new Date(b.event_time || 0) ||
                Number(a.id) - Number(b.id)
            );
        }

        const sipLadder = buildSipLadder(detailPackets);

        res.render('admin/call_intelligence', {
            pageTitle: 'Admin — Call Trace',
            calls: [],
            total: 0,
            from: '',
            to: '',
            q: '',
            selectedCall: call,
            selectedSession: null,
            events: eventResult.rows,
            captureLegs: legResult.rows,
            capturePackets: detailPackets,
            captureAmiEvents: detailAmiEvents,
            sipLadder,
            celTrace,
            artifacts: [],
            ...uiData,
            csrfToken: csrfToken(req),
            notice: consumeFlash(req)
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
