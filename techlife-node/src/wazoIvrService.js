'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
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
                ).toString('base64')
            },
            body: JSON.stringify({ backend: 'wazo_user', expiration: 300 })
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.data?.token) {
        throw new Error(`Wazo authentication failed (${response.status})`);
    }
    return data.data.token;
}

async function findIvrByDescription(token, tenantUuid, description) {
    const matches = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
        const page = await confdRequest(
            'GET',
            `/ivr?limit=100&offset=${offset}`,
            token,
            tenantUuid
        );

        const items = Array.isArray(page.items) ? page.items : [];
        total = Number(page.total);

        if (!Number.isFinite(total) || total < 0) {
            throw new Error('Wazo returned an invalid IVR list total.');
        }

        for (const item of items) {
            if (item.description === description) matches.push(item);
        }

        if (items.length === 0) break;
        offset += items.length;
    }

    if (matches.length > 1) {
        throw new Error(
            `Multiple Wazo IVRs match description "${description}"; ` +
            'refusing to create or update an ambiguous IVR.'
        );
    }

    return matches[0] || null;
}

async function confdRequest(method, apiPath, token, tenantUuid, body) {
    const response = await wazoFetch(
        `${config.wazo.confdUrl.replace(/\/$/, '')}${apiPath}`,
        {
            method,
            headers: {
                'X-Auth-Token': token,
                'Wazo-Tenant': tenantUuid,
                'Content-Type': 'application/json'
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }
    );

    if (!response.ok) {
        const details = (await response.text().catch(() => '')).slice(0, 1200);
        throw new Error(`Wazo ${method} ${apiPath} failed (${response.status}): ${details}`);
    }

    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
}

function safeSoundName(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][_.a-zA-Z0-9-]{0,120}$/.test(name)) {
        throw new Error('Invalid Wazo sound filename/category.');
    }
    return name;
}

async function uploadSound({ tenantUuid, audioPath, category, filename, language = 'en_US' }) {
    const safeCategory = safeSoundName(category);
    const safeFilename = safeSoundName(filename);
    const resolved = path.resolve(audioPath);
    const allowedRoot = path.resolve(__dirname, '../public/uploads/audio') + path.sep;

    if (!resolved.startsWith(allowedRoot)) {
        throw new Error('Audio must be selected from the application audio upload directory.');
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isFile() || stat.size < 128 || stat.size > 20 * 1024 * 1024) {
        throw new Error('Audio file is empty, too small, or exceeds the 20 MB limit.');
    }

    // Validate the WAV container before sending it to Wazo.
    const handle = await fs.promises.open(resolved, 'r');
    let header;
    try {
        header = Buffer.alloc(12);
        const readResult = await handle.read(header, 0, 12, 0);
        if (readResult.bytesRead !== 12 ||
            header.toString('ascii', 0, 4) !== 'RIFF' ||
            header.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('Selected audio is not a valid RIFF/WAVE file.');
        }
    } finally {
        await handle.close();
    }

    const token = await getToken();
    const base = config.wazo.confdUrl.replace(/\/$/, '');

    // Ensure the tenant-scoped sound category exists before uploading.
    const categoryUrl = `${base}/sounds/${encodeURIComponent(safeCategory)}`;
    const categoryCheck = await wazoFetch(categoryUrl, {
        method: 'GET',
        headers: { 'X-Auth-Token': token, 'Wazo-Tenant': tenantUuid }
    });

    if (categoryCheck.status === 404) {
        const createResponse = await wazoFetch(`${base}/sounds`, {
            method: 'POST',
            headers: {
                'X-Auth-Token': token,
                'Wazo-Tenant': tenantUuid,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: safeCategory })
        });

        if (!createResponse.ok && createResponse.status !== 409) {
            const details = (await createResponse.text().catch(() => '')).slice(0, 1200);
            throw new Error(
                `Wazo sound category creation failed (${createResponse.status}): ${details}`
            );
        }
    } else if (!categoryCheck.ok) {
        const details = (await categoryCheck.text().catch(() => '')).slice(0, 1200);
        throw new Error(
            `Wazo sound category check failed (${categoryCheck.status}): ${details}`
        );
    }

    const url = `${base}/sounds/${encodeURIComponent(safeCategory)}/files/${encodeURIComponent(safeFilename)}?language=${encodeURIComponent(language)}&format=wav`;

    const response = await wazoFetch(url, {
        method: 'PUT',
        headers: {
            'X-Auth-Token': token,
            'Wazo-Tenant': tenantUuid,
            'Content-Type': 'application/octet-stream'
        },
        body: await fs.promises.readFile(resolved)
    });

    if (!response.ok) {
        const details = (await response.text().catch(() => '')).slice(0, 1200);
        throw new Error(`Wazo sound upload failed (${response.status}): ${details}`);
    }

    return { category: safeCategory, filename: safeFilename };
}

