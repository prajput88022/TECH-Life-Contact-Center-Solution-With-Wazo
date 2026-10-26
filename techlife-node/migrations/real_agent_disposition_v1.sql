BEGIN;

CREATE TABLE IF NOT EXISTS do_not_call_entries (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone_number varchar(30) NOT NULL,
    campaign_id uuid NULL,
    reason varchar(100),
    created_by uuid NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_dnc_campaign_tenant
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_tenant_phone_global
    ON do_not_call_entries (tenant_id, phone_number)
    WHERE campaign_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_tenant_campaign_phone
    ON do_not_call_entries (tenant_id, campaign_id, phone_number)
    WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dnc_tenant_phone
    ON do_not_call_entries (tenant_id, phone_number);

CREATE INDEX IF NOT EXISTS idx_dnc_campaign_phone
    ON do_not_call_entries (tenant_id, campaign_id, phone_number);

CREATE TABLE IF NOT EXISTS agent_callbacks (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    agent_id uuid NOT NULL REFERENCES agents(id),
    call_id uuid NULL REFERENCES calls(id),
    lead_id uuid NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id uuid NULL,
    phone_number varchar(30) NOT NULL,
    due_at timestamptz NOT NULL,
    status varchar(20) NOT NULL DEFAULT 'scheduled',
    notes text,
    claimed_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_agent_callback_status
      CHECK (status IN (
        'scheduled', 'claimed', 'dialing',
        'completed', 'cancelled', 'failed'
      )),
    CONSTRAINT fk_agent_callback_campaign_tenant
      FOREIGN KEY (tenant_id, campaign_id)
      REFERENCES campaigns(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_callbacks_due
    ON agent_callbacks (due_at, id)
    WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_agent_callbacks_agent
    ON agent_callbacks (tenant_id, agent_id, due_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_callbacks_lead
    ON agent_callbacks (tenant_id, lead_id)
    WHERE lead_id IS NOT NULL;

INSERT INTO dispositions
    (tenant_id, code, label, is_conversion, channel, is_active,
     parent_id, hierarchy_level, sort_order)
SELECT
    t.id, v.code, v.label, false, 'voice', true, NULL, 1, v.sort_order
FROM tenants t
CROSS JOIN (
    VALUES
      ('DND',       'Do Not Call', 10),
      ('FOLLOW_UP', 'Follow Up',   20),
      ('TRANSFER',  'Transfer',    30),
      ('NORMAL',    'Normal',      40),
      ('OTHERS',    'Others',      50)
) AS v(code, label, sort_order)
WHERE NOT EXISTS (
    SELECT 1
    FROM dispositions d
    WHERE d.tenant_id = t.id
      AND d.code = v.code
);

COMMIT;
