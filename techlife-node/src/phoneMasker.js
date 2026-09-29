/**
 * Server-side phone number masking (port of PHP PhoneMasker). Used at
 * the query/service layer (callRecordService), not in the view -- a
 * masked number should never be sent to the browser in the first place.
 * The call's own unique id is never masked by this module.
 */
const { pool } = require('./db');

const cache = {};

function mask(number) {
    if (!number) return number;
    const digits = String(number).replace(/\D/g, '');
    if (digits.length <= 4) return '*'.repeat(digits.length);
    const first = digits.slice(0, 2);
    const last = digits.slice(-2);
    return `${first}******${last}`;
}

/**
 * screenContext is 'agent' or 'supervisor' -- decides which of the
 * tenant's two independent masking switches applies.
 */
async function shouldMask(tenantId, screenContext) {
    if (!(tenantId in cache)) {
        const res = await pool.query(
            'SELECT mask_number_for_agents, mask_number_for_supervisors FROM tenants WHERE id = $1',
            [tenantId]
        );
        cache[tenantId] = res.rows[0] || { mask_number_for_agents: false, mask_number_for_supervisors: false };
    }
    const settings = cache[tenantId];
    if (screenContext === 'agent') return !!settings.mask_number_for_agents;
    if (screenContext === 'supervisor') return !!settings.mask_number_for_supervisors;
    return false;
}

function invalidateCache(tenantId) {
    delete cache[tenantId];
}

module.exports = { mask, shouldMask, invalidateCache };
