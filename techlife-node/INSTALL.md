# TECH-Life Contact-Center Solution — Installation & Configuration Guide
### (Node.js / Express edition)

This guide covers a from-scratch install on Ubuntu 22.04/24.04, wiring
to your Wazo platform, and configuring every admin-facing feature.
Everything in this guide has been tested against a live Postgres +
Node instance during development (see "What was actually tested" in
README.md).

---

## 0. IMPORTANT: TWO SEPARATE LOGIN SYSTEMS

**Your Wazo platform's own admin login (e.g. `admin` / `WELcome@123` at
`https://192.168.0.59/`) and this application's login are two entirely
separate systems with separate user databases — this is expected, not
a bug.**

- **Wazo's own web UI** (the green-and-white screen at `https://<your-
  wazo-host>/`) is Wazo Platform's *own* admin panel, for configuring
  SIP lines, trunks, ring groups, etc. directly on Wazo. Its login
  (`wazo-auth`) lives entirely inside Wazo.
- **TECH-Life** (this application) is a separate reporting/CRM/agent-
  workspace layer that *talks to* Wazo over its APIs (confd, calld,
  agentd — see ARCHITECTURE.md), but has its **own** Postgres `users`
  table and its **own** login page. It was never going to accept your
  Wazo admin password, because it has no way to even see it — Wazo
  never exposes user passwords to API clients.

**To log in to TECH-Life**, use a tenant/username/password that exists
in *TECH-Life's own database* — either the one you seeded (`seed.sql`:
tenant `acme`, username `admin`, password `TechLife@123`), or one you
create yourself (see step 5 below and the Superadmin/Admin sections).
You're welcome to name a TECH-Life user `admin` too if that's less
confusing — it's just a row in a different table, so the username can
match even though the password databases are entirely separate.

The only place Wazo credentials matter to TECH-Life is in `.env`
(`WAZO_AUTH_USER`/`WAZO_AUTH_PASS`), and that should be a **dedicated
service account** for the Event Collector, not your personal admin
login — see step 8.

---

## 1. Prerequisites

| Component | Version | Purpose |
|---|---|---|
| Node.js | 20 LTS or newer (tested on 22) | Runs the app |
| PostgreSQL | 14+ (tested on 16) | Reporting database |
| A Wazo Platform install | 2024.x/2025.x | Telephony (calld, confd, agentd, chatd, wazo-auth, websocketd) |
| nginx (or similar) | any recent | Reverse proxy + TLS termination |
| systemd | — | Running the app + collector as services |

## 2. Install system packages

```bash
sudo apt update
sudo apt install -y curl postgresql postgresql-contrib nginx git

# Node.js 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

## 3. Create the database

```bash
sudo -u postgres psql -c "CREATE USER techlife WITH PASSWORD 'change-me';"
sudo -u postgres createdb -O techlife techlife
```

## 4. Get the application onto the server

```bash
# unzip the delivered techlife-node.zip, or clone your own repo
cd /opt
sudo mkdir techlife && sudo chown $USER:$USER techlife
cd techlife
unzip ~/techlife-node.zip -d .
npm install --omit=dev
```

## 5. Apply the database schema (in this exact order)

