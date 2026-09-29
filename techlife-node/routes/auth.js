const express = require('express');
const router = express.Router();
const { attemptLogin, logout } = require('../src/auth');

router.get('/login', (req, res) => {
    res.render('login', { error: null, form: {} });
});

router.post('/login', async (req, res) => {
    const { tenant_slug, username, password } = req.body;
    try {
        const user = await attemptLogin(tenant_slug, username, password);
        if (!user) {
            return res.render('login', { error: 'Invalid tenant, username, or password.', form: req.body });
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
    await logout(req);
    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
