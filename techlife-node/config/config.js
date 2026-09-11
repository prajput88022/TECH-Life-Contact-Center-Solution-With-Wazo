/**
 * TECH-Life Contact-Center Solution -- Node.js edition
 * Global configuration. Reads from environment variables with sane
 * local defaults, same shape as the previous PHP config.php so the
 * .env story stays identical for anyone migrating between the two.
 */
require('dotenv').config();

module.exports = {
    app: {
        name: 'TECH-Life Contact-Center Solution',
        port: process.env.APP_PORT || 3000,
        sessionSecret: process.env.SESSION_SECRET || 'change-me-session-secret',
        timezone: process.env.APP_TIMEZONE || 'UTC',
    },

    db: {
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'techlife',
        user: process.env.DB_USER || 'techlife',
        password: process.env.DB_PASS || 'techlife',
    },

    wazo: {
        host: process.env.WAZO_HOST || 'wazo.example.local',
        websocketdUrl: process.env.WAZO_WS_URL || 'wss://wazo.example.local/api/websocketd/',
        calldUrl: process.env.WAZO_CALLD_URL || 'https://wazo.example.local:9500/1.0',
        confdUrl: process.env.WAZO_CONFD_URL || 'https://wazo.example.local:9486/1.1',
        agentdUrl: process.env.WAZO_AGENTD_URL || 'https://wazo.example.local:9493/1.0',
        chatdUrl: process.env.WAZO_CHATD_URL || 'https://wazo.example.local:9304/1.0',
        authUrl: process.env.WAZO_AUTH_URL || 'https://wazo.example.local:9497/0.1',
        authUsername: process.env.WAZO_AUTH_USER || 'techlife-collector',
        authPassword: process.env.WAZO_AUTH_PASS || 'change-me',
        ingestSecret: process.env.WAZO_INGEST_SECRET || 'change-me-too',

        sipWsUri: process.env.WAZO_SIP_WS_URI || 'wss://wazo.example.local:443/api/asterisk/ws',
        sipDomain: process.env.WAZO_SIP_DOMAIN || 'wazo.example.local',
        defaultContext: process.env.WAZO_DEFAULT_CONTEXT || 'default',
        agentExtensionRangeStart: parseInt(process.env.WAZO_AGENT_EXT_START || '1000', 10),
        agentExtensionRangeEnd: parseInt(process.env.WAZO_AGENT_EXT_END || '1999', 10),
        roboOriginateUserUuid: process.env.WAZO_ROBO_ORIGINATE_UUID || null,
        // Wazo Platform installs commonly use a self-signed certificate
        // on the internal API ports (calld/confd/agentd/auth), which
        // causes Node's fetch() to fail with a generic "fetch failed"
        // error and no useful detail. Set this to 'false' in .env for
        // internal/on-prem Wazo installs with a self-signed cert; leave
        // it 'true' (default) whenever the Wazo host has a real,
        // CA-signed certificate.
        tlsRejectUnauthorized: process.env.WAZO_TLS_REJECT_UNAUTHORIZED !== 'false',
    },
};