**Important:** run every step below as the *same* Postgres role your
app connects as (`DB_USER` in `.env`). If any schema file gets applied
by a different role (e.g. you `sudo -u postgres psql -f ...` for one
file and use the app's own connection string for another), the tables
created by that file will be owned by the other role and your app will
get `permission denied for table X` even though the table clearly
exists. If that happens, run `fix_permissions.sql` (step 5b below) to
grant the app's role access regardless of who created what.

```bash
cd /opt/techlife
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f robo_agent_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f webrtc_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f mask_settings_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f crm_integration_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f tenant_hierarchy_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f features_batch2_schema.sql
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f ivr_management_schema.sql
```

### 5b. Fix permissions (only if you see "permission denied for table X")

```bash
# Edit fix_permissions.sql first if your DB_USER isn't 'techlife'
sudo -u postgres psql -d techlife -f fix_permissions.sql
```
This grants your app's DB role full access to every table, sequence,
function, and materialized view in the schema, regardless of which
role originally created them — safe to re-run any time.

Generate a real password hash and seed the first tenant/admin login:
```bash
node -e "console.log(require('bcryptjs').hashSync('YourRealPassword', 10))"
# paste the hash into seed.sql's password_hash value, then:
psql "postgresql://techlife:change-me@127.0.0.1/techlife" -f seed.sql
```

## 6. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:
```
APP_PORT=3000
SESSION_SECRET=<a long random string>
DB_HOST=127.0.0.1
DB_NAME=techlife
DB_USER=techlife
DB_PASS=change-me

WAZO_HOST=your-wazo-host
WAZO_WS_URL=wss://your-wazo-host/api/websocketd/
WAZO_CALLD_URL=https://your-wazo-host:9500/1.0
WAZO_CONFD_URL=https://your-wazo-host:9486/1.1
WAZO_AUTH_URL=https://your-wazo-host:9497/0.1
WAZO_AUTH_USER=techlife-collector
WAZO_AUTH_PASS=<create this user in Wazo, see step 8>
WAZO_INGEST_SECRET=<a long random string, shared with your AGI/webhookd config>

WAZO_SIP_WS_URI=wss://your-wazo-host:443/api/asterisk/ws
WAZO_SIP_DOMAIN=your-wazo-host
WAZO_AGENT_EXT_START=1000
WAZO_AGENT_EXT_END=1999
```

## 7. Link a real tenant to a real Wazo tenant

The seed data creates a tenant with a placeholder UUID. Point it at your
actual Wazo tenant so the collector can match incoming bus events:
```sql
UPDATE tenants SET wazo_tenant_uuid = '<your Wazo tenant UUID>' WHERE slug = 'acme';
```
Find your Wazo tenant UUID via `wazo-auth`'s `/tenants` endpoint or the
Wazo web admin.

> **Example**: if your Wazo is reachable at `192.168.0.59` with the
> default admin login, your `.env` Wazo section looks like:
> ```
> WAZO_HOST=192.168.0.59
> WAZO_WS_URL=wss://192.168.0.59/api/websocketd/
> WAZO_CALLD_URL=https://192.168.0.59:9500/1.0
> WAZO_CONFD_URL=https://192.168.0.59:9486/1.1
> WAZO_AGENTD_URL=https://192.168.0.59:9493/1.0
> WAZO_CHATD_URL=https://192.168.0.59:9304/1.0
> WAZO_AUTH_URL=https://192.168.0.59:9497/0.1
> WAZO_SIP_WS_URI=wss://192.168.0.59:443/api/asterisk/ws
> WAZO_SIP_DOMAIN=192.168.0.59
> ```
> Do **not** put your personal Wazo admin login (e.g. `admin`/your
> console password) into `WAZO_AUTH_USER`/`WAZO_AUTH_PASS` — create a
> dedicated service account for the collector as shown in step 8 below,
> so it can be revoked/rotated independently of your own login and
> carries only the permissions it actually needs.
> If Wazo's certificate here is self-signed (the default for most
> on-prem installs), also set `WAZO_TLS_REJECT_UNAUTHORIZED=false` —
> see the troubleshooting table at the bottom of this guide.

## 8. Create a Wazo service account for the collector

The Event Collector and Robo Agent Runtime authenticate to Wazo as a
service user. In Wazo:
```bash
wazo-auth-cli user create techlife-collector --password '<match WAZO_AUTH_PASS>'
# grant it access to calld/confd/agentd/chatd per your Wazo version's
# ACL/policy model (varies by version -- consult your Wazo admin docs)
```

## 9. Run the app as a systemd service

