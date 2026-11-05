'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { pool } = require('./db');
const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');

const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MAX_MEDIA_BYTES = Math.max(
    1024 * 1024,
    Number(process.env.RECORDING_MAX_MEDIA_BYTES) || 536870912
);
const CALL_LOGD_URL = (
    process.env.WAZO_CALL_LOGD_URL || 'http://127.0.0.1:9298/1.0'
).replace(/\/+$/, '');

let cachedToken = null;
let tokenExpiresAt = 0;
let workerRunning = false;
let activeTimer = null;

function log(message) {
    console.log(`[recording-ingestion] ${message}`);
}

function validUuid(value) {
    return typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function getWazoToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
        return cachedToken;
    }

    const response = await wazoFetch(
        `${config.wazo.authUrl.replace(/\/+$/, '')}/token`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Basic ' + Buffer.from(
                    `${config.wazo.authUsername}:${config.wazo.authPassword}`
                ).toString('base64')
            },
            body: JSON.stringify({
                backend: 'wazo_user',
                expiration: 3600
            })
        }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.data?.token) {
        throw new Error(`Wazo authentication failed: HTTP ${response.status}`);
    }

    cachedToken = data.data.token;
    tokenExpiresAt = Date.now() + 3600000;
    return cachedToken;
}

function tenantDateParts(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const result = {};
    for (const part of parts) {
        if (part.type !== 'literal') result[part.type] = part.value;
    }
    return result;
}

function safeSegments(template, values) {
    const rendered = String(template || '')
        .replace(/\{([a-z_]+)\}/gi, (_, key) =>
            values[key.toLowerCase()] == null
                ? ''
                : String(values[key.toLowerCase()])
        );

    const segments = rendered.split(/[\\/]+/).filter(Boolean);
    if (!segments.length) throw new Error('Recording folder template is empty.');

    return segments.map(segment => {
        if (segment === '.' || segment === '..') {
            throw new Error('Unsafe recording folder template.');
        }
        const safe = segment.replace(/[^A-Za-z0-9_.-]/g, '_');
        if (!safe || safe === '.' || safe === '..') {
            throw new Error('Invalid recording folder segment.');
        }
        return safe;
    });
}

async function getRecordingDirectory(settings, tenant, date) {
    const configuredRoot = path.resolve(
        settings.local_base_path || '/var/lib/techlife/recordings'
    );

    const forbidden = candidate =>
        candidate.split(path.sep).some(part =>
            part.toLowerCase() === 'demo-recordings'
        );

    if (!path.isAbsolute(configuredRoot) || forbidden(configuredRoot)) {
        throw new Error('Unsafe local recording directory.');
    }

    await fsp.mkdir(configuredRoot, { recursive: true, mode: 0o750 });
    const realRoot = await fsp.realpath(configuredRoot);

    if (forbidden(realRoot)) {
        throw new Error('Recording directory resolves to a demo directory.');
    }

    const d = tenantDateParts(date, tenant.timezone);
    const folderParts = safeSegments(
        settings.folder_template || '{yyyy}/{mm}/{dd}',
        {
            yyyy: d.year,
            mm: d.month,
            dd: d.day,
            tenant_id: tenant.id,
            tenant_slug: tenant.slug
        }
    );

    const directory = path.resolve(realRoot, tenant.id, ...folderParts);
    if (!directory.startsWith(realRoot + path.sep)) {
        throw new Error('Recording directory escaped its tenant storage root.');
    }

    await fsp.mkdir(directory, { recursive: true, mode: 0o750 });
    const realDirectory = await fsp.realpath(directory);

    if (!realDirectory.startsWith(realRoot + path.sep)) {
        throw new Error('Recording directory contains an unsafe symlink.');
    }

    return { realRoot, realDirectory };
}

