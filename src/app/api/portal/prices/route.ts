import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, transaction } from '@/lib/db';
import { requireSupplier, requireAccredited } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portal/prices
 *
 * The supplier's own price list — what they proposed, what we approved, and
 * what is still pending. Scoped to their supplier_id: a supplier seeing a
 * competitor's quoted prices would be a commercial injury, not just a privacy
 * one, so this never accepts a supplier id from the caller.
 */
export const GET = handler(async (request: NextRequest) => {
  const { supplier } = await requireSupplier(request);

  const rows = await query(
    `SELECT sp.id, sp.unit_price, sp.currency, sp.uom, sp.min_qty,
            sp.lead_time_days, sp.valid_from, sp.valid_to, sp.status,
            sp.decision_notes, sp.proposed_at, sp.decided_at,
            i.id AS item_id, i.sku, i.name AS item_name, i.uom AS item_uom
       FROM supplier_prices sp
       JOIN items i ON i.id = sp.item_id
      WHERE sp.supplier_id = $1
      ORDER BY i.name, sp.valid_from DESC`,
    [supplier.id],
  );

  // The items we buy that this supplier has not quoted yet — the actionable
  // half of the screen.
  const unquoted = await query(
    `SELECT i.id, i.sku, i.name, i.uom, i.category
       FROM items i
      WHERE i.company_id = $1
        AND i.is_active
        AND NOT EXISTS (
          SELECT 1 FROM supplier_prices sp
           WHERE sp.item_id = i.id
             AND sp.supplier_id = $2
             AND sp.status IN ('proposed', 'approved')
             AND (sp.valid_to IS NULL OR sp.valid_to >= current_date)
        )
      ORDER BY i.name`,
    [supplier.company_id, supplier.id],
  );

  return ok({ prices: rows, unquotedItems: unquoted });
});

const ProposeBody = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        unitPrice: z.number().min(0, 'A price cannot be negative.'),
        uom: z.string().max(20).optional(),
        minQty: z.number().min(0).optional(),
        leadTimeDays: z.number().int().min(0).max(365).optional(),
        validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
    )
    .min(1, 'Quote at least one item.')
    .max(200, 'Submit at most 200 items at a time.'),
});

/**
 * POST /api/portal/prices
 *
 * The supplier proposes prices; staff approve them separately. Nothing here can
 * set status — a proposed row is inert until someone with pricing.approve acts
 * on it, so this endpoint cannot be used to price a PO.
 *
 * Re-quoting an item supersedes the supplier's own previous PROPOSED row rather
 * than stacking a second one. An already-approved price is left alone: it may
 * be priced into an open PO, and withdrawing it retroactively would change what
 * that PO agreed. The new row simply waits for a decision alongside it.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = ProposeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid price list.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { auth, supplier } = await requireAccredited(request);
  const { items } = parsed.data;

  // Reject duplicates in the payload rather than letting the last one silently
  // win — a spreadsheet paste with the same item twice is a mistake worth
  // showing the supplier.
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.itemId)) {
      return err('The same item appears more than once in this submission.', 400);
    }
    seen.add(it.itemId);
  }

  for (const it of items) {
    if (it.validTo && it.validFrom && it.validTo < it.validFrom) {
      return err('A price cannot expire before it starts.', 400);
    }
  }

  // Every item must belong to this supplier's company. Without this check a
  // guessed uuid could attach a price to another company's item.
  const ids = items.map((i) => i.itemId);
  const valid = await query<{ id: string }>(
    `SELECT id FROM items WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active`,
    [ids, supplier.company_id],
  );
  if (valid.length !== ids.length) {
    return err('One or more items are not available to quote.', 400);
  }

  const inserted = await transaction(async (client) => {
    const out: { itemId: string; priceId: string }[] = [];

    for (const it of items) {
      // Supersede this supplier's earlier pending proposal for the same item.
      await client.query(
        `UPDATE supplier_prices
            SET status = 'superseded'
          WHERE supplier_id = $1 AND item_id = $2 AND status = 'proposed'`,
        [supplier.id, it.itemId],
      );

      const row = await client.query<{ id: string }>(
        `INSERT INTO supplier_prices
           (supplier_id, item_id, unit_price, currency, uom, min_qty,
            lead_time_days, valid_from, valid_to, status, proposed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 COALESCE($8::date, current_date), $9::date, 'proposed', $10)
         RETURNING id`,
        [
          supplier.id,
          it.itemId,
          it.unitPrice,
          supplier.currency,
          it.uom ?? null,
          it.minQty ?? null,
          it.leadTimeDays ?? null,
          it.validFrom ?? null,
          it.validTo ?? null,
          auth.userId,
        ],
      );
      out.push({ itemId: it.itemId, priceId: row.rows[0].id });
    }

    return out;
  });

  return ok(
    {
      submitted: inserted.length,
      prices: inserted,
      message: 'Your prices have been submitted for approval.',
    },
    201,
  );
});
