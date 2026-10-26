BEGIN;

-- Existing prefixes are legacy until explicitly reviewed.
-- New prefix rows receive status "pending" automatically.
ALTER TABLE prefixes
    ADD COLUMN IF NOT EXISTS provisioning_status varchar(24);

UPDATE prefixes
   SET provisioning_status = 'legacy'
 WHERE provisioning_status IS NULL;

ALTER TABLE prefixes
    ALTER COLUMN provisioning_status SET DEFAULT 'pending';

ALTER TABLE prefixes
    ALTER COLUMN provisioning_status SET NOT NULL;

ALTER TABLE prefixes
    ADD COLUMN IF NOT EXISTS provisioning_error text;

ALTER TABLE prefixes
    ADD COLUMN IF NOT EXISTS last_provisioned_at timestamptz;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'prefixes'::regclass
           AND conname = 'prefixes_provisioning_status_check'
    ) THEN
        ALTER TABLE prefixes
            ADD CONSTRAINT prefixes_provisioning_status_check
            CHECK (
                provisioning_status IN (
                    'pending',
                    'provisioning',
                    'provisioned',
                    'failed',
                    'legacy'
                )
            );
    END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS idx_prefixes_auto_provision_pending
    ON prefixes (tenant_id, provisioning_status)
    WHERE is_active = FALSE
      AND provisioning_status IN ('pending', 'failed');

COMMIT;