function makeFilename(settings, cdr, sourceRecording, recordingId, date) {
    const template = settings.filename_template ||
        '{timestamp}_{call_id}_{recording_id}';

    const rendered = String(template)
        .replace(/\{timestamp\}/gi, date.toISOString().replace(/[:.]/g, '-'))
        .replace(/\{call_id\}/gi, String(cdr.id))
        .replace(/\{cdr_id\}/gi, String(cdr.id))
        .replace(/\{recording_id\}/gi, recordingId);

    let base = rendered
        .replace(/\.wav$/i, '')
        .replace(/[^A-Za-z0-9_.-]/g, '_')
        .replace(/^\.+/, '');

    if (!base) base = recordingId;
    return `${base}.wav`;
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function downloadWav(tenantUuid, cdrId, recordingUuid, token, tempPath) {
    const url = `${CALL_LOGD_URL}/cdr/${encodeURIComponent(cdrId)}` +
        `/recordings/${encodeURIComponent(recordingUuid)}/media`;

    const response = await wazoFetch(url, {
        headers: {
            Accept: 'audio/wav',
            'X-Auth-Token': token,
            'Wazo-Tenant': tenantUuid
        }
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
            `Wazo recording media returned HTTP ${response.status}` +
            (detail ? `: ${detail.slice(0, 180)}` : '')
        );
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_MEDIA_BYTES) {
        throw new Error('Recording exceeds the configured maximum media size.');
    }
    if (!response.body) throw new Error('Wazo returned an empty media body.');

    let written = 0;
    const limiter = new Transform({
        transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > MAX_MEDIA_BYTES) {
                callback(new Error('Recording exceeded the maximum media size.'));
            } else {
                callback(null, chunk);
            }
        }
    });

    try {
        await pipeline(
            Readable.fromWeb(response.body),
            limiter,
            fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o640 })
        );

        if (written < 44) {
            throw new Error('Downloaded recording is too small to be a valid WAV file.');
        }

        const handle = await fsp.open(tempPath, 'r');
        try {
            const header = Buffer.alloc(12);
            const result = await handle.read(header, 0, 12, 0);
            const isRiff = header.toString('ascii', 0, 4) === 'RIFF' ||
                header.toString('ascii', 0, 4) === 'RF64';
            const isWave = header.toString('ascii', 8, 12) === 'WAVE';

            if (result.bytesRead !== 12 || !isRiff || !isWave) {
                throw new Error('Wazo media response is not a valid WAV recording.');
            }
        } finally {
            await handle.close();
        }

        return written;
    } catch (error) {
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function findUniqueTechLifeCall(tenantId, cdrId) {
    const result = await pool.query(`
        SELECT id
        FROM calls
        WHERE tenant_id = $1 AND wazo_cdr_id = $2
        LIMIT 2
    `, [tenantId, cdrId]);

    return result.rows.length === 1 ? result.rows[0].id : null;
}

async function alreadyImported(tenantId, cdrId, recordingUuid) {
    const result = await pool.query(`
        SELECT id
        FROM recordings
        WHERE tenant_id = $1
          AND wazo_cdr_id = $2
          AND wazo_recording_uuid = $3
        LIMIT 1
    `, [tenantId, cdrId, recordingUuid]);

    return result.rowCount > 0;
}

async function importRecording(settings, tenant, cdr, sourceRecording, token) {
    if (!Number.isSafeInteger(Number(cdr.id)) || Number(cdr.id) < 1) {
        throw new Error('Invalid Wazo CDR ID.');
    }

    const cdrId = Number(cdr.id);
    const sourceUuid = String(sourceRecording.uuid || '');

    if (!validUuid(sourceUuid)) {
        throw new Error('Wazo recording entry has an invalid recording UUID.');
    }
    if (sourceRecording.deleted === true) return false;

    if (await alreadyImported(tenant.id, cdrId, sourceUuid)) {
        return false;
    }

    const recordingId = crypto.randomUUID();
    const start = new Date(sourceRecording.start_time || cdr.start || Date.now());
    const endValue = sourceRecording.end_time || cdr.end || null;
    const end = endValue ? new Date(endValue) : null;

    if (Number.isNaN(start.getTime()) ||
        (end && Number.isNaN(end.getTime()))) {
        throw new Error('Wazo recording has invalid date metadata.');
    }

    const { realRoot, realDirectory } =
        await getRecordingDirectory(settings, tenant, start);

    const filename = makeFilename(
        settings, cdr, sourceRecording, recordingId, start
    );
    const targetPath = path.join(realDirectory, filename);
    const tempPath = `${targetPath}.${crypto.randomUUID()}.part`;

    let fileCreated = false;

    try {
        await downloadWav(
            tenant.wazo_tenant_uuid,
            cdrId,
            sourceUuid,
            token,
            tempPath
        );

        await fsp.rename(tempPath, targetPath);
        fileCreated = true;

        const stat = await fsp.stat(targetPath);
        const checksum = await sha256File(targetPath);
        const relativePath = path.relative(realRoot, targetPath);
        const callId = await findUniqueTechLifeCall(tenant.id, cdrId);

        const duration = end
            ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000))
            : (Number.isFinite(Number(cdr.duration))
                ? Math.max(0, Math.floor(Number(cdr.duration)))
                : null);

        const conversationId = validUuid(String(cdr.conversation_id || ''))
            ? String(cdr.conversation_id)
            : null;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const inserted = await client.query(`
                INSERT INTO recordings (
                    id, tenant_id, call_id, conversation_id,
                    file_path, storage_backend, duration_seconds,
                    file_size_bytes, is_downloadable, created_at,
                    wazo_cdr_id, wazo_recording_uuid, wazo_tenant_uuid,
                    source_filename, source_started_at, source_ended_at
                ) VALUES (
                    $1,$2,$3,$4,$5,'local',$6,$7,$8,NOW(),
                    $9,$10,$11,$12,$13,$14
                )
                ON CONFLICT (tenant_id, wazo_cdr_id, wazo_recording_uuid)
                WHERE wazo_cdr_id IS NOT NULL
                  AND wazo_recording_uuid IS NOT NULL
                DO NOTHING
                RETURNING id
            `, [
                recordingId,
                tenant.id,
                callId,
                conversationId,
                targetPath,
                duration,
                stat.size,
                settings.download_enabled === true,
                cdrId,
                sourceUuid,
                tenant.wazo_tenant_uuid,
                sourceRecording.filename
                    ? String(sourceRecording.filename).slice(0, 1000)
                    : null,
                start,
                end
            ]);

            if (!inserted.rowCount) {
                await client.query('ROLLBACK');
                await fsp.unlink(targetPath).catch(() => {});
                return false;
            }

            await client.query(`
                INSERT INTO recording_storage_copies (
                    tenant_id, recording_id, copy_type, provider,
                    object_key, copy_status, checksum_sha256,
                    size_bytes, verified_at, created_at, updated_at
                ) VALUES (
                    $1,$2,'local','local',$3,'available',$4,$5,NOW(),NOW(),NOW()
                )
                ON CONFLICT (recording_id, copy_type)
                DO UPDATE SET
                    provider = 'local',
                    object_key = EXCLUDED.object_key,
                    copy_status = 'available',
                    checksum_sha256 = EXCLUDED.checksum_sha256,
                    size_bytes = EXCLUDED.size_bytes,
                    last_error = NULL,
                    verified_at = NOW(),
                    updated_at = NOW()
            `, [tenant.id, recordingId, relativePath, checksum, stat.size]);

            if (settings.remote_upload_enabled === true &&
                settings.storage_provider === 'sftp') {
                await client.query(`
                    INSERT INTO recording_storage_jobs (
                        id, tenant_id, recording_id, job_type,
                        job_status, attempts, max_attempts,
                        available_at, created_at, updated_at
                    )
                    VALUES (
                        gen_random_uuid(), $1, $2, 'remote_upload',
                        'pending', 0, 8, NOW(), NOW(), NOW()
                    )
                    ON CONFLICT (tenant_id, recording_id, job_type)
                    DO NOTHING
                `, [tenant.id, recordingId]);
            }

            if (callId) {
                await client.query(`
                    UPDATE calls
                    SET recording_id = COALESCE(recording_id, $2)
                    WHERE tenant_id = $1 AND id = $3
                `, [tenant.id, recordingId, callId]);
            }

            await client.query('COMMIT');
            return true;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        if (fileCreated) await fsp.unlink(targetPath).catch(() => {});
        await fsp.unlink(tempPath).catch(() => {});
        throw error;
    }
}

