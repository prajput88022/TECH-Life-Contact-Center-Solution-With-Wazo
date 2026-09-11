-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: Customer number masking (PII protection)
-- Apply after schema.sql / robo_agent_schema.sql / webrtc_schema.sql
-- =====================================================================
-- Two independent tenant-level switches, toggled from Admin -> Privacy
-- & Number Masking:
--   mask_number_for_agents      -- masks customer numbers on every
--                                   agent-facing screen/export
--   mask_number_for_supervisors -- masks customer numbers on every
--                                   supervisor-facing screen/export
--                                   (including CDR download)
-- Masking is enforced server-side in CallRecordService -- the raw
-- number is never sent to the browser when the relevant switch is on,
-- it is not just hidden with CSS. The call's own UUID (`calls.id`) is
-- ALWAYS shown in full, masked or not, so a masked call can still be
-- matched to its recording and to every other record referencing it
-- (call_events, ivr_sessions, quality_reviews, audit_logs, etc.) --
-- masking only ever touches the phone number columns, never the id.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS mask_number_for_agents      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS mask_number_for_supervisors  BOOLEAN NOT NULL DEFAULT FALSE;
