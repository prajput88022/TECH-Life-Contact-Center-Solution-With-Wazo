/**
 * Shared Postgres connection pool (node-postgres). One pool for the
 * whole process, same pattern as the previous PHP Database::connect()
 * singleton.
 */
const { Pool } = require('pg');
const config = require('../config/config');

const pool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
});

/**
 * Pin subsequent queries on this connection to a tenant, for use
 * alongside Postgres Row-Level-Security policies (see ARCHITECTURE.md
 * section 6). Application code must STILL filter by tenant_id in every
 * query -- this is defense in depth, not a substitute.
 */
async function setTenantScope(client, tenantId) {
    await client.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
}

module.exports = { pool, setTenantScope };
