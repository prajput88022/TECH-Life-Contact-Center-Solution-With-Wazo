'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { wazoFetch } = require('./wazoFetch');
const config = require('../config/config');
const { uploadSound } = require('./wazoIvrService');

function unwrap(value) {
    return value?.data?.data ?? value?.data ?? value ?? {};
}

async function confd(method, apiPath, token, tenantUuid, body, binary = false) {
    const headers = {
        'X-Auth-Token': token,
        'Wazo-Tenant': tenantUuid,
        Accept: 'application/json',
        'Content-Type': binary ? 'application/octet-stream' : 'application/json'
    };

    const response = await wazoFetch(
        `${config.wazo.confdUrl.replace(/\/$/, '')}${apiPath}`,
        {
            method,
            headers,
            body: body === undefined ? undefined :
                binary ? body : JSON.stringify(body)
        }
    );

    const raw = await response.text().catch(() => '');
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!response.ok) {
        const error = new Error(
            `Wazo ${method} ${apiPath} failed (${response.status}): ` +
            String(payload?.message || payload?.error || raw).slice(0, 300)
        );
        error.status = response.status;
        throw error;
    }
    return response.status === 204 ? {} : unwrap(payload);
}

function assertTenant(resource, tenantUuid, label) {
    if (
        !resource ||
        String(resource.tenant_uuid || '').toLowerCase() !==
            String(tenantUuid).toLowerCase()
    ) {
        throw new Error(`${label} is missing or belongs to another Wazo tenant.`);
    }
}

function queueAudioNames(queue, tenantUuid) {
    const hash = crypto.createHash('sha256')
        .update(`${queue.tenant_id}:${queue.id}`)
        .digest('hex');

    const category = `tlq${hash.slice(0, 24)}`;
    return {
        category,
        holdFile: 'hold.wav',
        periodicFile: `periodic_${hash.slice(0, 12)}`,
        welcomeFile: `welcome_${hash.slice(0, 12)}`,
        soundPath: filename =>
            `/var/lib/wazo/sounds/tenants/${tenantUuid}/${category}/en_US/${filename}`,
        mohLabel: `TECH-Life Queue ${hash.slice(0, 20)}`
    };
}

async function loadAsset(tenantId, assetId) {
    if (!assetId) return null;

    const result = await pool.query(
        `SELECT id, name, storage_path, checksum_sha256,
                file_size_bytes, is_active
           FROM media_assets
          WHERE id = $1 AND tenant_id = $2
            AND media_type = 'audio' AND is_active = TRUE`,
        [assetId, tenantId]
    );

    const asset = result.rows[0];
    if (!asset) {
        throw new Error(
            'Selected audio asset is missing, inactive, or belongs to another tenant.'
        );
    }

    const publicRoot = path.resolve(__dirname, '../public');
    const audioRoot = path.join(publicRoot, 'uploads', 'audio') + path.sep;
    const filePath = path.resolve(
        publicRoot, String(asset.storage_path || '').replace(/^[/\\]+/, '')
    );

    if (!filePath.startsWith(audioRoot)) {
        throw new Error('Audio asset path is outside the approved upload directory.');
    }

    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size < 128 || stat.size > 20 * 1024 * 1024) {
        throw new Error('Audio asset is missing, invalid, or exceeds 20 MB.');
    }

    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        digest.update(chunk);
    }
    const checksum = digest.digest('hex');

    if (asset.checksum_sha256 &&
        checksum !== String(asset.checksum_sha256).trim()) {
        throw new Error(`Audio asset "${asset.name}" checksum mismatch.`);
    }

    return { ...asset, filePath, checksum };
}

async function listMoh(token, tenantUuid) {
    const all = [];

    for (let offset = 0; offset < 10000; offset += 100) {
        const page = await confd(
            'GET', `/moh?limit=100&offset=${offset}`, token, tenantUuid
        );
        const rows = Array.isArray(page) ? page :
            Array.isArray(page?.items) ? page.items : [];

        all.push(...rows);
        if (rows.length < 100) return all;
    }

    throw new Error('Wazo MOH listing exceeded its safe pagination limit.');
}

