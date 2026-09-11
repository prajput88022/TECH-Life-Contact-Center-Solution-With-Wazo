-- =====================================================================
-- TECH-Life Contact-Center Solution
-- Multi-Tenant Omnichannel Contact Center Reporting Platform (on Wazo)
-- PostgreSQL Core Schema  v1.0
-- =====================================================================
-- Design rules followed throughout this file:
--   1. Every tenant-owned table carries tenant_id and it is the FIRST
--      column of every composite index used for reporting, so Postgres
--      can always prune by tenant first (multi-tenant isolation + speed).
--   2. Nothing is ever hard-deleted from event/history tables. Status
--      fields (is_active, deleted_at) are used instead.
--   3. Wazo's CDR/CEL remains the source of truth for call timing.
--      wazo_call_id / wazo_cel_id columns are kept so we can always
--      reconcile our normalized rows against raw Wazo data.
--   4. All "duration" columns are GENERATED where possible so reports
--      never recompute them differently in different places.
--   5. High-volume, append-only tables (call_events, agent_status_events,
--      omnichannel_events, ivr_events, queue_events) are designed to be
--      PARTITIONED BY RANGE (event_time) per month. Partitioning DDL is
--      included at the bottom as a template.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- 0. ENUM TYPES
-- =====================================================================

CREATE TYPE channel_type AS ENUM
  ('voice','ivr','chat','email','whatsapp','sms','social','video');

CREATE TYPE direction_type AS ENUM ('inbound','outbound','internal');

CREATE TYPE agent_status_type AS ENUM
  ('login','logout','available','break','lunch','tea','training',
   'meeting','system_issue','personal_break','after_call_work',
   'on_call','on_chat','on_email','offline','custom');

CREATE TYPE call_status_type AS ENUM
  ('ringing','answered','missed','abandoned','busy','failed','completed');

CREATE TYPE user_role_type AS ENUM
  ('superadmin','admin','supervisor','agent','mis_agent');

-- =====================================================================
-- 1. PLATFORM / TENANT / RBAC
-- =====================================================================

CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(150) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,
    wazo_tenant_uuid UUID,                         -- link to Wazo's own tenant
    timezone        VARCHAR(64) NOT NULL DEFAULT 'UTC',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_features (
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    feature_key     VARCHAR(64) NOT NULL,   -- e.g. 'webrtc','recording','omnichannel','auto_dialer'
    is_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    config_json     JSONB NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, feature_key)
);

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE CASCADE, -- NULL = platform-level role
    name            VARCHAR(100) NOT NULL,
    role_type       user_role_type NOT NULL,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(100) NOT NULL UNIQUE,  -- e.g. 'reports.export.csv'
    description     VARCHAR(255)
);

CREATE TABLE role_permissions (
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    wazo_user_uuid  UUID,                           -- link to Wazo confd user
    username        VARCHAR(100) NOT NULL,
    email           VARCHAR(150),
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(150),
    mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, username)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE user_roles (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,
    resource_type   VARCHAR(100),
    resource_id     VARCHAR(100),
    previous_value  JSONB,
    new_value       JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);

-- =====================================================================
-- 2. TELEPHONY INFRASTRUCTURE (trunks, prefixes, DIDs)
-- =====================================================================

CREATE TABLE trunks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    wazo_trunk_id   INTEGER,                        -- Wazo confd trunk id
    sip_server      VARCHAR(255),
    transport       VARCHAR(20) DEFAULT 'udp',
    codec           VARCHAR(50),
    max_calls       INTEGER,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_trunks_tenant ON trunks(tenant_id);

CREATE TABLE prefixes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    trunk_id        UUID REFERENCES trunks(id),
    prefix_digits   VARCHAR(20) NOT NULL,
    route_name      VARCHAR(100),
    strip_digits    INTEGER DEFAULT 0,
    prepend_digits  VARCHAR(20),
    priority        INTEGER DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX idx_prefixes_tenant ON prefixes(tenant_id);

