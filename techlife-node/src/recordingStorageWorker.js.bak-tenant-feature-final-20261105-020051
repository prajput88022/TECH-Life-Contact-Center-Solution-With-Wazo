'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pool } = require('./db');
const trunkCredentialCrypto = require('./trunkCredentialCrypto');

let workerRunning = false;
let timer = null;

function log(message) {
    console.log(`[recording-storage] ${message}`);
}

function decodeSecrets(secretRef) {
    if (!secretRef) return {};
    const value = JSON.parse(trunkCredentialCrypto.decrypt(secretRef));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid encrypted recording credentials.');
    }
    return value;
}

function normalizeFingerprint(value) {
    let raw = String(value || '').trim()
        .replace(/^SHA256:/i, '')
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        throw new Error('Invalid SFTP SHA256 host fingerprint.');
    }

    raw = raw.replace(/=+$/, '');
    raw += '='.repeat((4 - raw.length % 4) % 4);

    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== raw) {
        throw new Error('SFTP host fingerprint must contain 32 SHA256 bytes.');
    }
    return raw;
}

function sftpFingerprint(settings) {
    const cfg = settings.provider_config || {};
    const secrets = decodeSecrets(settings.secret_ref);
    const hostKey = normalizeFingerprint(settings.host_key_sha256);
    const sftp = secrets.sftp || {};

    const host = String(cfg.host || '').trim();
    const port = Number(cfg.port || 22);
    const username = String(cfg.username || '').trim();
    const remotePath = String(cfg.remote_path || '').trim();

    if (!host || /[\/@?#\s\r\n]/.test(host) ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        !username || !remotePath) {
        throw new Error('Saved SFTP host settings are incomplete.');
    }
    if (!sftp.sftp_private_key && !sftp.sftp_password) {
        throw new Error('No SFTP password or private key is saved.');
    }

    return crypto.createHash('sha256').update(JSON.stringify({
        host, port, username, remotePath,
        hostKey,
        secrets: sftp
    })).digest('hex');
}

function curlQuote(value) {
    const text = String(value);
    if (/[\r\n\0]/.test(text)) {
        throw new Error('Invalid control character in SFTP configuration.');
    }
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function safeSegments(value, label) {
    const parts = String(value || '').split('/').filter(Boolean);
    if (!parts.length) {
        if (label === 'remote root') return [];
        throw new Error(`${label} is empty.`);
    }

    for (const part of parts) {
        if (part === '.' || part === '..' ||
            !/^[A-Za-z0-9_.-]+$/.test(part)) {
            throw new Error(`${label} contains an unsafe path segment.`);
        }
    }
    return parts;
}

function buildSftpUrl(host, port, parts) {
    const url = new URL(`sftp://${host}:${port}/`);
    url.pathname = '/' + parts.map(encodeURIComponent).join('/');
    return url.toString();
}

function runCurl(args, timeoutMs = 1800000) {
    return new Promise((resolve, reject) => {
        const child = spawn('curl', args, {
            stdio: ['ignore', 'ignore', 'pipe']
        });

        let stderr = '';
        let settled = false;

        const timerId = setTimeout(() => {
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stderr.on('data', chunk => {
            if (stderr.length < 2500) {
                stderr += chunk.toString().slice(0, 2500 - stderr.length);
            }
        });

        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timerId);
            reject(error);
        });

        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timerId);

            if (code === 0) return resolve();
            reject(new Error(
                `SFTP operation failed (curl exit ${code}). ` +
                (stderr.trim().slice(0, 1500) || 'No diagnostic returned.')
            ));
        });
    });
}

