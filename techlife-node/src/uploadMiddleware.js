/**
 * Multer upload configs used across admin routes: campaign audio
 * (voice-blast/survey prompts) and lead CSV files. Both write to
 * public/uploads/* with a randomized filename to avoid collisions/
 * path traversal from the original filename, and both cap file size.
 */
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

function randomizedStorage(subdir, allowedExts) {
    return multer.diskStorage({
        destination: path.join(__dirname, '..', 'public', 'uploads', subdir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            if (allowedExts && !allowedExts.includes(ext)) {
                return cb(new Error(`Unsupported file extension: ${ext}. Allowed: ${allowedExts.join(', ')}`));
            }
            cb(null, crypto.randomBytes(16).toString('hex') + ext);
        },
    });
}

const audioUpload = multer({
    storage: randomizedStorage('audio', ['.wav', '.mp3', '.ogg', '.gsm']),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

const leadsUpload = multer({
    storage: randomizedStorage('leads_tmp', ['.csv']),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

module.exports = { audioUpload, leadsUpload };
