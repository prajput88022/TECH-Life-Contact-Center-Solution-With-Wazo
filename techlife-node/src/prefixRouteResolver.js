'use strict';

/**
 * Pure prefix-routing resolver.
 *
 * Expected input:
 * {
 *   tenantId, destination, campaignId?, agentId?,
 *   routes: [{
 *     id, tenant_id, prefix_digits, route_name, strip_digits,
 *     prepend_digits, priority, is_active,
 *     campaign_id?, agent_id?, user_group_id?,
 *     campaign_allowed?, agent_allowed?, group_allowed?,
 *     trunks: [{
 *       id, tenant_id, name, priority, is_active,
 *       provisioning_status, wazo_trunk_id
 *     }]
 *   }]
 * }
 *
 * Scope flags are deliberately explicit. The database adapter must
 * calculate them using tenant-safe joins before calling this resolver.
 */
function resolvePrefixRoute(input) {
  if (!input || !input.tenantId) {
    return { ok: false, reason: 'missing_tenant' };
  }

  const destination = String(input.destination ?? '');
  if (!/^[0-9]+$/.test(destination)) {
    return { ok: false, reason: 'invalid_destination' };
  }

  if (!Array.isArray(input.routes)) {
    return { ok: false, reason: 'missing_routes' };
  }

  const tenantId = String(input.tenantId);

  const eligible = input.routes.filter((route) => {
    if (!route || String(route.tenant_id) !== tenantId) return false;
    if (route.is_active !== true) return false;

    const prefix = String(route.prefix_digits ?? '');
    if (!/^[0-9]+$/.test(prefix) || !destination.startsWith(prefix)) {
      return false;
    }

    // A scoped route only applies when its scope is explicitly satisfied.
    if (route.campaign_id != null) {
      if (String(route.campaign_id) !== String(input.campaignId ?? '')) {
        return false;
      }
      if (route.campaign_allowed !== true) return false;
    }

    if (route.agent_id != null) {
      if (String(route.agent_id) !== String(input.agentId ?? '')) {
        return false;
      }
      if (route.agent_allowed !== true) return false;
    }

    if (route.user_group_id != null && route.group_allowed !== true) {
      return false;
    }

    return true;
  });

  // Longest prefix first, then numerically higher route priority.
  // Stable lexical ID order resolves any remaining tie deterministically.
  eligible.sort((a, b) =>
    String(b.prefix_digits).length - String(a.prefix_digits).length ||
    Number(b.priority || 0) - Number(a.priority || 0) ||
    String(a.id).localeCompare(String(b.id))
  );

  for (const route of eligible) {
    const trunks = Array.isArray(route.trunks) ? route.trunks : [];
    const usableTrunks = trunks
      .filter((trunk) =>
        trunk &&
        String(trunk.tenant_id) === tenantId &&
        trunk.is_active === true &&
        trunk.provisioning_status === 'provisioned' &&
        Number.isSafeInteger(Number(trunk.wazo_trunk_id)) &&
        Number(trunk.wazo_trunk_id) > 0
      )
      .sort((a, b) =>
        Number(a.priority || 0) - Number(b.priority || 0) ||
        String(a.id).localeCompare(String(b.id))
      );

    if (!usableTrunks.length) {
      return {
        ok: false,
        reason: 'no_usable_trunk',
        routeId: route.id,
      };
    }

    const strip = Number(route.strip_digits || 0);
    if (!Number.isSafeInteger(strip) || strip < 0) {
      return { ok: false, reason: 'invalid_strip_digits', routeId: route.id };
    }

    const remaining = destination.slice(strip);
    const transformed = String(route.prepend_digits || '') + remaining;

    if (!transformed || !/^[0-9]+$/.test(transformed)) {
      return { ok: false, reason: 'invalid_transformed_destination', routeId: route.id };
    }

    return {
      ok: true,
      routeId: route.id,
      routeName: route.route_name || '',
      matchedPrefix: String(route.prefix_digits),
      destination: transformed,
      trunk: usableTrunks[0],
    };
  }

  return { ok: false, reason: 'no_eligible_route_or_trunk' };
}

module.exports = { resolvePrefixRoute };
