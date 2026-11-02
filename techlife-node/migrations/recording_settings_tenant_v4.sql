BEGIN;

ALTER TABLE recording_settings
    ADD COLUMN IF NOT EXISTS provider_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS recording_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS record_incoming_external BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS record_outgoing_external BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS record_incoming_internal BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS record_outgoing_internal BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS recording_policy_sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS recording_policy_sync_error TEXT,
    ADD COLUMN IF NOT EXISTS recording_policy_updated_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recording_settings_provider_config_object_ck'
    ) THEN
        ALTER TABLE recording_settings
            ADD CONSTRAINT recording_settings_provider_config_object_ck
            CHECK (jsonb_typeof(provider_config) = 'object');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'recording_settings_policy_status_ck'
    ) THEN
        ALTER TABLE recording_settings
            ADD CONSTRAINT recording_settings_policy_status_ck
            CHECK (recording_policy_sync_status IN (
                'pending', 'synced', 'error'
            ));
    END IF;
END $$;

COMMIT;