async function withSftpConfig(settings, callback) {
    const cfg = settings.provider_config || {};
    const secrets = decodeSecrets(settings.secret_ref);
    const sftp = secrets.sftp || {};
    const fingerprint = normalizeFingerprint(settings.host_key_sha256);

    const host = String(cfg.host || '').trim();
    const port = Number(cfg.port || 22);
    const username = String(cfg.username || '').trim();

    if (!host || /[\/@?#\s\r\n]/.test(host) ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        !username) {
        throw new Error('Invalid SFTP host, port or username.');
    }

    if (!sftp.sftp_private_key && !sftp.sftp_password) {
        throw new Error('No SFTP authentication credential is configured.');
    }

    const tempDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), 'techlife-sftp-job-')
    );
    await fsp.chmod(tempDir, 0o700);

    try {
        const lines = [
            'silent',
            'show-error',
            'connect-timeout = 15',
            'max-time = 1800',
            'hostpubsha256 = ' + curlQuote(fingerprint)
        ];

        if (sftp.sftp_private_key) {
            const keyPath = path.join(tempDir, 'identity');
            await fsp.writeFile(keyPath, sftp.sftp_private_key, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx'
            });
            lines.push('key = ' + curlQuote(keyPath));
            if (sftp.sftp_passphrase) {
                lines.push('pass = ' + curlQuote(sftp.sftp_passphrase));
            }
            lines.push('user = ' + curlQuote(username));
        } else {
            lines.push('user = ' + curlQuote(
                username + ':' + sftp.sftp_password
            ));
        }

        const configPath = path.join(tempDir, 'curl.conf');
        await fsp.writeFile(configPath, lines.join('\n') + '\n', {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
        });

        await callback({
            configPath,
            tempDir,
            host,
            port,
            remoteRoot: String(cfg.remote_path || '').trim()
        });
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
    }
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function getSafeLocalFile(settings, recording) {
    const root = path.resolve(settings.local_base_path);
    if (root.split(path.sep).some(x => x.toLowerCase() === 'demo-recordings')) {
        throw new Error('Demo recording storage is never eligible for upload.');
    }

    const realRoot = await fsp.realpath(root);
    const realFile = await fsp.realpath(recording.file_path);

    if (!realFile.startsWith(realRoot + path.sep) ||
        realFile.split(path.sep).some(x => x.toLowerCase() === 'demo-recordings')) {
        throw new Error('Recording file is outside its tenant local storage root.');
    }

    const stat = await fsp.stat(realFile);
    if (!stat.isFile() || stat.size < 44) {
        throw new Error('Local recording file is missing or invalid.');
    }

    const handle = await fsp.open(realFile, 'r');
    try {
        const header = Buffer.alloc(12);
        const read = await handle.read(header, 0, 12, 0);
        if (read.bytesRead !== 12 ||
            !['RIFF', 'RF64'].includes(header.toString('ascii', 0, 4)) ||
            header.toString('ascii', 8, 12) !== 'WAVE') {
            throw new Error('Local recording is not a valid WAV file.');
        }
    } finally {
        await handle.close();
    }

    const relative = path.relative(realRoot, realFile)
        .split(path.sep);

    return { realFile, realRoot, relative, stat };
}

async function uploadAndVerify(settings, recording) {
    const local = await getSafeLocalFile(settings, recording);
    const cfg = settings.provider_config || {};

    const rootParts = safeSegments(cfg.remote_path, 'remote root');
    const prefixParts = safeSegments(
        settings.destination_prefix, 'remote prefix'
    );

    const relativeParts = local.relative;
    if (!relativeParts.length ||
        relativeParts.some(part =>
            part === '.' || part === '..' ||
            !/^[A-Za-z0-9_.-]+$/.test(part))) {
        throw new Error('Local recording path cannot safely map to SFTP.');
    }

    const objectParts = prefixParts.concat(relativeParts);
    const targetParts = rootParts.concat(objectParts);
    const remoteUrl = buildSftpUrl(
        String(cfg.host).trim(),
        Number(cfg.port || 22),
        targetParts
    );

    const expectedChecksum = await sha256File(local.realFile);

    await withSftpConfig(settings, async ({ configPath, tempDir }) => {
        const args = ['--config', configPath];

        // The saved remote root is tested by the connection-test endpoint.
        // Create only the subdirectories below that root.
        const directories = objectParts.slice(0, -1);
        for (let i = 1; i <= directories.length; i++) {
            const remoteDirectory = '/' +
                rootParts.concat(directories.slice(0, i)).join('/');
            args.push('--quote', `*mkdir ${remoteDirectory}`);
        }

        args.push('--upload-file', local.realFile, remoteUrl);
        await runCurl(args);

        const verifyPath = path.join(tempDir, 'remote-verify.wav');
        await runCurl([
            '--config', configPath,
            '--max-filesize', String(local.stat.size),
            '--output', verifyPath,
            remoteUrl
        ], 300000);

        const remoteStat = await fsp.stat(verifyPath);
        if (remoteStat.size !== local.stat.size) {
            throw new Error('Remote verification failed: file sizes differ.');
        }

        const actualRemoteChecksum = await sha256File(verifyPath);
        if (actualRemoteChecksum !== expectedChecksum) {
            throw new Error('Remote verification failed: SHA256 checksums differ.');
        }
    });

    return {
        objectKey: targetParts.join('/'),
        size: local.stat.size,
        checksum: expectedChecksum
    };
}

