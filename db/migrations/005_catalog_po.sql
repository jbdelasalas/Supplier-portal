-- 005_catalog_po.sql — purchasable items, supplier price lists, and the
-- purchase-order + receiving workflow.
--
-- The direction of every flow here is the mirror image of the customer portal:
-- there, the customer places an order and we fulfil it. Here, WE issue the
-- purchase order and the SUPPLIER fulfils it. So a PO is created by staff and
-- acknowledged by the supplier, never the other way round — which is why
-- there is no supplier-facing "create PO" route anywhere in this codebase.

SET LOCAL search_path = supplier, public, extensions;

-- ============================================================================
-- Items we buy. Mastered in the ERP eventually; `erp_ref` is the hook.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.items (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE CASCADE,
  sku           varchar(60) NOT NULL,
  name          varchar(200) NOT NULL,
  description   text,
  category      varchar(120),
  uom           varchar(20) NOT NULL DEFAULT 'kg',
  -- Indicative budget price, used to flag a quote that comes in high.
  reference_cost numeric(18,4),
  is_active     boolean NOT NULL DEFAULT true,
  erp_ref       text,
  erp_synced_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku)
);
SELECT supplier.attach_updated_at('supplier.items');

CREATE INDEX IF NOT EXISTS idx_sp_items_active
  ON supplier.items (company_id, category) WHERE is_active;

