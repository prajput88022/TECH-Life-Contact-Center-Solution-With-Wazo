BEGIN;

ALTER TABLE dids
    ADD COLUMN IF NOT EXISTS wazo_managed_greeting_sound TEXT;

COMMIT;
