const express = require('express');
const router = express.Router();
const { attemptLogin, logout } = require('../src/auth');
const { clearDigitalPresence } = require('../src/services/digitalPresenceService');

router.get('/login', (req, res) => {
    res.render('login', { error: null, form: {} });
});

router.post('/login', async (req, res) => {
    const { tenant_slug, username, password } = req.body;
    try {
        const user = await attemptLogin(tenant_slug || null, username, password);
        if (!user) {
            return res.render('login', { error: 'Invalid tenant, username, or password. Super Admin may leave tenant slug blank.', form: req.body });
        }
        req.session.user = user;
        const roles = user.roles;
        let target = '/agent';
        if (roles.includes('superadmin')) target = '/superadmin';
        else if (roles.includes('admin')) target = '/admin';
        else if (roles.includes('supervisor')) target = '/supervisor';
        else if (roles.includes('mis_agent')) target = '/mis';
        res.redirect(target);
    } catch (e) {
        console.error(e);
        res.render('login', { error: 'Server error, please try again.', form: req.body });
    }
});

router.get('/logout', async (req, res) => {
    const u = req.session?.user;

    try {
        if (u?.agentId && req.sessionID) {
            await clearDigitalPresence(u.tenantId, u.agentId, req.sessionID);
        }
    } catch (err) {
        // Do not prevent logout if presence cleanup encounters a database error.
        console.error('Digital presence logout cleanup failed:', err);
    }

    try {
        await logout(req);
    } catch (err) {
        console.error('Logout audit failed:', err);
    }

    if (!req.session) return res.redirect('/login');
    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
