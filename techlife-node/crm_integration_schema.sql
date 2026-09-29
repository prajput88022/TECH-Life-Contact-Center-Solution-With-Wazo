-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: CRM Screen-Pop / CTI Integration
-- Apply after schema.sql (+ any other addenda already applied)
-- =====================================================================
-- Two independent integration styles, since different CRMs expect
-- different things:
--
--   1. CLIENT-SIDE POPUP  -- the agent's browser opens/embeds a URL
--      (e.g. "https://crm.example.com/lookup?phone={customer_number}")
--      when a call rings or is answered. Works for any CRM with a
--      phone-number-lookup URL (Zoho, Freshdesk, HubSpot contact search,
--      a custom internal CRM, etc). Configured via url_template +
--      popup_mode below, consumed by the Agent Workspace JS.
--
--   2. SERVER-SIDE WEBHOOK PUSH -- TECH-Life POSTs a signed JSON payload
--      to the CRM's own webhook/CTI-adapter endpoint on call events
--      (used by CTI toolkits like Salesforce OpenCTI, or any CRM whose
--      integration expects to be notified rather than polled/embedded).
--      Configured via webhook_url + webhook_secret below, sent by
--      CrmNotifier from the Event Processor.
--
-- A tenant can use either, both, or neither. Multiple named
-- integrations are supported (e.g. one popup config + one webhook
-- config, or different configs per queue/campaign in a future version);
-- only rows with is_active = TRUE are used.

CREATE TABLE IF NOT EXISTS crm_integrations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,           -- e.g. "Zoho CRM", "Internal CRM"
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    -- --- Client-side popup settings ---
    popup_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    trigger_event   VARCHAR(20) NOT NULL DEFAULT 'ringing',
        -- 'ringing' (pop as soon as the call rings -- most CTI does this)
        -- or 'answered' (pop only once the agent picks up)
    popup_mode      VARCHAR(20) NOT NULL DEFAULT 'new_tab',
        -- 'new_tab' | 'popup_window' | 'iframe_panel' | 'postmessage'
        --   new_tab / popup_window: window.open() the URL
        --   iframe_panel: renders inside the Agent Workspace's embedded panel
        --   postmessage: posts the built URL/payload to the parent frame
        --     instead of opening anything itself -- for when TECH-Life's
        --     agent screen is itself embedded inside the CRM (the CRM is
        --     the outer frame and wants to handle the "screen pop" itself)
    url_template    TEXT,
        -- Supports placeholders: {customer_number} {call_id} {agent_extension}
        -- {direction} {queue_name} {campaign_name} {disposition_code}
        -- Example (Zoho): https://crm.zoho.com/crm/org/tab/Leads/search?searchtext={customer_number}
        -- Example (HubSpot): https://app.hubspot.com/contacts/search?query={customer_number}
        -- Example (custom): https://yourcrm.internal/lookup?phone={customer_number}&callid={call_id}

    -- --- Server-side webhook push settings ---
    webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    webhook_url     TEXT,
    webhook_secret  VARCHAR(255),          -- used to HMAC-sign the payload (X-TechLife-Signature header)
    webhook_events  VARCHAR(100) NOT NULL DEFAULT 'CALL_STARTED,CALL_ANSWERED,CALL_HANGUP',
        -- comma-separated subset of event types to push

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_integrations_tenant ON crm_integrations(tenant_id, is_active);

-- Delivery log for webhook pushes -- lets an admin see whether the CRM
-- actually received/accepted each push, without digging through server
-- logs. Kept small and pruneable (not partitioned; low volume relative
-- to omnichannel_events).
CREATE TABLE IF NOT EXISTS crm_webhook_deliveries (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    crm_integration_id UUID NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
    call_id         UUID,
    event_type      VARCHAR(50) NOT NULL,
    http_status     INTEGER,
    success         BOOLEAN NOT NULL DEFAULT FALSE,
    error_message   TEXT,
    attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_deliveries_tenant_time ON crm_webhook_deliveries(tenant_id, attempted_at DESC);
