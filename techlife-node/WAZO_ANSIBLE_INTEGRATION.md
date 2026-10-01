# Wazo Ansible + TECH-Life Integration Plan

## Verified status

I checked the current repository state and the previous recommendation file was not actually present in the repo. The project is still a standalone Node/Express app under `techlife-node`, not a Wazo-native module or a Wazo Ansible plugin.

The upstream Wazo install mechanism is in the separate repos:
- `https://github.com/wazo-platform/wazo-ansible.git`
- Wazo system services and databases are created and managed by Wazo Ansible / Wazo packages.

This means the correct design is not “modify Wazo DB directly from TECH-Life.” The correct design is:
- Wazo Ansible provisions Wazo itself.
- TECH-Life queries and syncs Wazo through its APIs.
- Tenant, users, agents, queues, and IVR config are synchronized to TECH-Life through Wazo API/webhooks and not by directly altering Wazo service databases.

---

## Correct integration model

### 1) Wazo Ansible does the platform setup
Wazo Ansible installs and configures:
- `wazo-auth`
- `wazo-confd`
- `wazo-calld`
- `wazo-agentd`
- PostgreSQL for Wazo services
- SIP trunks, tenants, queues, agents
- web sockets and message bus

This is the platform layer.

### 2) TECH-Life owns the reporting / CRM / admin layer
TECH-Life should handle:
- customer/tenant user login for the contact-center app
- app-level RBAC
- reporting dashboards
- agent workspace UI
- MIS reports
- CRM screenpop
- queue and IVR management for the operator portal

### 3) Sync instead of direct DB editing
When a tenant is created in TECH-Life:
- first create or map the tenant in Wazo via `wazo-auth`/`confd` API or tenant provisioning endpoint
- then create app-side tenant record in TECH-Life
- then create roles and permissions in TECH-Life
- then create the user/agent in Wazo if needed

This keeps Wazo as the source of truth for telephony resources and TECH-Life as the source of truth for business reporting and UI logic.

---

## Required Wazo integration points

### A. Tenant creation
TECH-Life should support a workflow like:
- Admin click “Create Tenant”
- TECH-Life creates tenant metadata in its own DB
- TECH-Life calls Wazo tenant provisioning endpoint (or the appropriate Wazo API route for tenant creation)
- TECH-Life stores the mapped Wazo tenant UUID

Example flow:
```javascript
await wazoClient.post('/api/confd/1.1/tenants', {
  name: tenant.name,
  slug: tenant.slug,
  timezone: tenant.timezone,
  uuid: tenant.uuid
});
```

### B. User / agent login and role mapping
A user must be linked to:
- TECH-Life user record
- TECH-Life role set
- Wazo tenant id
- Wazo agent if they are a voice agent

Mapping example:
```sql
users (
  id, tenant_id, username, email, password_hash,
  wazo_tenant_uuid, wazo_user_uuid, wazo_agent_id,
  full_name, is_active
)
```

### C. Wazo agent provisioning
If a user is an agent:
- create Wazo user + Wazo agent profile
- attach SIP line / extension
- create agentd status mapping
- store returned IDs in TECH-Life DB

This is the correct way to ensure the same user can log in to TECH-Life and operate Wazo resources for real calls.

### D. Dialpad, ring, tone, and call control
The agent page must use a real SIP connection to Wazo or Asterisk through the web client. That means the UI should integrate with:
- SIP.js
- Wazo websocketd
- Wazo calld / agentd APIs
- WebRTC media streams

The UI must support:
- dialpad tones
- call progress/ringing state
- inbound/outbound ringing
- agent status login/logout
- hold, transfer, conference, whisper, barge, monitor controls

---

## Correct role model

The current project already has the basic roles, but the model should be tightened to match a real Wazo ops structure.

### Recommended roles
- `superadmin`: full platform administration
- `admin`: tenant administrator
- `manager`: team manager, team reports, agent assignment, call monitoring, no full tenant config changes
- `supervisor`: queue and team oversight, live dashboard, listen/whisper/barge
- `agent`: call handling, status updates, queue login/logout
- `mis_agent`: reporting-only access, not call operations

### Permission model
Use permissions, not only role names:
```sql
permissions (
  id, code, description
)

role_permissions (
  role_id, permission_id
)
```

Recommended MIS permissions:
- `reports.view.daily`
- `reports.view.queue`
- `reports.view.agent`
- `reports.view.ivr`
- `reports.export.csv`
- `reports.export.xlsx`
- `recordings.play`
- `agent_activity.view`

