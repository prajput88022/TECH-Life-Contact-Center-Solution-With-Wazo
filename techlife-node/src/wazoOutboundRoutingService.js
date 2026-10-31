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



async function verifyDedicatedPatternExtension(
  extensionId,
  expectedExten,
  expectedContext,
  tenantUuid,
  expectedOutcallId,
  token,
  { requireOutcallAssociation = false } = {}
) {
  const id = Number(extensionId);

  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Invalid Wazo pattern extension ID.');
  }

  const resource = await api(
    'GET',
    `/extensions/${id}`,
    token,
    tenantUuid
  );

  if (
    Number(resource?.id) !== id ||
    String(resource?.exten) !== expectedExten ||
    String(resource?.context) !== expectedContext ||
    String(resource?.tenant_uuid || '').toLowerCase() !==
      String(tenantUuid || '').toLowerCase()
  ) {
    throw new Error(
      `Wazo extension ${id} does not match the requested pattern, context, and tenant.`
    );
  }

  // A full extension response must expose these associations. If it
  // does not, fail closed instead of guessing that the extension is free.
  const associationFields = [
    'lines',
    'conference',
    'parking_lot',
    'group',
    'incall',
    'outcall',
    'queue',
  ];

  for (const field of associationFields) {
    if (!Object.prototype.hasOwnProperty.call(resource, field)) {
      throw new Error(
        `Cannot verify Wazo extension ${id}: association field "${field}" is missing.`
      );
    }
  }

  if (!Array.isArray(resource.lines) || resource.lines.length !== 0) {
    throw new Error(
      `Wazo extension ${id} is assigned to a line or its line associations cannot be verified.`
    );
  }

  for (const field of [
    'conference',
    'parking_lot',
    'group',
    'incall',
    'queue',
  ]) {
    if (resource[field] !== null) {
      throw new Error(
        `Wazo extension ${id} is already associated with ${field}; refusing to reuse it.`
      );
    }
  }

  const allowedOutcallId = Number(expectedOutcallId);
  const validExpectedOutcallId =
    Number.isSafeInteger(allowedOutcallId) && allowedOutcallId > 0;

  if (requireOutcallAssociation && resource.outcall === null) {
    throw new Error(
      `Wazo extension ${id} is not associated with the required outcall.`
    );
  }

  if (resource.outcall !== null) {
    const existingOutcallId = Number(resource.outcall?.id);

    if (
      !validExpectedOutcallId ||
      existingOutcallId !== allowedOutcallId
    ) {
      throw new Error(
        `Wazo extension ${id} is associated with a different outcall; refusing to reuse it.`
      );
    }
  }

  return resource;
}

