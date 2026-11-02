BEGIN;

ALTER TABLE queues
    ALTER COLUMN announce_position SET DEFAULT TRUE;

UPDATE queues
   SET announce_position = TRUE
 WHERE announce_position = FALSE;

COMMIT;
