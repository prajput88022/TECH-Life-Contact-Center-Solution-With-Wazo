/**
 * TECH-Life Contact-Center Solution -- Node.js/Express edition.
 * Entry point: wires session, view engine, static assets, and routes.
 */
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const config = require('./config/config');
const { pool } = require('./src/db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

app.use(session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: config.app.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8h shift
}));

// Make the logged-in user available to every view without passing it
// explicitly each time.
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    res.locals.currentPath = req.path;
    next();
});

app.use('/', require('./routes/auth'));
app.use('/superadmin', require('./routes/superadmin'));
app.use('/admin', require('./routes/admin'));
app.use('/supervisor', require('./routes/supervisor'));
app.use('/agent', require('./routes/agent'));
app.use('/mis', require('./routes/mis'));
app.use('/api/v1', require('./routes/api'));
app.use('/export', require('./routes/export'));
app.use('/webhooks', require('./collector/webhooks'));
app.use('/chat-widget', require('./routes/chatWidget'));
app.use('/mattermost', require('./routes/mattermostReply'));

app.get('/', (req, res) => res.redirect('/login'));

app.use((req, res) => res.status(404).send('Not found'));
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Server error' + (process.env.APP_DEBUG ? `: ${err.message}` : ''));
});

const PORT = config.app.port;
if (require.main === module) {
    app.listen(PORT, () => console.log(`TECH-Life listening on port ${PORT}`));
}

module.exports = app;
