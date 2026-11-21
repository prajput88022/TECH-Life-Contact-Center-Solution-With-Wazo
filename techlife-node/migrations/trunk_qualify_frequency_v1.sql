BEGIN;

ALTER TABLE public.trunks
    ADD COLUMN IF NOT EXISTS qualify_frequency
    INTEGER NOT NULL DEFAULT 60;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.trunks'::regclass
          AND conname = 'trunks_qualify_frequency_ck'
    ) THEN
        ALTER TABLE public.trunks
            ADD CONSTRAINT trunks_qualify_frequency_ck
            CHECK (qualify_frequency BETWEEN 0 AND 3600);
    END IF;
END
$$;

COMMIT;
