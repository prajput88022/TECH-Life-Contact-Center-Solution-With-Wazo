BEGIN;

-- Keep hierarchy depth within the supported range.
ALTER TABLE dispositions
    DROP CONSTRAINT IF EXISTS dispositions_hierarchy_level_check;

ALTER TABLE dispositions
    ADD CONSTRAINT dispositions_hierarchy_level_check
    CHECK (hierarchy_level BETWEEN 1 AND 3);

CREATE OR REPLACE FUNCTION enforce_disposition_hierarchy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_level SMALLINT;
    descendant_depth INTEGER;
BEGIN
    -- Root dispositions must have no parent.
    IF NEW.parent_id IS NULL THEN
        NEW.hierarchy_level := 1;
    ELSE
        IF NEW.parent_id = NEW.id THEN
            RAISE EXCEPTION 'A disposition cannot be its own parent'
                USING ERRCODE = '23514';
        END IF;

        SELECT d.hierarchy_level
          INTO parent_level
          FROM dispositions d
         WHERE d.id = NEW.parent_id
           AND d.tenant_id = NEW.tenant_id
         FOR KEY SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'Parent disposition does not exist in this tenant'
                USING ERRCODE = '23503';
        END IF;

        IF parent_level NOT IN (1, 2) THEN
            RAISE EXCEPTION
                'A disposition at level 3 cannot have children'
                USING ERRCODE = '23514';
        END IF;

        NEW.hierarchy_level := parent_level + 1;
    END IF;

    -- Reject a parent change that would make this node its own ancestor.
    IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT NULL THEN
        IF EXISTS (
            WITH RECURSIVE ancestors(id, parent_id, path, cycle) AS (
                SELECT d.id, d.parent_id,
                       ARRAY[d.id]::uuid[], false
                  FROM dispositions d
                 WHERE d.id = NEW.parent_id
                   AND d.tenant_id = NEW.tenant_id

                UNION ALL

                SELECT p.id, p.parent_id,
                       a.path || p.id,
                       p.id = ANY(a.path)
                  FROM ancestors a
                  JOIN dispositions p
                    ON p.id = a.parent_id
                   AND p.tenant_id = NEW.tenant_id
                 WHERE NOT a.cycle
            )
            SELECT 1 FROM ancestors
             WHERE id = NEW.id OR cycle
        ) THEN
            RAISE EXCEPTION
                'Disposition hierarchy cannot contain a cycle'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    -- Check the existing descendant subtree against the proposed level.
    -- A descendant's depth is measured from NEW, not from its old level.
    IF TG_OP = 'UPDATE' THEN
        WITH RECURSIVE descendants(id, depth, path, cycle) AS (
            SELECT d.id, 1, ARRAY[NEW.id, d.id]::uuid[], d.id = NEW.id
              FROM dispositions d
             WHERE d.parent_id = NEW.id
               AND d.tenant_id = NEW.tenant_id

            UNION ALL

            SELECT d.id, x.depth + 1,
                   x.path || d.id,
                   d.id = ANY(x.path)
              FROM descendants x
              JOIN dispositions d
                ON d.parent_id = x.id
               AND d.tenant_id = NEW.tenant_id
             WHERE NOT x.cycle
        )
        SELECT COALESCE(MAX(depth), 0)
          INTO descendant_depth
          FROM descendants;

        IF NEW.hierarchy_level + descendant_depth > 3 THEN
            RAISE EXCEPTION
                'This change would make a descendant deeper than level 3'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_disposition_hierarchy
    ON dispositions;

CREATE TRIGGER trg_enforce_disposition_hierarchy
BEFORE INSERT OR UPDATE OF tenant_id, parent_id, hierarchy_level
ON dispositions
FOR EACH ROW
EXECUTE FUNCTION enforce_disposition_hierarchy();

-- Verify the existing hierarchy before committing.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM dispositions d
         WHERE (d.parent_id IS NULL AND d.hierarchy_level <> 1)
            OR (d.parent_id IS NOT NULL AND NOT EXISTS (
                SELECT 1
                  FROM dispositions p
                 WHERE p.id = d.parent_id
                   AND p.tenant_id = d.tenant_id
                   AND p.hierarchy_level IN (1, 2)
                   AND d.hierarchy_level = p.hierarchy_level + 1
            ))
    ) THEN
        RAISE EXCEPTION
            'Existing dispositions contain an invalid hierarchy; inspect data before applying this migration';
    END IF;
END;
$$;

COMMIT;
