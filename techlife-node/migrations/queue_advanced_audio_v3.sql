BEGIN;

ALTER TABLE queues
    ADD COLUMN IF NOT EXISTS periodic_announce_start_delay_seconds
        INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS wazo_audio_fingerprint VARCHAR(64);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'queues_periodic_announce_start_delay_ck'
          AND conrelid = 'public.queues'::regclass
    ) THEN
        ALTER TABLE queues
            ADD CONSTRAINT queues_periodic_announce_start_delay_ck
            CHECK (periodic_announce_start_delay_seconds BETWEEN 0 AND 3600);
    END IF;
END
$$;

COMMIT;
