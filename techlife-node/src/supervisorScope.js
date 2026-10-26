const { pool } = require('./db');

function hasAdminAccess(user) {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    return roles.includes('admin') || roles.includes('superadmin');
}

function isScopedSupervisor(user) {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    return roles.includes('supervisor') && !hasAdminAccess(user);
}

function agentAccessPredicate(agentAlias = 'ag', tenantParam = '$1', supervisorParam = '$2') {
    return `(
        EXISTS (
            SELECT 1 FROM supervisor_agent_assignments saa
            WHERE saa.tenant_id = ${tenantParam}
              AND saa.supervisor_id = ${supervisorParam}
              AND saa.agent_id = ${agentAlias}.id
        )
        OR EXISTS (
            SELECT 1
            FROM supervisor_group_assignments sga
            JOIN user_groups ug ON ug.id = sga.group_id
                               AND ug.tenant_id = sga.tenant_id
                               AND ug.is_active = TRUE
            JOIN user_group_agents uga ON uga.group_id = sga.group_id
                                      AND uga.tenant_id = sga.tenant_id
            WHERE sga.tenant_id = ${tenantParam}
              AND sga.supervisor_id = ${supervisorParam}
              AND uga.agent_id = ${agentAlias}.id
        )
    )`;
}

async function canAccessAgent(tenantId, user, agentId) {
    if (hasAdminAccess(user) || (!isScopedSupervisor(user) && user?.agentId === agentId)) return true;
    if (!isScopedSupervisor(user)) return false;
    const result = await pool.query(
        `SELECT 1
         FROM agents ag
         WHERE ag.tenant_id = $1 AND ag.id = $3
           AND ${agentAccessPredicate('ag', '$1', '$2')}
         LIMIT 1`,
        [tenantId, user.id, agentId]
    );
    return result.rowCount > 0;
}

module.exports = { hasAdminAccess, isScopedSupervisor, agentAccessPredicate, canAccessAgent };
