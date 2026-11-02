BEGIN;

-- Refuse to change constraints if existing data crosses tenants.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dids d
        JOIN inbound_groups g ON g.id = d.inbound_group_id
        WHERE d.tenant_id <> g.tenant_id
    ) THEN
        RAISE EXCEPTION
            'Migration stopped: cross-tenant DID/inbound-group assignments exist.';
    END IF;
END
$$;

-- Required unique key for the composite foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS
    uq_inbound_groups_tenant_id_id
ON inbound_groups (tenant_id, id);

-- Remove the old group-only foreign key.
ALTER TABLE dids
    DROP CONSTRAINT IF EXISTS dids_inbound_group_fk;

-- Enforce that the DID and group belong to the same tenant.
-- When a group is deleted, clear only inbound_group_id.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dids_tenant_inbound_group_fk'
          AND conrelid = 'dids'::regclass
    ) THEN
        ALTER TABLE dids
            ADD CONSTRAINT dids_tenant_inbound_group_fk
            FOREIGN KEY (tenant_id, inbound_group_id)
            REFERENCES inbound_groups (tenant_id, id)
            ON DELETE SET NULL (inbound_group_id);
    END IF;
END
$$;

COMMIT;
