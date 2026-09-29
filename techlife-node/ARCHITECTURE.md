# TECH-Life Contact-Center Solution
### Multi-Tenant Omnichannel Reporting & WebRTC Platform on Wazo — Architecture v1.0

This document is the data/event/API layer that every report, dashboard, and
future channel integration builds on. Nothing here is UI-specific — the PHP
UI, agent workspace, and supervisor/management dashboards all read from the
same tables and services described below. See `schema.sql` for the full DDL.

---

## 1. Layered Architecture

```
                         Web Application (Agent / Supervisor / Admin / MIS)
                                          │
                                    API Gateway (auth, tenant scope, RBAC)
                                          │
        ┌───────────────┬─────────────────┼─────────────────┬───────────────┐
        │               │                 │                 │               │
   Auth Service   Tenant/RBAC       Core Backend       Reporting API   Realtime Gateway
                                 (Campaign/Queue/           (reads mv_*      (WebSocket /
                                  Contact/Chat)              views only)      websocketd)
        └───────────────┴─────────────────┼─────────────────┴───────────────┘
                                          │
                                   EVENT PROCESSOR
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                     WAZO EVENT COLLECTOR        AGI BRIDGE (business data
                     (calld/confd/agentd/         only: campaign_id, lead_id,
                      chatd/websocketd)            disposition, transfer reason)
                              │
                            WAZO
                    (asterisk, calld, confd, agentd,
                     chatd, webhookd, CDR/CEL, RabbitMQ)
                              │
                            PSTN / WebRTC / SIP Trunks
```

Key principle from the brief: **Wazo CDR/CEL is authoritative for call
timing**. AGI is only used to inject business context Wazo doesn't know
about (campaign, lead, custom disposition, transfer reason). The Event
Collector never treats AGI as a timing source.

---

## 2. Event Sourcing Model

Every state change in the system — an agent going on break, a call being
answered, a chat message arriving, an IVR menu being entered — becomes a row
in one of the append-only event tables:

| Event table | What it captures |
|---|---|
| `agent_status_events` | Every agent state transition (login, break types, ACW, etc.) |
| `call_events` | Ring/answer/hold/resume/transfer/hangup for a single call |
| `ivr_events` | Every node/step a caller passes through in an IVR |
| `queue_events` | Join/abandon/answer/overflow at the queue level |
| `omnichannel_events` | The unified cross-channel feed (superset, for audit/debug) |