async function claimJobs(tenantId, batchSize) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const rows = await client.query(`
            SELECT j.id AS job_id,
                   j.recording_id,
                   j.attempts,
                   j.max_attempts,
                   r.file_path,
                   r.file_size_bytes,
                   r.tenant_id
            FROM recording_storage_jobs j
            JOIN recordings r
              ON r.id = j.recording_id
             AND r.tenant_id = j.tenant_id
            WHERE j.tenant_id = $1
              AND j.job_type = 'remote_upload'
              AND j.job_status IN ('pending','failed')
              AND j.attempts < j.max_attempts
              AND j.available_at <= NOW()
              AND r.storage_backend = 'local'
              AND r.file_path NOT LIKE '%/demo-recordings/%'
              AND r.file_path NOT LIKE '%SYNTHETIC_DEMO_ONLY%'
              AND NOT EXISTS (
                  SELECT 1
                  FROM recording_storage_copies c
                  WHERE c.recording_id = r.id
                    AND c.copy_type = 'remote'
                    AND c.copy_status = 'available'
              )
            ORDER BY j.available_at, j.created_at
            LIMIT $2
            FOR UPDATE OF j SKIP LOCKED
        `, [tenantId, batchSize]);

        for (const row of rows.rows) {
            await client.query(`
                UPDATE recording_storage_jobs
                SET job_status = 'running',
                    attempts = attempts + 1,
                    locked_at = NOW(),
                    last_error = NULL,
                    updated_at = NOW()
                WHERE id = $1
            `, [row.job_id]);
        }

        await client.query('COMMIT');
        return rows.rows.map(row => ({
            ...row,
            attempts: Number(row.attempts) + 1
        }));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function markCopyUploading(settings, job, objectKey) {
    await pool.query(`
        INSERT INTO recording_storage_copies (
            tenant_id, recording_id, copy_type, provider,
            object_key, copy_status, created_at, updated_at
        ) VALUES ($1,$2,'remote','sftp',$3,'uploading',NOW(),NOW())
        ON CONFLICT (recording_id, copy_type)
        DO UPDATE SET
            provider = 'sftp',
            object_key = EXCLUDED.object_key,
            copy_status = 'uploading',
            last_error = NULL,
            updated_at = NOW()
    `, [settings.tenant_id, job.recording_id, objectKey]);
}

async function markJobSucceeded(settings, job, result) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(`
            UPDATE recording_storage_copies
            SET provider = 'sftp',
                object_key = $3,
                copy_status = 'available',
                checksum_sha256 = $4,
                size_bytes = $5,
                last_error = NULL,
                verified_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = $1
              AND recording_id = $2
              AND copy_type = 'remote'
        `, [
            settings.tenant_id,
            job.recording_id,
            result.objectKey,
            result.checksum,
            result.size
        ]);

        await client.query(`
            UPDATE recording_storage_jobs
            SET job_status = 'succeeded',
                locked_at = NULL,
                last_error = NULL,
                updated_at = NOW()
            WHERE id = $1
        `, [job.job_id]);

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function markJobFailed(settings, job, error) {
    const message = String(error.message || error).slice(0, 1800);
    const delaySeconds = Math.min(
        3600,
        30 * Math.pow(2, Math.min(job.attempts - 1, 7))
    );

    await pool.query(`
        UPDATE recording_storage_copies
        SET provider = 'sftp',
            copy_status = 'failed',
            last_error = $3,
            updated_at = NOW()
        WHERE tenant_id = $1
          AND recording_id = $2
          AND copy_type = 'remote'
    `, [settings.tenant_id, job.recording_id, message]);

    await pool.query(`
        UPDATE recording_storage_jobs
        SET job_status = 'failed',
            locked_at = NULL,
            last_error = $2,
            available_at = NOW() + ($3 * INTERVAL '1 second'),
            updated_at = NOW()
        WHERE id = $1
    `, [job.job_id, message, delaySeconds]);

    log(`Tenant ${settings.tenant_id}, job ${job.job_id}: ${message}`);
}

