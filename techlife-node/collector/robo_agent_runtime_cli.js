#!/usr/bin/env node
/**
 * Scheduler entrypoint for the Robo Agent Runtime -- run every 30-60s
 * via cron: node collector/robo_agent_runtime_cli.js
 */
const { pool } = require('../src/db');
const runtime = require('./roboAgentRuntime');

async function main() {
    const res = await pool.query(
        `SELECT tenant_id, id AS campaign_id FROM campaigns
         WHERE is_robo_campaign = TRUE AND is_active = TRUE
           AND (end_date IS NULL OR end_date >= CURRENT_DATE)`
    );
    for (const row of res.rows) {
        try {
            await runtime.runTick(row.tenant_id, row.campaign_id);
        } catch (e) {
            console.error(`RoboAgentRuntime error for campaign ${row.campaign_id}:`, e.message);
        }
    }
    await pool.end();
}
main();