async function getMenu(tenantId, menuId) {
    const result = await pool.query(
        `SELECT m.*, t.wazo_tenant_uuid, t.wazo_context_name
           FROM ivr_menus m
           JOIN tenants t ON t.id = m.tenant_id
          WHERE m.id = $1 AND m.tenant_id = $2`,
        [menuId, tenantId]
    );

    const menu = result.rows[0];
    if (!menu) throw new Error('IVR menu not found for this tenant.');
    if (!menu.wazo_tenant_uuid) throw new Error('Tenant has no Wazo tenant UUID.');
    return menu;
}

async function fetchAllConfdItems(apiPath, token, tenantUuid) {
    const all = [];
    let offset = 0;
    let total = null;

    for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
        const page = await confdRequest(
            'GET',
            `${apiPath}?limit=100&offset=${offset}`,
            token,
            tenantUuid
        );

        const batch = Array.isArray(page?.items)
            ? page.items
            : (Array.isArray(page) ? page : []);

        if (offset === 0 && Number.isFinite(Number(page?.total))) {
            total = Number(page.total);
        }

        if (!batch.length) break;

        all.push(...batch);
        if (total !== null && all.length >= total) break;
        if (total === null && batch.length < 100) break;

        offset += batch.length;
    }

    if (total !== null && all.length < total) {
        throw new Error(
            `Wazo ${apiPath} listing incomplete (${all.length}/${total}).`
        );
    }

    return all;
}