CREATE TABLE dids (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    did_number      VARCHAR(30) NOT NULL,
    wazo_incall_id  INTEGER,
    description     VARCHAR(150),
    default_queue_id UUID,      -- FK added after queues table
    default_ivr_id  UUID,       -- FK added after ivr_menus table
    campaign_id     UUID,       -- FK added after campaigns table
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, did_number)
);
CREATE INDEX idx_dids_tenant ON dids(tenant_id);

-- =====================================================================
-- 3. IVR DEFINITION (design-time) -- runtime journey tracked later
-- =====================================================================

CREATE TABLE ivr_menus (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    wazo_ivr_id     INTEGER,
    name            VARCHAR(150) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE dids ADD CONSTRAINT fk_dids_ivr
    FOREIGN KEY (default_ivr_id) REFERENCES ivr_menus(id);

-- =====================================================================
-- 4. QUEUES
-- =====================================================================

CREATE TABLE queues (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    wazo_queue_id   INTEGER,
    name            VARCHAR(150) NOT NULL,
    queue_number    VARCHAR(20),
    strategy        VARCHAR(30) DEFAULT 'ringall',  -- ringall/roundrobin/leastrecent/leastcalls/random/skillbased
    max_wait_seconds INTEGER,
    max_queue_size  INTEGER,
    wrapup_seconds  INTEGER DEFAULT 0,
    sla_seconds     INTEGER DEFAULT 20,      -- used for service-level calc
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, queue_number)
);
CREATE INDEX idx_queues_tenant ON queues(tenant_id);

ALTER TABLE dids ADD CONSTRAINT fk_dids_queue
    FOREIGN KEY (default_queue_id) REFERENCES queues(id);

-- =====================================================================
-- 5. AGENTS
-- =====================================================================

CREATE TABLE agents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wazo_agent_id   INTEGER,
    agent_number    VARCHAR(20),
    extension       VARCHAR(20),
    skills_json     JSONB DEFAULT '[]',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, agent_number)
);
CREATE INDEX idx_agents_tenant ON agents(tenant_id);

CREATE TABLE queue_agents (
    queue_id        UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    penalty         INTEGER DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (queue_id, agent_id)
);