async function fetchCdrPage(tenantUuid, token, from, until, offset) {
    const url = new URL(`${CALL_LOGD_URL}/cdr`);
    const params = {
        from: from.toISOString(),
        until: until.toISOString(),
        limit: String(PAGE_SIZE),
        offset: String(offset),
        order: 'start',
        direction: 'asc',
        recorded: 'true',
        format: 'json'
    };

    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }

    const response = await wazoFetch(url.toString(), {
        headers: {
            Accept: 'application/json',
            'X-Auth-Token': token,
            'Wazo-Tenant': tenantUuid
        }
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`Wazo CDR scan failed: HTTP ${response.status}`);
    }
    if (!Array.isArray(payload.items)) {
        throw new Error('Wazo CDR response did not contain an items array.');
    }

    return payload;
}

async function scanTenant(settings, tenant, token) {
    const now = new Date();
    const previous = settings.recording_ingestion_last_scan_at
        ? new Date(settings.recording_ingestion_last_scan_at)
        : new Date(now.getTime() -
            Number(settings.recording_ingestion_history_days || 7) * 86400000);

    // Overlap scans protect against CDRs becoming available after the first scan.
    const from = new Date(previous.getTime() - 5 * 60 * 1000);
    let offset = 0;
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let firstError = null;

    for (let page = 0; page < MAX_PAGES; page++) {
        const payload = await fetchCdrPage(
            tenant.wazo_tenant_uuid, token, from, now, offset
        );
        const items = payload.items;

        for (const cdr of items) {
            if (!Array.isArray(cdr.recordings)) continue;

            for (const sourceRecording of cdr.recordings) {
                if (!sourceRecording || sourceRecording.deleted === true) {
                    skipped++;
                    continue;
                }

                try {
                    const added = await importRecording(
                        settings, tenant, cdr, sourceRecording, token
                    );
                    if (added) imported++;
                    else skipped++;
                } catch (error) {
                    failed++;
                    if (!firstError) firstError = error.message;
                    log(`Tenant ${tenant.id}, CDR ${cdr.id}: ${error.message}`);
                }
            }
        }

        offset += items.length;
        if (!items.length ||
            items.length < PAGE_SIZE ||
            (Number.isFinite(Number(payload.total)) &&
                offset >= Number(payload.total))) {
            break;
        }

        if (page === MAX_PAGES - 1) {
            throw new Error('CDR scan reached the pagination safety limit.');
        }
    }

    return {
        imported,
        skipped,
        failed,
        firstError,
        scannedFrom: from,
        scannedUntil: now
    };
}

