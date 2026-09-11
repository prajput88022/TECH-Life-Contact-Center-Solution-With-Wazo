-- =====================================================================
-- TECH-Life Contact-Center Solution
-- Fixes "permission denied for table X" errors.
--
-- Cause: this happens when schema files were applied by a different
-- Postgres role than the one the app connects as (e.g. some files run
-- via `sudo -u postgres psql -f ...` and others via the app's own
-- `techlife` role) -- tables end up owned by whichever role created
-- them, and Postgres does not automatically grant access across roles.
--
-- Run this AFTER all schema files have been applied, as a superuser
-- (e.g. `sudo -u postgres psql -d techlife -f fix_permissions.sql`),
-- replacing techlife below with your actual DB_USER if different.
-- =====================================================================

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO techlife;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO techlife;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO techlife;

-- Materialized views are not covered by "ALL TABLES" in every Postgres
-- version -- grant them explicitly too.
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' LOOP
        EXECUTE format('GRANT ALL PRIVILEGES ON %I TO techlife', r.matviewname);
    END LOOP;
END $$;

-- Also cover any table/sequence created AFTER this point (e.g. if you
-- add another schema addendum later and forget to run this again),
-- for objects created by whichever role runs this statement:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO techlife;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO techlife;
