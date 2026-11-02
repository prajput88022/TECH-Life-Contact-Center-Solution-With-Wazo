/**
 * Shared fetch wrapper for every call to the Wazo platform (auth, calld,
 * confd, agentd, chatd). Centralizes TLS handling so self-signed
 * certificates on internal/on-prem Wazo installs (the default for most
 * on-prem deployments) don't cause a bare, undiagnosable "fetch failed"
 * error -- Node's fetch (undici) rejects unverifiable certs by default
 * and reports almost nothing about why.
 *
 * Controlled by WAZO_TLS_REJECT_UNAUTHORIZED in .env (defaults to
 * 'true' -- verify certs normally; set to 'false' only for a trusted
 * internal Wazo host with a self-signed cert, never for anything
 * reachable over the public internet).
 */
const { Agent } = require('undici');
const config = require('../config/config');

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

async function wazoFetch(url, options = {}) {
    const fetchOptions = { ...options };
    if (!config.wazo.tlsRejectUnauthorized) {
        fetchOptions.dispatcher = insecureAgent;
    }
    try {
        return await fetch(url, fetchOptions);
    } catch (e) {
        const causeCode = e.cause?.code || e.cause?.message;
        let hint = '';
        if (causeCode === 'ECONNREFUSED') {
            hint = ' -- connection refused: check the host/port and that the Wazo service is running and reachable from this server.';
        } else if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
            hint = ' -- DNS lookup failed: check the hostname in your .env is correct and resolvable from this server.';
        } else if (String(causeCode || '').includes('CERT') || String(causeCode || '').includes('SELF_SIGNED')) {
            hint = ' -- TLS certificate could not be verified. If this Wazo host uses a self-signed certificate (common for on-prem installs), set WAZO_TLS_REJECT_UNAUTHORIZED=false in .env.';
        } else if (causeCode) {
            hint = ` (${causeCode})`;
        }
        const err = new Error(`Request to ${url} failed${hint}`);
        err.cause = e.cause;
        throw err;
    }
}

module.exports = { wazoFetch };
