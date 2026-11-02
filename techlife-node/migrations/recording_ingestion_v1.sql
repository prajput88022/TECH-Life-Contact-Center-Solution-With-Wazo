BEGIN;

ALTER TABLE recording_settings
    ADD COLUMN IF NOT EXISTS recording_ingestion_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS recording_ingestion_interval_minutes SMALLINT NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS recording_ingestion_history_days INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN IF NOT EXISTS recording_ingestion_last_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recording_ingestion_next_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recording_ingestion_last_scan_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recording_ingestion_last_error TEXT,
    ADD COLUMN IF NOT EXISTS recording_ingestion_status VARCHAR(16) NOT NULL DEFAULT 'paused',
    ADD COLUMN IF NOT EXISTS upload_schedule_mode VARCHAR(16) NOT NULL DEFAULT 'interval',
    ADD COLUMN IF NOT EXISTS upload_schedule_time TIME NOT NULL DEFAULT '02:00',
    ADD COLUMN IF NOT EXISTS upload_next_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS upload_last_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS upload_last_error TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_recording_ingestion_interval'
    ) THEN
        ALTER TABLE recording_settings
        ADD CONSTRAINT ck_recording_ingestion_interval
        CHECK (recording_ingestion_interval_minutes BETWEEN 1 AND 1440);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_recording_ingestion_history'
    ) THEN
        ALTER TABLE recording_settings
        ADD CONSTRAINT ck_recording_ingestion_history
        CHECK (recording_ingestion_history_days BETWEEN 1 AND 3650);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_recording_ingestion_status'
    ) THEN
        ALTER TABLE recording_settings
        ADD CONSTRAINT ck_recording_ingestion_status
        CHECK (recording_ingestion_status IN
            ('paused','idle','running','succeeded','failed'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_recording_upload_schedule_mode'
    ) THEN
        ALTER TABLE recording_settings
        ADD CONSTRAINT ck_recording_upload_schedule_mode
        CHECK (upload_schedule_mode IN ('interval','daily'));
    END IF;
END $$;

ALTER TABLE recordings
    ADD COLUMN IF NOT EXISTS wazo_cdr_id BIGINT,
    ADD COLUMN IF NOT EXISTS wazo_recording_uuid VARCHAR(64),
    ADD COLUMN IF NOT EXISTS wazo_tenant_uuid UUID,
    ADD COLUMN IF NOT EXISTS source_filename TEXT,
    ADD COLUMN IF NOT EXISTS source_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_ended_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_recordings_wazo_source
    ON recordings (tenant_id, wazo_cdr_id, wazo_recording_uuid)
    WHERE wazo_cdr_id IS NOT NULL
      AND wazo_recording_uuid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recording_settings_ingestion_due
    ON recording_settings (recording_ingestion_next_run_at)
    WHERE recording_ingestion_enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_recording_settings_upload_due
    ON recording_settings (upload_next_run_at)
    WHERE remote_upload_enabled = TRUE;

COMMIT;
