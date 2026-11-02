'use strict';

const crypto = require('crypto');
const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');
const { provisionWazoAgent } = require('./wazoProvisioningService');

function unwrap(value) {
    return value?.data?.data ?? value?.data ?? value ?? {};
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
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!response.ok) {
        const error = new Error(
            `Wazo ${method} ${path} failed (${response.status}): ` +
            String(payload?.message || payload?.error || raw).slice(0, 300)
        );
        error.status = response.status;
        throw error;
    }
    return response.status === 204 ? {} : unwrap(payload);
}

function items(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.items)) return value.items;
    return [];
}

function remoteSkillName(skill) {
    const slug = String(skill.name).toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        .slice(0, 36) || 'skill';
    const hash = crypto.createHash('sha256')
        .update(`${skill.tenant_id}:${skill.id}`)
        .digest('hex').slice(0, 12);
    return `tl_${slug}_${hash}`;
}

function remoteRuleName(queue) {
    return 'tlqr_' + crypto.createHash('sha256')
        .update(`${queue.tenant_id}:${queue.id}`)
        .digest('hex').slice(0, 24);
}

function checkTenant(resource, tenantUuid, label) {
    if (
        resource?.tenant_uuid &&
        String(resource.tenant_uuid).toLowerCase() !==
            String(tenantUuid).toLowerCase()
    ) {
        throw new Error(`${label} belongs to a different Wazo tenant.`);
    }
}

async function listAll(path, token, tenantUuid) {
    const result = [];
    for (let offset = 0; offset < 10000; offset += 100) {
        const page = await confd(
            'GET', `${path}?limit=100&offset=${offset}`, token, tenantUuid
        );
        const batch = items(page);
        result.push(...batch);
        if (batch.length < 100) return result;
    }
    throw new Error(`Wazo listing exceeded the safe pagination limit: ${path}`);
}

function localAgentSkills(value) {
    let source = value;
    if (typeof source === 'string') {
        try { source = JSON.parse(source); } catch (_) { source = []; }
    }
    if (!Array.isArray(source)) return [];

    return source.map(entry => {
        if (typeof entry === 'string') {
            return { name: entry.toLowerCase(), level: 1 };
        }
        return {
            name: String(entry?.name || entry?.skill || '').toLowerCase(),
            level: Number(entry?.level ?? entry?.proficiency ?? 1)
        };
    }).filter(item => item.name);
}

async function syncSkillCatalog(tenantId, tenantUuid, token, apply) {
    const result = await pool.query(
        `SELECT id, tenant_id, name, is_active, wazo_skill_id,
                wazo_skill_name
           FROM skills
          WHERE tenant_id = $1
          ORDER BY name`,
        [tenantId]
    );

    const local = result.rows;
    if (!apply) {
        const mapped = new Map();
        for (const skill of local) {
            mapped.set(skill.name, {
                id: Number(skill.wazo_skill_id) || null,
                name: remoteSkillName(skill),
                active: skill.is_active === true
            });
        }
        console.log('[skill-reconcile][dry-run] Skill catalogue checked.');
        return mapped;
    }

    const remote = await listAll('/agents/skills', token, tenantUuid);
    const mapped = new Map();

    for (const skill of local) {
        const name = remoteSkillName(skill);
        let found = null;
        const savedId = Number(skill.wazo_skill_id) || null;

        if (savedId) {
            try {
                found = await confd(
                    'GET', `/agents/skills/${savedId}`, token, tenantUuid
                );
                checkTenant(found, tenantUuid, `Wazo skill ${savedId}`);
                if (found.name !== name) {
                    throw new Error(`Saved Wazo skill ${savedId} has an unexpected name.`);
                }
            } catch (error) {
                if (error.status !== 404) throw error;
            }
        }

        if (!found) {
            const matches = remote.filter(item => item.name === name);
            if (matches.length > 1) {
                throw new Error(`Multiple Wazo skills match ${name}; refusing to guess.`);
            }
            found = matches[0] || null;
        }

        if (!found) {
            found = await confd(
                'POST', '/agents/skills', token, tenantUuid, { name }
            );
        }

        const id = Number(found?.id);
        if (!Number.isSafeInteger(id) || id < 1) {
            throw new Error(`Wazo did not return a valid ID for skill ${name}.`);
        }
        checkTenant(found, tenantUuid, `Wazo skill ${id}`);

        await pool.query(
            `UPDATE skills
                SET wazo_skill_id = $1, wazo_skill_name = $2,
                    wazo_sync_status = 'synced', wazo_sync_error = NULL,
                    wazo_last_synced_at = now()
              WHERE id = $3 AND tenant_id = $4`,
            [id, name, skill.id, tenantId]
        );

        mapped.set(skill.name, {
            id, name, active: skill.is_active === true
        });
    }
    return mapped;
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
            body: JSON.stringify({ backend: 'wazo_user', expiration: 300 })
        }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.data?.token) {
        throw new Error(`Wazo authentication failed (${response.status}).`);
    }
    return body.data.token;
}

