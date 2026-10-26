BEGIN;

CREATE TABLE IF NOT EXISTS recording_settings (
    tenant_id UUID PRIMARY KEY
        REFERENCES tenants(id) ON DELETE RESTRICT,
    storage_provider VARCHAR(24) NOT NULL DEFAULT 's3'
        CHECK (storage_provider IN
            ('s3','azure','gcs','sftp','s3compatible')),
    destination_name VARCHAR(255),
    destination_prefix TEXT NOT NULL DEFAULT 'recordings',
    secret_ref TEXT,
    keep_local_copy BOOLEAN NOT NULL DEFAULT TRUE,
    keep_remote_copy BOOLEAN NOT NULL DEFAULT TRUE,
    local_base_path TEXT NOT NULL
        DEFAULT '/var/lib/techlife/recordings',
    folder_template VARCHAR(255) NOT NULL
        DEFAULT '{yyyy}/{mm}/{dd}',
    filename_template VARCHAR(255) NOT NULL
        DEFAULT '{timestamp}_{call_id}_{recording_id}',
    audio_format VARCHAR(8) NOT NULL DEFAULT 'wav'
        CHECK (audio_format IN ('wav','mp3','ogg','flac')),
    mp3_bitrate_kbps INTEGER NOT NULL DEFAULT 128
        CHECK (mp3_bitrate_kbps IN
            (64,96,128,160,192,256,320)),
    retention_days INTEGER
        CHECK (retention_days IS NULL
            OR retention_days BETWEEN 1 AND 36500),
    download_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    remote_upload_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recording_storage_copies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE RESTRICT,
    recording_id UUID NOT NULL
        REFERENCES recordings(id) ON DELETE RESTRICT,
    copy_type VARCHAR(12) NOT NULL
        CHECK (copy_type IN ('local','remote')),
    provider VARCHAR(24) NOT NULL
        CHECK (provider IN
            ('local','s3','azure','gcs','sftp','s3compatible')),
    object_key TEXT,
    copy_status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (copy_status IN
            ('pending','uploading','available','failed')),
    checksum_sha256 CHAR(64),
    size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
    last_error TEXT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (recording_id, copy_type)
);

CREATE INDEX IF NOT EXISTS idx_recording_copies_tenant_status
    ON recording_storage_copies
       (tenant_id, copy_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS recording_storage_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL
        REFERENCES tenants(id) ON DELETE RESTRICT,
    recording_id UUID NOT NULL
        REFERENCES recordings(id) ON DELETE RESTRICT,
    job_type VARCHAR(16) NOT NULL DEFAULT 'remote_upload'
        CHECK (job_type IN ('remote_upload','verify_remote')),
    job_status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (job_status IN
            ('pending','running','succeeded','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 8
        CHECK (max_attempts BETWEEN 1 AND 50),
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recording_jobs_ready
    ON recording_storage_jobs (available_at, created_at)
    WHERE job_status IN ('pending','failed');

COMMIT;
