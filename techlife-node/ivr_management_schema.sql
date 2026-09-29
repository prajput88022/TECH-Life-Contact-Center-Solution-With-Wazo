-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: IVR Menu Management (Admin CRUD for IVR trees)
-- Apply after all previous schema files
-- =====================================================================
-- ivr_menus (already in schema.sql) is just a registry row used for
-- reporting linkage (ivr_sessions.ivr_menu_id). This addendum adds the
-- actual menu structure -- what plays and where each DTMF option goes
-- -- so Admin can build/edit/delete an IVR tree from the UI.
--
-- IMPORTANT CAVEAT: this table is the SOURCE OF CONFIGURATION for an
-- IVR tree, but actually ROUTING a live call through it requires your
-- Wazo dialplan to read this config (via a small AGI script, the same
-- pattern already used for robo campaigns and the AGI business-data
-- bridge -- see collector/webhooks.js's /agi-events endpoint and
-- INSTALL.md). Building/editing the tree here does not, by itself,
-- change call routing on your Wazo box until that dialplan integration
-- reads it. This is the same honestly-scoped pattern as the
-- Listen/Whisper/Barge and transfer features: correct data model and
-- admin UI, telephony wiring documented for you to complete against
-- your specific Wazo install.

ALTER TABLE ivr_menus
    ADD COLUMN IF NOT EXISTS greeting_type   VARCHAR(20) NOT NULL DEFAULT 'tts' CHECK (greeting_type IN ('tts','audio_file')),
    ADD COLUMN IF NOT EXISTS greeting_text   TEXT,
    ADD COLUMN IF NOT EXISTS greeting_audio_path TEXT,
    ADD COLUMN IF NOT EXISTS invalid_retry_limit INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS timeout_seconds  INTEGER NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS ivr_menu_options (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    ivr_menu_id     UUID NOT NULL REFERENCES ivr_menus(id) ON DELETE CASCADE,
    dtmf_digit      VARCHAR(2) NOT NULL,   -- '0'-'9', '*', '#'
    label           VARCHAR(150) NOT NULL, -- e.g. "Sales", "Support (Hindi)"
    action_type     VARCHAR(20) NOT NULL CHECK (action_type IN ('queue','extension','submenu','voicemail','hangup')),
    target_queue_id UUID REFERENCES queues(id),
    target_extension VARCHAR(30),          -- direct extension/DID for action_type='extension'
    target_submenu_id UUID REFERENCES ivr_menus(id),  -- for action_type='submenu'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ivr_menu_id, dtmf_digit)
);
CREATE INDEX IF NOT EXISTS idx_ivr_menu_options_menu ON ivr_menu_options(ivr_menu_id);
