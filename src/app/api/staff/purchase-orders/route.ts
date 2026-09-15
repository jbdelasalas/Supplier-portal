import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireStaff } from '@/lib/auth';
import { send, poIssuedMail } from '@/lib/mail';

export const dynamic = 'force-dynamic';

/** GET /api/staff/purchase-orders — the purchasing queue. */
export const GET = handler(async (request: NextRequest) => {
  await requireStaff(request, 'po.view');

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const supplierId = url.searchParams.get('supplierId');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);

  const rows = await query(
    `SELECT po.id, po.po_no, po.status, po.requested_date, po.promised_date,
            po.currency, po.grand_total, po.issued_at, po.acknowledged_at,
            s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
            count(pl.id)::int AS line_count
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN po_lines pl ON pl.po_id = po.id
      WHERE ($1::text IS NULL OR po.status = $1)
        AND ($2::uuid IS NULL OR po.supplier_id = $2)
      GROUP BY po.id, s.id
      ORDER BY po.created_at DESC
      LIMIT $3`,
    [status, supplierId, limit],
  );

  return ok({ orders: rows });
});

const CreateBody = z.object({
  supplierId: z.string().uuid(),
  shipToAddress: z.string().max(2000).optional(),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(2000).optional(),
  /** Issue immediately, or leave as a draft to review first. */
  issue: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        description: z.string().max(300).optional(),
        uom: z.string().max(20).optional(),
        qtyOrdered: z.number().gt(0, 'Quantity must be greater than zero.'),
        /** Omit to use the supplier's approved price for the item. */
        unitPrice: z.number().min(0).optional(),
        discountPct: z.number().min(0).max(100).optional(),
        isVatable: z.boolean().optional(),
      }),
    )
    .min(1, 'A purchase order needs at least one line.')
    .max(200),
});

/**
 * POST /api/staff/purchase-orders
 *
 * Creates a purchase order and optionally issues it.
 *
 * Line prices come from the supplier's APPROVED price list by default, and the
 * price row that supplied each one is recorded on the line — so "why did we pay
 * that?" has an answer months later. An explicit unitPrice is allowed (phone
 * quotes and one-off buys exist) but requires po.issue, not merely po.view.
 *
 * A supplier whose accreditation has lapsed cannot be issued a new PO: the
 * whole point of an expiry is that it stops new commitments.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid purchase order.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const auth = await requireStaff(request, 'po.issue');
  const body = parsed.data;

  const supplier = await queryOne<{
    id: string;
    company_id: string;
    code: string;
    name: string;
    email: string | null;
    status: string;
    currency: string;
    payment_terms_days: number;
    expired: boolean;
  }>(
    `SELECT id, company_id, code, name, email, status, currency, payment_terms_days,
            (accreditation_expires_at IS NOT NULL
              AND accreditation_expires_at < current_date) AS expired
       FROM suppliers WHERE id = $1`,
    [body.supplierId],
  );
  if (!supplier) return err('Supplier not found.', 404);

  if (supplier.status !== 'active') {
    return err(
      `${supplier.name} is ${supplier.status} and cannot be issued a purchase order.`,
      409,
    );
  }
  if (supplier.expired) {
    return err(
      `${supplier.name}'s accreditation has expired. Renew it before issuing a purchase order.`,
      409,
    );
  }

  // Resolve items and their prices up front so a bad line fails before we
  // burn a PO number.
  const itemIds = body.lines.map((l) => l.itemId);
  const items = await query<{ id: string; sku: string; name: string; uom: string; price: string | null }>(
    `SELECT i.id, i.sku, i.name, i.uom,
            effective_cost($2, i.id) AS price
       FROM items i
      WHERE i.id = ANY($1::uuid[]) AND i.company_id = $3 AND i.is_active`,
    [itemIds, supplier.id, supplier.company_id],
  );
  const byId = new Map(items.map((i) => [i.id, i]));

  const unpriced: string[] = [];
  for (const l of body.lines) {
    const item = byId.get(l.itemId);
    if (!item) return err('One or more items are not available to order.', 400);
    if (l.unitPrice === undefined && item.price === null) {
      unpriced.push(`${item.sku} — ${item.name}`);
    }
  }
  if (unpriced.length) {
    return err(
      'These items have no approved price from this supplier. Approve a price first, ' +
        'or give an explicit unit price: ' +
        unpriced.join('; '),
      400,
    );
  }

  const result = await transaction(async (client) => {
    const noRow = await client.query<{ next_po_no: string }>('SELECT next_po_no()');
    const poNo = noRow.rows[0].next_po_no;
    const issuing = body.issue === true;

    const po = await client.query<{ id: string }>(
      `INSERT INTO purchase_orders
         (company_id, supplier_id, po_no, status, ship_to_address, requested_date,
          currency, payment_terms_days, notes, internal_notes,
          created_by, issued_by, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11,
               CASE WHEN $4 = 'issued' THEN $11 ELSE NULL END,
               CASE WHEN $4 = 'issued' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        supplier.company_id,
        supplier.id,
        poNo,
        issuing ? 'issued' : 'draft',
        body.shipToAddress ?? null,
        body.requestedDate ?? null,
        supplier.currency,
        supplier.payment_terms_days,
        body.notes ?? null,
        body.internalNotes ?? null,
        auth.userId,
      ],
    );
    const poId = po.rows[0].id;

    let lineNo = 0;
    for (const l of body.lines) {
      const item = byId.get(l.itemId)!;
      lineNo += 1;

      // Record WHICH approved price row produced this line's unit price, so the
      // number on the PO can be traced back to a decision.
      const priceRow =
        l.unitPrice === undefined
          ? await client.query<{ id: string }>(
              `SELECT id FROM supplier_prices
                WHERE supplier_id = $1 AND item_id = $2 AND status = 'approved'
                  AND valid_from <= current_date
                  AND (valid_to IS NULL OR valid_to >= current_date)
                ORDER BY valid_from DESC LIMIT 1`,
              [supplier.id, l.itemId],
            )
          : { rows: [] as { id: string }[] };

      await client.query(
        `INSERT INTO po_lines
           (po_id, item_id, line_no, description, uom, qty_ordered,
            unit_price, discount_pct, is_vatable, price_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          poId,
          l.itemId,
          lineNo,
          // Snapshotted so the PO still reads correctly if the item is renamed.
          l.description ?? `${item.sku} — ${item.name}`,
          l.uom ?? item.uom,
          l.qtyOrdered,
          l.unitPrice ?? Number(item.price),
          l.discountPct ?? 0,
          l.isVatable ?? true,
          priceRow.rows[0]?.id ?? null,
        ],
      );
    }

    await client.query('SELECT recalc_po_totals($1)', [poId]);

    await client.query(
      `INSERT INTO po_events
         (po_id, event_type, to_status, message, is_public, actor_user_id, actor_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        poId,
        issuing ? 'issued' : 'created',
        issuing ? 'issued' : 'draft',
        body.notes ?? null,
        issuing,
        auth.userId,
        auth.email,
      ],
    );

    const totals = await client.query(
      `SELECT po_no, status, subtotal, vat_total, grand_total, requested_date
         FROM purchase_orders WHERE id = $1`,
      [poId],
    );

    return { id: poId, issuing, ...totals.rows[0] };
  });

  // Mailed after the transaction: a provider outage must not roll back a PO
  // that has already been issued.
  if (result.issuing && supplier.email) {
    send(
      poIssuedMail(
        supplier.email,
        result.po_no as string,
        (result.requested_date as string) ?? null,
        result.id,
        supplier.name,
      ),
    ).catch(() => {});
  }

  return ok({ order: result }, 201);
});
