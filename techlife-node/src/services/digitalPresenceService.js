const crypto = require('crypto');
const { pool } = require('../db');

function hashSessionId(sessionId) {
    if (!sessionId) {
        throw new Error('session_id_required');
    }

    return crypto
        .createHash('sha256')
        .update(String(sessionId))
        .digest('hex');
}

async function touchDigitalPresence(tenantId, agentId, sessionId, status = 'active') {
    if (!['active', 'away'].includes(status)) {
        throw new Error('invalid_digital_presence_status');
    }

    const sessionHash = hashSessionId(sessionId);

    const result = await pool.query(
        `INSERT INTO agent_digital_presence
            (tenant_id, agent_id, session_hash, status, last_seen_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (tenant_id, agent_id, session_hash)
         DO UPDATE SET
            status = EXCLUDED.status,
            last_seen_at = NOW(),
            updated_at = NOW()
         RETURNING status, last_seen_at`,
        [tenantId, agentId, sessionHash, status]
    );

    return result.rows[0];
}

async function clearDigitalPresence(tenantId, agentId, sessionId) {
    if (!tenantId || !agentId || !sessionId) return;

    const sessionHash = hashSessionId(sessionId);

    await pool.query(
        `DELETE FROM agent_digital_presence
         WHERE tenant_id = $1
           AND agent_id = $2
           AND session_hash = $3`,
        [tenantId, agentId, sessionHash]
    );
}

module.exports = {
    touchDigitalPresence,
    clearDigitalPresence
};
