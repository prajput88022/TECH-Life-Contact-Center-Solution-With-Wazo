# TECH-Life Contact-Center Solution — Node.js / Express Edition

A full rewrite of the PHP scaffold onto Node.js + Express + PostgreSQL,
using real npm packages throughout (Express, node-postgres, ExcelJS,
bcryptjs, ws, express-session) rather than hand-rolled equivalents,
since npm's registry — unlike PHP's Composer/Packagist — is reachable
from this build environment.

**Start here: [`INSTALL.md`](./INSTALL.md)** for the full install,
Wazo wiring, and CRM screen-pop/CTI configuration guide.

## What's in this package

```
app.js                      Express entry point
config/config.js            Environment-driven config
src/                        DB pool, auth, RBAC, reporting services, masking, CRM notifier
routes/                     Express routers, one per role + api + export
views/                      EJS templates, one folder per role
collector/                  Wazo Event Collector, Event Processor, Robo Agent Runtime, webhooks
schema.sql + 4 addenda      PostgreSQL schema (unchanged from the PHP edition -- same DB either way)
seed.sql                    Minimal seed data for a first login
.env.example                All environment variables, documented
```

## Quick start (local dev)

```bash
npm install
createdb techlife
psql techlife -f schema.sql
psql techlife -f robo_agent_schema.sql
psql techlife -f webrtc_schema.sql
psql techlife -f mask_settings_schema.sql
psql techlife -f crm_integration_schema.sql
node -e "console.log(require('bcryptjs').hashSync('TechLife@123', 10))"
# paste that hash into seed.sql's password_hash value, then:
psql techlife -f seed.sql

cp .env.example .env    # edit DB_* and WAZO_* values
npm start                # or: node app.js
# → http://localhost:3000/login  (tenant: acme, user: admin, pass: TechLife@123)
```

Run the Wazo Event Collector (separate long-lived process):
```bash
npm run collector        # or: node collector/collector.js
```

Run the Robo Agent Runtime on a schedule (cron/systemd timer, every 30-60s):
```bash
npm run robo-runtime      # or: node collector/robo_agent_runtime_cli.js
```

## Changelog: fixes from real deployment testing

Three real bugs, reported from an actual install attempt, reproduced
and fixed in this build:

1. **`(row.roles || []).filter is not a function` crashing Admin → Users.**
   Root cause: `role_type` is a Postgres enum, and `node-postgres` has
   no array-type parser registered for custom enum arrays by default —
   `array_agg(r.role_type)` came back as the raw string `"{admin}"`
   instead of a parsed JS array. Fixed by casting inside the aggregate
   (`array_agg(r.role_type::text)`), plus the view now degrades
   gracefully instead of crashing if it ever receives a string.

2. **`permission denied for table crm_integrations`.** Happens when
   schema files get applied by a different Postgres role than the app
   connects as — the table ends up owned by that other role, with no
   grant for the app's role. Reproduced deliberately (created the table
   under `postgres`, revoked all privileges from a non-superuser test
   role, confirmed the exact reported error) and fixed with a new
   `fix_permissions.sql` script — confirmed it resolves the reproduced
   error. See `INSTALL.md` step 5b.

3. **Collector logging bare `Collector error: fetch failed` with no
   actionable detail.** Node's `fetch` rejects self-signed TLS
   certificates by default — extremely common on internal/on-prem Wazo
   installs — and reports almost nothing about why. Added a shared
   `src/wazoFetch.js` wrapper (used by the collector, provisioning
   service, and robo runtime) that surfaces the real cause
   (connection refused, DNS failure, cert error) and a new
   `WAZO_TLS_REJECT_UNAUTHORIZED` env var to explicitly opt into
   trusting a self-signed cert on a trusted internal host.

