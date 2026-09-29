-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: WebRTC / SIP provisioning for agents
-- Apply after schema.sql + robo_agent_schema.sql
-- =====================================================================
-- Every agent gets a SIP line so the browser-based WebRTC workspace
-- (SIP.js) can register directly against Wazo's SIP/WSS endpoint. Lines
-- are either auto-provisioned in Wazo confd when the agent is created
-- (extension left blank) or created against an admin-supplied extension
-- number. Either way, the resulting SIP credentials are stored here --
-- never in agents.extension alone, since SIP auth username/password are
-- distinct from the dialable extension number.

ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS sip_username       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS sip_password        VARCHAR(255),
    ADD COLUMN IF NOT EXISTS sip_domain          VARCHAR(150),
    ADD COLUMN IF NOT EXISTS wazo_line_id         INTEGER,
    ADD COLUMN IF NOT EXISTS wazo_user_id          INTEGER,
    ADD COLUMN IF NOT EXISTS wazo_extension_id      INTEGER,
    ADD COLUMN IF NOT EXISTS provisioning_status     VARCHAR(20) NOT NULL DEFAULT 'pending',
        -- pending | provisioned | failed | manual
    ADD COLUMN IF NOT EXISTS provisioning_error       TEXT;

-- Per-tenant WebRTC/SIP registration settings (the WSS endpoint and SIP
-- realm/domain agents register against). Kept separate from the global
-- collector config in config.php because each tenant's Wazo may differ
-- in a multi-Wazo/multi-region deployment; falls back to the platform
-- default (config.php `wazo.sip_ws_uri` / `wazo.sip_domain`) when NULL.
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS sip_ws_uri  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS sip_domain  VARCHAR(150);
