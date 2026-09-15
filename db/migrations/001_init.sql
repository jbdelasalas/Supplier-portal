-- 001_init.sql — the `supplier` schema, extensions, helpers, and companies.
--
-- All migrations here are ADDITIVE and IDEMPOTENT: safe to re-run.
--
-- ## Why everything lives in a dedicated schema
--
-- This portal SHARES its Postgres database with the customer portal, which
-- owns `public` and holds live customer accounts. Both systems independently
-- want tables called users, companies, documents, applications, invoices,
-- notifications, audit_log — and both write roles with codes like
-- 'superadmin' and 'viewer' into a UNIQUE-constrained column.
--
-- Because the customer portal's migrations are all CREATE TABLE IF NOT EXISTS,
-- a collision there would NOT fail loudly. It would silently skip the create,
-- leave the customer portal's table in place, and then run this portal's
-- ALTERs and seed INSERTs against real customer data. That is the exact
-- failure mode that nearly damaged the ERP once before.
--
-- So: every object below is created in `supplier`, nothing is created in
-- `public`, and scripts/migrate.mjs refuses to apply a migration whose SQL
-- would touch public. Sharing the database is then safe — the two systems are
-- neighbours in one instance, not co-owners of one namespace.
CREATE SCHEMA IF NOT EXISTS supplier;

-- Extensions are database-wide and live in public by design; CREATE EXTENSION
-- IF NOT EXISTS is a no-op when the customer portal already installed them.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

SET LOCAL search_path = supplier, public;

-- Keeps updated_at honest without every caller remembering to set it.
-- Namespaced into `supplier` so it cannot redefine the customer portal's copy.
CREATE OR REPLACE FUNCTION supplier.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attaches the updated_at trigger to a table, only once.
CREATE OR REPLACE FUNCTION supplier.attach_updated_at(tbl regclass) RETURNS void AS $$
DECLARE
  trg_name text := 'set_updated_at_' || replace(tbl::text, '.', '_');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trg_name) THEN
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION supplier.set_updated_at()',
      trg_name, tbl::text
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Companies — the BUYING entity a supplier is onboarded to.
-- Mirrors the customer portal's companies table, but this is a separate row
-- set: the same legal company may appear in both, matched later via erp_ref.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.companies (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  code         varchar(20)  NOT NULL UNIQUE,
  name         varchar(200) NOT NULL,
  legal_name   varchar(200),
  tin          varchar(20),
  address      text,
  phone        varchar(40),
  email        citext,
  logo_url     text,
  is_active    boolean NOT NULL DEFAULT true,
  -- Set when this company maps to a company row in the ERP. Nullable by
  -- design: the portal must work with no ERP connection at all.
  erp_ref      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.companies');

CREATE INDEX IF NOT EXISTS idx_sp_companies_active
  ON supplier.companies (is_active) WHERE is_active;
