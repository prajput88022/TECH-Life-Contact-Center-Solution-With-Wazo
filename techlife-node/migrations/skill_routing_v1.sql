BEGIN;

ALTER TABLE queues
    ADD COLUMN IF NOT EXISTS required_skills_json
        jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS skill_fallback_action
        varchar(30) NOT NULL DEFAULT 'leave';

ALTER TABLE queues
    DROP CONSTRAINT IF EXISTS queues_skill_fallback_action_check;

ALTER TABLE queues
    ADD CONSTRAINT queues_skill_fallback_action_check
    CHECK (
        skill_fallback_action IN (
            'leave',
            'next_queue',
            'callback',
            'voicemail'
        )
    );

ALTER TABLE queues
    DROP CONSTRAINT IF EXISTS queues_required_skills_json_check;

ALTER TABLE queues
    ADD CONSTRAINT queues_required_skills_json_check
    CHECK (
        jsonb_typeof(required_skills_json) = 'array'
    );

COMMIT;
