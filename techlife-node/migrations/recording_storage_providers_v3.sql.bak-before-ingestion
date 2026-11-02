BEGIN;

ALTER TABLE recording_settings
    ADD COLUMN IF NOT EXISTS connection_test_fingerprint CHAR(64),
    ADD COLUMN IF NOT EXISTS host_key_sha256 VARCHAR(100);

ALTER TABLE recording_settings
    ADD CONSTRAINT recording_settings_host_key_length_ck
    CHECK (
        host_key_sha256 IS NULL OR
        length(host_key_sha256) BETWEEN 32 AND 100
    );

COMMIT;