Manager permissions:
- `team.view`
- `team.call_monitor`
- `team.agent_status`
- `reports.view.queue`
- `reports.view.agent"
- `team.call_transfer`
- `team.whisper`
- `team.barge`

---

## Theme system requirements

The previous idea of a 5-color theme switcher is valid and should be included.

### Add a theme table
```sql
CREATE TABLE tenant_themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  primary_color TEXT NOT NULL,
  secondary_color TEXT NOT NULL,
  accent_color TEXT NOT NULL,
  background_color TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Presets
- Blue
- Green
- Red
- Purple
- Orange

This should load in the EJS layout as CSS variables so the whole UI changes via one switch button.

---

## Queue management and call flow requirements

This is a core missing feature and it should reflect how Wazo queue logic actually works.

### Required queue fields
- queue name
- queue number / extension
- strategy
- wait threshold
- timeout seconds
- fallback queue / IVR / campaign / voicemail
- callback option

### Queue routing model
```sql
CREATE TABLE queue_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  queue_id UUID NOT NULL,
  primary_target_type TEXT CHECK (...),
  fallback_target_type TEXT CHECK (...),
  timeout_target_type TEXT CHECK (...),
  overflow_threshold INTEGER,
  timeout_seconds INTEGER,
  callback_enabled BOOLEAN DEFAULT FALSE
);
```

This is required for real Wazo call routing and queue announcements.

---

## IVR and audio integration requirements

### Real IVR manager should include
- IVR menu configuration
- prompt audio upload
- TTS fallback
- DTMF mapping
- queue / extension / submenu / hangup target
- per-menu greeting and invalid retry behavior

### Audio file lifecycle
Audio uploaded through TECH-Life should be stored in both places:
1. Web-accessible asset under `/public/uploads/audio/...`
2. Asterisk-accessible path under `/var/lib/asterisk/sounds/techlife/<tenant>/...`

This is the key step to make voice prompts playable in actual Asterisk/Wazo dialplan.

---

## Asterisk/Wazo dialplan direction

The app should not pretend that UI-only settings are enough. The proper flow is:

### Wazo dialplan / AGI flow
- incoming call enters queue / IVR
- AGI fetches queue and IVR config from TECH-Life API
- returns queue position, wait estimation, and target routing
- Asterisk plays queue prompt or IVR prompt
- Wazo calld / agentd records the real call state

A simple Asterisk sequence looks like:
```asterisk
same => n,AGI(techlife_queue_position.py,${TENANT_ID},${QUEUE_ID},${CALLID})
same => n,Playback(techlife/queue-position)
same => n,Queue(${QUEUE_NAME},,,techlife-queue-logic)
```

This should be generated from TECH-Life config and exposed to Asterisk via AGI script or Wazo dialplan configuration.

---

## Recommended implementation order

### Phase 1 — Foundation
- tenant + user + agent sync with Wazo
- correct RBAC / permission model
- theme preset system
- manager and MIS role setup

### Phase 2 — Call handling
- queue routing and fallback logic
- IVR menu management with upload
- Asterisk audio asset copy logic
- queue position API

### Phase 3 — Agent experience
- SIP.js dialpad connection
- ringing and call progress UI
- hold / transfer / monitoring controls
- WebRTC conference support

### Phase 4 — Production hardening
- audit trail for Wazo sync
- rollback / sync retries
- rate limiting and webhook validation
- file security and content-type validation

---

## What is missing in the current repo

From the code I checked, the app has many excellent pieces already:
- tenant creation flow is present in some areas
- role checking exists
- queue and IVR routes exist
- audio upload middleware exists
- Wazo collector exists

But the required end-to-end flow is not fully complete yet:
- no full Wazo-Asterisk integration document
- no dedicated Wazo tenant sync layer
- no manager permission flow fully enforced
- no real one-click theme switcher implementation in app data model
- no full queue routing + Asterisk audio manager layered together
- no complete sync between TECH-Life and external Wazo tenant/user/agent objects

---

## Final position

The correct direction is:

- Keep `wazo-ansible` as the Wazo platform installer
- Keep TECH-Life as the Node app for business logic and reporting
- Use the Wazo API as the integration layer
- Use Wazo resources as the real call, queue, and agent backend
- Ensure TECH-Life login and tenant handling map directly to Wazo tenant + agent resources

This is the architecture that will let a tenant created in TECH-Life reflect in Wazo resources, and it is the correct way to give the same user access to agent phone controls and queue handling.

---

## Next concrete action

The next step I recommend is to implement a real Wazo sync layer in the app:
- `src/wazoTenantSync.js`
- `src/wazoUserSync.js`
- `src/wazoAgentSync.js`
- `src/wazoQueueSync.js`

These will handle:
- tenant creation in Wazo
- agent creation in Wazo
- queue and IVR config synchronization
- login/session mapping to Wazo tenant IDs
- inbound/outbound call state updates

This is the bridge that will make TECH-Life integrate cleanly with `wazo-ansible` and the live Wazo platform.
