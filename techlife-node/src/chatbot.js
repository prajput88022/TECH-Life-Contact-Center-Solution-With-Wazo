/**
 * Simple rule-based chatbot: matches a customer's message against
 * configured keyword rules (chatbot_rules), returns the first matching
 * rule's response (highest priority first), or null if nothing matches
 * (caller should then route to a human agent). This is intentionally
 * NOT an NLU/LLM engine -- that would need an external API key this
 * environment can't provision or test against. Keyword-rule bots are a
 * real, widely-used pattern for FAQ deflection in contact centers.
 */
const { pool } = require('./db');

async function getReply(tenantId, customerMessage) {
    const rulesRes = await pool.query(
        'SELECT * FROM chatbot_rules WHERE tenant_id = $1 AND is_active = TRUE ORDER BY priority DESC',
        [tenantId]
    );
    const lowerMsg = customerMessage.toLowerCase();

    for (const rule of rulesRes.rows) {
        const keywords = rule.trigger_keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        if (keywords.some((kw) => lowerMsg.includes(kw))) {
            return { matched: true, response: rule.response_text, ruleId: rule.id };
        }
    }
    return { matched: false, response: null };
}

module.exports = { getReply };