Also: the entire UI was redesigned from the original bare-bones
prototype styling to a sidebar-based admin panel layout (dark sidebar
with icon nav and active-state highlighting, card-based dashboards,
refined tables/forms/buttons) — applied through the shared partials
(`views/partials/*.ejs`) and `public/assets/style.css`, so every
existing page picked it up with no per-page changes needed. Verified
this didn't break anything: all 29 JS files and every `.ejs` template
still pass syntax/compile checks, and a full login → dashboard → users
page → CRM creation smoke test passed end-to-end after the redesign.

## 7. Reseller / Sub-Tenant hierarchy

Apply the schema addendum first: `psql techlife -f tenant_hierarchy_schema.sql`

Two tenant types, set by Superadmin (**Superadmin → Tenants**, or by
promoting/demoting an existing top-level tenant):

- **Normal** — the default. Manages only itself.
- **Reseller** — can create and manage its own **sub-tenants** from
  **Admin → Sub-Tenants**. A reseller's admin gets a **tenant switcher**
  in the sidebar to move between their own tenant and any of their
  sub-tenants — every admin page (Users, Queues, Campaigns, DIDs,
  Trunks, Privacy, CRM Integration) then operates on whichever tenant
  is currently selected.

**Isolation is enforced server-side on every request**, not just hidden
in the UI: `src/tenantContext.js` computes the admin's own tenant plus
its own sub-tenants (if any) fresh on every request, and any
`?as_tenant=` value that isn't in that exact set is silently ignored —
never trusted from the URL or a stale session value. This was
adversarially tested: logged in as a reseller admin, attempted to
switch into an unrelated tenant's id via the URL, and confirmed the
request fell back to the reseller's own context with zero data leaked
from the unrelated tenant.

**Creating a tenant or sub-tenant** can optionally include an initial
admin login (username/password) right in the same form — without this,
a newly created tenant has no way for anyone to sign in to it. Both
paths (Superadmin creating a top-level tenant, and a reseller creating
a sub-tenant) also auto-create the tenant's 4 standard roles
(admin/supervisor/agent/mis_agent), which are required before
`/admin/users/create` can assign any role — a real gap caught and fixed
while testing this feature (previously a brand-new tenant had no roles
rows at all).

**Trunk management** (new: **Admin → SIP Trunks**) follows the identical
isolation rule — a trunk belongs to whichever tenant is currently
selected via the switcher, and is invisible to every tenant outside
that reseller's own hierarchy.

## Changelog: reseller/sub-tenant hierarchy + trunk management

New this round, all adversarially tested against a real database:

- **Reseller / sub-tenant hierarchy** — `tenant_hierarchy_schema.sql`,
  `src/tenantContext.js`. Verified end-to-end: created a reseller tenant
  and an unrelated normal tenant via Superadmin, had the reseller create
  a real sub-tenant with its own login, confirmed that sub-tenant's admin
  can log in directly, confirmed the unrelated tenant gets a 403 on
  `/admin/sub-tenants`, and — the important one — **attempted the actual
  attack**: logged in as the reseller admin and tried switching into the
  unrelated tenant via `?as_tenant=<id>` in the URL. Confirmed the
  request was silently rejected and zero data leaked, verified by
  checking the response contained none of the unrelated tenant's data
  and by checking the database directly.
- **A second real bug, caught while building this**: new tenants had no
  `roles` rows at all, so `/admin/users/create` would silently create a
  user with no role assigned. Fixed with `src/tenantSetup.js`, which
  both tenant-creation paths now call.
- **A third real bug, caught while testing tenant creation**: submitting
  the tenant-creation form with zero feature checkboxes ticked crashed
  with `null value in column "is_enabled" violates not-null constraint`
  — `feature && feature[fk] !== undefined` returns JS `undefined` (not
  `false`) when `feature` itself is `undefined`, and an `undefined` bound
  parameter becomes SQL `NULL`. Fixed with an explicit `!!(...)` coercion.
- **SIP Trunk management** (new: Admin → SIP Trunks) — full create/edit,
  scoped by the same tenant-context rule as everything else. Tested
  create + edit end-to-end.
- **Edit forms added** for Users, Queues, DIDs, and Campaigns (previously
  create-only) — all tested end-to-end (queue rename + strategy change
  confirmed persisted).
