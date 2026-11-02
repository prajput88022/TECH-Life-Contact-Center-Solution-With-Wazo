'use strict';

const { pool } = require('./db');
const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');

const FLAGS = [
    'call_record_incoming_external_enabled',
    'call_record_outgoing_external_enabled',
    'call_record_incoming_internal_enabled',
    'call_record_outgoing_internal_enabled'
];

let cachedToken = null;
let tokenExpiresAt = 0;
let running = false;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedToken;
    }

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
                expiration: 3600
            })
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.data?.token) {
        throw new Error(`Wazo authentication failed: HTTP ${response.status}`);
    }

    cachedToken = data.data.token;
    tokenExpiresAt = Date.now() + 3600000;
    return cachedToken;
}

function flagsFromUser(user) {
    const flags = {};
    for (const key of FLAGS) flags[key] = user[key] === true;
    return flags;
}

function sameFlags(a, b) {
    return FLAGS.every(key => a?.[key] === b?.[key]);
}

function policyFlags(settings) {
    return {
        call_record_incoming_external_enabled:
            settings.record_incoming_external === true,
        call_record_outgoing_external_enabled:
            settings.record_outgoing_external === true,
        call_record_incoming_internal_enabled:
            settings.record_incoming_internal === true,
        call_record_outgoing_internal_enabled:
            settings.record_outgoing_internal === true
    };
}

