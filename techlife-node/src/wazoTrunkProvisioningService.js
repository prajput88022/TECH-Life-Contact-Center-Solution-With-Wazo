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
      body: JSON.stringify({ backend: 'wazo_user', expiration: 300 }),
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.data?.token) {
    throw new Error(`Wazo authentication failed (HTTP ${response.status})`);
  }
  return payload.data.token;
}

async function api(base, path, token, tenantUuid, method = 'GET', body) {
  const response = await wazoFetch(`${base.replace(/\/$/, '')}${path}`, {
    method,
    headers: {
      'X-Auth-Token': token,
      'Wazo-Tenant': tenantUuid,
      'Content-Type': 'application/json',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });

  const raw = await response.text().catch(() => '');
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

  if (!response.ok) {
    throw new Error(
      `Wazo ${method} ${path} failed (HTTP ${response.status}): ` +
      String(payload?.message || payload?.error || raw || 'no response body').slice(0, 350)
    );
  }
  return payload?.data?.data || payload?.data || payload;
}

function sipUri(server) {
  const value = String(server || '').trim();
  if (!value || /[\s;]/.test(value)) throw new Error('Invalid SIP server');
  return `sip:${value.replace(/^sips?:/i, '')}`;
}

function codecs(value) {
  const aliases = {
    ulaw: 'ulaw', alaw: 'alaw', g729: 'g729',
    g722: 'g722', opus: 'opus',
  };
  const requested = String(value || 'ulaw,alaw')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const result = [...new Set(requested.map(x => aliases[x]).filter(Boolean))];
  if (!result.length) throw new Error('No supported codecs specified');
  return result;
}

async function provisionTrunk(tenantId, trunkId) {
  const row = await pool.query(
    `SELECT tr.*, t.wazo_tenant_uuid, t.wazo_context_name,
            t.wazo_context_status
       FROM trunks tr
       JOIN tenants t ON t.id = tr.tenant_id
      WHERE tr.tenant_id = $1 AND tr.id = $2 AND t.is_active = TRUE`,
    [tenantId, trunkId]
  );

  if (!row.rowCount) throw new Error('Trunk or tenant not found');
  const tr = row.rows[0];

  if (!tr.wazo_tenant_uuid || !tr.wazo_context_name ||
      tr.wazo_context_status !== 'provisioned') {
    throw new Error('Acme Wazo tenant/contexts are not provisioned');
  }
  const authMode = tr.auth_mode || 'ip';
  if (!['ip', 'credentials'].includes(authMode)) {
    throw new Error('Unsupported trunk authentication mode');
  }
  let sipPassword = null;
  if (authMode === 'credentials') {
    if (!tr.sip_username || !tr.sip_password_enc) {
      throw new Error('SIP username/password credentials are missing');
    }
    sipPassword = require('./trunkCredentialCrypto').decrypt(tr.sip_password_enc);
  }

  const endpointUri = sipUri(tr.sip_server);
  const confd = config.wazo.confdUrl;
  const wazoTenant = tr.wazo_tenant_uuid;

  await pool.query(
    `UPDATE trunks
        SET provisioning_status = 'provisioning', provisioning_error = NULL
      WHERE id = $1 AND tenant_id = $2`,
    [trunkId, tenantId]
  );

  try {
    // Authenticate inside the guarded flow so failures are persisted
    // as provisioning errors instead of leaving the trunk stuck pending.
    const token = await getToken();
    const allowed = codecs(tr.codec);
    // Resolve the selected transport to a real Wazo transport UUID.
    const transportResponse = await api(
      confd, '/sip/transports?limit=100&offset=0',
      token, wazoTenant, 'GET'
    );

    const availableTransports = Array.isArray(transportResponse)
      ? transportResponse
      : Array.isArray(transportResponse?.items)
        ? transportResponse.items
        : Array.isArray(transportResponse?.data?.items)
          ? transportResponse.data.items
          : [];

    const requestedProtocol = String(tr.transport || 'udp').toLowerCase();
    const selectedTransport = availableTransports.find(item =>
      Array.isArray(item.options) &&
      item.options.some(option =>
        Array.isArray(option) &&
        String(option[0]).toLowerCase() === 'protocol' &&
        String(option[1]).toLowerCase() === requestedProtocol
      )
    );

    if (!selectedTransport?.uuid) {
      throw new Error(
        `No Wazo SIP transport is configured for protocol "${requestedProtocol}". ` +
        'Configure that transport in Wazo before provisioning this trunk.'
      );
    }

    const endpointBody = {
      transport: { uuid: selectedTransport.uuid },
      label: String(tr.name).slice(0, 128),
      aor_section_options: [['contact', endpointUri]],
      identify_section_options: authMode === 'ip'
        ? [['match', String(tr.sip_server).trim().replace(/^sips?:/i, '')]]
        : [],
      outbound_auth_section_options: authMode === 'credentials'
        ? [['username', String(tr.sip_username)], ['password', sipPassword]]
        : [],
      endpoint_section_options: [
        ['context', tr.wazo_context_name],
        ['disallow', 'all'],
        ...allowed.map(c => ['allow', c]),
        ...(authMode === 'credentials' ? [['outbound_auth', String(tr.name).slice(0, 128)]] : []),
      ],
    };

    let endpointUuid = tr.wazo_endpoint_uuid;
    if (endpointUuid) {
      await api(confd, `/endpoints/sip/${encodeURIComponent(endpointUuid)}`,
        token, wazoTenant, 'PUT', endpointBody);
    } else {
      const endpoint = await api(confd, '/endpoints/sip',
        token, wazoTenant, 'POST', endpointBody);
      endpointUuid = endpoint?.uuid;
      if (!endpointUuid) throw new Error('Wazo did not return a SIP endpoint UUID');

      await pool.query(
        `UPDATE trunks SET wazo_endpoint_uuid = $1
          WHERE id = $2 AND tenant_id = $3`,
        [endpointUuid, trunkId, tenantId]
      );
    }

    let wazoTrunkId = tr.wazo_trunk_id;
    if (wazoTrunkId) {
      await api(confd, `/trunks/${wazoTrunkId}`, token, wazoTenant,
        'PUT', { context: tr.wazo_context_name });
    } else {
      const created = await api(confd, '/trunks', token, wazoTenant,
        'POST', { context: tr.wazo_context_name });
      wazoTrunkId = created?.id;
      if (!wazoTrunkId) throw new Error('Wazo did not return a trunk ID');

      await pool.query(
        `UPDATE trunks SET wazo_trunk_id = $1
          WHERE id = $2 AND tenant_id = $3`,
        [wazoTrunkId, trunkId, tenantId]
      );
    }

    await api(confd,
      `/trunks/${wazoTrunkId}/endpoints/sip/${encodeURIComponent(endpointUuid)}`,
      token, wazoTenant, 'PUT', {});

    await pool.query(
      `UPDATE trunks
          SET provisioning_status = 'provisioned',
              provisioning_error = NULL
        WHERE id = $1 AND tenant_id = $2`,
      [trunkId, tenantId]
    );

    return {
      ok: true,
      trunk_id: wazoTrunkId,
      endpoint_uuid: endpointUuid,
      outbound_routing: 'not_configured',
    };
  } catch (error) {
    await pool.query(
      `UPDATE trunks SET provisioning_status = 'failed',
              provisioning_error = $1
        WHERE id = $2 AND tenant_id = $3`,
      [String(error.message || error).slice(0, 2000), trunkId, tenantId]
    );
    return { ok: false, error: error.message };
  }
}

module.exports = { provisionTrunk };
