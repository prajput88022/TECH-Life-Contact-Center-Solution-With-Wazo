/**
 * Resolves raw Wazo identifiers to our tenant-scoped UUIDs, with an
 * in-process cache so a long-running collector doesn't hit Postgres
 * per event.
 */
const { pool } = require('../src/db');

const tenantCache = {};
const agentCache = {};
const queueCache = {};

async function tenantId(wazoTenantUuid) {
    if (wazoTenantUuid in tenantCache) return tenantCache[wazoTenantUuid];
    const res = await pool.query('SELECT id FROM tenants WHERE wazo_tenant_uuid = $1', [wazoTenantUuid]);
    return (tenantCache[wazoTenantUuid] = res.rows[0]?.id || null);
}

async function agentId(tId, wazoAgentId) {
    if (wazoAgentId == null) return null;
    const key = `${tId}:${wazoAgentId}`;
    if (key in agentCache) return agentCache[key];
    const res = await pool.query('SELECT id FROM agents WHERE tenant_id = $1 AND wazo_agent_id = $2', [tId, wazoAgentId]);
    return (agentCache[key] = res.rows[0]?.id || null);
}

async function queueId(tId, wazoQueueId) {
    if (wazoQueueId == null) return null;
    const key = `${tId}:${wazoQueueId}`;
    if (key in queueCache) return queueCache[key];
    const res = await pool.query('SELECT id FROM queues WHERE tenant_id = $1 AND wazo_queue_id = $2', [tId, wazoQueueId]);
    return (queueCache[key] = res.rows[0]?.id || null);
}

async function didId(tId, didNumber) {
    if (!didNumber) return null;
    const res = await pool.query('SELECT id FROM dids WHERE tenant_id = $1 AND did_number = $2', [tId, didNumber]);
    return res.rows[0]?.id || null;
}

async function contactIdByPhone(tId, phone) {
    if (!phone) return null;
    const res = await pool.query('SELECT id FROM contacts WHERE tenant_id = $1 AND primary_phone = $2 LIMIT 1', [tId, phone]);
    if (res.rows[0]) return res.rows[0].id;
    const ins = await pool.query('INSERT INTO contacts (tenant_id, primary_phone) VALUES ($1,$2) RETURNING id', [tId, phone]);
    return ins.rows[0].id;
}

module.exports = { tenantId, agentId, queueId, didId, contactIdByPhone };
