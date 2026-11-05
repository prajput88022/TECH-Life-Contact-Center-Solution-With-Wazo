/**
 * Generic report export handler -- CSV and XLSX. Calls the SAME
 * Reporting Services as the on-screen pages, so an exported file always
 * matches what's shown on screen. XLSX uses ExcelJS (real npm package,
 * streamed to the response -- no temp files needed).
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../src/db');
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');
const { requireAuth, requireRole } = require('../src/auth');
const agentReportService = require('../src/services/agentReportService');
const queueReportService = require('../src/services/queueReportService');
const didReportService = require('../src/services/didReportService');
const campaignReportService = require('../src/services/campaignReportService');
const callRecordService = require('../src/services/callRecordService');
const customMisReportService = require('../src/services/customMisReportService');
const { requireFeature, tenantHasFeatures } = require('../src/tenantFeatures');

router.use(requireAuth);
router.use(requireFeature('mis_reports'));
router.use('/agent-hourly', requireFeature('voice'));
router.use('/agent-performance', requireFeature('voice'));
router.use('/omnichannel', requireFeature('omnichannel'));
router.use('/list-wise', requireFeature('list_management'));
router.use('/dispositions', requireFeature('voice'));
router.use('/dispositions', requireFeature('dispositions'));
router.use('/queue', requireFeature('queues'));
router.use('/did', requireFeature('inbound'));
router.use('/campaign', requireFeature('campaigns'));
router.use('/calls', requireFeature('voice'));

function formatCell(value) {
    if (value instanceof Date) {
        return value.toISOString().replace('T', ' ').slice(0, 19);
    }
    return value;
}

async function sendExport(res, header, rows, filenameBase, format) {
    const formattedRows = rows.map((row) => row.map(formatCell));
    const filename = `${filenameBase}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (format === 'xlsx') {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Report');
        sheet.addRow(header).font = { bold: true };
        formattedRows.forEach((r) => sheet.addRow(r));
        sheet.columns.forEach((col) => { col.width = 18; });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
        return;
    }
    const csv = stringify([header, ...formattedRows]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    res.send(csv);
}

router.get('/agent-hourly', requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']), async (req, res) => {
    const u = req.session.user;
    const { agent_id, from, to, format } = req.query;
    const data = await agentReportService.hourly(u.tenantId, agent_id || '', from, to);
    const header = ['Hour', 'Login (s)', 'Available (s)', 'Break (s)', 'ACW (s)', 'Offered', 'Answered', 'Outbound', 'Talk (s)', 'Hold (s)', 'Occupancy %', 'Productivity %'];
    const rows = data.map((r) => [r.hour_bucket, r.login_seconds, r.available_seconds, r.break_seconds, r.acw_seconds,
        r.calls_offered, r.calls_answered, r.outbound_calls, r.talk_seconds, r.hold_seconds,
        Math.round(r.occupancy * 1000) / 10, Math.round(r.productivity * 1000) / 10]);
    await sendExport(res, header, rows, 'agent_hourly', format);
});

router.get('/queue', requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']), async (req, res) => {
    const { from, to, format } = req.query;
    const data = await queueReportService.summary(req.session.user.tenantId, from, to);
    const header = ['Queue', 'Offered', 'Answered', 'Abandoned', 'Missed', 'Avg Wait (s)', 'Max Wait (s)', 'Service Level %'];
    const rows = data.map((r) => [r.name, r.calls_offered, r.calls_answered, r.calls_abandoned, r.calls_missed,
        r.avg_wait_seconds != null ? Math.round(r.avg_wait_seconds * 10) / 10 : '',
        r.max_wait_seconds ?? '', r.service_level != null ? Math.round(r.service_level * 1000) / 10 : '']);
    await sendExport(res, header, rows, 'queue_report', format);
});

router.get('/did', requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']), async (req, res) => {
    const { from, to, format } = req.query;
    const data = await didReportService.summary(req.session.user.tenantId, from, to);
    const header = ['DID', 'Description', 'Campaign', 'Received', 'Answered', 'Abandoned', 'Missed', 'Avg Wait (s)', 'Total Talk (s)'];
    const rows = data.map((r) => [r.did_number, r.description, r.campaign_name, r.calls_received, r.calls_answered,
        r.calls_abandoned, r.calls_missed, r.avg_wait_seconds != null ? Math.round(r.avg_wait_seconds * 10) / 10 : '', r.total_talk_seconds ?? '']);
    await sendExport(res, header, rows, 'did_report', format);
});

router.get('/campaign', requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']), async (req, res, next) => {
    try {
        const u = req.session.user;
        const { from, to } = exportDateRange(req);
        const campaignId = String(req.query.campaign_id || '');

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)) {
            return res.status(400).send('A valid campaign_id is required.');
        }

        const summary = await campaignReportService.summary(
            u.tenantId, campaignId, from, to
        );

        const header = [
            'Section', 'Metric', 'Value',
            'Hour', 'Node', 'DTMF', 'Responses'
        ];
        const rows = [];

        for (const [key, value] of Object.entries(summary.voice || {})) {
            rows.push(['Voice', key, value ?? '', '', '', '', '']);
        }

        for (const [key, value] of Object.entries(summary.leads || {})) {
            rows.push(['Leads', key, value ?? '', '', '', '', '']);
        }

        for (const event of summary.by_channel || []) {
            rows.push([
                'Channel Events',
                `${event.channel}: ${event.event_type}`,
                event.total,
                '', '', '', ''
            ]);
        }

        if (summary.campaign.is_robo_campaign) {
            const hourly = await campaignReportService.roboHourly(
                u.tenantId, campaignId, from, to
            );

            for (const item of hourly) {
                rows.push([
                    'Robo Hourly',
                    'Calls attempted',
                    item.calls_attempted,
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Calls connected',
                    item.calls_connected,
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Calls failed',
                    item.calls_failed,
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Calls busy',
                    item.calls_busy,
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Likely hangups',
                    item.likely_hangups,
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Average message seconds',
                    item.avg_message_seconds ?? '',
                    item.hour_bucket, '', '', ''
                ]);
                rows.push([
                    'Robo Hourly',
                    'Survey responses captured',
                    item.survey_responses_captured,
                    item.hour_bucket, '', '', ''
                ]);
            }

            const survey = await campaignReportService.surveyDistribution(
                u.tenantId, campaignId, from, to
            );

            for (const item of survey) {
                rows.push([
                    'Survey Distribution',
                    'DTMF response',
                    '',
                    '',
                    item.node_name,
                    item.response_dtmf ?? '',
                    item.total
                ]);
            }
        }

        await sendExport(res, header, rows, 'campaign_report', req.query.format);
    } catch (err) {
        return next(err);
    }
});

// CDR export: 'context' is 'supervisor' or 'agent' -- decides which
// masking switch applies, via the exact same CallRecordService used by
// the on-screen Call Records / My Calls pages.
router.get('/calls', async (req, res) => {
    const u = req.session.user;
    const context = ['supervisor', 'agent'].includes(req.query.context) ? req.query.context : 'supervisor';
    const allowedRoles = context === 'agent' ? ['agent', 'supervisor', 'admin', 'superadmin'] : ['supervisor', 'admin', 'superadmin'];
    if (!allowedRoles.some((r) => u.roles.includes(r))) {
        return res.status(403).send('Forbidden');
    }

    const { from, to, format } = req.query;
    const filters = { from, to };
    if (context === 'agent') filters.restrict_to_agent_id = u.agentId;

    let allRows = [];
    let page = 1;
    let batch;
    do {
        batch = await callRecordService.search(u.tenantId, context, filters, page, 500);
        allRows = allRows.concat(batch);
        page++;
    } while (batch.length === 500 && page < 50);

    const header = [
        'Tenant', 'Agent', 'Extension', 'Queue', 'Campaign',
        'Call UUID', 'Wazo Call ID', 'Wazo CDR ID',
        'From', 'To', 'Direction', 'Status',
        'Start Time', 'Ring Time', 'Answer Time', 'End Time',
        'Setup Seconds', 'Queue Wait Seconds', 'Ring Seconds',
        'Talk Seconds', 'Hold Seconds', 'ACW Seconds',
        'Hangup Cause', 'Hangup By', 'Disposition',
        'Recording ID', 'Recording Duration Seconds', 'Recording Downloadable'
    ];
    const rows = allRows.map((r) => [
        r.tenant_name, r.agent_name, r.agent_extension, r.queue_name, r.campaign_name,
        r.call_uuid, r.wazo_call_id, r.wazo_cdr_id,
        r.from_number, r.to_number, r.direction, r.status,
        r.start_time, r.ring_time, r.answer_time, r.end_time,
        r.setup_seconds, r.wait_seconds, r.ring_seconds,
        r.talk_seconds, r.hold_seconds, r.acw_seconds,
        r.hangup_cause, r.hangup_by, r.disposition_label,
        r.recording_id, r.recording_duration_seconds, r.recording_downloadable
    ]);
    await sendExport(res, header, rows, `cdr_${context}`, format);
});



// Validate export date parameters before passing them to report services.
function validExportDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
        !Number.isNaN(Date.parse(String(value) + 'T00:00:00Z')) &&
        new Date(String(value) + 'T00:00:00Z').toISOString().slice(0, 10) === String(value);
}

function exportDateRange(req) {
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!validExportDate(from) || !validExportDate(to) || from > to) {
        const err = new Error('Valid from and to dates are required for report exports.');
        err.status = 400;
        throw err;
    }
    return { from, to };
}

router.get('/agent-performance', requireRole(['mis_agent','supervisor','admin','superadmin']), async (req, res, next) => {
    try {
        const u = req.session.user;
        const { from, to } = exportDateRange(req);
        const agentId = String(req.query.agent_id || '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
            return res.status(400).send('A valid agent_id is required.');
        }

        const owner = await pool.query(
            'SELECT 1 FROM agents WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE',
            [agentId, u.tenantId]
        );
        if (!owner.rowCount) return res.status(400).send('Agent does not belong to this tenant.');

        const includeOmni = await tenantHasFeatures(u.tenantId, ['omnichannel']);
        const data = await agentReportService.performance(
            u.tenantId, agentId, from, to, { includeOmni }
        );
        const header = [
            'Metric','Value'
        ];
        const rows = [
            ['Inbound Calls',data.voice.inbound_calls],
            ['Outbound Calls',data.voice.outbound_calls],
            ['Answered Calls',data.voice.answered_calls],
            ['Missed Calls',data.voice.missed_calls],
            ['Abandoned Calls',data.voice.abandoned_calls],
            ['Talk Seconds',data.voice.talk_seconds],
            ['Hold Seconds',data.voice.hold_seconds],
            ['Call ACW Seconds',data.voice.acw_seconds],
            ['Average Handle Time Seconds',data.voice.aht_seconds],
            ['Transfers',data.voice.transfers],
            ['Logged In Seconds',data.status.total_logged_in],
            ['Available Seconds',data.status.available_seconds],
            ['Break Seconds',data.status.break_seconds],
            ['Status ACW Seconds',data.status.acw_seconds],
            ['Total Interactions',data.total_interactions],
            ['Conversions',data.total_conversions],
            ['Conversion Rate',data.conversion_rate],
            ['Occupancy',data.occupancy],
            ['Productivity',data.productivity],
            ...(data.omni || []).flatMap(channel => [
                [`Omnichannel ${channel.channel} Handled`, channel.handled],
                [`Omnichannel ${channel.channel} Responded`, channel.responded],
                [`Omnichannel ${channel.channel} Closed`, channel.closed],
                [`Omnichannel ${channel.channel} Avg First Response Seconds`, channel.avg_first_response_seconds],
                [`Omnichannel ${channel.channel} Avg Duration Seconds`, channel.avg_duration_seconds]
            ])
        ];
        await sendExport(res, header, rows, 'agent_performance', req.query.format);
    } catch (err) { next(err); }
});

router.get('/omnichannel', requireRole(['mis_agent','supervisor','admin','superadmin']), async (req, res, next) => {
    try {
        const { from, to } = exportDateRange(req);
        const result = await customMisReportService.run(
            req.session.user.tenantId, 'omnichannel', null, from, to
        );
        await sendExport(res, result.headers, result.rows.map(row =>
            result.columns.map(column => row[column])
        ), 'omnichannel_report', req.query.format);
    } catch (err) { next(err); }
});

router.get('/list-wise', requireRole(['mis_agent','supervisor','admin','superadmin']), async (req, res, next) => {
    try {
        const { from, to } = exportDateRange(req);
        const result = await customMisReportService.run(
            req.session.user.tenantId, 'lists', null, from, to
        );
        await sendExport(res, result.headers, result.rows.map(row =>
            result.columns.map(column => row[column])
        ), 'list_wise_report', req.query.format);
    } catch (err) { next(err); }
});

router.get('/dispositions', requireRole(['mis_agent','supervisor','admin','superadmin']), async (req, res, next) => {
    try {
        const { from, to } = exportDateRange(req);
        const result = await customMisReportService.run(
            req.session.user.tenantId, 'dispositions', null, from, to
        );
        await sendExport(res, result.headers, result.rows.map(row =>
            result.columns.map(column => row[column])
        ), 'disposition_report', req.query.format);
    } catch (err) { next(err); }
});

router.get('/custom', requireRole(['mis_agent','supervisor','admin','superadmin']), async (req, res, next) => {
    try {
        const u = req.session.user;
        const { from, to } = exportDateRange(req);
        const key = String(req.query.dataset || '');
        const definition = customMisReportService.getDataset(key);
        if (!definition) return res.status(400).send('Unknown report dataset.');

        if (!u.roles?.includes('superadmin')) {
            const allowed = await tenantHasFeatures(u.tenantId, definition.features);
            if (!allowed) return res.status(403).send('This report is not enabled for this tenant.');
        }

        const requested = req.query.columns
            ? (Array.isArray(req.query.columns) ? req.query.columns : [req.query.columns])
            : null;

        const result = await customMisReportService.run(
            u.tenantId, key, requested, from, to
        );
        await sendExport(res, result.headers, result.rows.map(row =>
            result.columns.map(column => row[column])
        ), `custom_${key}`, req.query.format);
    } catch (err) { next(err); }
});


module.exports = router;
