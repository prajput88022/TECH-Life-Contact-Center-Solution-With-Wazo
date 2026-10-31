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


async function tenantIdForWazoUser(wazoUserUuid) {
    if (typeof wazoUserUuid !== 'string' || !wazoUserUuid) return null;

    const result = await pool.query(
        `SELECT DISTINCT tenant_id
           FROM users
          WHERE wazo_user_uuid = $1
            AND tenant_id IS NOT NULL
          LIMIT 2`,
        [wazoUserUuid]
    );

    // Do not guess if the UUID is missing or ambiguous.
    return result.rows.length === 1 ? result.rows[0].tenant_id : null;
}

async function agentIdByWazoUserUuid(tenantId, wazoUserUuid) {
    if (!tenantId || typeof wazoUserUuid !== 'string' || !wazoUserUuid) {
        return null;
    }

    const result = await pool.query(
        `SELECT a.id
           FROM agents a
           JOIN users u
             ON u.id = a.user_id
            AND u.tenant_id = a.tenant_id
          WHERE a.tenant_id = $1
            AND u.wazo_user_uuid = $2
          LIMIT 2`,
        [tenantId, wazoUserUuid]
    );

    return result.rows.length === 1 ? result.rows[0].id : null;
}

module.exports = {
    tenantIdForWazoUser,
    agentIdByWazoUserUuid, tenantId, agentId, queueId, didId, contactIdByPhone };
