'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function run(program, args) {
    return execFileAsync(program, args, {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
    });
}

async function probeAudio(filePath) {
    const { stdout } = await run('ffprobe', [
        '-v', 'error',
        '-show_entries',
        'format=duration,size:stream=codec_type,codec_name,sample_rate,channels,bits_per_sample',
        '-of', 'json',
        filePath
    ]);

    const data = JSON.parse(stdout);
    const audio = (data.streams || []).find(s => s.codec_type === 'audio');
    const duration = Number(data.format && data.format.duration);

    if (!audio || !Number.isFinite(duration) || duration <= 0) {
        throw new Error('The uploaded file contains no valid, playable audio.');
    }

    return {
        codec: audio.codec_name,
        sampleRate: Number(audio.sample_rate),
        channels: Number(audio.channels),
        bitsPerSample: Number(audio.bits_per_sample) || null,
        durationSeconds: duration,
        fileSizeBytes: Number(data.format && data.format.size) || 0
    };
}

async function convertToWav(inputPath) {
    const input = path.resolve(inputPath);
    const directory = path.dirname(input);
    const output = path.join(
        directory,
        crypto.randomBytes(16).toString('hex') + '.wav'
    );

    try {
        const inputStat = await fs.promises.stat(input);
        if (!inputStat.isFile() || inputStat.size === 0) {
            throw new Error('The uploaded audio file is empty.');
        }

        await run('ffmpeg', [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', input,
            '-map', '0:a:0',
            '-vn',
            '-ac', '1',
            '-ar', '8000',
            '-c:a', 'pcm_s16le',
            '-f', 'wav',
            output
        ]);

        const info = await probeAudio(output);
        const outputStat = await fs.promises.stat(output);

        if (
            info.codec !== 'pcm_s16le' ||
            info.sampleRate !== 8000 ||
            info.channels !== 1 ||
            outputStat.size <= 44 ||
            info.durationSeconds <= 0
        ) {
            throw new Error('Converted audio failed WAV format validation.');
        }

        return {
            path: output,
            filename: path.basename(output),
            publicPath: '/uploads/audio/' + path.basename(output),
            mimeType: 'audio/wav',
            fileExtension: 'wav',
            fileSizeBytes: outputStat.size,
            durationSeconds: Math.round(info.durationSeconds * 1000) / 1000,
            codec: info.codec,
            sampleRate: info.sampleRate,
            channels: info.channels,
            bitsPerSample: 16
        };
    } catch (err) {
        await fs.promises.unlink(output).catch(() => {});
        throw err;
    }
}

module.exports = { convertToWav, probeAudio };