async function provisionPrefixOutboundRoute(prefixId, appTenantId, options = {}) {
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

  // Use the legacy trunk_id only for prefixes that have never had
  // explicit prefix_trunks records. An all-inactive assignment set must
  // not silently fall back to a deactivated legacy trunk.
  const assignmentHistory = await pool.query(
    `SELECT EXISTS (
       SELECT 1
         FROM prefix_trunks
        WHERE tenant_id = $1
          AND prefix_id = $2
     ) AS has_explicit_assignments`,
    [appTenantId, prefixId]
  );

  const hasExplicitAssignments =
    assignmentHistory.rows[0].has_explicit_assignments === true;

  if (!hasExplicitAssignments && !trunks.length && prefix.legacy_trunk_id) {
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
    throw new Error(
      hasExplicitAssignments
        ? 'No active explicit trunk assignments remain for this prefix. Assign and provision a healthy trunk before reprovisioning.'
        : 'No active trunk assignments are configured for this prefix.'
    );
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

    // Do not trust the POST response's ID by itself. Re-read the
    // extension collection and resolve the exact pattern/context/tenant.
    let createdPattern = null;
    let createdOffset = 0;
    let createdPages = 0;

    while (createdPages++ < 100) {
      const response = await api(
        'GET',
        `/extensions?limit=100&offset=${createdOffset}`,
        token,
        prefix.wazo_tenant_uuid
      );

      const items = Array.isArray(response)
        ? response
        : (response?.items || []);

      createdPattern = items.find(e =>
        String(e.exten) === patternExten &&
        String(e.context) === outcallContext.name &&
        String(e.tenant_uuid || '').toLowerCase() ===
          String(prefix.wazo_tenant_uuid).toLowerCase()
      ) || null;

      if (createdPattern) break;

      const total = Number(response?.total);
      if (
        items.length < 100 ||
        (Number.isFinite(total) && createdOffset + items.length >= total)
      ) {
        break;
      }

      createdOffset += items.length;
    }

    if (!createdPattern) {
      throw new Error(
        `Wazo did not expose the newly requested pattern ${patternExten} ` +
        `in context ${outcallContext.name}; refusing to associate an extension.`
      );
    }

    patternExtensionId = Number(createdPattern.id);

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
  await verifyDedicatedPatternExtension(
    patternExtensionId,
    patternExten,
    outcallContext.name,
    prefix.wazo_tenant_uuid,
    prefix.wazo_outcall_id,
    token
  );

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

    // Background reconciliation must never leave a reused route enabled.
    if (options.ensureDisabled === true) {
      await api(
        'PUT',
        `/outcalls/${outcallId}`,
        token,
        prefix.wazo_tenant_uuid,
        { name: existingOutcall.name, enabled: false }
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
    `SELECT p.id, p.tenant_id, p.prefix_digits,
            p.trunk_id AS legacy_trunk_id,
            p.wazo_outcall_id, p.wazo_pattern_extension_id,
            p.agent_id, p.user_group_id, p.campaign_id,
            t.wazo_tenant_uuid, t.wazo_outcall_context_id,
            t.wazo_outcall_context_name, t.wazo_outcall_context_status
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

  if (enabled) {
    if (prefix.agent_id || prefix.user_group_id || prefix.campaign_id) {
      throw new Error(
        'Cannot activate scoped routing until scope-specific Wazo routing is implemented.'
      );
    }

    if (
      prefix.wazo_outcall_context_status !== 'provisioned' ||
      !Number.isSafeInteger(Number(prefix.wazo_outcall_context_id)) ||
      Number(prefix.wazo_outcall_context_id) < 1 ||
      !prefix.wazo_outcall_context_name
    ) {
      throw new Error('Tenant outbound context is not fully provisioned.');
    }

    if (!/^\d{1,20}$/.test(String(prefix.prefix_digits || ''))) {
      throw new Error('Prefix must contain 1 to 20 digits only.');
    }

    // Verify at least one usable assigned trunk before enabling.
    const assigned = await pool.query(
      `SELECT tr.id, tr.name, tr.is_active,
              tr.provisioning_status, tr.wazo_trunk_id
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

    // Preserve legacy compatibility only when no explicit assignments exist.
    if (!trunks.length) {
      const history = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM prefix_trunks
            WHERE tenant_id = $1 AND prefix_id = $2
         ) AS has_explicit_assignments`,
        [appTenantId, prefixId]
      );

      if (!history.rows[0].has_explicit_assignments && prefix.legacy_trunk_id) {
        const legacy = await pool.query(
          `SELECT id, name, is_active, provisioning_status, wazo_trunk_id
             FROM trunks
            WHERE id = $1 AND tenant_id = $2`,
          [prefix.legacy_trunk_id, appTenantId]
        );
        trunks = legacy.rows;
      }
    }

    if (!trunks.length) {
      throw new Error('Cannot activate prefix: no active trunk assignments remain.');
    }

    const seen = new Set();
    for (const trunk of trunks) {
      const id = Number(trunk.wazo_trunk_id);
      if (
        trunk.is_active !== true ||
        trunk.provisioning_status !== 'provisioned' ||
        !Number.isSafeInteger(id) ||
        id < 1
      ) {
        throw new Error(
          `Cannot activate prefix: trunk "${trunk.name}" is not active and provisioned.`
        );
      }
      if (seen.has(id)) {
        throw new Error('Cannot activate prefix: duplicate Wazo trunk IDs are assigned.');
      }
      seen.add(id);
    }

    if (!prefix.wazo_pattern_extension_id) {
      throw new Error('Cannot activate a prefix without its dedicated pattern extension.');
    }

    await verifyDedicatedPatternExtension(
      prefix.wazo_pattern_extension_id,
      `_${String(prefix.prefix_digits)}.`,
      prefix.wazo_outcall_context_name,
      prefix.wazo_tenant_uuid,
      outcallId,
      token,
      { requireOutcallAssociation: true }
    );

    const associatedTrunks = Array.isArray(outcall.trunks)
      ? outcall.trunks.map(item => Number(item?.id)).sort((a, b) => a - b)
      : [];

    const expectedTrunks = [...seen].sort((a, b) => a - b);

    if (
      associatedTrunks.length !== expectedTrunks.length ||
      associatedTrunks.some((id, index) => id !== expectedTrunks[index])
    ) {
      throw new Error(
        'Cannot activate prefix: Wazo outcall trunk associations do not match the current assignments. Reprovision the route first.'
      );
    }
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

async function deactivatePrefixesDependingOnTrunk(appTenantId, trunkId) {
  const trunkResult = await pool.query(
    `SELECT id
       FROM trunks
      WHERE id = $1 AND tenant_id = $2`,
    [trunkId, appTenantId]
  );

  if (!trunkResult.rowCount) {
    throw new Error('Trunk not found in this tenant.');
  }

  const dependent = await pool.query(
    `SELECT DISTINCT p.id, p.wazo_outcall_id,
            p.agent_id, p.user_group_id, p.campaign_id
       FROM prefixes p
      WHERE p.tenant_id = $1
        AND (
          p.trunk_id = $2
          OR EXISTS (
            SELECT 1
              FROM prefix_trunks pt
             WHERE pt.tenant_id = p.tenant_id
               AND pt.prefix_id = p.id
               AND pt.trunk_id = $2
               AND pt.is_active = TRUE
          )
        )
      ORDER BY p.id`,
    [appTenantId, trunkId]
  );

  for (const prefix of dependent.rows) {
    // Disable Wazo first. Do not change assignment state if this fails.
    if (prefix.wazo_outcall_id) {
      await setPrefixOutboundRouteEnabled(prefix.id, appTenantId, false);
    }

    // Remove this trunk from the active routing set.
    await pool.query(
      `UPDATE prefix_trunks
          SET is_active = FALSE
        WHERE tenant_id = $1
          AND prefix_id = $2
          AND trunk_id = $3
          AND is_active = TRUE`,
      [appTenantId, prefix.id, trunkId]
    );

    const tenantWide =
      !prefix.agent_id && !prefix.user_group_id && !prefix.campaign_id;

    const remaining = await pool.query(
      `SELECT tr.id
         FROM prefix_trunks pt
         JOIN trunks tr
           ON tr.id = pt.trunk_id
          AND tr.tenant_id = pt.tenant_id
        WHERE pt.tenant_id = $1
          AND pt.prefix_id = $2
          AND pt.is_active = TRUE
          AND tr.id <> $3
          AND tr.is_active = TRUE
          AND tr.provisioning_status = 'provisioned'
          AND tr.wazo_trunk_id IS NOT NULL
        ORDER BY pt.priority ASC, pt.created_at ASC, tr.id ASC`,
      [appTenantId, prefix.id, trunkId]
    );

    const canReconcile = tenantWide && remaining.rowCount > 0;

    const reason = canReconcile
      ? 'Trunk deactivated; healthy backup assignment remains. Route queued for disabled reprovisioning and requires verification before activation.'
      : !tenantWide
        ? 'Trunk deactivated; agent/group/campaign-scoped routing is unsupported. Prefix remains inactive.'
        : 'Trunk deactivated; no healthy backup assignment remains. Assign and provision another trunk before reprovisioning this prefix.';

    await pool.query(
      `UPDATE prefixes
          SET is_active = FALSE,
              provisioning_status = $3,
              provisioning_error = $4
        WHERE id = $1
          AND tenant_id = $2`,
      [
        prefix.id,
        appTenantId,
        canReconcile ? 'pending' : 'failed',
        reason
      ]
    );
  }

  return { ok: true, affected_prefixes: dependent.rowCount };
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
      ORDER BY p.id ASC
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
      await provisionPrefixOutboundRoute(row.id, row.tenant_id, { ensureDisabled: true });

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
  deactivatePrefixesDependingOnTrunk,
  reconcilePendingPrefixRoutes,
  startPrefixReconciler,
};