async function buildChoices(tenantId, menuId, menu, token) {
    const result = await pool.query(
        `SELECT o.*, q.wazo_queue_id, q.is_active AS queue_active,
                sm.wazo_ivr_id, sm.is_active AS submenu_active
           FROM ivr_menu_options o
           LEFT JOIN queues q
             ON q.id = o.target_queue_id AND q.tenant_id = o.tenant_id
           LEFT JOIN ivr_menus sm
             ON sm.id = o.target_submenu_id AND sm.tenant_id = o.tenant_id
          WHERE o.ivr_menu_id = $1 AND o.tenant_id = $2
          ORDER BY o.dtmf_digit`,
        [menuId, tenantId]
    );

    if (!result.rows.length) {
        throw new Error(
            'Add at least one keypad option before syncing this IVR menu.'
        );
    }

    const choices = [];

    for (const option of result.rows) {
        const exten = String(option.dtmf_digit || '');
        if (!/^[0-9*#]$/.test(exten)) {
            throw new Error(`Invalid DTMF digit on IVR option ${option.id}.`);
        }

        let destination;

        switch (option.action_type) {
            case 'queue': {
                const id = Number(option.wazo_queue_id);
                if (
                    option.queue_active !== true ||
                    !Number.isSafeInteger(id) ||
                    id < 1
                ) {
                    throw new Error(
                        `Queue for digit ${exten} is inactive or not provisioned in Wazo.`
                    );
                }

                destination = { type: 'queue', queue_id: id };
                break;
            }

            case 'submenu': {
                const id = Number(option.wazo_ivr_id);
                if (
                    option.submenu_active !== true ||
                    !Number.isSafeInteger(id) ||
                    id < 1
                ) {
                    throw new Error(
                        `Submenu for digit ${exten} must be active and synced first.`
                    );
                }

                destination = { type: 'ivr', ivr_id: id };
                break;
            }

            case 'extension': {
                const target = String(option.target_extension || '').trim();
                const tenantContext = String(menu.wazo_context_name || '').trim();

                if (!/^[0-9*#]{1,40}$/.test(target)) {
                    throw new Error(
                        `Digit ${exten} requires a valid extension or DID.`
                    );
                }
                if (!tenantContext) {
                    throw new Error(
                        'Tenant has no configured Wazo context for extension routing.'
                    );
                }

                const tenantUuid =
                    String(menu.wazo_tenant_uuid || '').toLowerCase();

                const [extensions, contexts] = await Promise.all([
                    fetchAllConfdItems(
                        '/extensions', token, menu.wazo_tenant_uuid
                    ),
                    fetchAllConfdItems(
                        '/contexts', token, menu.wazo_tenant_uuid
                    )
                ]);

                const inboundContexts = contexts
                    .filter((item) =>
                        item.type === 'incall' &&
                        String(item.tenant_uuid || '').toLowerCase() === tenantUuid
                    )
                    .map((item) => String(item.name || ''))
                    .filter(Boolean);

                const permittedContexts = new Set([
                    tenantContext,
                    ...inboundContexts
                ]);

                const matches = extensions.filter((item) =>
                    String(item.exten) === target &&
                    permittedContexts.has(String(item.context)) &&
                    String(item.tenant_uuid || '').toLowerCase() === tenantUuid
                );

                if (matches.length !== 1) {
                    throw new Error(
                        `Extension/DID ${target} must match exactly one verified ` +
                        `extension in this tenant; found ${matches.length}.`
                    );
                }

                destination = {
                    type: 'extension',
                    exten: target,
                    context: String(matches[0].context)
                };
                break;
            }

            case 'voicemail': {
                const id = Number(option.target_voicemail_id);
                if (!Number.isSafeInteger(id) || id < 1) {
                    throw new Error(
                        `Digit ${exten} requires a positive Wazo voicemail ID.`
                    );
                }

                const mailbox = await confdRequest(
                    'GET',
                    `/voicemails/${id}`,
                    token,
                    menu.wazo_tenant_uuid
                );

                if (Number(mailbox?.id) !== id) {
                    throw new Error(
                        `Wazo voicemail ${id} could not be verified.`
                    );
                }

                if (
                    mailbox.tenant_uuid &&
                    String(mailbox.tenant_uuid).toLowerCase() !==
                    String(menu.wazo_tenant_uuid).toLowerCase()
                ) {
                    throw new Error(
                        `Wazo voicemail ${id} belongs to a different tenant.`
                    );
                }

                destination = { type: 'voicemail', voicemail_id: id };
                break;
            }

            case 'hangup':
                destination = { type: 'hangup', cause: 'normal' };
                break;

            default:
                throw new Error(
                    `Digit ${exten} uses unsupported action "${option.action_type}".`
                );
        }

        choices.push({ exten, destination });
    }

    return choices;
}


async function buildFallbackDestination(tenantId, menu, raw, token, label) {
    if (raw === null || raw === undefined || raw === '') return null;

    let fallback = raw;
    if (typeof fallback === 'string') {
        try {
            fallback = JSON.parse(fallback);
        } catch {
            throw new Error(`${label} fallback configuration is invalid JSON.`);
        }
    }

    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
        throw new Error(`${label} fallback configuration is invalid.`);
    }

    const action = String(fallback.action_type || 'none');

    if (action === 'none') return null;

    if (action === 'hangup') {
        return { type: 'hangup', cause: 'normal' };
    }

    if (action === 'queue') {
        const localQueueId = String(fallback.target_queue_id || '');
        if (!localQueueId) {
            throw new Error(`${label} fallback requires a queue.`);
        }

        const result = await pool.query(
            `SELECT wazo_queue_id, is_active
               FROM queues
              WHERE id = $1 AND tenant_id = $2`,
            [localQueueId, tenantId]
        );
        const queue = result.rows[0];
        const id = Number(queue?.wazo_queue_id);

        if (
            !queue ||
            queue.is_active !== true ||
            !Number.isSafeInteger(id) ||
            id < 1
        ) {
            throw new Error(
                `${label} fallback queue is inactive or not provisioned in Wazo.`
            );
        }

        return { type: 'queue', queue_id: id };
    }

    if (action === 'extension') {
        const target = String(fallback.target_extension || '').trim();
        const tenantContext = String(menu.wazo_context_name || '').trim();
        const tenantUuid = String(menu.wazo_tenant_uuid || '').toLowerCase();

        if (!/^[0-9*#]{1,40}$/.test(target)) {
            throw new Error(`${label} fallback extension/DID is invalid.`);
        }
        if (!tenantContext) {
            throw new Error(
                'Tenant has no configured Wazo context for fallback extension routing.'
            );
        }

        const [extensions, contexts] = await Promise.all([
            fetchAllConfdItems('/extensions', token, menu.wazo_tenant_uuid),
            fetchAllConfdItems('/contexts', token, menu.wazo_tenant_uuid)
        ]);

        const inboundContexts = contexts
            .filter((item) =>
                item.type === 'incall' &&
                String(item.tenant_uuid || '').toLowerCase() === tenantUuid
            )
            .map((item) => String(item.name || ''))
            .filter(Boolean);

        const permittedContexts = new Set([tenantContext, ...inboundContexts]);

        const matches = extensions.filter((item) =>
            String(item.exten) === target &&
            permittedContexts.has(String(item.context)) &&
            String(item.tenant_uuid || '').toLowerCase() === tenantUuid
        );

        if (matches.length !== 1) {
            throw new Error(
                `${label} fallback extension/DID ${target} must match exactly one ` +
                `verified extension in this tenant; found ${matches.length}.`
            );
        }

        return {
            type: 'extension',
            exten: target,
            context: String(matches[0].context)
        };
    }

    if (action === 'voicemail') {
        const id = Number(fallback.target_voicemail_id);
        if (!Number.isSafeInteger(id) || id < 1) {
            throw new Error(`${label} fallback requires a positive Wazo voicemail ID.`);
        }

        const mailbox = await confdRequest(
            'GET',
            `/voicemails/${id}`,
            token,
            menu.wazo_tenant_uuid
        );

        if (Number(mailbox?.id) !== id) {
            throw new Error(`${label} fallback voicemail ${id} could not be verified.`);
        }

        if (
            mailbox.tenant_uuid &&
            String(mailbox.tenant_uuid).toLowerCase() !==
                String(menu.wazo_tenant_uuid).toLowerCase()
        ) {
            throw new Error(`${label} fallback voicemail belongs to a different tenant.`);
        }

        return { type: 'voicemail', voicemail_id: id };
    }

    throw new Error(`${label} fallback action "${action}" is not supported.`);
}

async function syncIvrMenu(tenantId, menuId, options = {}) {
    const menu = await getMenu(tenantId, menuId);
    if (!menu.is_active) throw new Error('Activate the IVR menu before syncing it.');

    const soundCategory =
        `techlife${String(tenantId).replace(/-/g, '').slice(0, 20)}`;
    const soundFilename =
        `ivr${String(menu.id).replace(/-/g, '').slice(0, 24)}`;

    const token = await getToken();
    const choices = await buildChoices(tenantId, menuId, menu, token);

    // Validate configured fallbacks before generating or uploading greeting audio.
    const invalidDestination = await buildFallbackDestination(
        tenantId, menu, menu.invalid_destination_json, token, 'Invalid-key'
    );
    const timeoutDestination = await buildFallbackDestination(
        tenantId, menu, menu.timeout_destination_json, token, 'Timeout'
    );
    const abortDestination = await buildFallbackDestination(
        tenantId, menu, menu.abort_destination_json, token, 'Abort'
    );

    const audioRoot = path.resolve(__dirname, '../public/uploads/audio');
    let localAudioPath;
    let generatedDir = null;

    if (menu.greeting_type === 'tts') {
        const text = String(menu.greeting_text || '').trim();

        if (!text || text.length > 2000) {
            throw new Error(
                'TTS greeting text must contain between 1 and 2000 characters.'
            );
        }

        generatedDir = await fs.promises.mkdtemp(
            path.join(audioRoot, '.ivr-tts-')
        );

        try {
            const sourceWav = path.join(generatedDir, 'source.wav');
            localAudioPath = path.join(generatedDir, 'greeting.wav');

            await execFileAsync(
                'espeak-ng',
                ['-v', 'en-us', '-s', '150', '-w', sourceWav, text],
                { timeout: 60000, maxBuffer: 1024 * 1024 }
            );

            await execFileAsync(
                'ffmpeg',
                [
                    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                    '-i', sourceWav,
                    '-map', '0:a:0', '-vn',
                    '-ac', '1', '-ar', '8000',
                    '-c:a', 'pcm_s16le',
                    '-f', 'wav', localAudioPath
                ],
                { timeout: 60000, maxBuffer: 1024 * 1024 }
            );

            const probe = await execFileAsync(
                'ffprobe',
                [
                    '-v', 'error',
                    '-show_entries',
                    'format=duration,size:stream=codec_name,sample_rate,channels',
                    '-of', 'json',
                    localAudioPath
                ],
                { timeout: 30000, maxBuffer: 1024 * 1024 }
            );

            const metadata = JSON.parse(probe.stdout);
            const audioStream = (metadata.streams || [])
                .find((stream) => stream.codec_name);

            const duration = Number(metadata.format?.duration);
            const stat = await fs.promises.stat(localAudioPath);

            if (
                !audioStream ||
                audioStream.codec_name !== 'pcm_s16le' ||
                Number(audioStream.sample_rate) !== 8000 ||
                Number(audioStream.channels) !== 1 ||
                !Number.isFinite(duration) ||
                duration <= 0 ||
                stat.size <= 44
            ) {
                throw new Error(
                    'Generated TTS audio failed WAV format validation.'
                );
            }
        } catch (error) {
            await fs.promises.rm(generatedDir, {
                recursive: true,
                force: true
            }).catch(() => {});
            generatedDir = null;

            if (error.code === 'ENOENT') {
                throw new Error(
                    'TTS requires espeak-ng and ffmpeg installed on the server.'
                );
            }
            throw error;
        }
    } else if (menu.greeting_type === 'audio_file') {
        const audioPath = options.audioPath || menu.greeting_audio_path;

        if (
            typeof audioPath !== 'string' ||
            !audioPath.startsWith('/uploads/audio/')
        ) {
            throw new Error(
                'This audio-file menu has no uploaded greeting. Upload a WAV or other supported audio file.'
            );
        }

        localAudioPath = path.resolve(
            __dirname, '../public', audioPath.replace(/^\/+/, '')
        );

        if (!localAudioPath.startsWith(audioRoot + path.sep)) {
            throw new Error(
                'Greeting audio must be selected from the application audio directory.'
            );
        }
    } else {
        throw new Error('Unsupported IVR greeting type.');
    }

    try {
        await uploadSound({
            tenantUuid: menu.wazo_tenant_uuid,
            audioPath: localAudioPath,
            category: soundCategory,
            filename: soundFilename
        });
    } finally {
        if (generatedDir) {
            await fs.promises.rm(generatedDir, {
                recursive: true,
                force: true
            }).catch((error) => {
                console.error(
                    '[IVR] Could not clean temporary TTS files:',
                    error.message
                );
            });
        }
    }

    const payload = {
        name: String(menu.name).slice(0, 128),
        description: `TECH-Life IVR ${menu.id}`,
        // Wazo stores tenant sounds under this directory. Playback path
        // remains subject to live validation against this installed Wazo build.
        menu_sound: `/var/lib/wazo/sounds/tenants/${menu.wazo_tenant_uuid}/${soundCategory}/en_US/${soundFilename}`,
        timeout: Math.max(0, Math.min(120, Number(menu.timeout_seconds) || 5)),
        max_tries: Math.max(1, Math.min(10, Number(menu.invalid_retry_limit) || 3)),
        invalid_destination: invalidDestination,
        timeout_destination: timeoutDestination,
        abort_destination: abortDestination,
        choices
    };

    const marker = `TECH-Life IVR ${menu.id}`;
    let targetIvrId = menu.wazo_ivr_id ? Number(menu.wazo_ivr_id) : null;
    let saved;
    let created = false;

    if (!targetIvrId) {
        // Recover an earlier successful Wazo create if the local DB update failed.
        const existing = await findIvrByDescription(
            token,
            menu.wazo_tenant_uuid,
            marker
        );

        if (existing) {
            targetIvrId = Number(existing.id);
            if (!Number.isSafeInteger(targetIvrId) || targetIvrId < 1) {
                throw new Error('Wazo returned an invalid ID for the matching IVR.');
            }
        }
    }

    if (targetIvrId) {
        saved = await confdRequest(
            'PUT',
            `/ivr/${targetIvrId}`,
            token,
            menu.wazo_tenant_uuid,
            payload
        );
    } else {
        saved = await confdRequest(
            'POST', '/ivr', token, menu.wazo_tenant_uuid, payload
        );
        created = true;
    }

    const wazoIvrId = Number(saved.id || targetIvrId);
    if (!Number.isSafeInteger(wazoIvrId) || wazoIvrId < 1) {
        throw new Error('Wazo accepted the request but returned no usable IVR ID.');
    }

    await pool.query(
        `UPDATE ivr_menus
            SET wazo_ivr_id = $1
          WHERE id = $2 AND tenant_id = $3`,
        [wazoIvrId, menuId, tenantId]
    );

    return { id: wazoIvrId, created };
}

module.exports = { syncIvrMenu, uploadSound };
