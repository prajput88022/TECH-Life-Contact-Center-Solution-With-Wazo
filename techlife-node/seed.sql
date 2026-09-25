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
    ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'MIS Agent', 'mis_agent'),
    ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', 'Manager', 'manager'),
    ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000001', 'User Manager', 'user_manager'),
    ('00000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-000000000001', 'Reports Only', 'reports_only');

INSERT INTO users (id, tenant_id, username, email, password_hash, full_name, theme) VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
     'admin', 'admin@acme.test', '$2b$10$oQmqvARRXs7il6oGHlhhJ.6Oeuy3RFBp3XfljfyqLvpk1sXCQ9wnC', 'Acme Admin', 'blue');

INSERT INTO user_roles (user_id, role_id) VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011');
