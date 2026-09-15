-- 006_payables.sql — supplier invoices, payments, and the supplier statement.
--
-- This is a supplier-facing AP *mirror*, not a general ledger. It answers
-- "what have I billed, what was approved, and when do I get paid?".
-- Accounting stays in the ERP.
--
-- The important difference from the customer portal's 006: there, WE raise the
-- invoice. Here the SUPPLIER submits it and we check it before it becomes
-- payable — so an invoice arrives as 'submitted', not as a receivable, and
-- has to survive matching against the PO and the goods actually received.

SET LOCAL search_path = supplier, public, extensions;

CREATE TABLE IF NOT EXISTS supplier.bills (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE RESTRICT,
  supplier_id    uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE RESTRICT,
  po_id          uuid REFERENCES supplier.purchase_orders(id) ON DELETE SET NULL,

  -- Our internal reference.
  bill_no        varchar(30) NOT NULL UNIQUE,
  -- The supplier's own invoice number and their SI/OR document.
  supplier_invoice_no varchar(60) NOT NULL,
  invoice_date   date NOT NULL,
  due_date       date,

  currency       varchar(3) NOT NULL DEFAULT 'PHP',
  subtotal       numeric(18,2) NOT NULL DEFAULT 0,
  vat_total      numeric(18,2) NOT NULL DEFAULT 0,
  -- Expanded withholding tax we deduct at payment time.
  ewt_total      numeric(18,2) NOT NULL DEFAULT 0,
  grand_total    numeric(18,2) NOT NULL DEFAULT 0,
  -- Net of EWT: what the supplier actually receives.
  amount_payable numeric(18,2) NOT NULL DEFAULT 0,
  amount_paid    numeric(18,2) NOT NULL DEFAULT 0,

  status         varchar(20) NOT NULL DEFAULT 'submitted'
                 CHECK (status IN ('draft', 'submitted', 'under_review', 'disputed',
                                   'approved', 'partially_paid', 'paid', 'cancelled')),

  -- Three-way match outcome, recomputed by check_bill_match() below.
  -- 'unmatched' until it is run; 'mismatch' blocks approval in the UI.
  match_status   varchar(20) NOT NULL DEFAULT 'unmatched'
                 CHECK (match_status IN ('unmatched', 'matched', 'mismatch', 'overridden')),
  match_notes    text,

  -- The scanned invoice the supplier uploaded.
  document_path  text,

  submitted_by   uuid REFERENCES supplier.users(id),
  submitted_at   timestamptz,
  approved_by    uuid REFERENCES supplier.users(id),
  approved_at    timestamptz,
  dispute_reason text,

  erp_ref        text,
  erp_synced_at  timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A supplier cannot bill the same invoice number twice.
  UNIQUE (supplier_id, supplier_invoice_no)
);
SELECT supplier.attach_updated_at('supplier.bills');

