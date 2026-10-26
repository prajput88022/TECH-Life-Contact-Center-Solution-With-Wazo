'use strict';

const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');

async function getToken() {
  const response = await wazoFetch(
    `${config.wazo.authUrl.replace(/\/$/, '')}/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(
          `${config.wazo.authUsername}:${config.wazo.authPassword}`
        ).toString('base64'),
      },
      body: JSON.stringify({
        backend: 'wazo_user',
        expiration: 300,
      }),
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload?.data?.token) {
    throw new Error(
      `Wazo authentication failed (HTTP ${response.status})`
    );
  }

  return payload.data.token;
}

async function api(method, path, token, tenantUuid, body) {
  const response = await wazoFetch(
    `${config.wazo.confdUrl.replace(/\/$/, '')}${path}`,
    {
      method,
      headers: {
        'X-Auth-Token': token,
        'Wazo-Tenant': tenantUuid,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );

  const raw = await response.text().catch(() => '');
  let payload = {};

  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      `Wazo ${method} ${path} failed (HTTP ${response.status}): ` +
      String(
        payload?.message || payload?.error || raw || 'no response body'
      ).slice(0, 300)
    );
  }

  return payload?.data?.data || payload?.data || payload;
}


async function provisionPrefixOutboundRoute(prefixId, appTenantId) {
  const result = await pool.query(
    `SELECT p.id AS prefix_id,
            p.prefix_digits,
            p.strip_digits,
            p.prepend_digits,
            p.route_name,
            p.wazo_outcall_id,
            p.wazo_pattern_extension_id,
            p.trunk_id AS legacy_trunk_id,
            p.agent_id,
            p.user_group_id,
            p.campaign_id,
            p.tenant_id,
            t.wazo_tenant_uuid,
            t.wazo_outcall_context_id,
            t.wazo_outcall_context_name,
            t.wazo_outcall_context_status
       FROM prefixes p
       JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [prefixId, appTenantId]
  );

  if (!result.rows.length) {
    throw new Error('Prefix not found in this tenant');
  }

  const prefix = result.rows[0];

  // Campaign-specific execution cannot safely be represented by an
  // extension-to-outcall association alone. Fail closed until implemented.
  if (prefix.campaign_id) {
    throw new Error(
      'Campaign-scoped outbound routing is not enabled yet. ' +
      'The prefix must remain inactive until campaign-specific routing is implemented.'
    );
  }

  const hasAgent = Boolean(prefix.agent_id);
  const hasGroup = Boolean(prefix.user_group_id);

  if (hasAgent && hasGroup) {
    throw new Error('A prefix cannot target both an agent and a user group.');
  }

  if (!prefix.wazo_tenant_uuid) {
    throw new Error('Wazo tenant UUID is missing');
  }

  // Prefer explicitly configured trunk assignments, in ascending priority.
  // Preserve compatibility with older prefixes that have only trunk_id.
  const assigned = await pool.query(
    `SELECT tr.id AS app_trunk_id,
            tr.name AS trunk_name,
            tr.is_active AS trunk_active,
            tr.provisioning_status AS trunk_status,
            tr.wazo_trunk_id,
            pt.priority
       FROM prefix_trunks pt
       JOIN trunks tr
         ON tr.id = pt.trunk_id
        AND tr.tenant_id = pt.tenant_id
      WHERE pt.tenant_id = $1
        AND pt.prefix_id = $2
        AND pt.is_active = TRUE
      ORDER BY pt.priority ASC, pt.created_at ASC, tr.id ASC`,
    [appTenantId, prefixId]
  );

  let trunks = assigned.rows;

  if (!trunks.length && prefix.legacy_trunk_id) {
    const legacy = await pool.query(
      `SELECT id AS app_trunk_id,
              name AS trunk_name,
              is_active AS trunk_active,
              provisioning_status AS trunk_status,
              wazo_trunk_id,
              0 AS priority
         FROM trunks
        WHERE id = $1 AND tenant_id = $2`,
      [prefix.legacy_trunk_id, appTenantId]
    );
    trunks = legacy.rows;
  }

  if (!trunks.length) {
    throw new Error('No active trunk assignments are configured for this prefix.');
  }

  const seenTrunks = new Set();
  const wazoTrunks = [];

  for (const trunk of trunks) {
    if (trunk.trunk_active !== true ||
        trunk.trunk_status !== 'provisioned') {
      throw new Error(
        `Trunk "${trunk.trunk_name}" must be active and provisioned.`
      );
    }

    const id = Number(trunk.wazo_trunk_id);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error(
        `Trunk "${trunk.trunk_name}" has no valid Wazo trunk ID.`
      );
    }

    if (seenTrunks.has(id)) {
      throw new Error('Duplicate Wazo trunk IDs exist in the trunk assignment list.');
    }

    seenTrunks.add(id);
    wazoTrunks.push({ id });
  }

  // A pattern-to-outcall association is tenant/context-wide. Do not
  // silently widen an agent- or group-scoped route to all users.
  if (prefix.agent_id || prefix.user_group_id) {
    throw new Error(
      'Agent/group-scoped outbound prefixes require scope-specific Wazo contexts. ' +
      'This prefix remains inactive until that routing is configured.'
    );
  }

  if (!/^\d{1,20}$/.test(String(prefix.prefix_digits || ''))) {
    throw new Error('Outbound prefix must contain 1 to 20 digits only.');
  }

  const token = await getToken();

  // Outbound routing must use the tenant's explicitly provisioned
  // outcall context. Never substitute the internal context.
  if (
    prefix.wazo_outcall_context_status !== 'provisioned' ||
    !Number.isInteger(Number(prefix.wazo_outcall_context_id)) ||
    !prefix.wazo_outcall_context_name
  ) {
    throw new Error(
      'Tenant outcall context is not provisioned. Re-run Wazo tenant provisioning before activating this prefix.'
    );
  }

  const outcallContext = {
    id: Number(prefix.wazo_outcall_context_id),
    name: prefix.wazo_outcall_context_name,
    type: 'outcall',
    tenant_uuid: prefix.wazo_tenant_uuid,
  };
  const patternExten = `_${String(prefix.prefix_digits)}.`;
  let patternExtensionId = Number(prefix.wazo_pattern_extension_id) || null;

  // If the database remembers an extension, verify it before reuse.
  if (patternExtensionId) {
    let remembered;
    try {
      remembered = await api(
        'GET',
        `/extensions/${patternExtensionId}`,
        token,
        prefix.wazo_tenant_uuid
      );
    } catch (error) {
      if (/HTTP 404/.test(error.message)) {
        patternExtensionId = null;
      } else {
        throw error;
      }
    }

    if (remembered && (
      String(remembered.exten) !== patternExten ||
      String(remembered.context) !== outcallContext.name ||
      String(remembered.tenant_uuid || '').toLowerCase() !==
        String(prefix.wazo_tenant_uuid).toLowerCase()
    )) {
      throw new Error(
        'Stored Wazo pattern extension does not match this prefix and tenant. ' +
        'Refusing to modify or reuse an unrelated extension.'
      );
    }
  }

  // Recover an existing pattern if a previous run created it but did not
  // save its ID. Paginate so this works as a tenant grows.
  if (!patternExtensionId) {
    let offset = 0;
    let pages = 0;
    let found = null;

    while (pages++ < 100) {
      const response = await api(
        'GET',
        `/extensions?limit=100&offset=${offset}`,
        token,
        prefix.wazo_tenant_uuid
      );
      const items = Array.isArray(response)
        ? response
        : (response?.items || []);

      found = items.find(e =>
        String(e.exten) === patternExten &&
        String(e.context) === outcallContext.name &&
        String(e.tenant_uuid || '').toLowerCase() ===
          String(prefix.wazo_tenant_uuid).toLowerCase()
      ) || null;

      if (found) break;

      const total = Number(response?.total);
      if (
        items.length < 100 ||
        (Number.isFinite(total) && offset + items.length >= total)
      ) {
        break;
      }
      offset += items.length;
    }

    if (found) {
      patternExtensionId = Number(found.id);
    }
  }

  // Create only when no matching pattern exists in this tenant/context.
  if (!patternExtensionId) {
    const created = await api(
      'POST',
      '/extensions',
      token,
      prefix.wazo_tenant_uuid,
      {
        exten: patternExten,
        context: outcallContext.name
      }
    );

    patternExtensionId = Number(created?.id);

    if (!Number.isSafeInteger(patternExtensionId) || patternExtensionId < 1) {
      throw new Error(
        'Wazo created a pattern extension but returned no usable extension ID.'
      );
    }
  }

  if (!Number.isSafeInteger(patternExtensionId) || patternExtensionId < 1) {
    throw new Error('Could not resolve a valid Wazo pattern extension ID.');
  }

  // Persist the resource ID so future activation attempts are idempotent.
  await pool.query(
    `UPDATE prefixes
        SET wazo_pattern_extension_id = $1
      WHERE id = $2 AND tenant_id = $3`,
    [patternExtensionId, prefixId, appTenantId]
  );

  let outcallId = prefix.wazo_outcall_id
    ? Number(prefix.wazo_outcall_id)
    : null;

  if (outcallId) {
    const existingOutcall = await api(
      'GET',
      `/outcalls/${outcallId}`,
      token,
      prefix.wazo_tenant_uuid
    );

    if (
      !existingOutcall ||
      String(existingOutcall.tenant_uuid || '') !==
        String(prefix.wazo_tenant_uuid)
    ) {
      throw new Error(
        'Existing Wazo outcall is missing or belongs to another tenant; refusing to modify it.'
      );
    }

    const references = await pool.query(
      `SELECT id
         FROM prefixes
        WHERE tenant_id = $1
          AND wazo_outcall_id = $2
          AND id <> $3
        LIMIT 1`,
      [appTenantId, outcallId, prefixId]
    );

    if (references.rows.length) {
      throw new Error(
        'Existing Wazo outcall is already referenced by another prefix; refusing to share it.'
      );
    }
  } else {
    const routeName = (
      `techlife-${String(prefix.route_name || 'route')}-` +
      String(prefix.prefix_id).slice(0, 8)
    ).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);

    const created = await api(
      'POST',
      '/outcalls',
      token,
      prefix.wazo_tenant_uuid,
      {
        name: routeName,
        description: `TechLife prefix ${prefix.prefix_digits}`,
        enabled: false,
      }
    );

    outcallId = Number(created?.id);

    if (!Number.isSafeInteger(outcallId) || outcallId < 1) {
      throw new Error('Wazo response did not contain a usable outcall ID');
    }

    await pool.query(
      `UPDATE prefixes
          SET wazo_outcall_id = $1
        WHERE id = $2 AND tenant_id = $3`,
      [outcallId, prefixId, appTenantId]
    );
  }

  // Wazo's ordered association list is supplied in prefix_trunks priority order.
  await api(
    'PUT',
    `/outcalls/${outcallId}/trunks`,
    token,
    prefix.wazo_tenant_uuid,
    { trunks: wazoTrunks }
  );

  // Associate the dedicated pattern extension, never a personal agent line.
  // The dial pattern lives in extension.exten; do not send a `prefix` field.
  const association = {
    strip_digits: Number(prefix.strip_digits || 0),
  };

  if (prefix.prepend_digits) {
    association.external_prefix = String(prefix.prepend_digits);
  }

  await api(
    'PUT',
    `/outcalls/${outcallId}/extensions/${patternExtensionId}`,
    token,
    prefix.wazo_tenant_uuid,
    association
  );

  return {
    ok: true,
    prefix_id: prefix.prefix_id,
    outcall_id: outcallId,
    trunk_ids: wazoTrunks.map(trunk => trunk.id),
    pattern_extension_id: patternExtensionId,
    pattern: patternExten,
  };
}


