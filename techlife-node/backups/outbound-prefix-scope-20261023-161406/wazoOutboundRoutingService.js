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
    `SELECT
       p.id AS prefix_id,
       p.prefix_digits,
       p.strip_digits,
       p.prepend_digits,
       p.route_name,
       p.wazo_outcall_id,
       p.trunk_id,
       tr.name AS trunk_name,
       tr.is_active AS trunk_active,
       tr.provisioning_status AS trunk_status,
       tr.wazo_trunk_id,
       t.wazo_tenant_uuid
     FROM prefixes p
     JOIN trunks tr
       ON tr.id = p.trunk_id
      AND tr.tenant_id = p.tenant_id
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.id = $1 AND p.tenant_id = $2`,
    [prefixId, appTenantId]
  );

  if (!result.rows.length) {
    throw new Error('Prefix/trunk not found in this tenant');
  }

  const prefix = result.rows[0];

  if (
    prefix.trunk_active !== true ||
    prefix.trunk_status !== 'provisioned'
  ) {
    throw new Error('Selected trunk must be active and provisioned');
  }

  if (!prefix.wazo_tenant_uuid || !prefix.wazo_trunk_id) {
    throw new Error('Wazo tenant UUID or trunk ID is missing');
  }

  const agents = await pool.query(
    `SELECT extension, wazo_extension_id
       FROM agents
      WHERE tenant_id = $1
        AND is_active = TRUE
        AND extension ~ '^[0-9]+$'
      ORDER BY extension`,
    [appTenantId]
  );

  const token = await getToken();

  // Never attach stale IDs or an extension belonging to another context.
  const extensionIds = [];
  const seen = new Set();
  for (const agent of agents.rows) {
    const id = Number(agent.wazo_extension_id);
    if (!Number.isSafeInteger(id) || id < 1 || seen.has(id)) continue;

    let existing;
    try {
      existing = await api(
        'GET',
        `/extensions/${id}`,
        token,
        prefix.wazo_tenant_uuid
      );
    } catch (error) {
      if (/HTTP 404/.test(error.message)) continue;
      throw error;
    }

    if (
      String(existing.exten) !== String(agent.extension) ||
      String(existing.tenant_uuid).toLowerCase() !==
        String(prefix.wazo_tenant_uuid).toLowerCase()
    ) {
      continue;
    }

    seen.add(id);
    extensionIds.push(id);
  }

  if (!extensionIds.length) {
    throw new Error(
      'No active agents have a verified Wazo extension. Repair agent provisioning before activating this prefix.'
    );
  }
  let outcallId = prefix.wazo_outcall_id
    ? Number(prefix.wazo_outcall_id)
    : null;

  if (outcallId) {
    await api(
      'GET',
      `/outcalls/${outcallId}`,
      token,
      prefix.wazo_tenant_uuid
    );
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
        enabled: true,
      }
    );

    outcallId = Number(created?.id);

    if (!Number.isSafeInteger(outcallId) || outcallId < 1) {
      throw new Error(
        'Wazo response did not contain a usable outcall ID'
      );
    }

    await pool.query(
      `UPDATE prefixes
          SET wazo_outcall_id = $1
        WHERE id = $2 AND tenant_id = $3`,
      [outcallId, prefixId, appTenantId]
    );
  }

  await api(
    'PUT',
    `/outcalls/${outcallId}/trunks`,
    token,
    prefix.wazo_tenant_uuid,
    { trunks: [{ id: Number(prefix.wazo_trunk_id) }] }
  );

  for (const extensionId of extensionIds) {
    const association = {
      prefix: String(prefix.prefix_digits),
      strip_digits: Number(prefix.strip_digits || 0),
    };

    if (prefix.prepend_digits) {
      association.external_prefix = String(prefix.prepend_digits);
    }

    await api(
      'PUT',
      `/outcalls/${outcallId}/extensions/${extensionId}`,
      token,
      prefix.wazo_tenant_uuid,
      association
    );
  }

  return {
    ok: true,
    prefix_id: prefix.prefix_id,
    outcall_id: outcallId,
    trunk_id: Number(prefix.wazo_trunk_id),
    extension_ids: extensionIds,
  };
}

module.exports = { provisionPrefixOutboundRoute };