- **Visual redesign** toward a dark, grouped-sidebar SPA aesthetic
  (Material Icons, grouped nav sections, tenant-switcher badge) —
  referenced from a Kazoo-based admin panel example provided during
  development. Note: Kazoo and Wazo are different platforms with
  unrelated REST APIs (Kazoo uses `/v2` account/device/callflow
  resources; Wazo uses confd/calld/agentd) — only the visual language
  was carried over, not any API integration code.

## Changelog: design system rebuilt after actually studying all 4 reference files

Previously, the dark-sidebar redesign was only informed by a quick look
at `kazoo_admin.php`'s nav structure — not a real study of all four
reference dashboards (admin, agent, supervisor, callcenter) provided.
Called out directly, then fixed properly:

- Extracted and compared the actual `:root` CSS variable blocks from all
  four files. Confirmed they share one structural design language (near-
  black multi-layer background `--c0`→`--c4`, `--bd`/`--bdl` borders,
  three-tier text color `--t0`/`--t1`/`--t2`, JetBrains Mono for every
  numeric/stat value, pill badges with rgba background + matching
  border) with each role given its own accent color/font as a visual
  identity (admin/callcenter: blue + Plus Jakarta Sans; agent: indigo +
  DM Sans; supervisor: teal-green + Syne).
- Per your instruction to keep ONE general aesthetic uniformly across
  roles (rather than 4 different accent identities), rebuilt
  `public/assets/style.css` from scratch around the shared structural
  language — full `--c0`–`--c4`/`--bd`/`--t0-2`/`--acc` variable system,
  Plus Jakarta Sans + JetBrains Mono (swapped in for the previous
  Inter + Material Icons pairing), stat cards with tabular-mono numbers,
  properly-bordered rgba pill badges, buttons matching their `.btn`/
  `.bp`/`.bgb` size and color variants, tables matching their uppercase-
  label header treatment, and a live-pulse indicator class.
