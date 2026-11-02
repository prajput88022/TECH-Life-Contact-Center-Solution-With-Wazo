BEGIN;

-- Claim acquisition is not itself a dial attempt.
-- Multiple pre-origination claims may share one actual attempt number.
DROP INDEX IF EXISTS uq_campaign_dial_claim_attempt;

COMMIT;
