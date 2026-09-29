/**
 * TECH-Life Robo Agent Runtime -- Node port. Places outbound calls for
 * voice-blast / IVR-survey campaigns through Wazo calld, at the
 * campaign's configured dial_level, and drives each answered call
 * through its campaign_voice_content script.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../src/db');
const config = require('../config/config');
const { wazoFetch } = require('../src/wazoFetch');

async function getToken() {
    const resp = await wazoFetch(`${config.wazo.authUrl.replace(/\/$/, '')}/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${config.wazo.authUsername}:${config.wazo.authPassword}`).toString('base64'),
        },
        body: JSON.stringify({ backend: 'wazo_user', expiration: 300 }),
    });
    const data = await resp.json().catch(() => ({}));
    return data?.data?.token || '';
}

async function getCampaign(tenantId, campaignId) {
    const res = await pool.query('SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2', [tenantId, campaignId]);
    return res.rows[0] || null;
}

function withinCallingHours(campaign) {
    const hours = campaign.calling_hours_json || {};
    if (!hours || Object.keys(hours).length === 0) return true;
    const day = new Date().toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    if (!hours[day]) return false;
    const now = new Date().toTimeString().slice(0, 5);
    return now >= (hours[day].from || '00:00') && now <= (hours[day].to || '23:59');
}

function computeConcurrentCapacity(campaign) {
    if (campaign.max_concurrent_robo_calls) return parseInt(campaign.max_concurrent_robo_calls, 10);
    const dialLevel = parseFloat(campaign.dial_level || 1.0);
    return Math.min(20, Math.max(1, Math.round(dialLevel)));
}

async function countInFlightRoboCalls(tenantId, campaignId) {
    const res = await pool.query(
        `SELECT COUNT(*) AS n FROM calls WHERE tenant_id = $1 AND campaign_id = $2
         AND status IN ('ringing','answered') AND end_time IS NULL`,
        [tenantId, campaignId]
    );
    return parseInt(res.rows[0].n, 10);
}

async function nextLeadsToDial(tenantId, campaignId, limit) {
    const res = await pool.query(
        `SELECT * FROM leads WHERE tenant_id = $1 AND campaign_id = $2 AND status IN ('new','in_progress')
           AND (SELECT COUNT(*) FROM lead_attempts la WHERE la.lead_id = leads.id) < 3
         ORDER BY priority DESC, created_at LIMIT $3`,
        [tenantId, campaignId, limit]
    );
    return res.rows;
}

async function originateRoboCall(campaign, lead) {
    const token = await getToken();
    try {
        await wazoFetch(`${config.wazo.calldUrl.replace(/\/$/, '')}/calls`, {
            method: 'POST',
            headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: { user: config.wazo.roboOriginateUserUuid || null },
                destination: { context: 'robo-outbound', extension: lead.phone_number, priority: 1 },
                variables: {
                    TECHLIFE_CAMPAIGN_ID: campaign.id,
                    TECHLIFE_LEAD_ID: lead.id,
                    TECHLIFE_TENANT_ID: campaign.tenant_id,
                    TECHLIFE_ROBO: '1',
                },
            }),
        });
    } catch (e) {
        console.error('originateRoboCall failed:', e.message);
    }
    await pool.query(
        `INSERT INTO lead_attempts (tenant_id, lead_id, attempt_number, attempted_at, outcome)
         VALUES ($1,$2,1,now(),'originated')`,
        [campaign.tenant_id, lead.id]
    );
}

async function runTick(tenantId, campaignId) {
    const campaign = await getCampaign(tenantId, campaignId);
    if (!campaign || !campaign.is_robo_campaign || !campaign.is_active) return;
    if (!withinCallingHours(campaign)) return;

    const capacity = computeConcurrentCapacity(campaign);
    const inFlight = await countInFlightRoboCalls(tenantId, campaignId);
    const slots = Math.max(0, capacity - inFlight);
    if (slots <= 0) return;

    const leads = await nextLeadsToDial(tenantId, campaignId, slots);
    for (const lead of leads) {
        await originateRoboCall(campaign, lead);
    }
}

async function getNode(tenantId, campaignId, stepNumber) {
    const res = await pool.query(
        `SELECT * FROM campaign_voice_content WHERE tenant_id = $1 AND campaign_id = $2 AND step_number = $3 AND is_active = TRUE`,
        [tenantId, campaignId, stepNumber]
    );
    return res.rows[0] || null;
}

function resolvePlaybackFile(node) {
    if (node.content_type === 'audio_file') return node.audio_file_path;
    return synthesizeTts(node);
}

function synthesizeTts(node) {
    const cacheKey = crypto.createHash('md5').update(`${node.tts_text}|${node.tts_voice}|${node.tts_language}|${node.tts_speed}`).digest('hex');
    const cacheDir = process.env.TTS_CACHE_DIR || '/var/lib/techlife/tts-cache';
    const cachePath = path.join(cacheDir, `${cacheKey}.wav`);
    if (fs.existsSync(cachePath)) return cachePath;
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

    // Pluggable TTS provider call -- swap for Google Cloud TTS, Amazon
    // Polly, Azure Neural TTS, or a self-hosted engine. Contract: write
    // a WAV/PCM file to cachePath and return its path.
    console.log(`TTS synth requested via provider='${node.tts_provider || 'default'}' voice='${node.tts_voice}' -> ${cachePath} (implement provider call)`);
    return cachePath;
}

async function recordResponse(tenantId, campaignId, callId, voiceContentId, nodeName, responseType, dtmf = null, recordingPath = null) {
    await pool.query(
        `INSERT INTO survey_responses (tenant_id, campaign_id, call_id, voice_content_id, node_name, response_type, response_dtmf, response_recording_path)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, campaignId, callId, voiceContentId, nodeName, responseType, dtmf, recordingPath]
    );
    if (dtmf === null) return null;

    const nodeRes = await pool.query('SELECT next_step_map_json, step_number FROM campaign_voice_content WHERE id = $1', [voiceContentId]);
    const node = nodeRes.rows[0];
    if (!node) return null;
    const map = node.next_step_map_json || {};
    if (map[dtmf]) return parseInt(String(map[dtmf]).replace('step_', ''), 10);
    return parseInt(node.step_number, 10) + 1;
}

module.exports = { runTick, getNode, resolvePlaybackFile, recordResponse };
