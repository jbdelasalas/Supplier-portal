-- 003_suppliers.sql — the supplier master, created only when an application is
-- approved. Applications live in 004; this is the durable record.
--
-- Where this differs from the customer portal's `customers` table, and why:
--   * payment_terms_days is what WE owe THEM, so it is a liability term, not a
--     credit limit. There is no credit_limit here.
--   * accreditation_expires_at exists because a supplier's permits lapse. An
--     expired accreditation must block new POs without deleting history.
--   * bank details are here: we pay suppliers, so we need remittance details
--     that customers never have to give us.
--   * category / lead_time_days / minimum_order_value drive purchasing
--     decisions and have no customer-side equivalent.

SET LOCAL search_path = supplier, public;

CREATE TABLE IF NOT EXISTS supplier.suppliers (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE RESTRICT,

  -- Human-facing vendor code, assigned on approval (see next_supplier_code).
  code               varchar(30) NOT NULL,
  name               varchar(200) NOT NULL,
  legal_name         varchar(200),
  trade_name         varchar(200),

  supplier_type      varchar(30) NOT NULL DEFAULT 'corporate'
                     CHECK (supplier_type IN ('corporate', 'sole_proprietor', 'partnership',
                                              'cooperative', 'government', 'individual')),
  -- What they supply: feeds, medication, packaging, logistics, services…
  category           varchar(120),
  business_type      varchar(120),

  -- Tax / registration
  tin                varchar(20),
  vat_status         varchar(20) DEFAULT 'vat'
                     CHECK (vat_status IN ('vat', 'non_vat', 'exempt', 'zero_rated')),
  business_permit_no varchar(60),
  sec_dti_reg_no     varchar(60),
  bir_cor_no         varchar(60),
  -- Withholding tax rate we must deduct when paying this supplier, e.g. 1.00
  -- for goods or 2.00 for services. Percent, not a fraction.
  ewt_rate           numeric(5,2) NOT NULL DEFAULT 0,

  -- Primary contact
  contact_person     varchar(160),
  contact_position   varchar(120),
  email              citext,
  phone              varchar(40),
  mobile             varchar(40),

  -- Addresses
  business_address   text,
  -- Where goods are actually collected from, when it is not the office.
  pickup_address     text,
  city               varchar(120),
  province           varchar(120),
  postal_code        varchar(20),
  country            varchar(80) DEFAULT 'Philippines',

  -- Remittance details. Needed because we are the payer here.
  bank_name          varchar(160),
  bank_branch        varchar(160),
  bank_account_name  varchar(200),
  bank_account_no    varchar(60),

  -- Commercial terms, from our side of the table.
  payment_terms_days integer NOT NULL DEFAULT 30,
  currency           varchar(3) NOT NULL DEFAULT 'PHP',
  lead_time_days     integer,
  minimum_order_value numeric(18,2),

  status             varchar(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'on_hold', 'suspended', 'blacklisted', 'closed')),
  hold_reason        text,

  -- Accreditation validity. Permits expire; when this date passes the supplier
  -- stays visible and their history intact, but purchasing should not issue
  -- new POs against them until it is renewed.
  accredited_at            timestamptz,
  accreditation_expires_at date,

  -- Rolling performance summary, maintained by 005 as receipts are recorded.
  -- Denormalised on purpose: the PO list needs it on every row.
  on_time_deliveries integer NOT NULL DEFAULT 0,
  late_deliveries    integer NOT NULL DEFAULT 0,

  -- Provenance: which application produced this supplier (set in 004).
  application_id     uuid,
  -- Set when this supplier has been pushed to / matched with the ERP.
  erp_ref            text,
  erp_synced_at      timestamptz,

  notes              text,
  created_by         uuid REFERENCES supplier.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, code)
);
SELECT supplier.attach_updated_at('supplier.suppliers');

CREATE INDEX IF NOT EXISTS idx_sp_suppliers_company
  ON supplier.suppliers (company_id, status);
CREATE INDEX IF NOT EXISTS idx_sp_suppliers_name
  ON supplier.suppliers (company_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_sp_suppliers_tin
  ON supplier.suppliers (tin) WHERE tin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sp_suppliers_category
  ON supplier.suppliers (company_id, category) WHERE category IS NOT NULL;
-- Drives the "accreditation lapsing soon" queue.
CREATE INDEX IF NOT EXISTS idx_sp_suppliers_expiry
  ON supplier.suppliers (accreditation_expires_at)
  WHERE accreditation_expires_at IS NOT NULL AND status = 'active';

-- Now that suppliers exists, close the users.supplier_id loop.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sp_users_supplier_id_fkey'
  ) THEN
    ALTER TABLE supplier.users
      ADD CONSTRAINT sp_users_supplier_id_fkey
      FOREIGN KEY (supplier_id) REFERENCES supplier.suppliers(id) ON DELETE SET NULL;
  END IF;
END$$;

-- ============================================================================
-- Additional contacts
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.supplier_contacts (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id  uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE CASCADE,
  name         varchar(160) NOT NULL,
  position     varchar(120),
  email        citext,
  phone        varchar(40),
  role         varchar(40) DEFAULT 'general'
               CHECK (role IN ('general', 'sales', 'collections', 'dispatch',
                               'technical', 'authorized_signatory')),
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.supplier_contacts');

CREATE INDEX IF NOT EXISTS idx_sp_supplier_contacts
  ON supplier.supplier_contacts (supplier_id);

-- ============================================================================
-- Pickup / warehouse locations we collect from
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.supplier_sites (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id       uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE CASCADE,
  name              varchar(160) NOT NULL,
  address           text NOT NULL,
  city              varchar(120),
  province          varchar(120),
  contact_person    varchar(160),
  phone             varchar(40),
  pickup_notes      text,
  latitude          numeric(10,7),
  longitude         numeric(10,7),
  is_default        boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.supplier_sites');

CREATE INDEX IF NOT EXISTS idx_sp_supplier_sites
  ON supplier.supplier_sites (supplier_id) WHERE is_active;

-- Exactly one default site per supplier.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sp_supplier_default_site
  ON supplier.supplier_sites (supplier_id) WHERE is_default;

-- ============================================================================
-- Vendor code sequence, per company. Format: <COMPANY_CODE>-S-000123
--
-- The -S- infix keeps a vendor code visually distinct from a customer code
-- issued by the customer portal for the same company, which matters once both
-- appear on paperwork side by side.
--
-- Like the customer portal's generator (after its 008 fix), this skips past
-- any value already taken, so a restored backup or a hand-inserted row cannot
-- wedge the approval path behind a unique violation.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.supplier_code_seq (
  company_id uuid PRIMARY KEY REFERENCES supplier.companies(id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_supplier_code(p_company_id uuid)
RETURNS varchar AS $$
DECLARE
  v_next    integer;
  v_prefix  varchar(30);
  v_code    varchar(40);
BEGIN
  SELECT code INTO v_prefix FROM supplier.companies WHERE id = p_company_id;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'Unknown company %', p_company_id;
  END IF;

  INSERT INTO supplier.supplier_code_seq (company_id, last_value)
  VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
    SET last_value = supplier.supplier_code_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_code := v_prefix || '-S-' || lpad(v_next::text, 6, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM supplier.suppliers
       WHERE company_id = p_company_id AND code = v_code
    );
    v_next := v_next + 1;
    UPDATE supplier.supplier_code_seq
       SET last_value = v_next WHERE company_id = p_company_id;
  END LOOP;

  RETURN v_code;
END;
$$ LANGUAGE plpgsql;
