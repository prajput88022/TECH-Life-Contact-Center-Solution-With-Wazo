BEGIN;

-- Supporting unique keys for tenant-scoped foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_campaign_id
    ON leads (tenant_id, campaign_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_calls_tenant_id_id
    ON calls (tenant_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_agents_tenant_campaign_agent
    ON campaign_agents (tenant_id, campaign_id, agent_id);


-- Shared claim lifecycle for Robo and live-agent campaign attempts.
CREATE TABLE IF NOT EXISTS campaign_dial_claims (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid NOT NULL,
    lead_id uuid NOT NULL,
    agent_id uuid,

    dialing_mode varchar(30) NOT NULL,
    claim_status varchar(20) NOT NULL DEFAULT 'claimed',

    claim_token uuid NOT NULL DEFAULT uuid_generate_v4(),
    attempt_number integer NOT NULL CHECK (attempt_number > 0),

    lease_until timestamptz NOT NULL,
    call_id uuid,
    wazo_call_id varchar(150),

    claimed_at timestamptz NOT NULL DEFAULT now(),
    originating_at timestamptz,
    originated_at timestamptz,
    answered_at timestamptz,
    ended_at timestamptz,

    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT uq_campaign_dial_claim_token
        UNIQUE (claim_token),

    -- Referenced by lead_attempts: tenant and lead must match.
    CONSTRAINT uq_campaign_dial_claim_tenant_lead_id
        UNIQUE (tenant_id, lead_id, id),

    -- Referenced by reservations: tenant, campaign and agent must match.
    CONSTRAINT uq_campaign_dial_claim_reservation_target
        UNIQUE (tenant_id, campaign_id, agent_id, id),

    CONSTRAINT fk_campaign_dial_claim_campaign
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT fk_campaign_dial_claim_lead
        FOREIGN KEY (tenant_id, campaign_id, lead_id)
        REFERENCES leads (tenant_id, campaign_id, id)
        ON DELETE CASCADE,

    -- Preserve tenant-scoped agent identity without tying historical claims
    -- to a mutable campaign assignment. Membership is checked at claim time.
    -- A null agent is allowed for Robo/voice-blast claims.
    CONSTRAINT fk_campaign_dial_claim_agent
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT,

    -- A linked call must belong to the same tenant.
    CONSTRAINT fk_campaign_dial_claim_call
        FOREIGN KEY (tenant_id, call_id)
        REFERENCES calls (tenant_id, id)
        ON DELETE RESTRICT,

    CONSTRAINT chk_campaign_dial_claim_mode
        CHECK (dialing_mode IN (
            'preview', 'progressive', 'power', 'predictive',
            'voice_blast', 'robo_survey'
        )),

    CONSTRAINT chk_campaign_dial_claim_status
        CHECK (claim_status IN (
            'claimed', 'originating', 'ringing', 'in_flight',
            'completed', 'retry', 'failed', 'cancelled'
        ))
);


-- One active claim per tenant/lead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_dial_claim_active_lead
    ON campaign_dial_claims (tenant_id, lead_id)
    WHERE claim_status IN (
        'claimed', 'originating', 'ringing', 'in_flight'
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_dial_claim_wazo_call
    ON campaign_dial_claims (tenant_id, wazo_call_id)
    WHERE wazo_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_campaign_dial_claim_campaign_status
    ON campaign_dial_claims
       (tenant_id, campaign_id, claim_status, lease_until);

CREATE INDEX IF NOT EXISTS idx_campaign_dial_claim_agent
    ON campaign_dial_claims
       (tenant_id, agent_id, claim_status)
    WHERE agent_id IS NOT NULL;


-- An agent may hold only one active campaign reservation at a time.
CREATE TABLE IF NOT EXISTS campaign_agent_reservations (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    claim_id uuid NOT NULL UNIQUE,

    reservation_status varchar(20) NOT NULL DEFAULT 'reserved',
    reserved_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    released_at timestamptz,
    release_reason varchar(120),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT fk_campaign_agent_reservation_campaign
        FOREIGN KEY (tenant_id, campaign_id)
        REFERENCES campaigns (tenant_id, id)
        ON DELETE CASCADE,

    CONSTRAINT fk_campaign_agent_reservation_agent
        FOREIGN KEY (tenant_id, agent_id)
        REFERENCES agents (tenant_id, id)
        ON DELETE RESTRICT,

    -- The reservation must point to a claim for this exact agent/campaign.
    CONSTRAINT fk_campaign_agent_reservation_claim
        FOREIGN KEY (tenant_id, campaign_id, agent_id, claim_id)
        REFERENCES campaign_dial_claims
            (tenant_id, campaign_id, agent_id, id)
        ON DELETE CASCADE,

    CONSTRAINT chk_campaign_agent_reservation_status
        CHECK (reservation_status IN (
            'reserved', 'dialing', 'connected',
            'released', 'completed', 'failed', 'expired'
        ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_agent_active_reservation
    ON campaign_agent_reservations (tenant_id, agent_id)
    WHERE reservation_status IN ('reserved', 'dialing', 'connected');

CREATE INDEX IF NOT EXISTS idx_campaign_agent_reservation_expiry
    ON campaign_agent_reservations
       (tenant_id, reservation_status, expires_at);

CREATE INDEX IF NOT EXISTS idx_campaign_agent_reservation_agent_fk
    ON campaign_agent_reservations (tenant_id, agent_id);


-- Link each lead attempt to at most one originating claim.
ALTER TABLE lead_attempts
    ADD COLUMN IF NOT EXISTS claim_id uuid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_lead_attempt_campaign_claim'
          AND conrelid = 'lead_attempts'::regclass
    ) THEN
        ALTER TABLE lead_attempts
            ADD CONSTRAINT fk_lead_attempt_campaign_claim
            FOREIGN KEY (tenant_id, lead_id, claim_id)
            REFERENCES campaign_dial_claims (tenant_id, lead_id, id)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_attempt_campaign_claim
    ON lead_attempts (claim_id)
    WHERE claim_id IS NOT NULL;

COMMIT;
