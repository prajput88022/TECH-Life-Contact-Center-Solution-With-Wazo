BEGIN;

ALTER TABLE recording_settings
    DROP CONSTRAINT IF EXISTS recording_settings_storage_provider_check;

ALTER TABLE recording_settings
    ADD CONSTRAINT recording_settings_storage_provider_check
    CHECK (storage_provider IN (
        'local', 's3', 'azure', 'gcs', 'ftp', 'sftp', 's3compatible'
    ));

ALTER TABLE recording_settings
    ADD COLUMN IF NOT EXISTS endpoint_url TEXT,
    ADD COLUMN IF NOT EXISTS region VARCHAR(120),
    ADD COLUMN IF NOT EXISTS upload_interval_minutes SMALLINT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS upload_batch_size SMALLINT NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS auto_upload_existing BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS last_upload_scan_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS connection_tested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS connection_test_error TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recording_settings_upload_interval_ck'
    ) THEN
        ALTER TABLE recording_settings
            ADD CONSTRAINT recording_settings_upload_interval_ck
            CHECK (upload_interval_minutes BETWEEN 1 AND 1440);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recording_settings_upload_batch_ck'
    ) THEN
        ALTER TABLE recording_settings
            ADD CONSTRAINT recording_settings_upload_batch_ck
            CHECK (upload_batch_size BETWEEN 1 AND 100);
    END IF;
END $$;

-- One durable upload job per recording. Retries reuse the same job row.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_recording_storage_job_recording_type
ON recording_storage_jobs (tenant_id, recording_id, job_type);

CREATE INDEX IF NOT EXISTS
    idx_recording_storage_jobs_claim
ON recording_storage_jobs (job_status, available_at, created_at)
WHERE job_status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS
    idx_recordings_tenant_created
ON recordings (tenant_id, created_at DESC);

COMMIT;