- Studied `kazoo_agent.php`'s softphone panel specifically (`.call-
  status`, `.dialpad`, `.call-btns`) and rebuilt the Agent Workspace's
  phone panel to match: a green-tinted active-call status card showing
  caller ID, a proper dialpad display + key grid, and a call-controls
  button grid — replacing the previous generic button row.
- Applied everywhere in one place (`public/assets/style.css` +
  `views/partials/head.ejs`/`login.ejs` for the font import), so every
  existing page across every role picked up the new system automatically
  with no per-page changes needed beyond the agent phone panel's markup.
- Verified nothing broke: full lint pass (38 JS files, all EJS
  templates), and a live render test confirming the new fonts/variables/
  component classes are actually present in the served HTML/CSS across
  login, admin dashboard, and the restyled agent phone panel.

## Changelog: IVR management, full delete support, login clarification

- **Two separate login systems clarified** — your Wazo platform's own
  admin UI and TECH-Life have entirely separate user databases by
  design. See INSTALL.md §0.
- **IVR Menu Management** (new: Admin → IVR Menus) — previously
  completely missing (the schema had a bare registry table, no admin
  UI at all). Now full create/edit/delete for menus plus per-key
  routing options (queue/extension/submenu/voicemail/hangup). Tested
  end-to-end: created a menu, added a "press 1 → Sales queue" and
  "press 9 → hang up" option, confirmed both rendered correctly.
  ⚠️ Like monitoring/transfer, this defines *configuration* — actually
  routing live calls through it needs a Wazo dialplan AGI integration,
  documented in INSTALL.md §17.
- **Full delete support** added everywhere it was missing: Tenants
  (Superadmin), Sub-Tenants, Users, Queues, Campaigns, DIDs, SIP Trunks,
  IVR Menus/Options, chatbot rules. Every delete is guarded against
  Postgres foreign-key violations — tested directly: deleting a queue
  that an IVR option still pointed to was correctly blocked with a
  clear message and the queue was confirmed still present in the
  database afterward; deleting the referencing option first and then
  the queue succeeded.
- **Sub-tenant delete ownership check tested as an actual attack**: set
  up two separate resellers, one with a real sub-tenant, logged in as
  the *other* reseller, and tried deleting the first reseller's
  sub-tenant by guessing its ID. Confirmed a 403 and confirmed via
  direct database query that the sub-tenant was untouched.
- Tenant active/inactive toggle added (was referenced by the delete-
  blocked message but didn't actually exist yet).

## Changelog: recordings, login reports, lead/audio upload, monitoring, transfer/conference, omnichannel chat, Mattermost

Everything below was built and tested against a live database in this
round; telephony items needing a real Wazo box are marked accordingly.

- **Recordings** (MIS → Recordings) — search by date/agent/queue/campaign,
  inline playback. Tested including the missing-file case (returns a
  clean 404, not a crash).
- **Agent Login/Logout Report** (MIS → Agent Login/Logout) — pairs each
  login event with its matching logout event and totals available/break
  time within that span. Tested against a seeded 3-hour session with a
  15-minute break; the report computed all three durations exactly right.
- **Lead CSV upload** (Admin → Campaigns → Leads) — flexible column
  matching (phone/phone_number/mobile/number/contact_number), dedup
  against both the file itself and existing leads, invalid-number
  rejection. Tested with a 5-row CSV (3 valid, 1 duplicate, 1 invalid) —
  imported exactly 3.
- **Campaign audio upload** (Admin → Campaigns → script builder) — real
  file upload via multer, served back statically. Tested: uploaded file
  confirmed byte-identical when fetched back over HTTP.
- **Supervisor live dashboard filters** (queue/campaign/skill) and a new
  **Active Calls** panel with Listen/Whisper/Barge buttons.
- **Listen/Whisper/Barge** (`src/callMonitoring.js`) — ⚠️ genuine
  telephony feature requiring a Wazo ChanSpy dialplan context; the code
  is correct against Wazo's documented calld origination API but
  **cannot be verified from this sandbox**. Tested only its failure
  path: confirmed it fails cleanly with an actionable error (not a
  crash) when the supervisor has no provisioned SIP line.
- **WebRTC blind transfer, attended transfer, and a best-effort 3-way
  conference** (Agent Workspace) — uses SIP.js's documented
  `Session.refer()` (blind, and attended via REFER-with-Replaces).
  Conference uses client-side Web Audio API mixing. ⚠️ Verified the EJS
  template and the extracted inline JavaScript are both syntactically
  correct and the page renders; **actual call behavior needs testing
  against a real Wazo box and real audio hardware**, which this sandbox
  cannot provide. Conference in particular is noted in-code as
  best-effort — production-quality conferencing should use a real
  server-side bridge (Asterisk ConfBridge via Wazo).
- **Omnichannel webchat** — a real embeddable widget
  (`public/assets/webchat-widget.js`), public unauthenticated backend
  (`routes/chatWidget.js`), Agent Chat Inbox, and Supervisor Chat
  Monitor — all writing into the same `conversations`/
  `conversation_messages` tables as everything else. Tested completely
  end-to-end: customer starts a chat, sends messages, agent claims and
  replies, customer polls and receives it.
- **Rule-based chatbot** (`src/chatbot.js`) — keyword-match FAQ
  deflection with a configurable fallback. Tested: a matching keyword
  got the configured canned response; a non-matching message got the
  fallback and still reached the agent inbox. This is deliberately not
  an NLU/LLM bot (would need external API keys this sandbox can't
  provision or test against).
- **Mattermost bridge** (`src/mattermostBridge.js`,
  `routes/mattermostReply.js`) — pushes new customer messages to a
  Mattermost incoming webhook, accepts replies back via a slash-command-
  style endpoint with a per-tenant shared secret. Tested with a real
  local mock Mattermost receiver: confirmed both a chatbot-handled and a
  fallback message were pushed with correct thread markers, confirmed a
  reply posted back from "Mattermost" landed in the right conversation
  as an agent message, and confirmed a wrong shared secret is rejected
  with 401.

## What was actually tested (not just written)

Every claim below was verified against a real, running PostgreSQL 16 +
Node.js 22 instance in the build environment:

- All 5 schema files (`schema.sql` + 4 addenda) applied cleanly to a
  fresh database with zero errors.
- Login → session (via `connect-pg-simple`, session table auto-created)
  → RBAC redirect chain, including a real 403 for an out-of-role page.
- Admin dashboard renders live counts from Postgres; confirmed counts
  update after creating a queue and an agent through the actual HTML forms.
- Agent status tracking: posting a new status via the API correctly
  closes the previous open `agent_status_events` row.
- Number masking: inserted a real call with a real customer number,
  confirmed unmasked display with both switches off, confirmed toggling
  supervisor masking ON masks the number on the Call Records page AND in
  the downloaded CSV (verified via `grep` that the raw number is absent),
  and confirmed the agent/supervisor masking switches are fully independent.
- CSV export: correct data, and a real bug was caught and fixed during
  testing — `csv-stringify` was coercing Postgres `Date` objects to
  epoch-millisecond numbers instead of readable timestamps; fixed with an
  explicit `formatCell()` step in `routes/export.js` before serialization.
- XLSX export (via ExcelJS): output recognized by the `file` command as
  "Microsoft Excel 2007+".
- CDR export RBAC: an agent can export their own calls (`context=agent`)
  but gets a real 403 requesting the supervisor-wide CDR.
- SIP credentials API: manual-attach provisioning stores credentials
  correctly; an agent can fetch their own SIP credentials (200) but gets
  a real 403 fetching another agent's.
- CRM Integration: created a real integration through the admin form,
  confirmed `GET /api/v1/crm/config` returns it correctly for the agent
  workspace's screen-pop JS to consume.
- CRM webhook push: stood up a local HTTP receiver, triggered a real
  `CrmNotifier.notify()` call, and confirmed the receiver verified the
  HMAC-SHA256 `X-TechLife-Signature` as valid, got HTTP 200 back, and
  the delivery was correctly logged to `crm_webhook_deliveries` with
  `success: true`.
- All 28 JS files pass `node -c` syntax checking; every `.ejs` template
  compiles successfully via the `ejs` package.

What could **not** be tested in this sandbox (no real Wazo platform or
browser available): actual SIP.js registration against live
`websocketd`, real WebRTC audio, actual CRM screen-pop firing in a
browser, and the Wazo bus event names in `collector/collector.js`'s
`mapWazoEvent()` against a real Wazo bus feed. These are called out
explicitly in INSTALL.md with exactly what to verify against your
specific Wazo version.

## What's stubbed / what to finish before production

- **TTS synthesis** (`collector/roboAgentRuntime.js`'s `synthesizeTts()`)
  — clearly marked placeholder for your chosen TTS provider (Google
  Cloud TTS, Amazon Polly, Azure Neural TTS, or self-hosted).
- **MFA** — not implemented (no TOTP flow).
- **PDF export** — not implemented; CSV and XLSX are fully working.
  Add a library like `pdfmake` or `puppeteer` (both real npm packages,
  installable the same way everything else here was) if needed.
- **Row-Level Security** — `src/db.js`'s `setTenantScope()` sets the
  Postgres session var as a hook; add the actual `CREATE POLICY`
  statements per `ARCHITECTURE.md` section 6 for defense-in-depth.
- **Materialized view refresh** — set up a cron calling
  `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_...` for each `mv_*` view.
- **Partitioning** — `call_events` and `omnichannel_events` are declared
  `PARTITION BY RANGE`; add a monthly partition-creation job before
  production call volume.
- **WebRTC popup-blocker interaction** — some browsers restrict
  `window.open()` calls that don't originate from a direct user gesture;
  an incoming-call screen-pop firing from an async SIP event may be
  blocked in some browser/version combinations. Test against your actual
  target browsers, and prefer the `iframe_panel` mode if this is an issue.