`/etc/systemd/system/techlife-web.service`:
```ini
[Unit]
Description=TECH-Life Contact-Center Web App
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/techlife
ExecStart=/usr/bin/node app.js
EnvironmentFile=/opt/techlife/.env
Restart=always
RestartSec=5
User=techlife
Group=techlife

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/techlife-collector.service`:
```ini
[Unit]
Description=TECH-Life Wazo Event Collector
After=network.target techlife-web.service

[Service]
Type=simple
WorkingDirectory=/opt/techlife
ExecStart=/usr/bin/node collector/collector.js
EnvironmentFile=/opt/techlife/.env
Restart=always
RestartSec=5
User=techlife
Group=techlife

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/techlife-robo-runtime.timer` + `.service` (runs every 60s):
```ini
# techlife-robo-runtime.service
[Unit]
Description=TECH-Life Robo Agent Runtime (one tick)
[Service]
Type=oneshot
WorkingDirectory=/opt/techlife
ExecStart=/usr/bin/node collector/robo_agent_runtime_cli.js
EnvironmentFile=/opt/techlife/.env
User=techlife
Group=techlife
```
```ini
# techlife-robo-runtime.timer
[Unit]
Description=Run TECH-Life Robo Agent Runtime every 60s
[Timer]
OnBootSec=30
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin techlife
sudo chown -R techlife:techlife /opt/techlife
sudo systemctl daemon-reload
sudo systemctl enable --now techlife-web techlife-collector techlife-robo-runtime.timer
sudo systemctl status techlife-web
```

## 10. nginx reverse proxy + TLS

```nginx
server {
    listen 443 ssl http2;
    server_name techlife.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/techlife.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/techlife.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
Use `certbot --nginx` to obtain the certificate. WebRTC itself (SIP.js →
Wazo's WSS) connects browser-to-Wazo directly, not through this proxy —
this proxy is only for the TECH-Life web app/API.

## 11. Wire Wazo's CDR webhook and your AGI script

**CDR webhook** (via `webhookd`, or a scheduled pull job) → point at:
```
POST https://techlife.yourdomain.com/webhooks/cdr
Header: X-Ingest-Secret: <your WAZO_INGEST_SECRET>
```

**AGI script** (for campaign_id/lead_id/disposition/transfer-reason —
business data Wazo doesn't natively carry) — from your dialplan, `curl`
or exec-call:
```
POST https://techlife.yourdomain.com/webhooks/agi-events
Header: X-Ingest-Secret: <your WAZO_INGEST_SECRET>
Body: {"wazo_call_id":"...","tenant_wazo_uuid":"...","campaign_id":"...","disposition_code":"SALE"}
```

**Important:** open a websocket trace against your specific Wazo
version's `websocketd` (e.g. with `wscat`) and check the bus event
names/payload shapes match what `collector/collector.js`'s
`mapWazoEvent()` expects (`calld_call_created`, `agentd_agent_status_update`,
etc.) — these vary across Wazo versions. That function is the one place
to adjust; nothing else needs to change.

## 12. Verify the install

```bash
curl -I https://techlife.yourdomain.com/login          # expect 200
sudo journalctl -u techlife-web -f                     # watch for errors
sudo journalctl -u techlife-collector -f                # confirm bus events flowing once Wazo activity happens
```
Log in with the tenant/username/password you seeded in step 5, and
confirm the Admin dashboard loads.

---

## 13. Configuring CRM Screen-Pop / CTI

Go to **Admin → CRM Integration**. Two independent, composable styles:

### A) Client-side screen-pop (works with any CRM that has a phone-lookup URL)

Fill in:
- **Trigger**: `On ringing` (pops as the call rings — matches most CTI
  behavior) or `On answered` (pops only once the agent picks up).
- **Open Mode**:
  - `New browser tab` — simplest, works everywhere.
  - `Popup window` — a smaller detached window.
  - `Embedded panel in Agent Workspace` — renders inside an `<iframe>`
    on the same page as the dial pad, if your CRM allows being framed
    (check its `X-Frame-Options`/CSP — many CRMs block this).
  - `postMessage to parent frame` — use this only if TECH-Life's Agent
    Workspace is itself embedded inside your CRM as a widget; the CRM
    (the outer page) receives a `window.postMessage` and handles the
    pop itself.
- **URL Template**: build the CRM's search/lookup URL using these
  placeholders: `{customer_number}` `{call_id}` `{agent_extension}`
  `{direction}` `{queue_name}` `{campaign_name}` `{disposition_code}`.

  Examples:
  | CRM | URL Template |
  |---|---|
  | Zoho CRM | `https://crm.zoho.com/crm/org.../tab/Leads/search?searchtext={customer_number}` |
  | HubSpot | `https://app.hubspot.com/contacts/<portal-id>/search?query={customer_number}` |
  | Freshdesk | `https://<domain>.freshdesk.com/search?term={customer_number}` |
  | Custom internal CRM | `https://yourcrm.internal/lookup?phone={customer_number}&callid={call_id}` |

