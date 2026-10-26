'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePrefixRoute } = require('../src/prefixRouteResolver');

const TENANT = 'tenant-a';

function trunk(overrides = {}) {
  return {
    id: 'trunk-a',
    tenant_id: TENANT,
    name: 'trunk-a',
    priority: 0,
    is_active: true,
    provisioning_status: 'provisioned',
    wazo_trunk_id: 11,
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    id: 'route-a',
    tenant_id: TENANT,
    prefix_digits: '9',
    route_name: 'default',
    strip_digits: 1,
    prepend_digits: '',
    priority: 0,
    is_active: true,
    trunks: [trunk()],
    ...overrides,
  };
}

function resolve(routes, overrides = {}) {
  return resolvePrefixRoute({
    tenantId: TENANT,
    destination: '9876543210',
    routes,
    ...overrides,
  });
}

test('chooses the longest matching prefix before route priority', () => {
  const result = resolve([
    route({ id: 'long', prefix_digits: '987', priority: 0 }),
    route({ id: 'short', prefix_digits: '9', priority: 999 }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.routeId, 'long');
  assert.equal(result.destination, '876543210');
});

test('uses higher route priority for equal-length prefixes', () => {
  const result = resolve([
    route({ id: 'lower', prefix_digits: '98', priority: 1 }),
    route({ id: 'higher', prefix_digits: '98', priority: 10 }),
  ]);

  assert.equal(result.routeId, 'higher');
});

test('uses stable route ID order to break remaining ties', () => {
  const result = resolve([
    route({ id: 'z-route', prefix_digits: '98', priority: 5 }),
    route({ id: 'a-route', prefix_digits: '98', priority: 5 }),
  ]);

  assert.equal(result.routeId, 'a-route');
});

test('does not select a route from another tenant', () => {
  const result = resolve([
    route({ tenant_id: 'tenant-b' }),
  ]);

  assert.equal(result.ok, false);
});

test('rejects inactive routes', () => {
  const result = resolve([route({ is_active: false })]);
  assert.equal(result.ok, false);
});

test('rejects a campaign-scoped route when campaign does not match', () => {
  const result = resolve([
    route({
      campaign_id: 'campaign-a',
      campaign_allowed: true,
    }),
  ], { campaignId: 'campaign-b' });

  assert.equal(result.ok, false);
});

test('requires explicit campaign assignment authorization', () => {
  const result = resolve([
    route({
      campaign_id: 'campaign-a',
      campaign_allowed: false,
    }),
  ], { campaignId: 'campaign-a' });

  assert.equal(result.ok, false);
});

test('does not apply an agent-scoped route to a robo call without an agent', () => {
  const result = resolve([
    route({
      agent_id: 'agent-a',
      agent_allowed: true,
    }),
  ], { agentId: null });

  assert.equal(result.ok, false);
});

test('requires explicit user-group authorization', () => {
  const result = resolve([
    route({
      user_group_id: 'group-a',
      group_allowed: false,
    }),
  ]);

  assert.equal(result.ok, false);
});

test('chooses the lowest-priority-number eligible trunk first', () => {
  const result = resolve([
    route({
      trunks: [
        trunk({ id: 'later', priority: 5, wazo_trunk_id: 12 }),
        trunk({ id: 'first', priority: 1, wazo_trunk_id: 13 }),
      ],
    }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.trunk.id, 'first');
});

test('skips inactive or unprovisioned trunks', () => {
  const result = resolve([
    route({
      trunks: [
        trunk({ id: 'inactive', is_active: false }),
        trunk({ id: 'pending', provisioning_status: 'pending' }),
      ],
    }),
  ]);

  assert.equal(result.ok, false);
});

test('applies strip and prepend to the destination', () => {
  const result = resolve([
    route({
      prefix_digits: '98',
      strip_digits: 2,
      prepend_digits: '00',
    }),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.destination, '0076543210');
});

test('rejects non-numeric destinations', () => {
  const result = resolve([route()], { destination: '+1-555-0100' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_destination');
});

test('rejects a route that transforms the destination to an empty string', () => {
  const result = resolve([
    route({ prefix_digits: '9876543210', strip_digits: 10 }),
  ]);

  assert.equal(result.ok, false);
});

test('returns a deterministic no-route result for an unmatched number', () => {
  const result = resolve(
    [route({ prefix_digits: '123' })],
    { destination: '9876543210' }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_eligible_route_or_trunk');
});