function localParts(timezone, date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);

    const result = {};
    for (const part of parts) {
        if (part.type !== 'literal') result[part.type] = Number(part.value);
    }
    return result;
}

function localWallTimeToUtc(year, month, day, hour, minute, timezone) {
    const target = Date.UTC(year, month - 1, day, hour, minute, 0);
    let guess = target;

    for (let i = 0; i < 5; i++) {
        const actual = localParts(timezone, new Date(guess));
        const actualAsUtc = Date.UTC(
            actual.year, actual.month - 1, actual.day,
            actual.hour, actual.minute, 0
        );
        const offset = actualAsUtc - guess;
        const next = target - offset;
        if (next === guess) break;
        guess = next;
    }

    return new Date(guess);
}

function nextUploadRun(settings, timezone, now = new Date()) {
    if ((settings.upload_schedule_mode || 'interval') === 'interval') {
        const minutes = Number(settings.upload_interval_minutes || 5);
        return new Date(now.getTime() + minutes * 60000);
    }

    const time = String(settings.upload_schedule_time || '02:00:00').slice(0, 5);
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match) throw new Error('Invalid daily upload time.');

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const current = localParts(timezone, now);

    let next = localWallTimeToUtc(
        current.year, current.month, current.day,
        hour, minute, timezone
    );

    if (next <= now) {
        const nextDay = new Date(Date.UTC(
            current.year, current.month - 1, current.day + 1
        ));
        next = localWallTimeToUtc(
            nextDay.getUTCFullYear(),
            nextDay.getUTCMonth() + 1,
            nextDay.getUTCDate(),
            hour, minute, timezone
        );
    }

    return next;
}

async function processTenant(settings) {
    let current;
    try {
        const result = await pool.query(`
            SELECT *
            FROM recording_settings
            WHERE tenant_id = $1
              AND remote_upload_enabled = TRUE
              AND storage_provider = 'sftp'
        `, [settings.tenant_id]);

        current = result.rows[0];
        if (!current) return;

        const actualFingerprint = sftpFingerprint(current);
        if (!current.connection_test_fingerprint ||
            current.connection_test_error ||
            actualFingerprint !== current.connection_test_fingerprint) {
            await pool.query(`
                UPDATE recording_settings
                SET remote_upload_enabled = FALSE,
                    upload_next_run_at = NULL,
                    upload_last_error =
                        'SFTP configuration changed or connection test is no longer valid. Test the saved connection again.',
                    updated_at = NOW()
                WHERE tenant_id = $1
            `, [settings.tenant_id]);
            log(`Tenant ${settings.tenant_id}: remote sync paused; SFTP test is no longer valid.`);
            return;
        }
    } catch (error) {
        await pool.query(`
            UPDATE recording_settings
            SET remote_upload_enabled = FALSE,
                upload_next_run_at = NULL,
                upload_last_error = $2,
                updated_at = NOW()
            WHERE tenant_id = $1
        `, [
            settings.tenant_id,
            String(error.message || error).slice(0, 1500)
        ]).catch(() => {});
        return;
    }

    const nextRun = nextUploadRun(current, settings.timezone);

    await pool.query(`
        UPDATE recording_settings
        SET upload_last_run_at = NOW(),
            upload_next_run_at = $2,
            upload_last_error = NULL,
            last_upload_scan_at = NOW(),
            updated_at = NOW()
        WHERE tenant_id = $1
          AND remote_upload_enabled = TRUE
    `, [settings.tenant_id, nextRun]);

    const jobs = await claimJobs(
        settings.tenant_id,
        Number(current.upload_batch_size || 20)
    );

    for (const job of jobs) {
        const liveSetting = await pool.query(`
            SELECT remote_upload_enabled, storage_provider
            FROM recording_settings
            WHERE tenant_id = $1
        `, [settings.tenant_id]);

        if (!liveSetting.rows[0]?.remote_upload_enabled ||
            liveSetting.rows[0]?.storage_provider !== 'sftp') {
            await pool.query(`
                UPDATE recording_storage_jobs
                SET job_status = 'pending',
                    locked_at = NULL,
                    available_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1 AND job_status = 'running'
            `, [job.job_id]);
            continue;
        }

        try {
            const objectParts = safeSegments(
                current.destination_prefix, 'remote prefix'
            );
            const remoteRoot = safeSegments(
                (current.provider_config || {}).remote_path, 'remote root'
            );
            const relative = path.relative(
                path.resolve(current.local_base_path),
                path.resolve(job.file_path)
            ).split(path.sep);

            const objectKey = remoteRoot.concat(objectParts, relative).join('/');
            await markCopyUploading(current, job, objectKey);

            const result = await uploadAndVerify(current, {
                file_path: job.file_path
            });

            await markJobSucceeded(current, job, result);
        } catch (error) {
            await markJobFailed(current, job, error);
            await pool.query(`
                UPDATE recording_settings
                SET upload_last_error = $2,
                    updated_at = NOW()
                WHERE tenant_id = $1
            `, [
                settings.tenant_id,
                String(error.message || error).slice(0, 1500)
            ]).catch(() => {});
        }
    }

    log(`Tenant ${settings.tenant_id}: claimed=${jobs.length}, batch=${current.upload_batch_size}.`);
}