CREATE INDEX IF NOT EXISTS idx_sp_bills_supplier
  ON supplier.bills (supplier_id, status, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_sp_bills_queue
  ON supplier.bills (company_id, status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_sp_bills_po
  ON supplier.bills (po_id) WHERE po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sp_bills_open
  ON supplier.bills (company_id, due_date)
  WHERE status IN ('approved', 'partially_paid');

CREATE TABLE IF NOT EXISTS supplier.bill_lines (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id      uuid NOT NULL REFERENCES supplier.bills(id) ON DELETE CASCADE,
  po_line_id   uuid REFERENCES supplier.po_lines(id) ON DELETE SET NULL,
  line_no      integer NOT NULL,
  description  varchar(300) NOT NULL,
  uom          varchar(20),
  qty          numeric(18,3) NOT NULL CHECK (qty > 0),
  unit_price   numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  is_vatable   boolean NOT NULL DEFAULT true,
  line_total   numeric(18,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_sp_bill_lines ON supplier.bill_lines (bill_id);

-- ============================================================================
-- Payments. One payment may settle several bills, so allocations are a table.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.payments (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id     uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE RESTRICT,
  supplier_id    uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE RESTRICT,

  payment_no     varchar(30) NOT NULL UNIQUE,
  payment_date   date NOT NULL DEFAULT current_date,
  method         varchar(20) NOT NULL DEFAULT 'bank_transfer'
                 CHECK (method IN ('bank_transfer', 'check', 'cash', 'other')),
  reference_no   varchar(60),
  check_no       varchar(60),

  currency       varchar(3) NOT NULL DEFAULT 'PHP',
  amount         numeric(18,2) NOT NULL CHECK (amount > 0),

  status         varchar(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'cancelled')),

  -- Proof the supplier can see: the deposit slip or remittance advice.
  document_path  text,
  notes          text,

  recorded_by    uuid REFERENCES supplier.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.payments');

CREATE INDEX IF NOT EXISTS idx_sp_payments_supplier
  ON supplier.payments (supplier_id, payment_date DESC);

CREATE TABLE IF NOT EXISTS supplier.payment_allocations (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id   uuid NOT NULL REFERENCES supplier.payments(id) ON DELETE CASCADE,
  bill_id      uuid NOT NULL REFERENCES supplier.bills(id)    ON DELETE CASCADE,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, bill_id)
);

CREATE INDEX IF NOT EXISTS idx_sp_alloc_bill ON supplier.payment_allocations (bill_id);

-- Recompute a bill's paid amount and status from its confirmed allocations.
CREATE OR REPLACE FUNCTION supplier.recalc_bill_payment(p_bill_id uuid)
RETURNS void AS $$
DECLARE
  v_paid    numeric(18,2);
  v_payable numeric(18,2);
  v_status  varchar(20);
BEGIN
  SELECT COALESCE(SUM(pa.amount), 0) INTO v_paid
    FROM supplier.payment_allocations pa
    JOIN supplier.payments p ON p.id = pa.payment_id
   WHERE pa.bill_id = p_bill_id AND p.status = 'confirmed';

  SELECT amount_payable, status INTO v_payable, v_status
    FROM supplier.bills WHERE id = p_bill_id;

  UPDATE supplier.bills
     SET amount_paid = v_paid,
         status = CASE
           -- Never override a terminal or pre-approval state from here.
           WHEN v_status IN ('cancelled', 'draft', 'submitted', 'under_review', 'disputed')
             THEN v_status
           WHEN v_paid >= v_payable AND v_payable > 0 THEN 'paid'
           WHEN v_paid > 0 THEN 'partially_paid'
           ELSE 'approved'
         END
   WHERE id = p_bill_id;
END;
$$ LANGUAGE plpgsql;

-- Keep bills in step whenever an allocation or a payment's status changes.
CREATE OR REPLACE FUNCTION supplier.trg_recalc_bill_payment() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_allocations' THEN
    PERFORM supplier.recalc_bill_payment(COALESCE(NEW.bill_id, OLD.bill_id));
  ELSE
    -- A payment's status flipped: refresh every bill it touches.
    PERFORM supplier.recalc_bill_payment(pa.bill_id)
       FROM supplier.payment_allocations pa
      WHERE pa.payment_id = COALESCE(NEW.id, OLD.id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sp_alloc_recalc') THEN
    CREATE TRIGGER sp_alloc_recalc
      AFTER INSERT OR UPDATE OR DELETE ON supplier.payment_allocations
      FOR EACH ROW EXECUTE FUNCTION supplier.trg_recalc_bill_payment();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sp_payment_recalc') THEN
    CREATE TRIGGER sp_payment_recalc
      AFTER UPDATE OF status ON supplier.payments
      FOR EACH ROW EXECUTE FUNCTION supplier.trg_recalc_bill_payment();
  END IF;
END$$;

-- ============================================================================
-- Bill totals, including the EWT deduction.
-- ============================================================================
CREATE OR REPLACE FUNCTION supplier.recalc_bill_totals(p_bill_id uuid)
RETURNS void AS $$
DECLARE
  v_subtotal numeric(18,2) := 0;
  v_vatable  numeric(18,2) := 0;
  v_vat      numeric(18,2) := 0;
  v_ewt_rate numeric(5,2)  := 0;
  v_ewt      numeric(18,2) := 0;
BEGIN
  UPDATE supplier.bill_lines
     SET line_total = round(qty * unit_price, 2)
   WHERE bill_id = p_bill_id;

  SELECT COALESCE(SUM(line_total), 0),
         COALESCE(SUM(CASE WHEN is_vatable THEN line_total ELSE 0 END), 0)
    INTO v_subtotal, v_vatable
    FROM supplier.bill_lines WHERE bill_id = p_bill_id;

  v_vat := round(v_vatable * 0.12, 2);

  SELECT s.ewt_rate INTO v_ewt_rate
    FROM supplier.bills b
    JOIN supplier.suppliers s ON s.id = b.supplier_id
   WHERE b.id = p_bill_id;

  -- EWT is computed on the VAT-exclusive base, which is how BIR Form 2307
  -- works — withholding on the gross including VAT would over-deduct.
  v_ewt := round(v_subtotal * COALESCE(v_ewt_rate, 0) / 100.0, 2);

  UPDATE supplier.bills
     SET subtotal       = v_subtotal,
         vat_total      = v_vat,
         ewt_total      = v_ewt,
         grand_total    = v_subtotal + v_vat,
         amount_payable = v_subtotal + v_vat - v_ewt
   WHERE id = p_bill_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Three-way match: invoice vs purchase order vs goods received.
--
-- Sets match_status on the bill and returns a human-readable explanation.
-- Staff can still approve a mismatch deliberately (match_status becomes
-- 'overridden'), but not without seeing this first.
-- ============================================================================
CREATE OR REPLACE FUNCTION supplier.check_bill_match(p_bill_id uuid)
RETURNS text AS $$
DECLARE
  v_po_id    uuid;
  v_problems text[] := ARRAY[]::text[];
  v_row      record;
  v_billed   numeric(18,2);
  v_po_total numeric(18,2);
BEGIN
  SELECT po_id INTO v_po_id FROM supplier.bills WHERE id = p_bill_id;

  IF v_po_id IS NULL THEN
    UPDATE supplier.bills SET match_status = 'unmatched',
           match_notes = 'No purchase order linked to this invoice.'
     WHERE id = p_bill_id;
    RETURN 'No purchase order linked to this invoice.';
  END IF;

  -- Billed quantity must not exceed what was actually received.
  FOR v_row IN
    SELECT bl.line_no,
           bl.description,
           bl.qty          AS billed_qty,
           bl.unit_price   AS billed_price,
           pl.qty_received,
           pl.unit_price   AS po_price
      FROM supplier.bill_lines bl
      JOIN supplier.po_lines   pl ON pl.id = bl.po_line_id
     WHERE bl.bill_id = p_bill_id
  LOOP
    IF v_row.billed_qty > v_row.qty_received THEN
      v_problems := v_problems || format(
        'Line %s (%s): billed %s but only %s received.',
        v_row.line_no, v_row.description, v_row.billed_qty, v_row.qty_received);
    END IF;

    IF round(v_row.billed_price, 4) <> round(v_row.po_price, 4) THEN
      v_problems := v_problems || format(
        'Line %s (%s): billed at %s, PO price is %s.',
        v_row.line_no, v_row.description, v_row.billed_price, v_row.po_price);
    END IF;
  END LOOP;

  -- A bill line with no po_line_id is something we never ordered.
  IF EXISTS (
    SELECT 1 FROM supplier.bill_lines
     WHERE bill_id = p_bill_id AND po_line_id IS NULL
  ) THEN
    v_problems := v_problems || 'One or more invoice lines are not linked to a PO line.';
  END IF;

  -- Guard against the total exceeding the PO even when each line looks sane.
  SELECT grand_total INTO v_billed   FROM supplier.bills           WHERE id = p_bill_id;
  SELECT grand_total INTO v_po_total FROM supplier.purchase_orders WHERE id = v_po_id;
  IF v_billed > v_po_total THEN
    v_problems := v_problems || format(
      'Invoice total %s exceeds the PO total %s.', v_billed, v_po_total);
  END IF;

  IF array_length(v_problems, 1) IS NULL THEN
    UPDATE supplier.bills SET match_status = 'matched', match_notes = NULL
     WHERE id = p_bill_id;
    RETURN NULL;
  END IF;

  UPDATE supplier.bills
     SET match_status = 'mismatch',
         match_notes  = array_to_string(v_problems, E'\n')
   WHERE id = p_bill_id;

  RETURN array_to_string(v_problems, E'\n');
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Bill / payment numbers
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.bill_no_seq (
  period     varchar(6) PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_bill_no()
RETURNS varchar AS $$
DECLARE
  v_period varchar(6) := to_char(now(), 'YYYYMM');
  v_next   integer;
  v_no     varchar(30);
BEGIN
  INSERT INTO supplier.bill_no_seq (period, last_value)
  VALUES (v_period, 1)
  ON CONFLICT (period) DO UPDATE
    SET last_value = supplier.bill_no_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_no := 'AP-' || v_period || '-' || lpad(v_next::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM supplier.bills WHERE bill_no = v_no);
    v_next := v_next + 1;
    UPDATE supplier.bill_no_seq SET last_value = v_next WHERE period = v_period;
  END LOOP;

  RETURN v_no;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS supplier.payment_no_seq (
  period     varchar(6) PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_payment_no()
RETURNS varchar AS $$
DECLARE
  v_period varchar(6) := to_char(now(), 'YYYYMM');
  v_next   integer;
  v_no     varchar(30);
BEGIN
  INSERT INTO supplier.payment_no_seq (period, last_value)
  VALUES (v_period, 1)
  ON CONFLICT (period) DO UPDATE
    SET last_value = supplier.payment_no_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_no := 'PV-' || v_period || '-' || lpad(v_next::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM supplier.payments WHERE payment_no = v_no);
    v_next := v_next + 1;
    UPDATE supplier.payment_no_seq SET last_value = v_next WHERE period = v_period;
  END LOOP;

  RETURN v_no;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Statement views
-- ============================================================================

-- Open items with ageing buckets, one row per unpaid bill.
CREATE OR REPLACE VIEW supplier.v_supplier_open_items AS
SELECT
  b.id            AS bill_id,
  b.company_id,
  b.supplier_id,
  s.code          AS supplier_code,
  s.name          AS supplier_name,
  b.bill_no,
  b.supplier_invoice_no,
  b.invoice_date,
  b.due_date,
  b.currency,
  b.amount_payable,
  b.amount_paid,
  (b.amount_payable - b.amount_paid) AS balance,
  b.status,
  GREATEST((current_date - b.due_date), 0) AS days_overdue,
  CASE
    WHEN b.due_date IS NULL OR current_date <= b.due_date THEN 'current'
    WHEN current_date - b.due_date <= 30  THEN '1_30'
    WHEN current_date - b.due_date <= 60  THEN '31_60'
    WHEN current_date - b.due_date <= 90  THEN '61_90'
    ELSE 'over_90'
  END AS ageing_bucket
  FROM supplier.bills b
  JOIN supplier.suppliers s ON s.id = b.supplier_id
 WHERE b.status IN ('approved', 'partially_paid')
   AND (b.amount_payable - b.amount_paid) > 0;

-- One row per supplier: what we owe them, and how overdue it is.
CREATE OR REPLACE VIEW supplier.v_supplier_balances AS
SELECT
  s.id          AS supplier_id,
  s.company_id,
  s.code,
  s.name,
  s.currency,
  COALESCE(SUM(oi.balance), 0) AS total_outstanding,
  COALESCE(SUM(CASE WHEN oi.ageing_bucket = 'current' THEN oi.balance ELSE 0 END), 0) AS current_amt,
  COALESCE(SUM(CASE WHEN oi.ageing_bucket = '1_30'    THEN oi.balance ELSE 0 END), 0) AS overdue_1_30,
  COALESCE(SUM(CASE WHEN oi.ageing_bucket = '31_60'   THEN oi.balance ELSE 0 END), 0) AS overdue_31_60,
  COALESCE(SUM(CASE WHEN oi.ageing_bucket = '61_90'   THEN oi.balance ELSE 0 END), 0) AS overdue_61_90,
  COALESCE(SUM(CASE WHEN oi.ageing_bucket = 'over_90' THEN oi.balance ELSE 0 END), 0) AS overdue_over_90,
  COUNT(oi.bill_id) AS open_bill_count
  FROM supplier.suppliers s
  LEFT JOIN supplier.v_supplier_open_items oi ON oi.supplier_id = s.id
 GROUP BY s.id, s.company_id, s.code, s.name, s.currency;

-- ============================================================================
-- Notifications & audit
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.notifications (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     uuid NOT NULL REFERENCES supplier.users(id) ON DELETE CASCADE,
  kind        varchar(40) NOT NULL,
  title       varchar(200) NOT NULL,
  body        text,
  link        text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_notifications_unread
  ON supplier.notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS supplier.audit_log (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id uuid REFERENCES supplier.users(id) ON DELETE SET NULL,
  actor_label   varchar(160),
  action        varchar(60) NOT NULL,
  entity_type   varchar(60) NOT NULL,
  entity_id     uuid,
  before_data   jsonb,
  after_data    jsonb,
  ip_address    inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_audit_entity
  ON supplier.audit_log (entity_type, entity_id, created_at DESC);