async function reconcileRecordingIngestion() {
    if (workerRunning) {
        return { skipped: true, reason: 'recording ingestion cycle is already running' };
    }
    workerRunning = true;
    let lockClient = null;
    let lockAcquired = false;

    try {
        lockClient = await pool.connect();
        const lock = await lockClient.query(`
            SELECT pg_try_advisory_lock(
                hashtext('techlife-recording-ingestion')
            ) AS acquired
        `);

        if (!lock.rows[0]?.acquired) {
            return { skipped: true, reason: 'another recording ingestion worker is active' };
        }
        lockAcquired = true;

        const due = await pool.query(`
            SELECT s.*,
                   t.name AS tenant_name,
                   t.slug AS tenant_slug,
                   t.timezone,
                   t.wazo_tenant_uuid::text AS wazo_tenant_uuid
            FROM recording_settings s
            JOIN tenants t ON t.id = s.tenant_id
            WHERE s.recording_ingestion_enabled = TRUE
              AND EXISTS (
                  SELECT 1
                    FROM tenant_features tf
                   WHERE tf.tenant_id = s.tenant_id
                     AND tf.feature_key = 'call_recording'
                     AND tf.is_enabled = TRUE
              )
              AND (
                  s.recording_ingestion_status <> 'running'
                  OR s.recording_ingestion_last_run_at IS NULL
                  OR s.recording_ingestion_last_run_at < NOW() - INTERVAL '30 minutes'
              )
              AND (s.recording_ingestion_next_run_at IS NULL
                   OR s.recording_ingestion_next_run_at <= NOW())
              AND t.is_active = TRUE
              AND t.wazo_tenant_uuid IS NOT NULL
            ORDER BY s.recording_ingestion_next_run_at NULLS FIRST
            LIMIT 20
        `);

        const summary = {
            tenants: due.rowCount,
            imported: 0,
            skipped: 0,
            failed: 0
        };

        if (!due.rowCount) return summary;

        const token = await getWazoToken();

        for (const settings of due.rows) {
            // Recheck after scheduler selection so a recently disabled
            // tenant is not started by a stale due-list entry.
            const featureCheck = await pool.query(
                `SELECT is_enabled
                   FROM tenant_features
                  WHERE tenant_id = $1
                    AND feature_key = 'call_recording'`,
                [settings.tenant_id]
            );

            if (featureCheck.rows[0]?.is_enabled !== true) {
                continue;
            }

            const tenant = {
                id: settings.tenant_id,
                name: settings.tenant_name,
                slug: settings.tenant_slug,
                timezone: settings.timezone,
                wazo_tenant_uuid: settings.wazo_tenant_uuid
            };

            await pool.query(`
                UPDATE recording_settings
                SET recording_ingestion_status = 'running',
                    recording_ingestion_last_run_at = NOW(),
                    recording_ingestion_last_error = NULL,
                    updated_at = NOW()
                WHERE tenant_id = $1
            `, [tenant.id]);

            try {
                const result = await scanTenant(settings, tenant, token);
                summary.imported += result.imported;
                summary.skipped += result.skipped;
                summary.failed += result.failed;

                const interval = Number(
                    settings.recording_ingestion_interval_minutes || 5
                );

                await pool.query(`
                    UPDATE recording_settings
                    SET recording_ingestion_status = $2,
                        recording_ingestion_last_scan_at = CASE
                            WHEN $2 = 'succeeded' THEN $3
                            ELSE recording_ingestion_last_scan_at
                        END,
                        recording_ingestion_next_run_at =
                            NOW() + ($4 * INTERVAL '1 minute'),
                        recording_ingestion_last_error = $5,
                        updated_at = NOW()
                    WHERE tenant_id = $1
                `, [
                    tenant.id,
                    result.failed ? 'failed' : 'succeeded',
                    result.scannedUntil,
                    interval,
                    result.firstError
                ]);

                log(
                    `Tenant ${tenant.id}: imported=${result.imported}, ` +
                    `skipped=${result.skipped}, failed=${result.failed}.`
                );
            } catch (error) {
                summary.failed++;

                await pool.query(`
                    UPDATE recording_settings
                    SET recording_ingestion_status = 'failed',
                        recording_ingestion_last_error = $2,
                        recording_ingestion_next_run_at =
                            NOW() + (recording_ingestion_interval_minutes *
                                     INTERVAL '1 minute'),
                        updated_at = NOW()
                    WHERE tenant_id = $1
                `, [tenant.id, String(error.message).slice(0, 2000)]);

                log(`Tenant ${tenant.id} ingestion failed: ${error.message}`);
            }
        }

        return summary;
    } finally {
        try {
            if (lockAcquired) {
                await lockClient.query(`
                    SELECT pg_advisory_unlock(
                        hashtext('techlife-recording-ingestion')
                    )
                `);
            }
        } finally {
            if (lockClient) lockClient.release();
            workerRunning = false;
        }
    }
}

function startRecordingIngestionWorker(intervalMs = 30000) {
    if (activeTimer) return;

    const run = async () => {
        try {
            const result = await reconcileRecordingIngestion();
            if (result && !result.skipped && result.tenants) {
                log(`Cycle summary: ${JSON.stringify(result)}`);
            }
        } catch (error) {
            log(`Worker error: ${error.message}`);
        }
    };

    run();
    activeTimer = setInterval(run, Math.max(10000, intervalMs));
    if (typeof activeTimer.unref === 'function') activeTimer.unref();
}

module.exports = {
    reconcileRecordingIngestion,
    startRecordingIngestionWorker
};
