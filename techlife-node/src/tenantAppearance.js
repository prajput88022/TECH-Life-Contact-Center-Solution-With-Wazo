'use strict';

const { pool } = require('./db');

const DEFAULT_APPEARANCE = Object.freeze({
    portal_name: 'TECH-Life Contact-Center Solution',
    logo_path: null,
    theme: 'blue',
    primary_color: null
});

const ALLOWED_THEMES = new Set([
    'blue', 'purple', 'green', 'yellow', 'light', 'dark'
]);

function validHex(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function mixHex(hex, target, amount) {
    const source = [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16)
    ];
    const dest = [
        parseInt(target.slice(1, 3), 16),
        parseInt(target.slice(3, 5), 16),
        parseInt(target.slice(5, 7), 16)
    ];

    return '#' + source.map((value, i) =>
        Math.round(value + (dest[i] - value) * amount)
            .toString(16).padStart(2, '0')
    ).join('');
}

function getTenantId(req) {
    if (req.effectiveTenant && req.effectiveTenant.id) {
        return req.effectiveTenant.id;
    }

    const user = req.session && req.session.user;
    return user && user.tenantId ? user.tenantId : null;
}

async function loadTenantAppearance(req, res, next) {
    try {
        const tenantId = getTenantId(req);

        if (!tenantId) {
            res.locals.tenantAppearance = { ...DEFAULT_APPEARANCE };
            return next();
        }

        const result = await pool.query(
            `SELECT portal_name, logo_path, theme, primary_color
             FROM tenant_appearance
             WHERE tenant_id = $1`,
            [tenantId]
        );

        const saved = result.rows[0] || {};
        const theme = ALLOWED_THEMES.has(saved.theme)
            ? saved.theme
            : DEFAULT_APPEARANCE.theme;

        const accent = validHex(saved.primary_color)
            ? saved.primary_color
            : null;

        res.locals.tenantAppearance = {
            ...DEFAULT_APPEARANCE,
            ...saved,
            portal_name: typeof saved.portal_name === 'string' &&
                saved.portal_name.trim()
                ? saved.portal_name.trim()
                : DEFAULT_APPEARANCE.portal_name,
            theme,
            primary_color: accent,
            accent_light: accent ? mixHex(accent, '#ffffff', 0.35) : null,
            accent_dark: accent ? mixHex(accent, '#000000', 0.25) : null,
            accent_rgb: accent
                ? [
                    parseInt(accent.slice(1, 3), 16),
                    parseInt(accent.slice(3, 5), 16),
                    parseInt(accent.slice(5, 7), 16)
                ].join(',')
                : null
        };

        return next();
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    loadTenantAppearance,
    DEFAULT_APPEARANCE,
    ALLOWED_THEMES,
    validHex
};
