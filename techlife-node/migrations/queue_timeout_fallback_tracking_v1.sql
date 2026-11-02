BEGIN;

ALTER TABLE queues
    ADD COLUMN IF NOT EXISTS wazo_managed_noanswer_json JSONB;

COMMIT;