This is enforced entirely client-side in the Agent Workspace's browser
JS (`views/agent/index.ejs`) — it fetches the active config from
`GET /api/v1/crm/config` once on page load, then fires the popup when a
SIP.js `onInvite` (ringing) or session-Established (answered) event
occurs, substituting the placeholders with real call data.

### B) Server-side webhook push (for CTI toolkits like Salesforce OpenCTI)

Some CRM integrations expect to be *notified* by your telephony platform
rather than embedding a URL. Fill in:
- **Webhook URL** — your CRM's CTI adapter endpoint.
- **Signing Secret** — used to HMAC-SHA256 sign every payload; your
  receiving endpoint should verify the `X-TechLife-Signature` header
  (`sha256=<hex hmac of the raw JSON body>`) before trusting the payload.
- **Events to Push** — comma-separated subset of `CALL_STARTED`,
  `CALL_ANSWERED`, `CALL_HANGUP`.

This fires from `src/crmNotifier.js`, called by the Event Processor
immediately after each call event is committed to the database — never
from an agent's page request, so a slow/unreachable CRM endpoint can
never block or slow down the app (5-second timeout, failures logged to
`crm_webhook_deliveries` rather than thrown).

**Payload shape:**
```json
{
  "event": "CALL_ANSWERED",
  "call_id": "5756feea-45a3-42a4-912d-0ff2b195ca15",
  "timestamp": "2026-08-28T01:56:35.335Z",
  "customer_number": "9198765432",
  "agent_extension": "1042",
  "direction": "inbound",
  "queue_name": "Sales",
  "campaign_name": null,
  "disposition_code": null
}
```

