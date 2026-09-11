-- =====================================================================
-- Minimal seed data to get a first login working.
-- Password for both users below is: TechLife@123
-- =====================================================================
INSERT INTO tenants (id, name, slug, timezone) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Acme Corp', 'acme', 'Asia/Kolkata');

INSERT INTO roles (id, tenant_id, name, role_type) VALUES
    ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Admin', 'admin'),
    ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'Supervisor', 'supervisor'),
    ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'Agent', 'agent'),
    ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'MIS Agent', 'mis_agent');

-- bcrypt hash of "TechLife@123"
INSERT INTO users (id, tenant_id, username, email, password_hash, full_name) VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
     'admin', 'admin@acme.test', '$2b$10$oQmqvARRXs7il6oGHlhhJ.6Oeuy3RFBp3XfljfyqLvpk1sXCQ9wnC', 'Acme Admin');

-- NOTE: generate a real hash before using this seed, e.g.:
--   php -r "echo password_hash('TechLife@123', PASSWORD_BCRYPT), PHP_EOL;"
-- and paste it into the password_hash value above.

INSERT INTO user_roles (user_id, role_id) VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011');
