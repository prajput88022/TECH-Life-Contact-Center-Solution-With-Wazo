ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS wazo_context_links_status
        VARCHAR(20) NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS wazo_context_links_error TEXT,
    ADD COLUMN IF NOT EXISTS wazo_context_links_updated_at
        TIMESTAMPTZ;

UPDATE tenants
   SET wazo_context_links_status = 'pending',
       wazo_context_links_error = NULL
 WHERE is_active = TRUE
   AND wazo_context_id IS NOT NULL
   AND wazo_outcall_context_id IS NOT NULL
   AND wazo_context_links_status IS DISTINCT FROM 'provisioned';