async function setPrefixOutboundRouteEnabled(prefixId, appTenantId, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new Error('The enabled argument must be a boolean.');
  }

  const result = await pool.query(
    `SELECT p.id, p.tenant_id, p.wazo_outcall_id,
            p.wazo_pattern_extension_id,
            t.wazo_tenant_uuid
       FROM prefixes p
       JOIN tenants t ON t.id = p.tenant_id
      WHERE p.id = $1 AND p.tenant_id = $2`,
    [prefixId, appTenantId]
  );

  if (!result.rows.length) {
    throw new Error('Prefix not found in this tenant.');
  }

  const prefix = result.rows[0];
  const outcallId = Number(prefix.wazo_outcall_id);

  if (!Number.isSafeInteger(outcallId) || outcallId < 1) {
    throw new Error('Prefix has no valid Wazo outcall ID.');
  }

  if (!prefix.wazo_tenant_uuid) {
    throw new Error('Wazo tenant UUID is missing.');
  }

  const references = await pool.query(
    `SELECT id
       FROM prefixes
      WHERE tenant_id = $1
        AND wazo_outcall_id = $2
        AND id <> $3
      LIMIT 1`,
    [appTenantId, outcallId, prefixId]
  );

  if (references.rows.length) {
    throw new Error('Wazo outcall is shared by another prefix; refusing to change it.');
  }

  const token = await getToken();
  const outcall = await api(
    'GET',
    `/outcalls/${outcallId}`,
    token,
    prefix.wazo_tenant_uuid
  );

  if (
    !outcall ||
    String(outcall.tenant_uuid || '') !== String(prefix.wazo_tenant_uuid)
  ) {
    throw new Error('Wazo outcall tenant mismatch; refusing to change it.');
  }

  if (enabled && !prefix.wazo_pattern_extension_id) {
    throw new Error('Cannot activate a prefix without its dedicated pattern extension.');
  }

  await api(
    'PUT',
    `/outcalls/${outcallId}`,
    token,
    prefix.wazo_tenant_uuid,
    {
      name: outcall.name,
      enabled,
    }
  );

  return { ok: true, outcall_id: outcallId, enabled };
}

