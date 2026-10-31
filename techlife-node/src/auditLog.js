const { pool } = require('./db');

const DEFAULT_CATEGORIES = Object.freeze({
    auth: true,
    users: true,
    campaigns: true,
    telephony: true,
    ivr: true,
    integrations: true,
    other: true,
});

// Keep login/logout and security-related events auditable even when ordinary
// activity logging is disabled. Never put credentials or tokens in these logs.
function classifyAuditEvent(action, resourceType) {
    const a = String(action || '').toUpperCase();
    const r = String(resourceType || '').toLowerCase();

    if (
        /(^|_)(LOGIN|LOGOUT|AUTH|MFA|PASSWORD|ACCESS_DENIED|SECURITY)(_|$)/.test(a) ||
        a === 'LOGIN' || a === 'LOGOUT'
    ) return 'auth';

    if (/CAMPAIGN|LEAD|SURVEY|ROBO/.test(a) || ['campaign', 'lead', 'survey'].includes(r)) {
        return 'campaigns';
    }
    if (/TRUNK|QUEUE|PREFIX|DID|CALL|SIP|ROUTE|ROUTING/.test(a) ||
        ['trunk', 'queue', 'prefix', 'did', 'call', 'route'].includes(r)) {
        return 'telephony';
    }
    if (/IVR/.test(a) || r === 'ivr_menu') return 'ivr';
    if (/CRM|INTEGRATION|WEBHOOK/.test(a) ||
        ['crm_integration', 'integration', 'webhook'].includes(r)) {
        return 'integrations';
    }
    if (/USER|AGENT|SUPERVISOR|GROUP|ROLE/.test(a) ||
        ['user', 'agent', 'supervisor', 'user_group', 'role'].includes(r)) {
        return 'users';
    }
    return 'other';
}

async function writeAuditLog(
    tenantId,
    userId,
    action,
    resourceType = null,
    resourceId = null,
    previousValue = null,
    newValue = null,
    ipAddress = null
) {
    // A missing tenant cannot be safely matched to tenant-specific preferences.
    // Preserve the legacy behavior in that case rather than silently dropping
    // the record.
    if (tenantId) {
        const category = classifyAuditEvent(action, resourceType);
        const securityEvent = category === 'auth';

        if (!securityEvent) {
            const settings = await pool.query(
                `SELECT enabled, categories
                   FROM tenant_activity_log_settings
                  WHERE tenant_id = $1`,
                [tenantId]
            );

            if (settings.rowCount) {
                const row = settings.rows[0];
                const categories = {
                    ...DEFAULT_CATEGORIES,
                    ...(row.categories && typeof row.categories === 'object'
                        ? row.categories : {})
                };

                if (!row.enabled || categories[category] === false) return;
            }
        }
    }

    await pool.query(
        `INSERT INTO audit_logs
            (tenant_id, user_id, action, resource_type, resource_id,
             previous_value, new_value, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
            tenantId,
            userId,
            action,
            resourceType,
            resourceId,
            previousValue == null ? null : JSON.stringify(previousValue),
            newValue == null ? null : JSON.stringify(newValue),
            ipAddress
        ]
    );
}

module.exports = { writeAuditLog, classifyAuditEvent };