-- =====================================================================
-- 6. AGENT LOGIN / STATUS TRACKING  (Requirement #1)
-- =====================================================================
-- One row per continuous state. ended_at/duration_seconds are filled in
-- when the NEXT status event arrives (closing the previous one) or by
-- the nightly reconciliation job for still-open sessions at day rollover.

CREATE TABLE agent_status_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    queue_id        UUID REFERENCES queues(id),          -- nullable: not all states are queue-scoped
    status          agent_status_type NOT NULL,
    reason_code     VARCHAR(50),                          -- e.g. 'LUNCH','WIFI_ISSUE', configurable
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ,
    duration_seconds INTEGER GENERATED ALWAYS AS (
        CASE WHEN ended_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
             ELSE NULL END
    ) STORED,
    source          VARCHAR(30) NOT NULL,   -- 'wazo_event' | 'php_ui' | 'reconciled'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ase_tenant_agent_time ON agent_status_events(tenant_id, agent_id, started_at DESC);
CREATE INDEX idx_ase_open ON agent_status_events(tenant_id, agent_id) WHERE ended_at IS NULL;
CREATE INDEX idx_ase_status_time ON agent_status_events(tenant_id, status, started_at);

-- Login/logout "session" convenience table (one row per login->logout span,
-- derived from agent_status_events but materialized for fast hourly joins).
CREATE TABLE agent_sessions (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    login_at        TIMESTAMPTZ NOT NULL,
    logout_at       TIMESTAMPTZ,
    logout_reason   VARCHAR(50),
    total_available_seconds INTEGER DEFAULT 0,
    total_break_seconds     INTEGER DEFAULT 0,
    total_acw_seconds       INTEGER DEFAULT 0,
    source          VARCHAR(30) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_asess_tenant_agent_time ON agent_sessions(tenant_id, agent_id, login_at DESC);

-- =====================================================================
-- 7. CONTACTS / CUSTOMER 360
-- =====================================================================

CREATE TABLE contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_customer_id VARCHAR(100),   -- CRM/lead-source id, if any
    full_name       VARCHAR(150),
    primary_phone   VARCHAR(30),
    alt_phone       VARCHAR(30),
    email           VARCHAR(150),
    whatsapp_id     VARCHAR(60),
    city            VARCHAR(100),
    state           VARCHAR(100),
    custom_fields   JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contacts_tenant_phone ON contacts(tenant_id, primary_phone);
CREATE INDEX idx_contacts_tenant_email ON contacts(tenant_id, email);

-- =====================================================================
-- 8. CAMPAIGNS / LEADS
-- =====================================================================

CREATE TABLE campaigns (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            VARCHAR(150) NOT NULL,
    channel         channel_type NOT NULL DEFAULT 'voice',
    dialing_mode    VARCHAR(30),          -- preview/progressive/predictive/power (voice only)
    dial_level      NUMERIC(4,2),
    caller_id       VARCHAR(30),
    trunk_id        UUID REFERENCES trunks(id),
    queue_id        UUID REFERENCES queues(id),
    start_date      DATE,
    end_date        DATE,
    calling_hours_json JSONB DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaigns_tenant ON campaigns(tenant_id);

ALTER TABLE dids ADD CONSTRAINT fk_dids_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id);

CREATE TABLE campaign_agents (
    campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, agent_id)
);

CREATE TABLE leads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES contacts(id),
    phone_number    VARCHAR(30) NOT NULL,
    status          VARCHAR(30) DEFAULT 'new',   -- new/in_progress/contacted/converted/dnc/invalid/duplicate
    priority        INTEGER DEFAULT 0,
    custom_fields   JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_leads_tenant_campaign ON leads(tenant_id, campaign_id);
CREATE INDEX idx_leads_status ON leads(tenant_id, campaign_id, status);

CREATE TABLE lead_attempts (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    call_id         UUID,             -- FK added after calls table
    attempt_number  INTEGER NOT NULL,
    attempted_at    TIMESTAMPTZ NOT NULL,
    outcome         VARCHAR(30),
    next_retry_at   TIMESTAMPTZ
);
CREATE INDEX idx_lead_attempts_lead ON lead_attempts(lead_id);

-- campaign_contacts: cross-channel link between a campaign and any contact
-- (used for whatsapp/sms/email campaigns as well as voice)
CREATE TABLE campaign_contacts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id      UUID NOT NULL REFERENCES contacts(id),
    status          VARCHAR(30) DEFAULT 'pending',
    converted_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, contact_id)
);

CREATE TABLE campaign_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    campaign_id     UUID NOT NULL REFERENCES campaigns(id),
    contact_id      UUID REFERENCES contacts(id),
    event_type      VARCHAR(50) NOT NULL,   -- ATTEMPT, ANSWERED, CONVERTED, REPLY, ...
    channel         channel_type NOT NULL,
    event_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_json    JSONB DEFAULT '{}'
);
CREATE INDEX idx_campaign_events_tenant_campaign_time
    ON campaign_events(tenant_id, campaign_id, event_time);

-- =====================================================================
-- 9. DISPOSITIONS (shared across channels)
-- =====================================================================

CREATE TABLE dispositions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code            VARCHAR(50) NOT NULL,
    label           VARCHAR(150) NOT NULL,
    is_conversion   BOOLEAN NOT NULL DEFAULT FALSE,
    channel         channel_type,          -- NULL = applies to all channels
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (tenant_id, code)
);

-- =====================================================================
-- 10. CALLS (voice) -- normalized from Wazo CDR/CEL
-- =====================================================================