async function syncAgentSkillWeights(
    tenantId, tenantUuid, token, skillMap, apply
) {
    const result = await pool.query(
        `SELECT id, agent_number, wazo_agent_id, is_active, skills_json
           FROM agents
          WHERE tenant_id = $1
          ORDER BY agent_number`,
        [tenantId]
    );

    for (const agent of result.rows) {
        const local = localAgentSkills(agent.skills_json);
        const desired = new Map();

        for (const entry of local) {
            if (!Number.isInteger(entry.level) ||
                entry.level < 1 || entry.level > 5) {
                throw new Error(
                    `Agent ${agent.agent_number} has an invalid proficiency for ${entry.name}.`
                );
            }

            const skill = skillMap.get(entry.name);
            if (!skill) {
                throw new Error(
                    `Agent ${agent.agent_number} references "${entry.name}", ` +
                    'which is not configured as an active skill in this tenant.'
                );
            }

            if (skill.active && agent.is_active === true) {
                desired.set(skill.id || skill.name, {
                    weight: entry.level * 20,
                    name: entry.name
                });
            }
        }

        if (!apply) {
            for (const target of desired.values()) {
                console.log(
                    `[skill-reconcile][dry-run] Agent ${agent.agent_number}: ` +
                    `${target.name} weight ${target.weight}`
                );
            }
            continue;
        }

        let agentId = Number(agent.wazo_agent_id) || null;

        if (!agentId && apply && agent.is_active === true && desired.size > 0) {
            const provisioned = await provisionWazoAgent(
                tenantId, agent.id
            );
            if (!provisioned?.ok) {
                throw new Error(
                    `Agent ${agent.agent_number} provisioning failed: ` +
                    String(provisioned?.error || 'unknown error')
                );
            }

            const refreshed = await pool.query(
                `SELECT wazo_agent_id
                   FROM agents
                  WHERE id = $1 AND tenant_id = $2`,
                [agent.id, tenantId]
            );
            agentId = Number(refreshed.rows[0]?.wazo_agent_id) || null;
        }

        if (!agentId) {
            if (desired.size) {
                console.log(
                    `[skill-reconcile][dry-run] Agent ${agent.agent_number} ` +
                    'needs Wazo provisioning before skill assignment.'
                );
            }
            continue;
        }

        const remote = await confd(
            'GET', `/agents/${agentId}`, token, tenantUuid
        );

        if (
            Number(remote.id) !== agentId ||
            String(remote.number) !== String(agent.agent_number)
        ) {
            throw new Error(
                `Wazo agent ${agentId} does not match local agent ${agent.agent_number}.`
            );
        }
        checkTenant(remote, tenantUuid, `Wazo agent ${agentId}`);

        if (!Array.isArray(remote.skills)) {
            throw new Error(
                `Wazo agent ${agentId} response did not include its skills array; refusing to reconcile.`
            );
        }

        const remoteById = new Map(
            remote.skills.map(item => [Number(item.id), item])
        );

        for (const [skillId, target] of desired) {
            const current = remoteById.get(Number(skillId));
            if (Number(current?.skill_weight) === target.weight) continue;

            if (apply) {
                await confd(
                    'PUT',
                    `/agents/${agentId}/skills/${skillId}`,
                    token,
                    tenantUuid,
                    { skill_weight: target.weight }
                );
            } else {
                console.log(
                    `[skill-reconcile][dry-run] Agent ${agent.agent_number}: ` +
                    `${target.name} weight ${target.weight}`
                );
            }
        }

        // Remove only stale skills mapped to this TECH-Life tenant.
        for (const skill of skillMap.values()) {
            if (desired.has(Number(skill.id))) continue;
            if (!remoteById.has(Number(skill.id))) continue;

            if (apply) {
                await confd(
                    'DELETE',
                    `/agents/${agentId}/skills/${skill.id}`,
                    token,
                    tenantUuid
                );
            } else {
                console.log(
                    `[skill-reconcile][dry-run] Would remove skill ` +
                    `${skill.name} from agent ${agent.agent_number}`
                );
            }
        }
    }
}


function buildRuleDefinition(queue, skillMap) {
    let requirements = queue.required_skills_json;
    if (typeof requirements === 'string') {
        requirements = JSON.parse(requirements);
    }
    if (!Array.isArray(requirements) || !requirements.length) {
        throw new Error(`Skill queue ${queue.name} has no skill requirements.`);
    }

    const terms = requirements.map(requirement => {
        const name = String(requirement.name || '').toLowerCase();
        const level = Number(requirement.min_proficiency || 1);
        const skill = skillMap.get(name);

        if (!skill || !skill.active) {
            throw new Error(
                `Queue ${queue.name} requires missing or inactive skill "${name}".`
            );
        }
        if (!Number.isInteger(level) || level < 1 || level > 5) {
            throw new Error(`Queue ${queue.name} has an invalid minimum for "${name}".`);
        }

        return `${skill.name} > ${(level - 1) * 20}`;
    });

    return terms.join(' & ');
}