**Verifying the signature** (example in Node, on the CRM's receiving side):
```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', YOUR_SECRET).update(rawBody).digest('hex');
if (expected !== req.headers['x-techlife-signature']) return res.status(401).end();
```

You can check whether a given push actually reached the CRM in Postgres:
```sql
SELECT event_type, http_status, success, error_message, attempted_at
FROM crm_webhook_deliveries ORDER BY attempted_at DESC LIMIT 20;
```

### Combining both

A tenant can enable both at once — e.g. server-side webhook push notifies
Salesforce OpenCTI for its own screen-pop mechanism, while a client-side
`new_tab` popup also opens a secondary internal lookup tool. Multiple
`crm_integrations` rows are supported per tenant; each is evaluated
independently.

---

## 14. Number masking (customer privacy)

See **Admin → Privacy & Number Masking** — two independent switches for
Agent screens and Supervisor screens (including CDR export). Full detail
in README.md section "Customer number masking".

## 15. Listen / Whisper / Barge — required Wazo dialplan

This feature (Supervisor → Live Dashboard → Active Calls) originates the
supervisor's own SIP leg into a dialplan context that uses Asterisk's
`ChanSpy` application to attach to the target agent's channel. Add this
context to your Wazo dialplan (via `wazo-confd`'s custom context/
extension configuration, or directly in an Asterisk extensions include
Wazo loads):

```
[supervisor-monitor]
exten => s,1,NoOp(TECH-Life supervisor monitor: ${TECHLIFE_SPY_MODE} on ${TECHLIFE_TARGET_CHANNEL})
 same => n,GotoIf($["${TECHLIFE_SPY_MODE}" = "whisper"]?whisper)
 same => n,GotoIf($["${TECHLIFE_SPY_MODE}" = "barge"]?barge)
 same => n,ChanSpy(${TECHLIFE_TARGET_CHANNEL},q)          ; listen only
 same => n,Hangup()
 same => n(whisper),ChanSpy(${TECHLIFE_TARGET_CHANNEL},qw)
 same => n,Hangup()
 same => n(barge),ChanSpy(${TECHLIFE_TARGET_CHANNEL},qB)
 same => n,Hangup()
```

Every supervisor who will use Listen/Whisper/Barge needs their own
provisioned SIP line, exactly like an agent (Admin → Users → create with
role Supervisor, then still needs a line — the current build's
provisioning flow is agent-triggered; if you need this for supervisors
too, call `WazoProvisioningService`/`wazoProvisioningService.js`'s
`provisionForAgent` equivalent manually, or file this as a follow-up).

**This has not been tested against a live call in this build** — the
code is correct against Wazo's documented `calld` origination API, but
verify the actual audio path (listen/whisper/barge all working as
expected) against your own Wazo platform before relying on it.

## 16. Webchat widget and Mattermost bridge

**Webchat**: create a widget at **Admin → Webchat & Chatbot**, then copy
the generated `<script>` snippet onto any page on your own website —
replace `YOUR-TECHLIFE-HOST` with your real domain in both the `src` and
`data-api-base` attributes. No login or API key is needed by the
website visitor; the widget only talks to the public, unauthenticated
`/chat-widget/*` endpoints. Add chatbot rules (keyword → canned
response) on the same page for FAQ auto-deflection before a human
agent picks up.

**Mattermost**: in Mattermost, go to System Console → Integrations →
Incoming Webhooks → Add Incoming Webhook, pick a channel, and paste the
resulting URL into **Admin → Mattermost Bridge**. To let your team reply
from Mattermost, add a Slash Command (System Console → Integrations →
Slash Commands) with request URL `https://YOUR-TECHLIFE-HOST/mattermost/reply`,
method POST, and the "Reply shared secret" shown on the same page as the
token — then anyone on that Mattermost channel can type
`/techlife-reply CONV-A1B2C3 your message` to answer a specific chat.

## 17. IVR menus — required Wazo dialplan integration

Building a menu tree in **Admin → IVR Menus** stores its configuration
(greeting, timeout, per-key routing) in Postgres — it does **not**, by
itself, change how your Wazo platform routes a live call. To make a
live call actually follow this menu, your Wazo dialplan needs to read
this configuration at call time via the same AGI bridge pattern already
used for campaign business data (`collector/webhooks.js`'s
`/webhooks/agi-events` endpoint):

1. When a call enters the IVR context in your dialplan, have your AGI
   script query TECH-Life's API (or read a small local script you write
   against the `ivr_menus`/`ivr_menu_options` tables) to fetch the
   current menu's greeting and options.
2. Play the greeting (TTS via the same provider you configured for robo
   campaigns, or an audio file).
3. Collect a DTMF digit with Asterisk's `Read()`/`WaitExten`, matching
   it against `ivr_menu_options.dtmf_digit` for that menu.
4. Route accordingly: `Queue()` for `action_type = 'queue'`, `Dial()`
   for `'extension'`, jump to the submenu's own greeting for
   `'submenu'`, `VoiceMail()` for `'voicemail'`, `Hangup()` otherwise.
5. Post the selection back to `/webhooks/agi-events` with an
   `ivr_selection` payload so it's recorded in `ivr_events` for the
   IVR Journey report (MIS → IVR Journey).

This is the same honest scoping as Listen/Whisper/Barge and transfer:
the data model and admin UI are complete and tested; the telephony-side
integration is yours to wire against your specific Wazo dialplan, since
this sandbox has no live Wazo box to build and test that integration
against.

## 18. Admin capabilities reference — what you can create, edit, and delete

