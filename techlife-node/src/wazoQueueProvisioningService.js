'use strict';

const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');
const { provisionWazoAgent } = require('./wazoProvisioningService');

const LOCK_ID = 7241906202610301n;
const PAGE_SIZE = 100;
const MANAGED_OPTIONS = new Set([
    'wrapuptime', 'ringinuse', 'strategy', 'maxlen'
]);

const STRATEGIES = {
    ringall: 'ringall',
    roundrobin: 'rrmemory',
    leastrecent: 'leastrecent',
    leastcalls: 'fewestcalls',
    random: 'random'
};

let running = false;

function unwrap(value) {
    return value?.data?.data ?? value?.data ?? value ?? {};
}

function queueName(id) {
    const crypto = require('crypto');
    const suffix = crypto.createHash('sha256')
        .update(String(id))
        .digest('hex')
        .slice(0, 24);
    return `tlq_${suffix}`;
}

async function getToken() {
    const response = await wazoFetch(
        `${config.wazo.authUrl.replace(/\/$/, '')}/token`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(
                    `${config.wazo.authUsername}:${config.wazo.authPassword}`
                ).toString('base64')
            },
            body: JSON.stringify({
                backend: 'wazo_user',
                expiration: 300
            })
        }
    );

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.data?.token) {
        throw new Error(`Wazo authentication failed (${response.status})`);
    }
    return body.data.token;
}

