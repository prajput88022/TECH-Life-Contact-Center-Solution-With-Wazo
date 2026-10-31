'use strict';

const { pool } = require('./db');

const TABLES = ['call_events', 'omnichannel_events'];
const LOCK_KEY = '7310261030';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MONTHS_AHEAD = 15;

function monthBoundary(offset) {
    const now = new Date();
    return new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() + offset,
        1
    ));
}

function partitionName(table, date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${table}_${y}${m}`;
}

async function relationInfo(client, qualifiedName, parentOid) {
    const result = await client.query(
        `SELECT c.oid::regclass::text AS relation_name,
                EXISTS (
                    SELECT 1 FROM pg_inherits i
                    WHERE i.inhparent = $2::oid AND i.inhrelid = c.oid
                ) AS attached
         FROM pg_class c
         WHERE c.oid = to_regclass($1)`,
        [qualifiedName, parentOid]
    );
    return result.rows[0] || null;
}

async function reconcileEventPartitions({
    apply = false,
    monthsAhead = DEFAULT_MONTHS_AHEAD
} = {}) {
    if (!Number.isInteger(monthsAhead) || monthsAhead < 2 || monthsAhead > 36) {
        throw new Error('monthsAhead must be an integer between 2 and 36');
    }

    const client = await pool.connect();
    let locked = false;
    const result = {
        ok: true,
        apply,
        processed: 0,
        created: 0,
        existing: 0,
        failed: 0,
        errors: []
    };

    try {
        const lockResult = await client.query(
            'SELECT pg_try_advisory_lock($1::bigint) AS locked',
            [LOCK_KEY]
        );

        locked = lockResult.rows[0]?.locked === true;
        if (!locked) {
            console.log('[partition-maintenance] Another instance holds the lock; skipping.');
            return { ...result, skipped: true };
        }

        for (const table of TABLES) {
            try {
                const parentResult = await client.query(
                    `SELECT c.oid, c.relkind,
                            pg_get_userbyid(c.relowner) AS owner
                     FROM pg_class c
                     WHERE c.oid = to_regclass($1)`,
                    [`public.${table}`]
                );

                const parent = parentResult.rows[0];
                if (!parent || parent.relkind !== 'p') {
                    throw new Error(`public.${table} is missing or is not partitioned`);
                }

                if (parent.owner !== 'techlife') {
                    // The owner is checked for diagnostics, not hard-coded as
                    // an identity requirement for future deployments.
                    const privilege = await client.query(
                        `SELECT pg_has_role(current_user, $1, 'USAGE') AS member`,
                        [parent.owner]
                    );
                    if (!privilege.rows[0]?.member) {
                        throw new Error(
                            `Current role cannot act as owner ${parent.owner} of ${table}`
                        );
                    }
                }

                const defaultName = `${table}_default`;
                const defaultInfo = await relationInfo(
                    client,
                    `public.${defaultName}`,
                    parent.oid
                );

                if (defaultInfo && !defaultInfo.attached) {
                    throw new Error(
                        `public.${defaultName} exists but is not attached to ${table}`
                    );
                }

                for (let i = 0; i < monthsAhead; i++) {
                    const from = monthBoundary(i);
                    const to = monthBoundary(i + 1);
                    const name = partitionName(table, from);
                    const qualifiedName = `public.${name}`;
                    const fromIso = from.toISOString();
                    const toIso = to.toISOString();

                    const existing = await relationInfo(
                        client,
                        qualifiedName,
                        parent.oid
                    );

                    if (existing) {
                        if (!existing.attached) {
                            throw new Error(
                                `${qualifiedName} exists but is not attached to ${table}`
                            );
                        }
                        result.existing++;
                        result.processed++;
                        continue;
                    }

                    // A default partition may contain out-of-range rows.
                    // PostgreSQL will refuse to attach an overlapping monthly
                    // partition; detect that condition before attempting DDL.
                    if (defaultInfo) {
                        const overlap = await client.query(
                            `SELECT EXISTS (
                                SELECT 1 FROM public.${defaultName}
                                WHERE event_time >= $1::timestamptz
                                  AND event_time < $2::timestamptz
                            ) AS found`,
                            [fromIso, toIso]
                        );

                        if (overlap.rows[0]?.found) {
                            throw new Error(
                                `${defaultName} contains rows in ${name}; refusing unsafe partition attachment`
                            );
                        }
                    }

                    if (!apply) {
                        console.log(
                            `[partition-maintenance][dry-run] Would create ${qualifiedName}`
                        );
                    } else {
                        await client.query(
                            `CREATE TABLE public."${name}"
                             PARTITION OF public."${table}"
                             FOR VALUES FROM ('${fromIso}') TO ('${toIso}')`
                        );
                        result.created++;
                        console.log(`[partition-maintenance] Created ${qualifiedName}`);
                    }

                    result.processed++;
                }

                if (!defaultInfo) {
                    if (!apply) {
                        console.log(
                            `[partition-maintenance][dry-run] Would create public.${defaultName}`
                        );
                    } else {
                        await client.query(
                            `CREATE TABLE public."${defaultName}"
                             PARTITION OF public."${table}" DEFAULT`
                        );
                        result.created++;
                        console.log(`[partition-maintenance] Created public.${defaultName}`);
                    }
                }

                console.log(
                    `[partition-maintenance] Checked ${table}; owner=${parent.owner}`
                );
            } catch (error) {
                result.ok = false;
                result.failed++;
                result.errors.push({ table, error: error.message });
                console.error(
                    `[partition-maintenance] ${table} failed: ${error.message}`
                );
            }
        }

        console.log(
            '[partition-maintenance] Summary: ' +
            JSON.stringify(result)
        );
        return result;
    } finally {
        if (locked) {
            try {
                await client.query(
                    'SELECT pg_advisory_unlock($1::bigint)',
                    [LOCK_KEY]
                );
            } catch (error) {
                console.error(
                    '[partition-maintenance] Advisory unlock failed:',
                    error.message
                );
            }
        }
        client.release();
    }
}

function startEventPartitionMaintenance({
    intervalMs = DEFAULT_INTERVAL_MS,
    apply = false,
    monthsAhead = DEFAULT_MONTHS_AHEAD
} = {}) {
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await reconcileEventPartitions({ apply, monthsAhead });
        } catch (error) {
            console.error(
                '[partition-maintenance] Run failed:',
                error.stack || error.message
            );
        } finally {
            running = false;
        }
    };

    void run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

module.exports = {
    reconcileEventPartitions,
    startEventPartitionMaintenance
};
