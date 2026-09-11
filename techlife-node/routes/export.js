/**
 * Generic report export handler -- CSV and XLSX. Calls the SAME
 * Reporting Services as the on-screen pages, so an exported file always
 * matches what's shown on screen. XLSX uses ExcelJS (real npm package,
 * streamed to the response -- no temp files needed).
 */
const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');
const { requireAuth, requireRole } = require('../src/auth');
const agentReportService = require('../src/services/agentReportService');
const queueReportService = require('../src/services/queueReportService');
const didReportService = require('../src/services/didReportService');
const campaignReportService = require('../src/services/campaignReportService');
const callRecordService = require('../src/services/callRecordService');

router.use(requireAuth);

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

router.get('/campaign', requireRole(['mis_agent', 'supervisor', 'admin', 'superadmin']), async (req, res) => {
    const { campaign_id, from, to, format } = req.query;
    const summary = await campaignReportService.summary(req.session.user.tenantId, campaign_id, from, to);
    const header = ['Channel', 'Event Type', 'Total'];
    const rows = summary.by_channel.map((r) => [r.channel, r.event_type, r.total]);
    await sendExport(res, header, rows, 'campaign_report', format);
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

    const header = ['Call ID', 'Time', 'Agent', 'Queue', 'From', 'To', 'Direction', 'Status', 'Talk (s)', 'Disposition'];
    const rows = allRows.map((r) => [r.short_id, r.start_time, r.agent_name, r.queue_name, r.from_number, r.to_number, r.direction, r.status, r.talk_seconds, r.disposition_label]);
    await sendExport(res, header, rows, `cdr_${context}`, format);
});

module.exports = router;