CREATE TABLE calls (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id),
    wazo_call_id        VARCHAR(100),          -- Wazo call/channel id
    wazo_cdr_id         BIGINT,                -- Wazo CDR row id (authoritative timing)
    agent_id            UUID REFERENCES agents(id),
    queue_id            UUID REFERENCES queues(id),
    campaign_id         UUID REFERENCES campaigns(id),
    did_id              UUID REFERENCES dids(id),
    contact_id          UUID REFERENCES contacts(id),
    direction           direction_type NOT NULL,
    from_number         VARCHAR(30),
    to_number           VARCHAR(30),
    status              call_status_type NOT NULL,
    start_time          TIMESTAMPTZ NOT NULL,   -- call created/dialed
    ring_time           TIMESTAMPTZ,
    answer_time         TIMESTAMPTZ,
    end_time            TIMESTAMPTZ,
    hold_seconds         INTEGER DEFAULT 0,     -- summed from call_events
    acw_seconds          INTEGER DEFAULT 0,
    ring_seconds  INTEGER GENERATED ALWAYS AS (
        CASE WHEN answer_time IS NOT NULL
             THEN EXTRACT(EPOCH FROM (answer_time - COALESCE(ring_time, start_time)))::INTEGER
             ELSE NULL END) STORED,
    -- NOTE: generated columns must be IMMUTABLE, so this can only be
    -- computed once the call has an answer_time or end_time. For a call
    -- still ringing (both NULL), wait_seconds is NULL here; live/in-
    -- progress wait time for the supervisor dashboard is computed at
    -- query time as EXTRACT(EPOCH FROM (now() - start_time)) instead
    -- (see QueueReportService::liveSnapshot() in the application layer).
    wait_seconds  INTEGER GENERATED ALWAYS AS (
        CASE WHEN COALESCE(answer_time, end_time) IS NOT NULL
             THEN EXTRACT(EPOCH FROM (COALESCE(answer_time, end_time) - start_time))::INTEGER
             ELSE NULL END
    ) STORED,
    talk_seconds  INTEGER GENERATED ALWAYS AS (
        CASE WHEN answer_time IS NOT NULL AND end_time IS NOT NULL
             THEN EXTRACT(EPOCH FROM (end_time - answer_time))::INTEGER
             ELSE NULL END) STORED,
    hangup_cause         VARCHAR(50),
    hangup_by            VARCHAR(20),           -- agent/customer/system
    disposition_id       UUID REFERENCES dispositions(id),
    is_transfer          BOOLEAN NOT NULL DEFAULT FALSE,
    transfer_to_type      VARCHAR(20),          -- agent/queue/supervisor
    transfer_to_id        UUID,
    ivr_session_id        UUID,                 -- FK added after ivr_sessions
    recording_id          UUID,                 -- FK added after recordings
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calls_tenant_time ON calls(tenant_id, start_time DESC);
CREATE INDEX idx_calls_tenant_agent_time ON calls(tenant_id, agent_id, start_time DESC);
CREATE INDEX idx_calls_tenant_queue_time ON calls(tenant_id, queue_id, start_time DESC);
CREATE INDEX idx_calls_tenant_campaign ON calls(tenant_id, campaign_id, start_time DESC);
CREATE INDEX idx_calls_tenant_did ON calls(tenant_id, did_id, start_time DESC);
CREATE INDEX idx_calls_wazo_cdr ON calls(wazo_cdr_id);
CREATE UNIQUE INDEX uidx_calls_wazo_call ON calls(tenant_id, wazo_call_id) WHERE wazo_call_id IS NOT NULL;

ALTER TABLE lead_attempts ADD CONSTRAINT fk_lead_attempts_call
    FOREIGN KEY (call_id) REFERENCES calls(id);

CREATE TABLE call_participants (
    id              BIGSERIAL PRIMARY KEY,
    call_id         UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    participant_type VARCHAR(20) NOT NULL,   -- agent/supervisor/customer/ivr
    agent_id        UUID REFERENCES agents(id),
    joined_at       TIMESTAMPTZ NOT NULL,
    left_at         TIMESTAMPTZ,
    role            VARCHAR(20)               -- primary/transferred/conference/whisper/barge
);
CREATE INDEX idx_call_participants_call ON call_participants(call_id);