async function getUser(userId, tenantUuid, token) {
    const base = config.wazo.confdUrl.replace(/\/$/, '');
    const response = await wazoFetch(
        `${base}/users/${encodeURIComponent(userId)}`,
        {
            headers: {
                Accept: 'application/json',
                'X-Auth-Token': token,
                'Wazo-Tenant': tenantUuid
            }
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Wazo user ${userId} GET failed: HTTP ${response.status}`);
    }

    const user = data.user || data;
    if (Number(user.id) !== Number(userId)) {
        throw new Error(`Wazo returned an unexpected user for ID ${userId}.`);
    }
    return user;
}

async function updateFlags(userId, tenantUuid, flags, token) {
    const base = config.wazo.confdUrl.replace(/\/$/, '');
    const response = await wazoFetch(
        `${base}/users/${encodeURIComponent(userId)}`,
        {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': token,
                'Wazo-Tenant': tenantUuid
            },
            // Wazo's installed ResourceMiddleware loads this partial body
            // with partial=True and updates only these four fields.
            body: JSON.stringify(flags)
        }
    );

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
            `Wazo user ${userId} recording update failed: HTTP ${response.status}` +
            (detail ? ` (${detail.slice(0, 300)})` : '')
        );
    }

    const verified = await getUser(userId, tenantUuid, token);
    if (!sameFlags(flagsFromUser(verified), flags)) {
        throw new Error(`Wazo user ${userId} recording flags did not verify after update.`);
    }
}

async function saveState(tenantId, agentId, userId, original, applied, status, error = null) {
    await pool.query(`
        INSERT INTO recording_policy_agent_state (
            tenant_id, agent_id, wazo_user_id,
            original_flags, applied_flags, sync_status,
            last_error, last_synced_at, updated_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,
                  CASE WHEN $6 IN ('managed','restored') THEN NOW() ELSE NULL END,
                  NOW())
        ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
            wazo_user_id = EXCLUDED.wazo_user_id,
            original_flags = EXCLUDED.original_flags,
            applied_flags = EXCLUDED.applied_flags,
            sync_status = EXCLUDED.sync_status,
            last_error = EXCLUDED.last_error,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = NOW()
    `, [
        tenantId, agentId, userId,
        JSON.stringify(original), JSON.stringify(applied),
        status, error
    ]);
}

async function setStateStatus(tenantId, agentId, status, error = null) {
    await pool.query(`
        UPDATE recording_policy_agent_state
        SET sync_status = $3,
            last_error = $4,
            last_synced_at = CASE
                WHEN $3 IN ('managed','restored') THEN NOW()
                ELSE last_synced_at
            END,
            updated_at = NOW()
        WHERE tenant_id = $1 AND agent_id = $2
    `, [tenantId, agentId, status, error]);
}

async function processAgent(settings, agent, token, apply) {
    const { tenant_id: tenantId, tenant_uuid: tenantUuid } = settings;
    const currentUser = await getUser(agent.wazo_user_id, tenantUuid, token);
    const current = flagsFromUser(currentUser);

    const stateResult = await pool.query(`
        SELECT original_flags, applied_flags, sync_status
        FROM recording_policy_agent_state
        WHERE tenant_id = $1 AND agent_id = $2
    `, [tenantId, agent.id]);

    const state = stateResult.rows[0] || null;
    const shouldRecord = settings.recording_enabled === true &&
        agent.is_active === true;
    const desired = shouldRecord ? policyFlags(settings) :
        (state ? state.original_flags : null);

    // No TECH-Life ownership exists for this agent and policy is off.
    // Do not change manually configured Wazo recording settings.
    if (!desired) return 'untouched';

    if (!state || state.sync_status === 'restored') {
        if (!shouldRecord) return 'untouched';

        if (!apply) {
            console.log(
                `[recording-policy][dry-run] ${settings.tenant_name}` +
                ` agent=${agent.agent_number} user=${agent.wazo_user_id}: would manage recording flags`
            );
            return 'pending';
        }

        if (sameFlags(current, desired)) {
            await saveState(
                tenantId, agent.id, agent.wazo_user_id,
                current, desired, 'managed'
            );
            return 'managed';
        }

        await saveState(
            tenantId, agent.id, agent.wazo_user_id,
            current, desired, 'pending'
        );
        await updateFlags(agent.wazo_user_id, tenantUuid, desired, token);
        await setStateStatus(tenantId, agent.id, 'managed');
        return 'managed';
    }

    const original = state.original_flags;
    const applied = state.applied_flags;

    if (state.sync_status === 'managed' &&
        !sameFlags(current, applied)) {
        const message = 'Wazo recording flags changed outside TECH-Life; refusing to overwrite.';
        if (apply) await setStateStatus(tenantId, agent.id, 'conflict', message);
        throw new Error(message);
    }

    if (shouldRecord) {
        if (!sameFlags(current, desired)) {
            if (!apply) {
                console.log(
                    `[recording-policy][dry-run] ${settings.tenant_name}` +
                    ` agent=${agent.agent_number}: would update recording flags`
                );
                return 'pending';
            }
            await updateFlags(agent.wazo_user_id, tenantUuid, desired, token);
        }

        if (apply) {
            await pool.query(`
                UPDATE recording_policy_agent_state
                SET applied_flags = $3::jsonb,
                    sync_status = 'managed',
                    last_error = NULL,
                    last_synced_at = NOW(),
                    updated_at = NOW()
                WHERE tenant_id = $1 AND agent_id = $2
            `, [tenantId, agent.id, JSON.stringify(desired)]);
        }
        return 'managed';
    }

    if (!sameFlags(current, original)) {
        if (!sameFlags(current, applied) && state.sync_status !== 'pending') {
            const message = 'Wazo recording flags changed externally; original settings were not restored.';
            if (apply) await setStateStatus(tenantId, agent.id, 'conflict', message);
            throw new Error(message);
        }

        if (!apply) {
            console.log(
                `[recording-policy][dry-run] ${settings.tenant_name}` +
                ` agent=${agent.agent_number}: would restore original recording flags`
            );
            return 'pending';
        }

        await updateFlags(agent.wazo_user_id, tenantUuid, original, token);
    }

    if (apply) {
        await setStateStatus(tenantId, agent.id, 'restored');
    }
    return 'restored';
}

async function reconcileRecordingPolicies({ apply = false } = {}) {
    const lockClient = await pool.connect();
    let lockAcquired = false;

    try {
        const lock = await lockClient.query(
            `SELECT pg_try_advisory_lock(hashtext('techlife-recording-policy')) AS acquired`
        );

        if (!lock.rows[0]?.acquired) {
            lockClient.release();
            return { skipped: true, reason: 'another recording-policy run is active' };
        }
        lockAcquired = true;
    } catch (error) {
        lockClient.release();
        throw error;
    }

    const summary = { tenants: 0, agents: 0, managed: 0, restored: 0, errors: 0 };

    try {
        const tenants = await pool.query(`
            SELECT s.*, t.name AS tenant_name,
                   to_jsonb(t)->>'wazo_tenant_uuid' AS tenant_uuid
            FROM recording_settings s
            JOIN tenants t ON t.id = s.tenant_id
            WHERE NULLIF(to_jsonb(t)->>'wazo_tenant_uuid','') IS NOT NULL
            ORDER BY t.name
        `);

        if (!apply) {
            console.log('[recording-policy] DRY RUN — no Wazo changes will be made.');
        }

        const token = await getToken();

        for (const settings of tenants.rows) {
            summary.tenants++;

            const agents = await pool.query(`
                SELECT a.id, a.agent_number, a.wazo_user_id, a.is_active
                FROM agents a
                WHERE a.tenant_id = $1
                  AND a.wazo_user_id IS NOT NULL
                UNION
                SELECT st.agent_id, NULL::varchar AS agent_number,
                       st.wazo_user_id, FALSE AS is_active
                FROM recording_policy_agent_state st
                WHERE st.tenant_id = $1
                  AND NOT EXISTS (
                      SELECT 1 FROM agents a
                      WHERE a.id = st.agent_id AND a.tenant_id = st.tenant_id
                  )
            `, [settings.tenant_id]);

            let tenantErrors = 0;

            for (const agent of agents.rows) {
                summary.agents++;

                try {
                    const result = await processAgent(settings, agent, token, apply);
                    if (result === 'managed') summary.managed++;
                    if (result === 'restored') summary.restored++;
                } catch (error) {
                    tenantErrors++;
                    summary.errors++;
                    console.error(
                        `[recording-policy] ${settings.tenant_name}` +
                        ` agent=${agent.agent_number || agent.wazo_user_id}: ${error.message}`
                    );

                    if (apply) {
                        await setStateStatus(
                            settings.tenant_id, agent.id, 'error',
                            String(error.message).slice(0, 2000)
                        ).catch(() => {});
                    }
                }
            }

            if (apply) {
                await pool.query(`
                    UPDATE recording_settings
                    SET recording_policy_sync_status = $2,
                        recording_policy_sync_error = $3,
                        recording_policy_updated_at = NOW(),
                        updated_at = NOW()
                    WHERE tenant_id = $1
                `, [
                    settings.tenant_id,
                    tenantErrors ? 'error' : 'synced',
                    tenantErrors ? `${tenantErrors} agent(s) need attention` : null
                ]);
            }
        }

        console.log('[recording-policy] Summary:', JSON.stringify(summary));
        return summary;
    } finally {
        try {
            if (lockAcquired) {
                await lockClient.query(
                    `SELECT pg_advisory_unlock(hashtext('techlife-recording-policy'))`
                );
            }
        } finally {
            lockClient.release();
        }
    }
}

function startRecordingPolicyReconciler(intervalMs = 60000) {
    if (running) return;
    running = true;

    const apply = process.env.RECORDING_POLICY_RECONCILE_APPLY === 'true';

    const run = async () => {
        try {
            await reconcileRecordingPolicies({ apply });
        } catch (error) {
            console.error('[recording-policy] Worker error:', error.message);
        }
    };

    run();
    setInterval(run, intervalMs);
}

module.exports = {
    reconcileRecordingPolicies,
    startRecordingPolicyReconciler
};