async function reconcileRecordingStorage() {
    if (workerRunning) {
        return { skipped: true, reason: 'storage worker already running' };
    }
    workerRunning = true;

    let lockClient = null;
    let lockAcquired = false;

    try {
        lockClient = await pool.connect();

        const lock = await lockClient.query(`
            SELECT pg_try_advisory_lock(
                hashtext('techlife-recording-storage')
            ) AS acquired
        `);

        if (!lock.rows[0]?.acquired) {
            return { skipped: true, reason: 'another storage worker is active' };
        }
        lockAcquired = true;

        // Recover jobs whose worker process died while holding a job.
        await pool.query(`
            UPDATE recording_storage_jobs
            SET job_status = 'failed',
                locked_at = NULL,
                last_error = 'Recovered stale running job after worker interruption.',
                available_at = NOW(),
                updated_at = NOW()
            WHERE job_status = 'running'
              AND locked_at < NOW() - INTERVAL '30 minutes'
        `);

        const due = await pool.query(`
            SELECT s.*, t.timezone, t.slug
            FROM recording_settings s
            JOIN tenants t ON t.id = s.tenant_id
            WHERE s.remote_upload_enabled = TRUE
              AND s.storage_provider = 'sftp'
              AND t.is_active = TRUE
              AND (s.upload_next_run_at IS NULL
                   OR s.upload_next_run_at <= NOW())
            ORDER BY s.upload_next_run_at NULLS FIRST
            LIMIT 10
        `);

        for (const settings of due.rows) {
            try {
                await processTenant(settings);
            } catch (error) {
                log(`Tenant ${settings.tenant_id}: ${error.message}`);
                await pool.query(`
                    UPDATE recording_settings
                    SET upload_last_error = $2,
                        upload_next_run_at = NOW() + INTERVAL '5 minutes',
                        updated_at = NOW()
                    WHERE tenant_id = $1
                `, [
                    settings.tenant_id,
                    String(error.message || error).slice(0, 1500)
                ]).catch(() => {});
            }
        }

        return { tenants: due.rowCount };
    } finally {
        try {
            if (lockAcquired && lockClient) {
                await lockClient.query(`
                    SELECT pg_advisory_unlock(
                        hashtext('techlife-recording-storage')
                    )
                `);
            }
        } finally {
            if (lockClient) lockClient.release();
            workerRunning = false;
        }
    }
}

function startRecordingStorageWorker(intervalMs = 30000) {
    if (timer) return;

    const run = async () => {
        try {
            await reconcileRecordingStorage();
        } catch (error) {
            log(`Worker error: ${error.message}`);
        }
    };

    run();
    timer = setInterval(run, Math.max(10000, intervalMs));
    if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
    reconcileRecordingStorage,
    startRecordingStorageWorker,
    getSftpConfigurationFingerprint: sftpFingerprint
};