-- ============================================================================
-- Supplier price lists (quotations)
--
-- The supplier proposes, staff approve, and only an approved row may price a
-- PO line. Date-ranged so a price change is a new row, preserving what a past
-- PO was actually quoted.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.supplier_prices (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  supplier_id   uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES supplier.items(id)     ON DELETE CASCADE,

  unit_price    numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  currency      varchar(3) NOT NULL DEFAULT 'PHP',
  uom           varchar(20),
  -- Minimum quantity this price is good for.
  min_qty       numeric(18,3),
  lead_time_days integer,

  valid_from    date NOT NULL DEFAULT current_date,
  valid_to      date,

  status        varchar(20) NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
  -- Who proposed it: the supplier themselves, or staff keying in a phone quote.
  proposed_by   uuid REFERENCES supplier.users(id),
  proposed_at   timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES supplier.users(id),
  decided_at    timestamptz,
  decision_notes text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sp_prices_date_order CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
SELECT supplier.attach_updated_at('supplier.supplier_prices');

CREATE INDEX IF NOT EXISTS idx_sp_prices_lookup
  ON supplier.supplier_prices (supplier_id, item_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_sp_prices_pending
  ON supplier.supplier_prices (status, proposed_at DESC) WHERE status = 'proposed';

-- At most one open-ended APPROVED price per supplier+item. A superseded or
-- rejected row may sit alongside it; two live prices for the same thing could
-- not be resolved deterministically.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sp_price_open_ended
  ON supplier.supplier_prices (supplier_id, item_id)
  WHERE valid_to IS NULL AND status = 'approved';

-- The approved price for an item from a supplier today, or NULL if there is
-- none — in which case a PO line must carry an explicitly keyed price.
CREATE OR REPLACE FUNCTION supplier.effective_cost(p_supplier_id uuid, p_item_id uuid)
RETURNS numeric AS $$
DECLARE
  v_price numeric(18,4);
BEGIN
  SELECT unit_price INTO v_price
    FROM supplier.supplier_prices
   WHERE supplier_id = p_supplier_id
     AND item_id     = p_item_id
     AND status      = 'approved'
     AND valid_from <= current_date
     AND (valid_to IS NULL OR valid_to >= current_date)
   ORDER BY valid_from DESC
   LIMIT 1;

  RETURN v_price;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- Purchase orders
--
-- Workflow (index = progress):
--   Draft -> Issued -> Acknowledged -> In Transit -> Partially Received
--         -> Received -> Closed
-- Terminal off-ramps: Cancelled (by us), Declined (by the supplier)
--
-- 'acknowledged' is the supplier's own action and the reason this portal
-- exists: it turns a PO we emailed into a commitment with a timestamp, and it
-- is where a supplier states the delivery date they can actually meet.
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.purchase_orders (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        uuid NOT NULL REFERENCES supplier.companies(id) ON DELETE RESTRICT,
  supplier_id       uuid NOT NULL REFERENCES supplier.suppliers(id) ON DELETE RESTRICT,

  po_no             varchar(30) NOT NULL UNIQUE,

  status            varchar(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'issued', 'acknowledged', 'in_transit',
                                      'partially_received', 'received', 'closed',
                                      'cancelled', 'declined')),

  -- Where and when we want the goods.
  ship_to_address   text,
  requested_date    date,
  -- What the supplier committed to at acknowledgement. Kept apart from
  -- requested_date so slippage is visible rather than overwritten.
  promised_date     date,

  currency          varchar(3) NOT NULL DEFAULT 'PHP',
  payment_terms_days integer NOT NULL DEFAULT 30,

  -- Money. Prices are treated as VAT-EXCLUSIVE; totals maintained by
  -- recalc_po_totals() below.
  subtotal          numeric(18,2) NOT NULL DEFAULT 0,
  discount_total    numeric(18,2) NOT NULL DEFAULT 0,
  vat_total         numeric(18,2) NOT NULL DEFAULT 0,
  grand_total       numeric(18,2) NOT NULL DEFAULT 0,

  notes             text,
  internal_notes    text,

  issued_by         uuid REFERENCES supplier.users(id),
  issued_at         timestamptz,
  -- The supplier's acknowledgement, or their decline reason.
  acknowledged_by   uuid REFERENCES supplier.users(id),
  acknowledged_at   timestamptz,
  decline_reason    text,
  closed_at         timestamptz,

  erp_ref           text,
  erp_synced_at     timestamptz,

  created_by        uuid REFERENCES supplier.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
SELECT supplier.attach_updated_at('supplier.purchase_orders');

CREATE INDEX IF NOT EXISTS idx_sp_po_supplier
  ON supplier.purchase_orders (supplier_id, status, requested_date DESC);
CREATE INDEX IF NOT EXISTS idx_sp_po_queue
  ON supplier.purchase_orders (company_id, status, created_at DESC);
-- The supplier's "needs my attention" list.
CREATE INDEX IF NOT EXISTS idx_sp_po_awaiting_ack
  ON supplier.purchase_orders (supplier_id, issued_at DESC) WHERE status = 'issued';

CREATE TABLE IF NOT EXISTS supplier.po_lines (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id         uuid NOT NULL REFERENCES supplier.purchase_orders(id) ON DELETE CASCADE,
  item_id       uuid REFERENCES supplier.items(id) ON DELETE RESTRICT,
  line_no       integer NOT NULL,

  -- Snapshotted at issue time so the PO still reads correctly if the item is
  -- renamed or deactivated later.
  description   varchar(300) NOT NULL,
  uom           varchar(20) NOT NULL DEFAULT 'kg',

  qty_ordered   numeric(18,3) NOT NULL CHECK (qty_ordered > 0),
  qty_received  numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),

  unit_price    numeric(18,4) NOT NULL CHECK (unit_price >= 0),
  discount_pct  numeric(5,2)  NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  is_vatable    boolean NOT NULL DEFAULT true,
  line_total    numeric(18,2) NOT NULL DEFAULT 0,

  -- Which quoted price produced unit_price, for audit.
  price_id      uuid REFERENCES supplier.supplier_prices(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (po_id, line_no)
);
SELECT supplier.attach_updated_at('supplier.po_lines');

CREATE INDEX IF NOT EXISTS idx_sp_po_lines ON supplier.po_lines (po_id);

-- Append-only PO history, mirroring application_events.
CREATE TABLE IF NOT EXISTS supplier.po_events (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id         uuid NOT NULL REFERENCES supplier.purchase_orders(id) ON DELETE CASCADE,
  event_type    varchar(30) NOT NULL
                CHECK (event_type IN ('created', 'issued', 'acknowledged', 'declined',
                                      'dispatched', 'received', 'closed', 'cancelled',
                                      'commented', 'amended')),
  from_status   varchar(20),
  to_status     varchar(20),
  message       text,
  is_public     boolean NOT NULL DEFAULT true,
  actor_user_id uuid REFERENCES supplier.users(id),
  actor_label   varchar(160),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_po_events
  ON supplier.po_events (po_id, created_at DESC);

-- ============================================================================
-- Goods receipts — what actually arrived, against what was ordered
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.goods_receipts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id         uuid NOT NULL REFERENCES supplier.purchase_orders(id) ON DELETE CASCADE,
  receipt_no    varchar(30) NOT NULL UNIQUE,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- The supplier's own delivery-receipt number, for reconciliation.
  supplier_dr_no varchar(60),
  received_by   uuid REFERENCES supplier.users(id),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_receipts_po ON supplier.goods_receipts (po_id);

CREATE TABLE IF NOT EXISTS supplier.goods_receipt_lines (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id    uuid NOT NULL REFERENCES supplier.goods_receipts(id) ON DELETE CASCADE,
  po_line_id    uuid NOT NULL REFERENCES supplier.po_lines(id)       ON DELETE RESTRICT,
  qty_received  numeric(18,3) NOT NULL CHECK (qty_received > 0),
  qty_rejected  numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_rejected >= 0),
  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_receipt_lines
  ON supplier.goods_receipt_lines (receipt_id);

-- ============================================================================
-- PO numbers: PO-YYYYMM-00123
-- ============================================================================
CREATE TABLE IF NOT EXISTS supplier.po_no_seq (
  period     varchar(6) PRIMARY KEY,   -- YYYYMM
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_po_no()
RETURNS varchar AS $$
DECLARE
  v_period varchar(6) := to_char(now(), 'YYYYMM');
  v_next   integer;
  v_no     varchar(30);
BEGIN
  INSERT INTO supplier.po_no_seq (period, last_value)
  VALUES (v_period, 1)
  ON CONFLICT (period) DO UPDATE
    SET last_value = supplier.po_no_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_no := 'PO-' || v_period || '-' || lpad(v_next::text, 5, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM supplier.purchase_orders WHERE po_no = v_no
    );
    v_next := v_next + 1;
    UPDATE supplier.po_no_seq SET last_value = v_next WHERE period = v_period;
  END LOOP;

  RETURN v_no;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS supplier.receipt_no_seq (
  period     varchar(6) PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION supplier.next_receipt_no()
RETURNS varchar AS $$
DECLARE
  v_period varchar(6) := to_char(now(), 'YYYYMM');
  v_next   integer;
  v_no     varchar(30);
BEGIN
  INSERT INTO supplier.receipt_no_seq (period, last_value)
  VALUES (v_period, 1)
  ON CONFLICT (period) DO UPDATE
    SET last_value = supplier.receipt_no_seq.last_value + 1
  RETURNING last_value INTO v_next;

  LOOP
    v_no := 'GR-' || v_period || '-' || lpad(v_next::text, 5, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM supplier.goods_receipts WHERE receipt_no = v_no
    );
    v_next := v_next + 1;
    UPDATE supplier.receipt_no_seq SET last_value = v_next WHERE period = v_period;
  END LOOP;

  RETURN v_no;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Totals. VAT is 12% of the vatable, post-discount base.
-- Prices are VAT-EXCLUSIVE.
-- ============================================================================
CREATE OR REPLACE FUNCTION supplier.recalc_po_totals(p_po_id uuid)
RETURNS void AS $$
DECLARE
  v_subtotal numeric(18,2) := 0;
  v_discount numeric(18,2) := 0;
  v_vatable  numeric(18,2) := 0;
BEGIN
  -- Keep each line's own total honest first.
  UPDATE supplier.po_lines
     SET line_total = round(qty_ordered * unit_price * (1 - discount_pct / 100.0), 2)
   WHERE po_id = p_po_id;

  SELECT
    COALESCE(SUM(round(qty_ordered * unit_price, 2)), 0),
    COALESCE(SUM(round(qty_ordered * unit_price * (discount_pct / 100.0), 2)), 0),
    COALESCE(SUM(CASE WHEN is_vatable THEN line_total ELSE 0 END), 0)
    INTO v_subtotal, v_discount, v_vatable
    FROM supplier.po_lines
   WHERE po_id = p_po_id;

  UPDATE supplier.purchase_orders
     SET subtotal       = v_subtotal,
         discount_total = v_discount,
         vat_total      = round(v_vatable * 0.12, 2),
         grand_total    = round(v_subtotal - v_discount + (v_vatable * 0.12), 2)
   WHERE id = p_po_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Applying a receipt: roll quantities up to the PO lines, move the PO's status
-- to partially_received / received, and update the supplier's delivery record.
--
-- Done in the database rather than the route so a receipt recorded by any path
-- keeps the PO, the lines and the supplier's on-time counters consistent.
-- ============================================================================
CREATE OR REPLACE FUNCTION supplier.apply_goods_receipt(p_receipt_id uuid)
RETURNS void AS $$
DECLARE
  v_po_id       uuid;
  v_supplier_id uuid;
  v_promised    date;
  v_received_at timestamptz;
  v_outstanding numeric(18,3);
BEGIN
  SELECT gr.po_id, gr.received_at INTO v_po_id, v_received_at
    FROM supplier.goods_receipts gr WHERE gr.id = p_receipt_id;
  IF v_po_id IS NULL THEN
    RAISE EXCEPTION 'Unknown receipt %', p_receipt_id;
  END IF;

  -- Accepted quantity only: rejected goods were never received.
  UPDATE supplier.po_lines pl
     SET qty_received = pl.qty_received + src.accepted
    FROM (
      SELECT grl.po_line_id, SUM(grl.qty_received - grl.qty_rejected) AS accepted
        FROM supplier.goods_receipt_lines grl
       WHERE grl.receipt_id = p_receipt_id
       GROUP BY grl.po_line_id
    ) AS src
   WHERE pl.id = src.po_line_id;

  SELECT COALESCE(SUM(GREATEST(qty_ordered - qty_received, 0)), 0)
    INTO v_outstanding
    FROM supplier.po_lines WHERE po_id = v_po_id;

  UPDATE supplier.purchase_orders
     SET status = CASE WHEN v_outstanding <= 0 THEN 'received' ELSE 'partially_received' END
   WHERE id = v_po_id
     -- Never drag a closed or cancelled PO back into an open state.
     AND status IN ('issued', 'acknowledged', 'in_transit', 'partially_received');

  -- Score the delivery once, when the PO becomes fully received.
  IF v_outstanding <= 0 THEN
    SELECT po.supplier_id, po.promised_date INTO v_supplier_id, v_promised
      FROM supplier.purchase_orders po WHERE po.id = v_po_id;

    IF v_promised IS NOT NULL THEN
      UPDATE supplier.suppliers
         SET on_time_deliveries = on_time_deliveries
               + CASE WHEN v_received_at::date <= v_promised THEN 1 ELSE 0 END,
             late_deliveries    = late_deliveries
               + CASE WHEN v_received_at::date >  v_promised THEN 1 ELSE 0 END
       WHERE id = v_supplier_id;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