**Design contract:** `omnichannel_events` is not a replacement for the
channel-specific event tables — it's a denormalized copy written by the
Event Processor *in addition to* the specific table, tagged with a stable
`event_uuid`. This gives:
- A single audit/debugging timeline across all channels (Requirement #11).
- Channel-specific tables that stay clean and strongly typed for reporting joins.

Summary/aggregate columns (e.g. `calls.talk_seconds`, `calls.hold_seconds`,
`ivr_sessions.duration_seconds`) are *never* entered by hand — they are
either Postgres `GENERATED` columns computed from the authoritative
timestamps, or maintained by the Event Processor by summing the
corresponding `*_events` rows for that entity. This is what guarantees
Requirement #16 (data consistency): every report is a query against the
same base rows or the same materialized views, so the same call always
produces the same numbers everywhere.

---

## 3. Wazo Integration — Event Collector Design

### 3.1 Sources consumed
| Wazo component | What we pull | Protocol |
|---|---|---|
| `calld` | Real-time call events (ringing, answered, hold, transfer, hangup) | Websocket (bus events) + REST for enrichment |
| `confd` | Users, trunks, queues, DIDs, IVR config (reference data sync) | REST, polled/webhook on change |
| `agentd` | Agent login/logout/pause events | Websocket (bus events) |
| CDR/CEL (via `webhookd` or DB replica) | Authoritative call timing & disposition-adjacent facts | Webhook push or scheduled pull |
| `chatd` | Chat session/message events | Websocket |
| AGI scripts (custom, per dialplan) | Business fields not native to Wazo: campaign_id, lead_id, IVR business selection, transfer reason, disposition code | HTTP POST to Event Collector's `/agi-events` endpoint |

### 3.2 Collector responsibilities
The **Wazo Event Collector** is a small, stateless worker (or pool of
workers) that:
1. Subscribes to Wazo's RabbitMQ/websocket bus for `calld`, `agentd`,
   `chatd` events, and receives AGI HTTP callbacks and CDR webhooks.
2. Normalizes each raw payload into a canonical internal event envelope:
   `{tenant_id, event_type, channel, entity_ids{...}, event_time, payload}`.
3. Publishes the canonical envelope onto an internal queue (RabbitMQ topic
   exchange, e.g. `techlife.events.{channel}`) for the Event Processor.
4. Does **no business logic** and **no direct DB writes** — it only
   translates and forwards. This keeps it replaceable if Wazo's bus format
   changes, and lets the Event Processor be the single place aggregation
   rules live.

### 3.3 Event Processor responsibilities
The **Event Processor** is the only writer to the reporting database. It:
1. Resolves canonical envelopes to tenant/agent/queue/campaign/DID/contact
   UUIDs (via lookup tables, cached in Redis) — this is where Wazo's
   integer IDs get mapped to our `tenant_id`-scoped UUIDs.
2. Writes to the specific event table (`agent_status_events`, `call_events`,
   `ivr_events`, `queue_events`, chat/email tables) **and** to
   `omnichannel_events`, in the same transaction.
3. Closes the previous open row where relevant — e.g. an `AGENT_BREAK_END`
   event sets `ended_at` on the still-open `agent_status_events` row rather
   than only inserting a new one, so `duration_seconds` can be computed by
   Postgres.
4. Upserts aggregate columns on the parent entity (`calls.hold_seconds`,
   `ivr_sessions.steps_count`, etc.) via a single `UPDATE ... SET x = x +
   n`, guarded by the event's `event_uuid` to make processing idempotent
   (safe against at-least-once delivery / retries).
5. Reconciliation job (nightly + on-demand): compares PHP-UI-sourced
   `agent_status_events` (`source = 'php_ui'`) against Wazo `agentd` events
   (`source = 'wazo_event'`) for the same agent/time window, flags and
   auto-closes orphaned open sessions (e.g. browser closed without logout),
   and marks the reconciled rows `source = 'reconciled'`.

### 3.4 Delivery guarantees
- RabbitMQ with durable queues + manual ack: the Event Processor acks only
  after the DB transaction commits.
- All inserts keyed by `event_uuid` with a unique index → replays/duplicate
  deliveries are no-ops.
- If the Event Processor is down, events queue in RabbitMQ (bounded by
  disk); Wazo itself is unaffected since the Collector only *subscribes*,
  it doesn't sit in the call path.

---

## 4. Reporting Layer Strategy (Requirement #16: one source of truth)

1. **Raw tables** (`calls`, `agent_status_events`, `ivr_sessions`,
   `conversations`, …) are the ground truth, always queryable for ad-hoc /
   custom-range reports and CSV/Excel/PDF export.
2. **Materialized views** (`mv_agent_hourly`, `mv_agent_hourly_calls`,
   `mv_queue_hourly`, `mv_campaign_daily`, `mv_did_hourly`, `mv_ivr_hourly`)
   pre-aggregate the hot paths used by dashboards, so the Supervisor and
   Management dashboards never scan raw event tables directly.
   - Refreshed with `REFRESH MATERIALIZED VIEW CONCURRENTLY` (enabled by
     the unique indexes already defined in `schema.sql`) on a 1–5 minute
     cron for near-real-time views, and again after nightly reconciliation.
   - Daily/weekly/monthly rollups are plain `GROUP BY date_trunc('day'|
     'week'|'month', hour_bucket)` queries **on top of these same hourly
     views** — never a separately-computed pipeline. This is what
     guarantees an agent's daily total always equals the sum of their
     24 hourly rows.
3. **Reporting Service** (a PHP service layer, not individual report
   controllers) exposes typed query builders — `AgentReportService`,
   `QueueReportService`, `CampaignReportService`, `DIDReportService`,
   `IVRReportService` — each of which *only* queries the raw tables or
   `mv_*` views above. Individual report endpoints/pages call these
   services; they never write their own SQL aggregations. This is the
   concrete mechanism that prevents "15 PHP reports that each calculate
   things differently."
4. **Derived metrics formulas** (kept in exactly one place — the Reporting
   Service — and documented here so every consumer agrees):
   - `Occupancy = (talk + hold + acw) / (talk + hold + acw + available_idle)`
   - `Productivity = (talk + hold + acw) / total_login_time`
   - `Adherence = actual_status_time_in_schedule / scheduled_time` (needs a
     `agent_schedules` table — out of scope for v1, flagged for phase 2)
   - `Service Level = calls answered within SLA / (answered + abandoned)`
     — already encoded in `mv_queue_hourly.service_level`
   - `Conversion rate = conversions / total_interactions` per channel,
     from `dispositions.is_conversion` joined to `calls`/`conversations`.

---

## 5. PHP REST API Structure

Base path: `/api/v1`. Every request is authenticated (JWT/session) and
scoped to `tenant_id` from the token — no endpoint accepts a client-supplied
tenant id for data access; it's always resolved server-side from the
authenticated user, then checked against resource ownership.

```
/api/v1/auth
    POST   /login
    POST   /logout
    POST   /mfa/verify
    POST   /password/forgot

/api/v1/tenants                (superadmin only)
    GET    /
    POST   /
    GET    /{id}
    PATCH  /{id}
    PATCH  /{id}/features

/api/v1/users
    GET    /            POST   /
    GET    /{id}        PATCH  /{id}     DELETE /{id}
/api/v1/roles, /api/v1/permissions       (RBAC CRUD)

/api/v1/trunks | /api/v1/prefixes | /api/v1/dids
/api/v1/queues | /api/v1/queues/{id}/agents
/api/v1/campaigns | /api/v1/campaigns/{id}/agents | /api/v1/campaigns/{id}/leads
/api/v1/leads               POST /import  (CSV/Excel upload + validation)
/api/v1/contacts            GET /{id}/history   (Customer 360 feed, Req #9)
/api/v1/ivr-menus

/api/v1/agents
    GET  /{id}/status                 current live status
    POST /{id}/status                 agent-initiated status change (writes
                                       agent_status_events with source='php_ui')
    GET  /{id}/sessions

/api/v1/calls                        list/search calls (filters per Req #15)
    GET  /{id}                       full call detail incl. events timeline
    GET  /{id}/recording

/api/v1/ivr-sessions/{id}/journey    the visual per-call IVR path (Req #4)

/api/v1/conversations                omnichannel list (chat/email/whatsapp/sms)
    GET /{id}/messages
    POST /{id}/messages
    POST /{id}/close

/api/v1/reports/agents/hourly | daily | weekly | monthly
/api/v1/reports/agents/{id}/performance
/api/v1/reports/queues/{id}
/api/v1/reports/campaigns/{id}
/api/v1/reports/dids/{id}
/api/v1/reports/ivr/{menu_id}
/api/v1/reports/export?format=csv|xlsx|pdf&report=...&filters=...
/api/v1/reports/schedule            (recurring report subscriptions)

/api/v1/realtime/dashboard/supervisor   (bootstraps; live deltas via WebSocket)
/api/v1/realtime/dashboard/management

/api/v1/quality/reviews              QA scorecards (Req: Quality Management)
/api/v1/audit-logs                   (admin/superadmin)
```

Every `/reports/*` and `/realtime/dashboard/*` endpoint is implemented
**only** via the Reporting Services described in section 4 — this is the
architectural rule that keeps all reports consistent.

Realtime dashboard data (Requirement #13) is pushed over WebSocket
(`websocketd`-style) using the same canonical events the Event Processor
already produces — the Realtime Gateway is a thin subscriber to the same
RabbitMQ topic exchange the Event Processor consumes, so the live dashboard
and the historical reports are guaranteed to agree (same event stream, two
consumers).

---

## 6. Multi-Tenancy & Security Enforcement

- Every table with tenant-owned data carries `tenant_id`; every API query
  is auto-scoped by middleware that injects `WHERE tenant_id = :auth_tenant`
  before any handler code runs — handler code cannot omit it.
- Row-level security (Postgres RLS) is recommended as a defense-in-depth
  layer on top of the application-level scoping, using
  `SET app.current_tenant = '<uuid>'` per connection/session.
- Recording/download access, transfer targets, and campaign/queue
  assignment are additionally checked against `role_permissions` per
  request (RBAC), not just tenant match.
- All admin/config-changing actions write to `audit_logs` with
  previous/new value diffs.

---

## 7. Build Order (confirming your Section 17, mapped to deliverables)

| Phase | Deliverable | Primary tables/services touched |
|---|---|---|
| 1 | PostgreSQL schema (this document's companion `schema.sql`) | all |
| 2 | Wazo Event Collector (calld/agentd/chatd subscribers, CDR webhook, AGI bridge) | — |
| 3 | Event Processor + `omnichannel_events` + idempotent upserts | `omnichannel_events`, per-channel event tables |
| 4 | Agent login/logout/status tracking + reconciliation job | `agent_status_events`, `agent_sessions` |
| 5 | Call/voice normalization from CDR/CEL | `calls`, `call_events`, `call_participants` |
| 6 | IVR journey tracking | `ivr_sessions`, `ivr_events` |
| 7 | Queue tracking | `queue_events`, `mv_queue_hourly` |
| 8 | Campaign tracking (voice first, then omnichannel) | `campaigns`, `campaign_events`, `leads` |
| 9 | DID tracking | `dids`, `mv_did_hourly` |
| 10 | Customer 360 | `contacts`, `conversations` |
| 11–13 | Chat / Email / WhatsApp-SMS-social integration | `conversations`, `chat_sessions`, `emails` |
| 14 | PHP REST API (section 5) | API Gateway + Reporting Services |
| 15 | Real-time Supervisor Dashboard | Realtime Gateway + WebSocket |
| 16 | Agent Dashboard (WebRTC workspace) | `/api/v1/agents`, `/api/v1/conversations` |
| 17 | Management Dashboard | `/api/v1/reports/*` |
| 18 | Hourly/Daily/Weekly/Monthly reports | `mv_*` views + Reporting Services |
| 19 | CSV/Excel/PDF export | `/api/v1/reports/export` |
| 20 | Scheduled reports & alerts | `/api/v1/reports/schedule` + worker |

This build order lets every later phase (chat, email, WhatsApp, new report
types) plug into the same `omnichannel_events` + `conversations` +
Reporting Service pattern already proven by voice — which is the
scalability requirement in your brief (Section 27 / Final Requirement):
adding a channel means adding rows to existing tables, not new schemas.