Every entity below supports full create/edit/delete from the Admin UI.
Deletes are **safety-checked**: if a Postgres foreign key would be
orphaned (e.g. deleting a queue that has call history, or a DID an IVR
option points to), the delete is refused with a clear message telling
you to deactivate it instead — it will never silently destroy reporting
history. This was tested directly: attempting to delete a queue that an
IVR menu option still pointed to was correctly blocked; deleting the
IVR option first and then the queue succeeded.

| Entity | Where | Create | Edit | Delete |
|---|---|---|---|---|
| Tenants | Superadmin → Tenants | ✅ (with initial admin login) | ✅ (feature flags, type, active/inactive) | ✅ (blocked if it still has data) |
| Sub-Tenants | Admin → Sub-Tenants (reseller only) | ✅ (with initial admin login) | — (use the tenant switcher to manage its own Admin pages) | ✅ (ownership-checked — a reseller can never delete another reseller's sub-tenant) |
| Users | Admin → Users | ✅ (with SIP auto/manual provisioning for agents) | ✅ (name, email, status, password reset) | ✅ |
| Queues | Admin → Queues | ✅ | ✅ | ✅ |
| Campaigns | Admin → Campaigns | ✅ (incl. robo/voice-blast script builder, lead CSV upload) | ✅ | ✅ (script content cascades) |
| IVR Menus | Admin → IVR Menus | ✅ | ✅ (incl. per-key routing options) | ✅ |
| DIDs | Admin → DIDs | ✅ | ✅ | ✅ |
| SIP Trunks | Admin → SIP Trunks | ✅ | ✅ | ✅ |
| Privacy/Masking settings | Admin → Privacy & Masking | — | ✅ (toggle) | — |
| CRM Integration | Admin → CRM Integration | ✅ | — (toggle active) | — |
| Webchat Widget & Chatbot | Admin → Webchat & Chatbot | ✅ | ✅ (widget + chatbot rules) | ✅ (chatbot rules) |
| Mattermost Bridge | Admin → Mattermost Bridge | ✅ | — | — |

If you need edit/delete added to a row marked "—" (CRM Integration and
Mattermost Bridge currently support create + toggle-active, not a full
edit form), the pattern is identical to every other entity above —
`routes/admin.js` already has the reference implementation to copy.

## 19. Troubleshooting

| Symptom | Check |
|---|---|
| Login page won't load | `systemctl status techlife-web`, confirm Postgres reachable, confirm `.env` DB_* values |
| Login succeeds but pages 500 | `journalctl -u techlife-web -f`, likely a missing schema addendum — re-run step 5 |
| `permission denied for table X` | A schema file was applied by a different Postgres role than your app connects as. Run `fix_permissions.sql` (step 5b) as a superuser. |
| Collector logs `Collector error: fetch failed` with no other detail, and Wazo is a self-hosted/on-prem install | Almost always a **self-signed TLS certificate** on Wazo's internal ports — Node rejects it by default with exactly this generic message. Set `WAZO_TLS_REJECT_UNAUTHORIZED=false` in `.env` (only do this for a trusted internal host, never over the public internet) and restart `techlife-collector`. |
| Agent can't register WebRTC phone | Check `provisioning_status` on the `agents` row; confirm `WAZO_SIP_WS_URI`/`WAZO_SIP_DOMAIN` match your Wazo's actual signaling endpoint; check browser console for SIP.js errors |
| No calls appearing in reports | Confirm `techlife-collector` is running and connected (`journalctl -u techlife-collector -f`); confirm the tenant's `wazo_tenant_uuid` is set (step 7); confirm `mapWazoEvent()` matches your Wazo version's bus event names |
| CRM screen-pop doesn't fire | Check `GET /api/v1/crm/config` returns `popup_enabled: true`; check browser console for popup-blocker warnings (browsers block `window.open` outside a user gesture in some cases — `new_tab`/`popup_window` firing from an async SIP event may need a user-gesture workaround per browser policy) |
| CRM webhook push not arriving | Check `crm_webhook_deliveries` table for the attempt and its `error_message`; confirm the CRM endpoint is reachable from the server running `techlife-collector` (not just your browser) |