async function syncSkillRuleForQueue(
    queue, tenantUuid, token, skillMap, apply
) {
    const name = remoteRuleName(queue);
    const definition = buildRuleDefinition(queue, skillMap);
    const payload = {
        name,
        rules: [{ definition }]
    };

    let remote = null;
    let id = Number(queue.wazo_skill_rule_id) || null;

    if (id) {
        try {
            remote = await confd(
                'GET', `/queues/skillrules/${id}`, token, tenantUuid
            );
            checkTenant(remote, tenantUuid, `Wazo skill rule ${id}`);
            if (remote.name !== name) {
                throw new Error(
                    `Saved Wazo skill rule ${id} has an unexpected name.`
                );
            }
        } catch (error) {
            if (error.status !== 404) throw error;
            remote = null;
            id = null;
        }
    }

    if (!remote) {
        const all = await listAll('/queues/skillrules', token, tenantUuid);
        const matches = all.filter(item => item.name === name);
        if (matches.length > 1) {
            throw new Error(
                `Multiple Wazo skill rules match queue ${queue.name}; refusing to guess.`
            );
        }
        remote = matches[0] || null;
        if (remote) {
            id = Number(remote.id);
            checkTenant(remote, tenantUuid, `Wazo skill rule ${id}`);
        }
    }

    if (!apply) {
        console.log(
            `[skill-reconcile][dry-run] ${queue.slug}/${queue.name}: ${definition}`
        );
        return { ready: false, id: id || null, definition };
    }

    if (remote) {
        await confd(
            'PUT', `/queues/skillrules/${id}`, token, tenantUuid, payload
        );
    } else {
        const created = await confd(
            'POST', '/queues/skillrules', token, tenantUuid, payload
        );
        id = Number(created.id);
    }

    if (!Number.isSafeInteger(id) || id < 1) {
        throw new Error(`Wazo returned an invalid skill-rule ID for ${queue.name}.`);
    }

    const verified = await confd(
        'GET', `/queues/skillrules/${id}`, token, tenantUuid
    );
    checkTenant(verified, tenantUuid, `Wazo skill rule ${id}`);

    const actualDefinitions = Array.isArray(verified.rules)
        ? verified.rules.map(item => String(item.definition || '').trim())
        : [];

    if (
        verified.name !== name ||
        actualDefinitions.length !== 1 ||
        actualDefinitions[0] !== definition
    ) {
        throw new Error(
            `Wazo skill rule ${id} did not retain the expected name and expression.`
        );
    }

    await pool.query(
        `UPDATE queues
            SET wazo_skill_rule_id = $1,
                wazo_sync_status = 'synced',
                wazo_sync_error = NULL,
                wazo_last_synced_at = now()
          WHERE id = $2 AND tenant_id = $3`,
        [id, queue.id, queue.tenant_id]
    );

    return { ready: true, id, definition };
}


async function reconcileTenantSkillRouting(
    tenantId, tenantUuid, { apply = false } = {}
) {
    if (!tenantId || !tenantUuid) {
        throw new Error('Tenant ID and Wazo tenant UUID are required.');
    }

    const token = await getToken();
    const skillMap = await syncSkillCatalog(
        tenantId, tenantUuid, token, apply
    );

    await syncAgentSkillWeights(
        tenantId, tenantUuid, token, skillMap, apply
    );

    const result = await pool.query(
        `SELECT *
           FROM queues
          WHERE tenant_id = $1
            AND strategy = 'skillbased'
          ORDER BY name, id`,
        [tenantId]
    );

    const errors = [];
    const rules = [];

    for (const queue of result.rows) {
        try {
            const rule = await syncSkillRuleForQueue(
                queue, tenantUuid, token, skillMap, apply
            );
            rules.push({
                queue_id: queue.id,
                rule_id: rule.id,
                ready: rule.ready,
                definition: rule.definition
            });
        } catch (error) {
            const message = String(error.message || error).slice(0, 1000);
            errors.push({ queue: queue.name, error: message });

            if (apply) {
                await pool.query(
                    `UPDATE queues
                        SET wazo_sync_status = 'error',
                            wazo_sync_error = $1
                      WHERE id = $2 AND tenant_id = $3`,
                    [message, queue.id, tenantId]
                );
            }
        }
    }

    return {
        ok: errors.length === 0,
        apply,
        skills: skillMap.size,
        queues: rules,
        errors
    };
}

module.exports = {
    reconcileTenantSkillRouting
};
