const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'audio');
const ASTERISK_SOUND_ROOT = process.env.ASTERISK_SOUND_ROOT || path.join(__dirname, '..', 'public', 'uploads', 'asterisk');

function ensureDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function buildStorageFileName(originalName) {
    const ext = path.extname(originalName || '').toLowerCase() || '.wav';
    return `${crypto.randomBytes(12).toString('hex')}${ext}`;
}

function makePublicUrl(fileName) {
    return `/uploads/audio/${fileName}`;
}

function resolveAsteriskPath(tenantId, fileName) {
    return path.join(ASTERISK_SOUND_ROOT, String(tenantId), fileName);
}

function copyToAsterisk(tenantId, sourcePath, targetName) {
    const tenantDir = path.join(ASTERISK_SOUND_ROOT, String(tenantId));
    ensureDirectory(tenantDir);
    const targetPath = path.join(tenantDir, targetName);
    fs.copyFileSync(sourcePath, targetPath);
    return targetPath;
}

async function registerAudioAsset({ tenantId, originalName, sourcePath, kind = 'ivr' }) {
    ensureDirectory(PUBLIC_UPLOAD_DIR);
    const fileName = buildStorageFileName(originalName);
    const targetPublicPath = path.join(PUBLIC_UPLOAD_DIR, fileName);
    fs.copyFileSync(sourcePath, targetPublicPath);
    const asteriskPath = copyToAsterisk(tenantId, targetPublicPath, fileName);

    return {
        kind,
        originalName,
        fileName,
        publicUrl: makePublicUrl(fileName),
        publicPath: targetPublicPath,
        asteriskPath,
    };
}

function getQueuePositionSummary({ queueName, callersAhead = 0, currentCaller = null, estimatedWaitSeconds = 0 }) {
    return {
        queueName: queueName || 'Queue',
        caller: currentCaller || 'Current caller',
        position: Math.max(1, callersAhead + 1),
        callersAhead: Math.max(0, callersAhead),
        estimatedWaitSeconds: Math.max(0, estimatedWaitSeconds),
        announcement: `You are number ${Math.max(1, callersAhead + 1)} in the ${queueName || 'queue'} queue.`
    };
}

module.exports = { registerAudioAsset, getQueuePositionSummary, resolveAsteriskPath, ensureDirectory };
