const { pool } = require('./db');

async function writeAuditLog(tenantId, userId, action, resourceType = null, resourceId = null, previousValue = null, newValue = null, ipAddress = null) {
    await pool.query(
        `INSERT INTO audit_logs (tenant_id, user_id, action, resource_type, resource_id, previous_value, new_value, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, userId, action, resourceType, resourceId,
         previousValue ? JSON.stringify(previousValue) : null,
         newValue ? JSON.stringify(newValue) : null, ipAddress]
    );
}

module.exports = { writeAuditLog };
