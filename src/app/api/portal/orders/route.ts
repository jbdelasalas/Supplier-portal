import type { NextRequest } from 'next/server';
import { ok, handler } from '@/lib/api';
import { query } from '@/lib/db';
import { requireSupplier } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface PoRow {
  id: string;
  po_no: string;
  status: string;
  requested_date: string | null;
  promised_date: string | null;
  currency: string;
  grand_total: string;
  issued_at: string | null;
  acknowledged_at: string | null;
  line_count: number;
  qty_ordered: string;
  qty_received: string;
}

/**
 * GET /api/portal/orders
 *
 * The purchase orders issued to the signed-in supplier.
 *
 * Scoped by requireSupplier's id, never by a query parameter — a supplier must
 * not be able to read another's orders by changing a URL, and quoted prices on
 * a PO are commercially sensitive.
 *
 * Drafts are excluded: a PO we have not issued yet is an internal working
 * document, and showing one would leak an intention to buy before we commit.
 */
export const GET = handler(async (request: NextRequest) => {
  const { supplier } = await requireSupplier(request);

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  const rows = await query<PoRow>(
    `SELECT po.id, po.po_no, po.status, po.requested_date, po.promised_date,
            po.currency, po.grand_total, po.issued_at, po.acknowledged_at,
            count(pl.id)::int                     AS line_count,
            COALESCE(sum(pl.qty_ordered), 0)      AS qty_ordered,
            COALESCE(sum(pl.qty_received), 0)     AS qty_received
       FROM purchase_orders po
       LEFT JOIN po_lines pl ON pl.po_id = po.id
      WHERE po.supplier_id = $1
        AND po.status <> 'draft'
        AND ($2::text IS NULL OR po.status = $2)
      GROUP BY po.id
      ORDER BY COALESCE(po.issued_at, po.created_at) DESC
      LIMIT $3`,
    [supplier.id, status, limit],
  );

  // Surfaced separately so the UI can lead with what needs an action rather
  // than making the supplier scan a list for it.
  const awaitingAck = rows.filter((r) => r.status === 'issued').length;

  return ok({
    orders: rows,
    awaitingAcknowledgement: awaitingAck,
    supplier: { code: supplier.code, name: supplier.name },
  });
});
