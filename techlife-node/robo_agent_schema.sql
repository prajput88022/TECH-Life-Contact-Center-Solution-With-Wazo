-- =====================================================================
-- TECH-Life Contact-Center Solution
-- ADDENDUM: Robo Agent / Voice-Blast / IVR-Survey Campaigns
-- Apply after schema.sql
-- =====================================================================
-- Design: a "robo campaign" reuses the exact same auto-dialer engine,
-- dial_level, trunk, and campaign_contacts/campaign_events tables as a
-- normal voice campaign (Requirement #9 in the original brief) -- it
-- simply never bridges the answered call to a live agent. Instead it
-- bridges to a synthetic IVR flow ("robo node") that plays either a
-- pre-recorded audio file or a TTS-generated natural voice prompt, then
-- optionally collects DTMF (or recorded voice) survey answers.
--
-- This means robo/voice-blast calls flow through the SAME calls,
-- call_events, ivr_sessions and ivr_events tables as everything else --
-- no parallel reporting pipeline, per Requirement #16 (data consistency).
-- The only new tables are: (1) the content the robo agent plays, and
-- (2) captured survey answers.
-- =====================================================================

-- Extend campaigns with robo-specific settings. dialing_mode already
-- supports free-text values; robo campaigns use 'robo_survey' or
-- 'voice_blast' there. These new columns are only meaningful when
-- is_robo_campaign = TRUE.
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS is_robo_campaign BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS max_concurrent_robo_calls INTEGER,
    ADD COLUMN IF NOT EXISTS retry_on_no_answer BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS retry_on_busy BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS max_retry_attempts INTEGER DEFAULT 3,
    ADD COLUMN IF NOT EXISTS answering_machine_detection BOOLEAN NOT NULL DEFAULT FALSE;

-- The audio/TTS content a robo campaign plays. A campaign can have
-- multiple nodes (e.g. intro -> question 1 -> question 2 -> thank you)
-- so this doubles as the survey script definition, ordered by step_number.
CREATE TABLE IF NOT EXISTS campaign_voice_content (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id     UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    step_number     INTEGER NOT NULL,
    node_name       VARCHAR(150) NOT NULL,          -- e.g. 'Intro', 'Q1_Satisfaction', 'ThankYou'
    content_type    VARCHAR(20) NOT NULL CHECK (content_type IN ('audio_file','tts')),

    -- content_type = 'audio_file'
    audio_file_path TEXT,                            -- pre-recorded prompt / blast message

    -- content_type = 'tts'
    tts_text        TEXT,                             -- script text, natural-voice synthesized at call time
    tts_voice       VARCHAR(100),                      -- e.g. 'en-US-Neural2-F', provider-specific voice id
    tts_language    VARCHAR(20) DEFAULT 'en-US',
    tts_speed       NUMERIC(3,2) DEFAULT 1.00,
    tts_provider    VARCHAR(50) DEFAULT 'default',     -- which TTS engine/integration to call

    -- Response collection for this node (NULL = play-only, no input expected)
    expects_response BOOLEAN NOT NULL DEFAULT FALSE,
    response_type    VARCHAR(20) CHECK (response_type IN ('dtmf','recorded_voice')),
    valid_dtmf_options VARCHAR(50),                    -- e.g. '1,2,3,4,5' for a 1-5 satisfaction scale
    max_response_seconds INTEGER DEFAULT 5,
    next_step_map_json JSONB DEFAULT '{}',             -- {"1":"step_3","2":"step_4"} branching, optional

    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, step_number)
);
CREATE INDEX IF NOT EXISTS idx_cvc_campaign ON campaign_voice_content(tenant_id, campaign_id, step_number);

-- Captured survey answers. One row per question answered per call.
-- Deliberately mirrors ivr_events (same shape) but scoped to campaigns
-- and joined to leads/contacts for reporting ("Q1: 78% satisfied").
CREATE TABLE IF NOT EXISTS survey_responses (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    campaign_id     UUID NOT NULL REFERENCES campaigns(id),
    call_id         UUID NOT NULL REFERENCES calls(id),
    contact_id      UUID REFERENCES contacts(id),
    lead_id         UUID REFERENCES leads(id),
    voice_content_id UUID NOT NULL REFERENCES campaign_voice_content(id),
    node_name       VARCHAR(150) NOT NULL,
    response_type   VARCHAR(20) NOT NULL,             -- dtmf/recorded_voice/no_response/hangup
    response_dtmf   VARCHAR(10),
    response_recording_path TEXT,
    responded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_campaign
    ON survey_responses(tenant_id, campaign_id, node_name, responded_at);
CREATE INDEX IF NOT EXISTS idx_survey_responses_call ON survey_responses(call_id);

-- Reporting view: response distribution per question, per campaign --
-- exactly the same "one source of truth" pattern as mv_ivr_hourly.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_survey_response_summary AS
SELECT
    tenant_id, campaign_id, node_name,
    response_dtmf,
    COUNT(*) AS response_count,
    date_trunc('day', responded_at) AS day_bucket
FROM survey_responses
WHERE response_type = 'dtmf'
GROUP BY tenant_id, campaign_id, node_name, response_dtmf, date_trunc('day', responded_at);
CREATE INDEX IF NOT EXISTS idx_mv_survey_summary
    ON mv_survey_response_summary(tenant_id, campaign_id, node_name, day_bucket);

-- Robo/voice-blast reach & completion, hourly -- built on the SAME calls
-- table used for every other voice report, filtered to robo campaigns.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_robo_campaign_hourly AS
SELECT
    c.tenant_id, c.campaign_id,
    date_trunc('hour', c.start_time) AS hour_bucket,
    COUNT(DISTINCT c.id) AS calls_attempted,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('answered','completed')) AS calls_connected,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'failed') AS calls_failed,
    COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'busy') AS calls_busy,
    COUNT(DISTINCT c.id) FILTER (WHERE c.hangup_by = 'customer' AND c.talk_seconds < 3) AS likely_hangups,
    AVG(c.talk_seconds) AS avg_message_seconds,
    COUNT(DISTINCT sr.id) AS survey_responses_captured
FROM calls c
JOIN campaigns camp ON camp.id = c.campaign_id AND camp.is_robo_campaign = TRUE
LEFT JOIN survey_responses sr ON sr.call_id = c.id
GROUP BY c.tenant_id, c.campaign_id, date_trunc('hour', c.start_time);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_robo_campaign_hourly
    ON mv_robo_campaign_hourly(tenant_id, campaign_id, hour_bucket);
