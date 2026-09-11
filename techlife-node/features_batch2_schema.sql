-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: Call monitoring audit trail, Omnichannel webchat widget,
--           rule-based chatbot, Mattermost bridge config
-- Apply after all previous schema files
-- =====================================================================

-- Audit trail for supervisor Listen/Whisper/Barge actions -- required
-- for compliance in most jurisdictions (agents/customers often must be
-- informed monitoring occurred, and organizations need a record of who
-- monitored which call and when).
CREATE TABLE IF NOT EXISTS call_monitoring_sessions (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    call_id         UUID NOT NULL REFERENCES calls(id),
    supervisor_id   UUID NOT NULL REFERENCES users(id),
    mode            VARCHAR(10) NOT NULL CHECK (mode IN ('listen','whisper','barge')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    wazo_monitor_call_id VARCHAR(100)   -- the supervisor's own originated leg, for hangup control
);
CREATE INDEX IF NOT EXISTS idx_call_monitoring_call ON call_monitoring_sessions(call_id);
CREATE INDEX IF NOT EXISTS idx_call_monitoring_tenant_time ON call_monitoring_sessions(tenant_id, started_at DESC);

-- One webchat widget config per tenant (public-facing: no login required
-- for the customer side, identified by a public_key embedded in the
-- widget snippet). Powers the customer-facing chat entry point that
-- creates rows in the existing conversations/conversation_messages
-- tables -- no parallel chat data model, same one used by voice-derived
-- omnichannel reporting.
CREATE TABLE IF NOT EXISTS chat_widget_configs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    public_key          VARCHAR(64) NOT NULL UNIQUE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    welcome_message     TEXT NOT NULL DEFAULT 'Hi! How can we help you today?',
    default_queue_id    UUID REFERENCES queues(id),
    bot_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    bot_fallback_message TEXT NOT NULL DEFAULT 'Let me connect you with an agent.',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Simple rule-based chatbot: keyword -> canned response, with an
-- optional "hand off to queue" action when no rule matches (or when the
-- customer asks for an agent). This is a legitimate, widely-used
-- contact-center chatbot pattern (FAQ deflection before/alongside human
-- handoff) -- not an NLU/LLM engine, which would need external API keys
-- this environment can't provision or test against.
CREATE TABLE IF NOT EXISTS chatbot_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    trigger_keywords TEXT NOT NULL,   -- comma-separated, case-insensitive substring match
    response_text   TEXT NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 0,  -- higher checked first
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chatbot_rules_tenant ON chatbot_rules(tenant_id, priority DESC);

-- Mattermost bridge: pushes new customer chat messages into a
-- Mattermost channel via an incoming webhook (Mattermost's own,
-- well-documented integration point), and accepts replies back via a
-- slash-command-style POST from Mattermost (outgoing webhook / slash
-- command configured on the Mattermost side, shared-secret verified).
CREATE TABLE IF NOT EXISTS mattermost_integrations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    incoming_webhook_url TEXT NOT NULL,   -- Mattermost's "incoming webhook" URL we POST to
    reply_shared_secret  VARCHAR(100) NOT NULL,  -- verifies POSTs coming back from Mattermost
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Track which Mattermost "thread" (we fake threading via a marker in
-- the message text, since incoming webhooks don't return post ids)
-- corresponds to which conversation, so a reply can be routed back.
CREATE TABLE IF NOT EXISTS mattermost_conversation_links (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    thread_marker   VARCHAR(20) NOT NULL UNIQUE,   -- short code embedded in the MM message, e.g. [CONV-A1B2C3]
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
