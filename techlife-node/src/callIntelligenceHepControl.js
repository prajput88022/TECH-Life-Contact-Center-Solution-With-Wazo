'use strict';

const config = require('../config/config');
const { wazoFetch } = require('./wazoFetch');

function unwrapOptions(body) {
    const options = body?.options || body?.data?.options;
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new Error('Wazo returned an invalid HEP general configuration.');
    }
    return { ...options };
}

function enabledValue(value) {
    return ['1', 'yes', 'true', 'on', 'enabled'].includes(
        String(value || '').trim().toLowerCase()
    );
}

class CallIntelligenceHepControl {
    constructor(options = {}) {
        this.captureAddress = options.captureAddress || '127.0.0.1:9060';
        this.captureName = options.captureName || 'TECH-Life Call Intelligence';
        this.captureId = Number(options.captureId);

        if (
            !Number.isSafeInteger(this.captureId) ||
            this.captureId < 1 ||
            this.captureId > 4294967295
        ) {
            throw new Error('A valid 32-bit HEP capture ID is required.');
        }

        this.baseUrl = config.wazo.confdUrl.replace(/\/$/, '');
    }

    async token() {
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
                body: JSON.stringify({
                    backend: 'wazo_user',
                    expiration: 300
                })
            }
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok || !body?.data?.token) {
            throw new Error(`Wazo authentication failed (HTTP ${response.status}).`);
        }

        return body.data.token;
    }

    async getOptions(token) {
        const response = await wazoFetch(
            `${this.baseUrl}/asterisk/hep/general`,
            {
                headers: {
                    'X-Auth-Token': token,
                    'Content-Type': 'application/json'
                }
            }
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(`HEP configuration GET failed (HTTP ${response.status}).`);
        }

        return unwrapOptions(body);
    }

    async putOptions(token, options) {
        const response = await wazoFetch(
            `${this.baseUrl}/asterisk/hep/general`,
            {
                method: 'PUT',
                headers: {
                    'X-Auth-Token': token,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ options })
            }
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
            throw new Error(`HEP configuration PUT failed (HTTP ${response.status}).`);
        }

        return body;
    }

    async status() {
        const token = await this.token();
        const options = await this.getOptions(token);

        return {
            enabled: enabledValue(options.enabled),
            options: {
                ...options,
                capture_password: options.capture_password
                    ? '<configured>'
                    : ''
            }
        };
    }

    async enable() {
        const token = await this.token();
        const oldOptions = await this.getOptions(token);

        const nextOptions = {
            ...oldOptions,
            enabled: 'yes',
            capture_address: this.captureAddress,
            capture_id: String(this.captureId),
            capture_name: this.captureName,
            uuid_type: 'channel'
        };

        await this.putOptions(token, nextOptions);

        // Confirm Wazo persisted the requested global state.
        const verify = await this.getOptions(token);

        if (!enabledValue(verify.enabled)) {
            throw new Error('Wazo did not confirm HEP enabled state.');
        }

        if (
            String(verify.capture_address || '') !== this.captureAddress ||
            String(verify.uuid_type || '').toLowerCase() !== 'channel' ||
            Number(verify.capture_id) !== this.captureId
        ) {
            throw new Error('Wazo HEP settings did not match the requested receiver settings.');
        }

        return { enabled: true };
    }

    async disable() {
        const token = await this.token();
        const oldOptions = await this.getOptions(token);

        // Preserve every setting except the enabled flag.
        const nextOptions = {
            ...oldOptions,
            enabled: 'no'
        };

        await this.putOptions(token, nextOptions);

        const verify = await this.getOptions(token);

        if (enabledValue(verify.enabled)) {
            throw new Error('Wazo still reports HEP enabled.');
        }

        return { enabled: false };
    }
}

module.exports = {
    CallIntelligenceHepControl,
    enabledValue
};