async function reconcilePendingPrefixRoutes() {
  const candidates = await pool.query(
    `SELECT p.id, p.tenant_id
       FROM prefixes p
      WHERE p.is_active = FALSE
        AND p.provisioning_status IN ('pending', 'failed')
        AND p.agent_id IS NULL
        AND p.user_group_id IS NULL
        AND p.campaign_id IS NULL
      ORDER BY p.created_at ASC
      LIMIT 20`
  );

  for (const row of candidates.rows) {
    const claimed = await pool.query(
      `UPDATE prefixes
          SET provisioning_status = 'provisioning',
              provisioning_error = NULL
        WHERE id = $1
          AND tenant_id = $2
          AND is_active = FALSE
          AND provisioning_status IN ('pending', 'failed')
      RETURNING id`,
      [row.id, row.tenant_id]
    );

    if (!claimed.rows.length) continue;

    try {
      await provisionPrefixOutboundRoute(row.id, row.tenant_id);

      await pool.query(
        `UPDATE prefixes
            SET provisioning_status = 'provisioned',
                provisioning_error = NULL,
                last_provisioned_at = NOW()
          WHERE id = $1
            AND tenant_id = $2
            AND is_active = FALSE`,
        [row.id, row.tenant_id]
      );
    } catch (err) {
      const message = String(err?.message || err).slice(0, 1500);

      await pool.query(
        `UPDATE prefixes
            SET provisioning_status = 'failed',
                provisioning_error = $3
          WHERE id = $1
            AND tenant_id = $2
            AND is_active = FALSE`,
        [row.id, row.tenant_id, message]
      );

      console.error(
        `[prefix-reconciler] Prefix ${row.id} failed: ${message}`
      );
    }
  }
}

function startPrefixReconciler(intervalMs = 60000) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;

    try {
      await reconcilePendingPrefixRoutes();
    } catch (err) {
      console.error(
        '[prefix-reconciler] Worker error:',
        err?.message || err
      );
    } finally {
      running = false;
    }
  };

  void run();

  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}

module.exports = {
  provisionPrefixOutboundRoute,
  setPrefixOutboundRouteEnabled,
  reconcilePendingPrefixRoutes,
  startPrefixReconciler,
};