async function ensureMoh(queue, tenantUuid, token, names, apply) {
    let moh = null;

    if (queue.wazo_moh_uuid) {
        try {
            moh = await confd(
                'GET', `/moh/${encodeURIComponent(queue.wazo_moh_uuid)}`,
                token, tenantUuid
            );
            assertTenant(moh, tenantUuid, 'Saved queue MOH category');
            if (moh.label !== names.mohLabel) {
                throw new Error('Saved MOH category label does not match this queue.');
            }
        } catch (error) {
            if (error.status !== 404) throw error;
            moh = null;
        }
    }

    if (!moh) {
        const matches = (await listMoh(token, tenantUuid))
            .filter(item => item.label === names.mohLabel);

        if (matches.length > 1) {
            throw new Error('Multiple Wazo MOH categories match this queue; refusing to guess.');
        }

        moh = matches[0] || null;
        if (moh) {
            assertTenant(moh, tenantUuid, 'Discovered queue MOH category');
        }
    }

    if (!moh && !apply) {
        return { uuid: null, name: null, pending: true };
    }

    if (!moh) {
        moh = await confd(
            'POST', '/moh', token, tenantUuid,
            {
                label: names.mohLabel,
                mode: 'files',
                sort: 'alphabetical'
            }
        );
    }

    assertTenant(moh, tenantUuid, 'Queue MOH category');

    const uuid = String(moh.uuid || '');
    const name = String(moh.name || '');

    if (!uuid || !name) {
        throw new Error('Wazo MOH response did not include its UUID and category name.');
    }

    return { uuid, name, pending: false };
}

async function uploadMohFile(mohUuid, tenantUuid, token, asset) {
    await confd(
        'PUT',
        `/moh/${encodeURIComponent(mohUuid)}/files/hold.wav`,
        token,
        tenantUuid,
        await fs.promises.readFile(asset.filePath),
        true
    );
}

async function syncQueueAudio(queue, tenantUuid, token, apply = false) {
    const [hold, periodic, welcome] = await Promise.all([
        loadAsset(queue.tenant_id, queue.moh_asset_id),
        loadAsset(queue.tenant_id, queue.periodic_announce_asset_id),
        loadAsset(queue.tenant_id, queue.welcome_asset_id)
    ]);

    const names = queueAudioNames(queue, tenantUuid);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        hold: hold?.checksum || null,
        periodic: periodic?.checksum || null,
        welcome: welcome?.checksum || null,
        interval: Number(queue.periodic_announce_interval_seconds) || 60,
        startDelay: Number(queue.periodic_announce_start_delay_seconds) || 0
    })).digest('hex');

    const unchanged = queue.wazo_audio_fingerprint === fingerprint;
    let moh = {
        uuid: queue.wazo_moh_uuid || null,
        name: queue.wazo_moh_name || null,
        pending: false
    };

    if (!apply) {
        console.log(
            `[queue-audio][dry-run] ${queue.name}: ` +
            `hold=${hold?.name || 'off'}, ` +
            `periodic=${periodic?.name || 'off'}, ` +
            `welcome=${welcome?.name || 'off'}, ` +
            `changed=${!unchanged}`
        );
        return {
            musicOnHold: hold ? moh.name : null,
            periodicAnnounce: periodic ? names.soundPath(names.periodicFile) : null,
            welcomeSound: welcome ? names.soundPath(names.welcomeFile) : null,
            fingerprint,
            ready: false
        };
    }

    try {
        if (hold) {
            moh = await ensureMoh(queue, tenantUuid, token, names, true);
        }

        if (!unchanged) {
            if (hold) {
                await uploadMohFile(moh.uuid, tenantUuid, token, hold);
            }

            if (periodic) {
                await uploadSound({
                    tenantUuid,
                    audioPath: periodic.filePath,
                    category: names.category,
                    filename: names.periodicFile
                });
            }

            if (welcome) {
                await uploadSound({
                    tenantUuid,
                    audioPath: welcome.filePath,
                    category: names.category,
                    filename: names.welcomeFile
                });
            }
        }

        const welcomeSound = welcome
            ? names.soundPath(names.welcomeFile) : null;
        const periodicSound = periodic
            ? names.soundPath(names.periodicFile) : null;

        await pool.query(
            `UPDATE queues
                SET wazo_moh_uuid = $1,
                    wazo_moh_name = $2,
                    wazo_welcome_sound = $3,
                    wazo_periodic_announce_sound = $4,
                    wazo_audio_fingerprint = $5,
                    wazo_audio_sync_status = 'synced',
                    wazo_audio_sync_error = NULL,
                    wazo_audio_last_synced_at = now()
              WHERE id = $6 AND tenant_id = $7`,
            [
                moh.uuid, moh.name, welcomeSound, periodicSound,
                fingerprint, queue.id, queue.tenant_id
            ]
        );

        return {
            musicOnHold: hold ? moh.name : null,
            periodicAnnounce: periodicSound,
            welcomeSound,
            fingerprint,
            ready: true
        };
    } catch (error) {
        await pool.query(
            `UPDATE queues
                SET wazo_audio_sync_status = 'error',
                    wazo_audio_sync_error = $1
              WHERE id = $2 AND tenant_id = $3`,
            [String(error.message || error).slice(0, 1000),
             queue.id, queue.tenant_id]
        ).catch(() => {});
        throw error;
    }
}

module.exports = {
    syncQueueAudio
};