async function confd(method, path, token, tenantUuid, body) {
    const response = await wazoFetch(
        `${config.wazo.confdUrl.replace(/\/$/, '')}${path}`,
        {
            method,
            headers: {
                'X-Auth-Token': token,
                'Wazo-Tenant': tenantUuid,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        }
    );

    const raw = await response.text().catch(() => '');
    let payload = {};
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch (_) {}

    if (!response.ok) {
        const error = new Error(
            `Wazo ${method} ${path} failed (${response.status}): ` +
            String(payload?.message || payload?.error || raw || 'no response')
                .slice(0, 300)
        );
        error.status = response.status;
        throw error;
    }

    return response.status === 204 ? {} : unwrap(payload);
}

function assertTenant(resource, tenantUuid, description) {
    if (
        !resource ||
        String(resource.tenant_uuid || '').toLowerCase() !==
            String(tenantUuid).toLowerCase()
    ) {
        throw new Error(
            `${description} is missing or belongs to another Wazo tenant`
        );
    }
}

async function listAllQueues(token, tenantUuid) {
    const result = [];

    for (let offset = 0; offset < 10000; offset += PAGE_SIZE) {
        const page = await confd(
            'GET',
            `/queues?limit=${PAGE_SIZE}&offset=${offset}`,
            token,
            tenantUuid
        );

        const rows = Array.isArray(page)
            ? page
            : Array.isArray(page?.items)
                ? page.items
                : [];

        result.push(...rows);
        if (rows.length < PAGE_SIZE) break;
    }

    return result;
}

function mergedOptions(existing, queue) {
    const strategy = STRATEGIES[queue.strategy] || 'ringall';
    const desired = [
        ['wrapuptime', String(Math.max(0, Number(queue.wrapup_seconds) || 0))],
        ['ringinuse', 'no'],
        ['strategy', strategy],
        ['maxlen', String(Math.max(0, Number(queue.max_queue_size) || 0))]
    ];

    const preserved = Array.isArray(existing)
        ? existing.filter(item =>
            Array.isArray(item) &&
            item.length === 2 &&
            !MANAGED_OPTIONS.has(String(item[0]).toLowerCase())
        )
        : [];

    return [...preserved, ...desired];
}

async function persistQueueId(queue, wazoQueueId) {
    const saved = await pool.query(
        `UPDATE queues
            SET wazo_queue_id = $1
          WHERE id = $2
            AND tenant_id = $3
            AND (
                wazo_queue_id IS NULL
                OR wazo_queue_id = $1
            )
          RETURNING id`,
        [wazoQueueId, queue.id, queue.tenant_id]
    );

    if (saved.rowCount !== 1) {
        throw new Error(
            `Could not safely save Wazo queue ID for local queue ${queue.id}`
        );
    }
}

async function findOrCreateQueue(queue, token, tenantUuid, apply) {
    let remote = null;
    let id = Number(queue.wazo_queue_id) || null;

    if (id) {
        remote = await confd(
            'GET', `/queues/${id}`, token, tenantUuid
        );

        if (Number(remote.id) !== id) {
            throw new Error(`Wazo queue ID ${id} did not verify`);
        }
        assertTenant(remote, tenantUuid, `Wazo queue ${id}`);
    } else {
        const name = queueName(queue.id);
        const all = await listAllQueues(token, tenantUuid);
        const matches = all.filter(item => item.name === name);

        if (matches.length > 1) {
            throw new Error(
                `Multiple Wazo queues match local queue ${queue.id}; refusing to guess`
            );
        }

        if (matches.length === 1) {
            remote = matches[0];
            id = Number(remote.id);
            assertTenant(remote, tenantUuid, `Wazo queue ${name}`);
        } else if (!apply) {
            console.log(
                `[queue-reconcile][dry-run] Would create queue ` +
                `${queue.name} (${name}) for tenant ${queue.slug}`
            );
            return null;
        } else {
            remote = await confd(
                'POST',
                '/queues',
                token,
                tenantUuid,
                {
                    name,
                    label: `TECH-Life: ${String(queue.name).slice(0, 100)}`,
                    enabled: false,
                    options: mergedOptions([], queue)
                }
            );

            id = Number(remote.id);
            if (!Number.isSafeInteger(id) || id <= 0) {
                throw new Error(
                    `Wazo did not return a valid ID for queue ${queue.name}`
                );
            }

            remote = await confd(
                'GET', `/queues/${id}`, token, tenantUuid
            );
            assertTenant(remote, tenantUuid, `New Wazo queue ${id}`);
        }

        if (id && apply && !queue.wazo_queue_id) {
            await persistQueueId(queue, id);
        }
    }

    if (!id || !remote) {
        throw new Error(`Queue ${queue.name} could not be resolved`);
    }

    return { id, remote };
}

async function applyQueueSettings(queue, remote, queueId, token, tenantUuid, apply) {
    const strategySupported = Object.prototype.hasOwnProperty.call(
        STRATEGIES, queue.strategy
    );

    const enabled = queue.is_active === true && strategySupported;
    const label = `TECH-Life: ${String(queue.name).slice(0, 100)}`;
    const options = mergedOptions(remote.options, queue);

    if (!strategySupported && queue.is_active) {
        console.error(
            `[queue-reconcile] Queue ${queue.name} uses skillbased routing. ` +
            'Wazo queue remains disabled until the live skill dispatcher is implemented.'
        );
    }

    if (!apply) {
        console.log(
            `[queue-reconcile][dry-run] ${queue.slug}/${queue.name}: ` +
            `Wazo queue ${queueId}, enabled=${enabled}, ` +
            `wrapuptime=${queue.wrapup_seconds || 0}, ringinuse=no, ` +
            `strategy=${strategySupported ? STRATEGIES[queue.strategy] : 'unsupported/disabled'}`
        );
        return { enabled, strategySupported };
    }

    await confd(
        'PUT',
        `/queues/${queueId}`,
        token,
        tenantUuid,
        { enabled, label, options }
    );

    const verified = await confd(
        'GET', `/queues/${queueId}`, token, tenantUuid
    );
    assertTenant(verified, tenantUuid, `Updated Wazo queue ${queueId}`);

    const actualOptions = new Map(
        (Array.isArray(verified.options) ? verified.options : [])
            .filter(item => Array.isArray(item) && item.length === 2)
            .map(item => [String(item[0]).toLowerCase(), String(item[1])])
    );

    if (
        Boolean(verified.enabled) !== enabled ||
        actualOptions.get('ringinuse') !== 'no' ||
        actualOptions.get('wrapuptime') !==
            String(Math.max(0, Number(queue.wrapup_seconds) || 0))
    ) {
        throw new Error(
            `Wazo queue ${queueId} did not retain the required queue settings`
        );
    }

    console.log(
        `[queue-reconcile] Verified ${queue.slug}/${queue.name} ` +
        `(Wazo queue ${queueId}, enabled=${enabled})`
    );

    return { enabled, strategySupported };
}

async function syncLocalMembers(
    queue, queueId, token, tenantUuid, apply, queueEnabled
) {
    const members = await pool.query(
        `SELECT qa.agent_id, qa.penalty, qa.is_active AS membership_active,
                a.agent_number, a.is_active AS agent_active, a.wazo_agent_id
           FROM queue_agents qa
           JOIN agents a
             ON a.id = qa.agent_id
            AND a.tenant_id = qa.tenant_id
          WHERE qa.tenant_id = $1
            AND qa.queue_id = $2
          ORDER BY qa.agent_id`,
        [queue.tenant_id, queue.id]
    );

    for (let member of members.rows) {
        const shouldBeMember =
            queueEnabled &&
            member.membership_active === true &&
            member.agent_active === true;

        if (!shouldBeMember) {
            if (member.wazo_agent_id && apply) {
                try {
                    await confd(
                        'DELETE',
                        `/queues/${queueId}/members/agents/${member.wazo_agent_id}`,
                        token,
                        tenantUuid
                    );
                } catch (error) {
                    if (error.status !== 404) throw error;
                }
            } else if (member.wazo_agent_id && !apply) {
                console.log(
                    `[queue-reconcile][dry-run] Would remove Wazo agent ` +
                    `${member.wazo_agent_id} from ${queue.name}`
                );
            }
            continue;
        }

        let wazoAgentId = Number(member.wazo_agent_id) || null;

        if (!wazoAgentId && !apply) {
            console.log(
                `[queue-reconcile][dry-run] Would provision Wazo contact-centre ` +
                `agent ${member.agent_number} for queue ${queue.name}`
            );
            continue;
        }

        if (!wazoAgentId) {
            const result = await provisionWazoAgent(
                queue.tenant_id,
                member.agent_id
            );

            if (!result?.ok) {
                throw new Error(
                    `Agent ${member.agent_number} contact-centre provisioning failed: ` +
                    String(result?.error || 'unknown error')
                );
            }

            const refreshed = await pool.query(
                `SELECT wazo_agent_id
                   FROM agents
                  WHERE id = $1 AND tenant_id = $2`,
                [member.agent_id, queue.tenant_id]
            );
            wazoAgentId = Number(refreshed.rows[0]?.wazo_agent_id) || null;
        }

        if (!wazoAgentId) {
            throw new Error(
                `Agent ${member.agent_number} has no verified Wazo agent ID`
            );
        }

        const remoteAgent = await confd(
            'GET', `/agents/${wazoAgentId}`, token, tenantUuid
        );

        if (
            Number(remoteAgent.id) !== wazoAgentId ||
            String(remoteAgent.number) !== String(member.agent_number)
        ) {
            throw new Error(
                `Wazo agent ${wazoAgentId} does not match local agent ` +
                `${member.agent_number} in this tenant`
            );
        }
        assertTenant(
            remoteAgent, tenantUuid, `Wazo agent ${wazoAgentId}`
        );

        if (apply) {
            await confd(
                'PUT',
                `/queues/${queueId}/members/agents/${wazoAgentId}`,
                token,
                tenantUuid,
                {
                    penalty: Math.max(0, Number(member.penalty) || 0),
                    priority: 0
                }
            );
        } else {
            console.log(
                `[queue-reconcile][dry-run] Would synchronize agent ` +
                `${member.agent_number} with queue ${queue.name}`
            );
        }
    }
}

async function reconcileQueue(queue, token, apply) {
    if (!queue.wazo_tenant_uuid) {
        throw new Error(`Tenant ${queue.slug} has no Wazo tenant UUID`);
    }

    const tenantUuid = queue.wazo_tenant_uuid;
    const resolved = await findOrCreateQueue(
        queue, token, tenantUuid, apply
    );

    if (!resolved) return { skipped: true };

    const settings = await applyQueueSettings(
        queue, resolved.remote, resolved.id, token, tenantUuid, apply
    );

    await syncLocalMembers(
        queue, resolved.id, token, tenantUuid, apply,
        settings.enabled && settings.strategySupported
    );

    return { queue_id: resolved.id, enabled: settings.enabled };
}

async function reconcilePendingQueues({ apply = false } = {}) {
    if (running) {
        return { ok: true, skipped: true, reason: 'already_running' };
    }

    running = true;
    const lockClient = await pool.connect();
    let lockAcquired = false;
    const report = { ok: true, apply, processed: 0, failed: 0, errors: [] };

    try {
        const lock = await lockClient.query(
            'SELECT pg_try_advisory_lock($1::bigint) AS locked',
            [LOCK_ID.toString()]
        );

        lockAcquired = lock.rows[0]?.locked === true;
        if (!lockAcquired) {
            return { ...report, skipped: true, reason: 'another_reconciler_holds_lock' };
        }

        const candidates = await pool.query(
            `SELECT q.*, t.slug, t.wazo_tenant_uuid
               FROM queues q
               JOIN tenants t ON t.id = q.tenant_id
              WHERE t.is_active = TRUE
              ORDER BY t.slug, q.name, q.id`
        );

        if (!candidates.rowCount) {
            console.log('[queue-reconcile] No tenant queues found.');
            return report;
        }

        const token = await getToken();

        for (const queue of candidates.rows) {
            try {
                await reconcileQueue(queue, token, apply);
                report.processed++;
            } catch (error) {
                report.failed++;
                report.errors.push({
                    tenant: queue.slug,
                    queue: queue.name,
                    error: String(error.message || error).slice(0, 400)
                });
                console.error(
                    `[queue-reconcile] ${queue.slug}/${queue.name} failed: ` +
                    String(error.message || error).slice(0, 400)
                );
            }
        }

        report.ok = report.failed === 0;
        console.log('[queue-reconcile] Summary:', JSON.stringify(report));
        return report;
    } finally {
        if (lockAcquired) {
            await lockClient.query(
                'SELECT pg_advisory_unlock($1::bigint)',
                [LOCK_ID.toString()]
            ).catch(() => {});
        }
        lockClient.release();
        running = false;
    }
}

function startQueueReconciler(intervalMs = 60000) {
    let active = false;

    const run = async () => {
        if (active) return;
        active = true;
        try {
            const apply = process.env.WAZO_QUEUE_RECONCILE_APPLY === 'true';
            await reconcilePendingQueues({ apply });
        } catch (error) {
            console.error(
                '[queue-reconcile] Worker error:',
                String(error.message || error).slice(0, 400)
            );
        } finally {
            active = false;
        }
    };

    void run();
    const timer = setInterval(run, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return () => clearInterval(timer);
}

module.exports = {
    reconcilePendingQueues,
    startQueueReconciler
};