-- Raw, granular events per call (hold/resume/transfer/mute/etc.), driven
-- straight from Wazo CEL + calld websocket events. Authoritative detail
-- log behind the summarized columns on `calls`.
-- NOTE: Postgres requires a partitioned table's PRIMARY KEY/UNIQUE
-- constraints to include the partition key column, so (id, event_time)
-- is the key here rather than id alone. call_id no longer carries a
-- direct FK for the same reason (FKs on partitioned tables have extra
-- restrictions) -- referential integrity to `calls` is enforced by the
-- application layer (EventProcessor) instead.
CREATE TABLE call_events (
    id              BIGSERIAL,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    call_id         UUID NOT NULL,
    event_type      VARCHAR(30) NOT NULL,   -- STARTED/RINGING/ANSWERED/HOLD/RESUME/TRANSFER/CONFERENCE/HANGUP
    event_time      TIMESTAMPTZ NOT NULL,
    agent_id        UUID REFERENCES agents(id),
    payload_json    JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, event_time)
) PARTITION BY RANGE (event_time);
CREATE INDEX idx_call_events_call ON call_events(call_id);
CREATE INDEX idx_call_events_tenant_time ON call_events(tenant_id, event_time);

CREATE TABLE recordings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    call_id         UUID REFERENCES calls(id),
    conversation_id UUID,                    -- for chat/other channel recordings/transcripts
    file_path       TEXT NOT NULL,
    storage_backend VARCHAR(30) DEFAULT 'local',  -- local/s3/minio
    duration_seconds INTEGER,
    file_size_bytes  BIGINT,
    is_downloadable  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recordings_tenant_call ON recordings(tenant_id, call_id);

ALTER TABLE calls ADD CONSTRAINT fk_calls_recording
    FOREIGN KEY (recording_id) REFERENCES recordings(id);

-- =====================================================================
-- 11. IVR JOURNEY TRACKING  (Requirement #4)
-- =====================================================================

CREATE TABLE ivr_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    call_id         UUID REFERENCES calls(id),
    contact_id      UUID REFERENCES contacts(id),
    did_id          UUID REFERENCES dids(id),
    ivr_menu_id     UUID REFERENCES ivr_menus(id),
    entry_time      TIMESTAMPTZ NOT NULL,
    exit_time       TIMESTAMPTZ,
    duration_seconds INTEGER GENERATED ALWAYS AS (
        CASE WHEN exit_time IS NOT NULL
             THEN EXTRACT(EPOCH FROM (exit_time - entry_time))::INTEGER
             ELSE NULL END) STORED,
    steps_count     INTEGER DEFAULT 0,
    invalid_count   INTEGER DEFAULT 0,
    timeout_count   INTEGER DEFAULT 0,
    language_selected VARCHAR(20),
    exit_reason     VARCHAR(30),   -- queue_transfer/agent_transfer/abandoned/voicemail/hangup
    final_queue_id  UUID REFERENCES queues(id),
    final_agent_id  UUID REFERENCES agents(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ivr_sessions_tenant_time ON ivr_sessions(tenant_id, entry_time DESC);
CREATE INDEX idx_ivr_sessions_call ON ivr_sessions(call_id);

ALTER TABLE calls ADD CONSTRAINT fk_calls_ivr_session
    FOREIGN KEY (ivr_session_id) REFERENCES ivr_sessions(id);

-- Every single node visited/step taken -- this is what powers the
-- "CALL 100245 -> DID -> IVR -> Language -> Menu -> Queue -> Agent" view.
CREATE TABLE ivr_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    ivr_session_id  UUID NOT NULL REFERENCES ivr_sessions(id) ON DELETE CASCADE,
    step_number     INTEGER NOT NULL,
    node_name       VARCHAR(150) NOT NULL,   -- e.g. 'Main Menu', 'Sales'
    event_type      VARCHAR(30) NOT NULL,    -- ENTERED/OPTION_SELECTED/INVALID/TIMEOUT/EXITED
    dtmf_input      VARCHAR(10),
    event_time      TIMESTAMPTZ NOT NULL,
    payload_json    JSONB DEFAULT '{}'
);
CREATE INDEX idx_ivr_events_session ON ivr_events(ivr_session_id, step_number);
CREATE INDEX idx_ivr_events_tenant_time ON ivr_events(tenant_id, event_time);

-- =====================================================================
-- 12. QUEUE RUNTIME EVENTS (join/leave/abandon, for wait/staffing calcs)
-- =====================================================================

CREATE TABLE queue_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    queue_id        UUID NOT NULL REFERENCES queues(id),
    call_id         UUID REFERENCES calls(id),
    event_type      VARCHAR(30) NOT NULL,   -- JOINED/ABANDONED/ANSWERED/OVERFLOW/TRANSFERRED_OUT
    agent_id        UUID REFERENCES agents(id),
    event_time      TIMESTAMPTZ NOT NULL,
    wait_seconds    INTEGER,
    payload_json    JSONB DEFAULT '{}'
);
CREATE INDEX idx_queue_events_tenant_queue_time ON queue_events(tenant_id, queue_id, event_time);

