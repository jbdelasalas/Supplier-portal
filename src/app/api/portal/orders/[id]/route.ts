import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { queryOne, query } from '@/lib/db';
import { requireSupplier } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface PoDetail {
  id: string;
  po_no: string;
  status: string;
  ship_to_address: string | null;
  requested_date: string | null;
  promised_date: string | null;
  currency: string;
  payment_terms_days: number;
  subtotal: string;
  discount_total: string;
  vat_total: string;
  grand_total: string;
  notes: string | null;
  issued_at: string | null;
  acknowledged_at: string | null;
  decline_reason: string | null;
}

/**
 * GET /api/portal/orders/:id
 *
 * One purchase order with its lines and public history.
 *
 * The supplier_id in the WHERE clause is the access check — a wrong id returns
 * 404 rather than 403, so this cannot be used to discover that a PO exists.
 * `internal_notes` is deliberately not selected: it is where purchasing records
 * its own commentary about the supplier.
 */
export const GET = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const { supplier } = await requireSupplier(request);

    const po = await queryOne<PoDetail>(
      `SELECT id, po_no, status, ship_to_address, requested_date, promised_date,
              currency, payment_terms_days, subtotal, discount_total, vat_total,
              grand_total, notes, issued_at, acknowledged_at, decline_reason
         FROM purchase_orders
        WHERE id = $1 AND supplier_id = $2 AND status <> 'draft'`,
      [params.id, supplier.id],
    );
    if (!po) return err('Purchase order not found.', 404);

    const lines = await query(
      `SELECT pl.id, pl.line_no, pl.description, pl.uom,
              pl.qty_ordered, pl.qty_received, pl.unit_price,
              pl.discount_pct, pl.is_vatable, pl.line_total,
              i.sku
         FROM po_lines pl
         LEFT JOIN items i ON i.id = pl.item_id
        WHERE pl.po_id = $1
        ORDER BY pl.line_no`,
      [po.id],
    );

    // Only public events: the internal review trail stays internal.
    const events = await query(
      `SELECT event_type, from_status, to_status, message, actor_label, created_at
         FROM po_events
        WHERE po_id = $1 AND is_public
        ORDER BY created_at DESC`,
      [po.id],
    );

    const receipts = await query(
      `SELECT gr.receipt_no, gr.received_at, gr.supplier_dr_no,
              COALESCE(sum(grl.qty_received), 0) AS qty_received,
              COALESCE(sum(grl.qty_rejected), 0) AS qty_rejected
         FROM goods_receipts gr
         LEFT JOIN goods_receipt_lines grl ON grl.receipt_id = gr.id
        WHERE gr.po_id = $1
        GROUP BY gr.id
        ORDER BY gr.received_at DESC`,
      [po.id],
    );

    return ok({ order: po, lines, events, receipts });
  },
);
