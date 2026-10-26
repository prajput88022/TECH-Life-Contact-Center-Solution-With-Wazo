const express = require('express');
const router = express.Router();
const { requireRole } = require('../src/auth');
const { pool } = require('../src/db');
const callRecordService = require('../src/services/callRecordService');
const phoneMasker = require('../src/phoneMasker');
const { loadTenantAppearance } = require('../src/tenantAppearance');
const { isScopedSupervisor, agentAccessPredicate, canAccessAgent } = require('../src/supervisorScope');

router.use(requireRole(['supervisor', 'admin', 'superadmin']));
router.use(loadTenantAppearance);

router.get('/', async (req, res) => {
    const t = req.session.user.tenantId;
    const u = req.session.user;
    let queues;
    let campaigns;
    if (isScopedSupervisor(u)) {
        const scope = agentAccessPredicate('ag', '$1', '$2');
        [queues, campaigns] = await Promise.all([
            pool.query(`SELECT DISTINCT q.id, q.name
                        FROM queues q JOIN queue_agents qa ON qa.queue_id=q.id
                        JOIN agents ag ON ag.id=qa.agent_id
                        WHERE q.tenant_id=$1 AND qa.is_active=TRUE AND ${scope}
                        ORDER BY q.name`, [t, u.id]).then(r => r.rows),
            pool.query(`SELECT DISTINCT c.id, c.name
                        FROM campaigns c JOIN calls ca ON ca.campaign_id=c.id
                        JOIN agents ag ON ag.id=ca.agent_id
                        WHERE c.tenant_id=$1 AND ca.tenant_id=$1 AND ${scope}
                        ORDER BY c.name`, [t, u.id]).then(r => r.rows)
        ]);
    } else {
        queues = (await pool.query('SELECT id, name FROM queues WHERE tenant_id = $1 ORDER BY name', [t])).rows;
        campaigns = (await pool.query('SELECT id, name FROM campaigns WHERE tenant_id = $1 ORDER BY name', [t])).rows;
    }
    const scoped = isScopedSupervisor(u);
    const scope = agentAccessPredicate('ag', '$1', '$2');
    const [callbacks, dncEntries] = await Promise.all([
        pool.query(`
            SELECT cb.id, cb.phone_number, cb.due_at, cb.status, cb.notes,
                   COALESCE(NULLIF(usr.full_name, ''), ag.agent_number, ag.extension, ag.id::text) AS agent_name
            FROM agent_callbacks cb
            JOIN agents ag ON ag.id=cb.agent_id AND ag.tenant_id=cb.tenant_id
            LEFT JOIN users usr ON usr.id=ag.user_id
            WHERE cb.tenant_id=$1
              AND cb.status IN ('scheduled','claimed','dialing')
              ${scoped ? `AND ${scope}` : ''}
            ORDER BY cb.due_at ASC LIMIT 100`,
            scoped ? [t, u.id] : [t]
        ).then(r => r.rows),
        pool.query(`
            SELECT d.id, d.phone_number, d.campaign_id, d.reason, d.created_at,
                   c.name AS campaign_name
            FROM do_not_call_entries d
            LEFT JOIN campaigns c ON c.id=d.campaign_id AND c.tenant_id=d.tenant_id
            WHERE d.tenant_id=$1
            ORDER BY d.created_at DESC LIMIT 100`, [t]).then(r => r.rows)
    ]);
    res.render('supervisor/index', {
        pageTitle: 'Supervisor — Live Dashboard', queues, campaigns, callbacks, dncEntries
    });
});

router.post('/callbacks/:id/status', async (req, res) => {
    const t = req.session.user.tenantId;
    const u = req.session.user;
    const status = String(req.body.status || '');
    if (!['completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
    const scoped = isScopedSupervisor(u);
    const scope = agentAccessPredicate('ag', '$3', '$4');
    const result = await pool.query(`
        UPDATE agent_callbacks cb SET status=$1, updated_at=now(),
            completed_at=CASE WHEN $1='completed' THEN now() ELSE completed_at END
        WHERE cb.id=$2 AND cb.tenant_id=$3
          AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id=cb.agent_id AND ag.tenant_id=cb.tenant_id
            ${scoped ? `AND ${scope}` : ''})
        RETURNING cb.id`, scoped ? [status, req.params.id, t, u.id] : [status, req.params.id, t]);
    if (!result.rowCount) return res.status(404).json({ error: 'callback_not_found_or_forbidden' });
    return res.redirect('/supervisor#callbacks');
});

router.post('/dnc', async (req, res) => {
    const t = req.session.user.tenantId;
    const u = req.session.user;
    const phone = String(req.body.phone_number || '').replace(/\D/g, '');
    const reason = String(req.body.reason || 'Supervisor-added DNC').trim().slice(0, 100);
    const campaignId = String(req.body.campaign_id || '').trim() || null;
    if (phone.length < 7 || phone.length > 15) return res.status(400).send('Enter a valid phone number.');
    if (campaignId) {
        const validCampaign = await pool.query('SELECT 1 FROM campaigns WHERE tenant_id=$1 AND id=$2', [t, campaignId]);
        if (!validCampaign.rowCount) return res.status(400).send('Invalid campaign.');
    }
    await pool.query(`INSERT INTO do_not_call_entries (tenant_id, phone_number, campaign_id, reason, created_by)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [t, phone, campaignId, reason, u.id]);
    return res.redirect('/supervisor#dnc');
});

router.get('/chat', async (req, res) => {
    const t = req.session.user.tenantId;
    const scoped = isScopedSupervisor(req.session.user);
    const conversations = (await pool.query(
        `SELECT cv.id, cv.status, cv.started_at, cv.closed_at,
                q.name AS queue_name, c.full_name AS contact_name, u.full_name AS agent_name,
                (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = cv.id) AS message_count,
                EXTRACT(EPOCH FROM (COALESCE(cv.first_response_at, now()) - cv.started_at))::INT AS wait_seconds
         FROM conversations cv
         LEFT JOIN queues q ON q.id = cv.queue_id
         LEFT JOIN contacts c ON c.id = cv.contact_id
         LEFT JOIN agents ag ON ag.id = cv.agent_id
         LEFT JOIN users u ON u.id = ag.user_id
         WHERE cv.tenant_id = $1 AND cv.channel = 'chat'
           ${scoped ? `AND EXISTS (SELECT 1 FROM agents scope_ag WHERE scope_ag.id = cv.agent_id AND ${agentAccessPredicate('scope_ag', '$1', '$2')})` : ''}
         ORDER BY cv.status = 'open' DESC, cv.started_at DESC LIMIT 100`,
        scoped ? [t, req.session.user.id] : [t]
    )).rows;
    res.render('supervisor/chat', { pageTitle: 'Supervisor — Chat Monitor', conversations });
});

router.get('/calls', async (req, res) => {
    const t = req.session.user.tenantId;
    const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
    const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
    const page = Math.max(1, parseInt(req.query.page || '1', 10));

    let rows = await callRecordService.search(t, 'supervisor', { from, to }, page);
    if (isScopedSupervisor(req.session.user)) {
        // Fail closed if the record service does not return agent_id.
        rows = await Promise.all(rows.map(async row =>
            row.agent_id && await canAccessAgent(t, req.session.user, row.agent_id) ? row : null
        ));
        rows = rows.filter(Boolean);
    }
    const isMasked = rows.length ? rows[0].number_masked : await phoneMasker.shouldMask(t, 'supervisor');

    res.render('supervisor/calls', { pageTitle: 'Supervisor — Call Records', rows, from, to, page, isMasked });
});

module.exports = router;
