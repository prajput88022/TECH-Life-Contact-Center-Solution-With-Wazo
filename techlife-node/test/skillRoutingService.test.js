'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSkills,
  qualifyAgent,
  selectSkillAgent
} = require('../src/services/skillRoutingService');

const tenant = 'tenant-a';

function agent(id, skills, extra = {}) {
  return {
    id,
    tenant_id: tenant,
    is_active: true,
    membership_active: true,
    skills_json: skills,
    ...extra
  };
}

test('normalizes existing string skill arrays', () => {
  const skills = normalizeSkills([' Sales ', 'ENGLISH']);
  assert.equal(skills.get('sales'), 1);
  assert.equal(skills.get('english'), 1);
});

test('supports proficiency objects', () => {
  const result = qualifyAgent(
    agent('a1', [{ name: 'sales', level: 4 }]),
    [{ name: 'sales', min_proficiency: 3 }]
  );

  assert.equal(result.qualified, true);
  assert.equal(result.skillScore, 4);
});

test('rejects missing skills and insufficient proficiency', () => {
  assert.equal(
    qualifyAgent(agent('a1', ['sales']), ['english']).qualified,
    false
  );

  assert.equal(
    qualifyAgent(
      agent('a1', [{ name: 'sales', level: 2 }]),
      [{ name: 'sales', min_proficiency: 3 }]
    ).qualified,
    false
  );
});

test('rejects inactive agents', () => {
  assert.equal(
    qualifyAgent(agent('a1', ['sales'], { is_active: false }), ['sales'])
      .qualified,
    false
  );
});

test('does not select an agent from another tenant', () => {
  const result = selectSkillAgent({
    tenantId: tenant,
    requiredSkills: ['sales'],
    members: [
      agent('foreign', ['sales'], { tenant_id: 'tenant-b' })
    ]
  });

  assert.equal(result.agent, null);
  assert.equal(result.reason, 'no_qualified_agent');
});

test('selects highest skill score, then lowest penalty, deterministically', () => {
  const result = selectSkillAgent({
    tenantId: tenant,
    requiredSkills: [{ name: 'sales', min_proficiency: 2 }],
    members: [
      agent('b', [{ name: 'sales', level: 3 }], { penalty: 1 }),
      agent('a', [{ name: 'sales', level: 3 }], { penalty: 0 }),
      agent('c', [{ name: 'sales', level: 2 }], { penalty: 0 })
    ]
  });

  assert.equal(result.agent.id, 'a');
  assert.equal(result.reason, 'matched');
});

test('returns explicit no-match result when nobody qualifies', () => {
  const result = selectSkillAgent({
    tenantId: tenant,
    requiredSkills: ['english'],
    members: [agent('a1', ['sales'])]
  });

  assert.equal(result.agent, null);
  assert.equal(result.reason, 'no_qualified_agent');
});

test('requires configured skills instead of routing arbitrarily', () => {
  const result = selectSkillAgent({
    tenantId: tenant,
    requiredSkills: [],
    members: [agent('a1', ['sales'])]
  });

  assert.equal(result.agent, null);
  assert.equal(result.reason, 'no_required_skills_configured');
});

test('queue selector uses skill requirements stored on the queue', async () => {
  const { selectSkillAgentForQueue } = require('../src/services/skillRoutingService');

  const calls = [];
  const mockPool = {
    async query(sql, params) {
      calls.push({ sql, params });

      if (sql.includes('FROM queues')) {
        return {
          rows: [{
            id: 'queue-1',
            tenant_id: tenant,
            strategy: 'skillbased',
            is_active: true,
            required_skills_json: [
              { name: 'sales', min_proficiency: 3 }
            ]
          }]
        };
      }

      if (sql.includes('FROM queue_agents')) {
        return {
          rows: [
            {
              id: 'agent-qualified',
              tenant_id: tenant,
              is_active: true,
              membership_active: true,
              skills_json: [{ name: 'sales', level: 4 }],
              penalty: 0
            },
            {
              id: 'agent-unqualified',
              tenant_id: tenant,
              is_active: true,
              membership_active: true,
              skills_json: ['english'],
              penalty: 0
            }
          ]
        };
      }

      throw new Error('Unexpected SQL query');
    }
  };

  const result = await selectSkillAgentForQueue(mockPool, {
    tenantId: tenant,
    queueId: 'queue-1'
  });

  assert.equal(result.reason, 'matched');
  assert.equal(result.agent.id, 'agent-qualified');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ['queue-1', tenant]);
  assert.deepEqual(calls[1].params, [tenant, 'queue-1']);
});

test('queue selector refuses queues without saved skill requirements', async () => {
  const { selectSkillAgentForQueue } = require('../src/services/skillRoutingService');

  const mockPool = {
    async query(sql) {
      if (sql.includes('FROM queues')) {
        return {
          rows: [{
            id: 'queue-empty',
            tenant_id: tenant,
            strategy: 'skillbased',
            is_active: true,
            required_skills_json: []
          }]
        };
      }

      throw new Error('Member query should not run for an unconfigured queue');
    }
  };

  const result = await selectSkillAgentForQueue(mockPool, {
    tenantId: tenant,
    queueId: 'queue-empty'
  });

  assert.equal(result.agent, null);
  assert.equal(result.reason, 'no_required_skills_configured');
});
