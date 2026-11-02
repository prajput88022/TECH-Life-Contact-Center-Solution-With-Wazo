BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE campaign_dial_claims
    DROP CONSTRAINT IF EXISTS fk_campaign_dial_claim_assignment;

ALTER TABLE campaign_agent_reservations
    DROP CONSTRAINT IF EXISTS fk_campaign_agent_reservation_assignment;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_campaign_dial_claim_agent'
          AND conrelid = 'campaign_dial_claims'::regclass
    ) THEN
        ALTER TABLE campaign_dial_claims
            ADD CONSTRAINT fk_campaign_dial_claim_agent
            FOREIGN KEY (tenant_id, agent_id)
            REFERENCES agents (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_campaign_agent_reservation_agent'
          AND conrelid = 'campaign_agent_reservations'::regclass
    ) THEN
        ALTER TABLE campaign_agent_reservations
            ADD CONSTRAINT fk_campaign_agent_reservation_agent
            FOREIGN KEY (tenant_id, agent_id)
            REFERENCES agents (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_campaign_agent_reservation_agent_fk
    ON campaign_agent_reservations (tenant_id, agent_id);

COMMIT;