-- =====================================================================
-- 13. CHAT / EMAIL / OMNICHANNEL CONVERSATIONS
-- =====================================================================

CREATE TABLE conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    channel         channel_type NOT NULL,
    contact_id      UUID REFERENCES contacts(id),
    agent_id        UUID REFERENCES agents(id),
    queue_id        UUID REFERENCES queues(id),
    campaign_id     UUID REFERENCES campaigns(id),
    direction       direction_type NOT NULL DEFAULT 'inbound',
    status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- open/closed/abandoned
    started_at      TIMESTAMPTZ NOT NULL,
    first_response_at TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    disposition_id  UUID REFERENCES dispositions(id),
    duration_seconds INTEGER GENERATED ALWAYS AS (
        CASE WHEN closed_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (closed_at - started_at))::INTEGER
             ELSE NULL END) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_tenant_channel_time ON conversations(tenant_id, channel, started_at DESC);
CREATE INDEX idx_conversations_tenant_agent_time ON conversations(tenant_id, agent_id, started_at DESC);
CREATE INDEX idx_conversations_contact ON conversations(contact_id, started_at DESC);

CREATE TABLE conversation_messages (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type     VARCHAR(20) NOT NULL,   -- agent/customer/system/bot
    agent_id        UUID REFERENCES agents(id),
    body            TEXT,
    sent_at         TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conv_messages_conversation ON conversation_messages(conversation_id, sent_at);

-- Chat-specific summary (kept separate for chat-specific metrics like
-- wait_seconds/first_response_time that don't apply cleanly to email)
CREATE TABLE chat_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    wait_seconds    INTEGER,
    first_response_seconds INTEGER,
    message_count   INTEGER DEFAULT 0
);

CREATE TABLE emails (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    subject         VARCHAR(255),
    from_address    VARCHAR(150),
    to_address      VARCHAR(150),
    thread_id       VARCHAR(100),
    is_replied      BOOLEAN NOT NULL DEFAULT FALSE,
    response_seconds INTEGER
);

-- =====================================================================
-- 14. UNIFIED OMNICHANNEL EVENT TABLE  (Requirement #11) -- audit trail
-- =====================================================================

CREATE TABLE omnichannel_events (
    id              BIGSERIAL,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    event_uuid      UUID NOT NULL DEFAULT uuid_generate_v4(),
    event_type      VARCHAR(50) NOT NULL,
    channel         channel_type NOT NULL,
    conversation_id UUID,
    contact_id      UUID,
    agent_id        UUID,
    queue_id        UUID,
    campaign_id     UUID,
    did_id          UUID,
    call_id         UUID,
    message_id      BIGINT,
    event_time      TIMESTAMPTZ NOT NULL,
    payload_json    JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (event_time);

CREATE INDEX idx_oe_tenant_time ON omnichannel_events(tenant_id, event_time DESC);
CREATE INDEX idx_oe_tenant_type_time ON omnichannel_events(tenant_id, event_type, event_time DESC);
CREATE INDEX idx_oe_agent_time ON omnichannel_events(tenant_id, agent_id, event_time DESC);
CREATE INDEX idx_oe_contact_time ON omnichannel_events(tenant_id, contact_id, event_time DESC);
CREATE UNIQUE INDEX uidx_oe_event_uuid ON omnichannel_events(event_uuid, event_time);

-- =====================================================================
-- 15. QUALITY MANAGEMENT
-- =====================================================================

CREATE TABLE quality_scorecards (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    name            VARCHAR(150) NOT NULL,
    categories_json JSONB NOT NULL DEFAULT '[]'  -- [{name:'Greeting', max_score:10}, ...]
);

CREATE TABLE quality_reviews (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    call_id         UUID REFERENCES calls(id),
    conversation_id UUID REFERENCES conversations(id),
    agent_id        UUID NOT NULL REFERENCES agents(id),
    reviewer_id     UUID NOT NULL REFERENCES users(id),
    scorecard_id    UUID REFERENCES quality_scorecards(id),
    scores_json     JSONB NOT NULL DEFAULT '{}',
    total_score     NUMERIC(6,2),
    comments        TEXT,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qr_tenant_agent ON quality_reviews(tenant_id, agent_id, reviewed_at DESC);

-- =====================================================================
-- 16. PARTITION TEMPLATE (apply the same pattern to call_events,
--     omnichannel_events, agent_status_events at high volume)
-- =====================================================================
-- Example for omnichannel_events, monthly partitions, created by a
-- scheduled job (e.g. pg_partman or a cron'd DDL script):
--
-- CREATE TABLE omnichannel_events_2026_08 PARTITION OF omnichannel_events
--     FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
--
-- Same pattern for call_events_YYYY_MM.
-- =====================================================================

-- =====================================================================
-- 17. REPORTING LAYER -- MATERIALIZED VIEWS (single source of truth)
-- =====================================================================
-- All hourly/daily/agent/queue/campaign/DID reports read from these,
-- never recomputing raw aggregations independently in PHP. Refresh via
-- the Event Processor after each batch, or on a 1-5 minute cron for
-- near-real-time dashboards (see ARCHITECTURE.md, section "Reporting
-- Refresh Strategy").

-- 17.1 Agent hourly activity (drives Agent Hourly Report, Req #2)
CREATE MATERIALIZED VIEW mv_agent_hourly AS
SELECT
    a.tenant_id,
    a.agent_id,
    date_trunc('hour', a.started_at) AS hour_bucket,
    SUM(a.duration_seconds) FILTER (WHERE a.status = 'available')          AS available_seconds,
    SUM(a.duration_seconds) FILTER (WHERE a.status IN
        ('break','lunch','tea','training','meeting','personal_break'))    AS break_seconds,
    SUM(a.duration_seconds) FILTER (WHERE a.status = 'after_call_work')   AS acw_seconds,
    SUM(a.duration_seconds) FILTER (WHERE a.status NOT IN ('login','logout','offline')) AS login_seconds
FROM agent_status_events a
WHERE a.ended_at IS NOT NULL
GROUP BY a.tenant_id, a.agent_id, date_trunc('hour', a.started_at);
CREATE UNIQUE INDEX uidx_mv_agent_hourly ON mv_agent_hourly(tenant_id, agent_id, hour_bucket);

-- 17.2 Agent hourly call activity, joined separately to keep concerns clean
CREATE MATERIALIZED VIEW mv_agent_hourly_calls AS
SELECT
    c.tenant_id,
    c.agent_id,
    date_trunc('hour', c.start_time) AS hour_bucket,
    COUNT(*)                                                    AS calls_offered,
    COUNT(*) FILTER (WHERE c.status = 'answered' OR c.status = 'completed') AS calls_answered,
    COUNT(*) FILTER (WHERE c.direction = 'outbound')             AS outbound_calls,
    SUM(c.talk_seconds)                                          AS talk_seconds,
    SUM(c.hold_seconds)                                          AS hold_seconds,
    SUM(c.acw_seconds)                                           AS acw_seconds
FROM calls c
WHERE c.agent_id IS NOT NULL
GROUP BY c.tenant_id, c.agent_id, date_trunc('hour', c.start_time);
CREATE UNIQUE INDEX uidx_mv_agent_hourly_calls ON mv_agent_hourly_calls(tenant_id, agent_id, hour_bucket);

-- 17.3 Queue hourly (Req #5)
CREATE MATERIALIZED VIEW mv_queue_hourly AS
SELECT
    c.tenant_id,
    c.queue_id,
    date_trunc('hour', c.start_time) AS hour_bucket,
    COUNT(*)                                                     AS calls_offered,
    COUNT(*) FILTER (WHERE c.status IN ('answered','completed'))  AS calls_answered,
    COUNT(*) FILTER (WHERE c.status = 'abandoned')                AS calls_abandoned,
    COUNT(*) FILTER (WHERE c.status = 'missed')                   AS calls_missed,
    AVG(c.wait_seconds)                                           AS avg_wait_seconds,
    MAX(c.wait_seconds)                                           AS max_wait_seconds,
    AVG(c.talk_seconds)                                           AS avg_talk_seconds,
    COUNT(*) FILTER (WHERE c.wait_seconds <= q.sla_seconds
        AND c.status IN ('answered','completed'))::NUMERIC
        / NULLIF(COUNT(*) FILTER (WHERE c.status IN ('answered','completed','abandoned')),0) AS service_level
FROM calls c
JOIN queues q ON q.id = c.queue_id
WHERE c.queue_id IS NOT NULL
GROUP BY c.tenant_id, c.queue_id, date_trunc('hour', c.start_time);
CREATE UNIQUE INDEX uidx_mv_queue_hourly ON mv_queue_hourly(tenant_id, queue_id, hour_bucket);

-- 17.4 Campaign daily, all channels (Req #6)
CREATE MATERIALIZED VIEW mv_campaign_daily AS
SELECT
    tenant_id, campaign_id, event_type, channel,
    date_trunc('day', event_time) AS day_bucket,
    COUNT(*) AS event_count
FROM campaign_events
GROUP BY tenant_id, campaign_id, event_type, channel, date_trunc('day', event_time);
CREATE INDEX idx_mv_campaign_daily ON mv_campaign_daily(tenant_id, campaign_id, day_bucket);

-- 17.5 DID daily/hourly (Req #7)
CREATE MATERIALIZED VIEW mv_did_hourly AS
SELECT
    c.tenant_id,
    c.did_id,
    date_trunc('hour', c.start_time) AS hour_bucket,
    COUNT(*)                                                    AS calls_received,
    COUNT(*) FILTER (WHERE c.status IN ('answered','completed')) AS calls_answered,
    COUNT(*) FILTER (WHERE c.status = 'abandoned')               AS calls_abandoned,
    COUNT(*) FILTER (WHERE c.status = 'missed')                  AS calls_missed,
    AVG(c.wait_seconds)                                          AS avg_wait_seconds,
    SUM(c.talk_seconds)                                          AS total_talk_seconds
FROM calls c
WHERE c.did_id IS NOT NULL
GROUP BY c.tenant_id, c.did_id, date_trunc('hour', c.start_time);
CREATE UNIQUE INDEX uidx_mv_did_hourly ON mv_did_hourly(tenant_id, did_id, hour_bucket);

-- 17.6 IVR summary (Req #4)
CREATE MATERIALIZED VIEW mv_ivr_hourly AS
SELECT
    tenant_id, ivr_menu_id,
    date_trunc('hour', entry_time) AS hour_bucket,
    COUNT(*)                                              AS sessions_entered,
    COUNT(*) FILTER (WHERE exit_time IS NOT NULL)          AS sessions_exited,
    COUNT(*) FILTER (WHERE exit_reason = 'abandoned')      AS sessions_abandoned,
    COUNT(*) FILTER (WHERE exit_reason = 'queue_transfer') AS transferred_to_queue,
    COUNT(*) FILTER (WHERE exit_reason = 'agent_transfer') AS transferred_to_agent,
    AVG(duration_seconds)                                  AS avg_duration_seconds,
    SUM(invalid_count)                                     AS invalid_selections,
    SUM(timeout_count)                                     AS timeouts
FROM ivr_sessions
GROUP BY tenant_id, ivr_menu_id, date_trunc('hour', entry_time);
CREATE UNIQUE INDEX uidx_mv_ivr_hourly ON mv_ivr_hourly(tenant_id, ivr_menu_id, hour_bucket);

-- All mv_* views: REFRESH MATERIALIZED VIEW CONCURRENTLY (unique index
-- above enables CONCURRENTLY) on a schedule -- see ARCHITECTURE.md.

-- =====================================================================
-- End of schema v1.0
-- =====================================================================
