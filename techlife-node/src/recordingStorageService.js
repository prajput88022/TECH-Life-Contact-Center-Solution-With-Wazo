'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const DEMO_DIR = '/var/lib/techlife/demo-recordings';
const DEFAULT_RECORDINGS_DIR = '/var/lib/techlife/recordings';

function validUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
}

function isInside(file, root) {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..' + path.sep) &&
        relative !== '..' && !path.isAbsolute(relative));
}

async function findLocalRecording({ id, tenantId }) {
    if (!validUuid(id) || !validUuid(tenantId)) {
        const error = new Error('Invalid recording ID or tenant');
        error.status = 400;
        throw error;
    }

    const result = await pool.query(
        `SELECT r.id, r.file_path, r.storage_backend, r.file_size_bytes,
                r.is_downloadable, r.tenant_id, r.created_at,
                COALESCE(s.local_base_path, $3) AS local_base_path
         FROM recordings r
         LEFT JOIN recording_settings s ON s.tenant_id = r.tenant_id
         WHERE r.id = $1 AND r.tenant_id = $2
           AND r.is_downloadable = TRUE`,
        [id, tenantId, DEFAULT_RECORDINGS_DIR]
    );

    const rec = result.rows[0];
    if (!rec) {
        const error = new Error('Recording not found or download is disabled');
        error.status = 404;
        throw error;
    }

    if (rec.storage_backend !== 'local' || !rec.file_path) {
        const error = new Error('This recording is not available in local storage');
        error.status = 501;
        throw error;
    }

    let file;
    try {
        file = fs.realpathSync(rec.file_path);
    } catch {
        const error = new Error('Recording file is missing');
        error.status = 404;
        throw error;
    }

    const configuredRoots = [rec.local_base_path, DEMO_DIR];
    const permittedRoots = [];

    for (const root of configuredRoots) {
        if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
        try {
            permittedRoots.push(fs.realpathSync(root));
        } catch {
            // A not-yet-created storage directory is not an allowed root.
        }
    }

    if (!permittedRoots.some(root => isInside(file, root))) {
        const error = new Error('Recording file is outside the permitted storage directories');
        error.status = 403;
        throw error;
    }

    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        const error = new Error('Recording file is missing');
        error.status = 404;
        throw error;
    }

    if (!stat.isFile()) {
        const error = new Error('Recording path is not a regular file');
        error.status = 404;
        throw error;
    }

    return { ...rec, file, file_size_bytes: stat.size };
}

module.exports = { findLocalRecording };
