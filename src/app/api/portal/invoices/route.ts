import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireSupplier, requireAccredited } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/portal/invoices
 *
 * What the supplier has billed, what we approved, and what we owe — the answer
 * to the phone call this portal is meant to replace.
 */
export const GET = handler(async (request: NextRequest) => {
  const { supplier } = await requireSupplier(request);

  const bills = await query(
    `SELECT b.id, b.bill_no, b.supplier_invoice_no, b.invoice_date, b.due_date,
            b.currency, b.subtotal, b.vat_total, b.ewt_total, b.grand_total,
            b.amount_payable, b.amount_paid,
            (b.amount_payable - b.amount_paid) AS balance,
            b.status, b.match_status, b.dispute_reason, b.submitted_at, b.approved_at,
            po.po_no
       FROM bills b
       LEFT JOIN purchase_orders po ON po.id = b.po_id
      WHERE b.supplier_id = $1
      ORDER BY b.invoice_date DESC, b.created_at DESC
      LIMIT 200`,
    [supplier.id],
  );

  // match_notes names our internal quantities and is useful to the supplier
  // only once we have decided; while a bill is under review it would read as an
  // accusation before anyone has checked it.
  const balance = await queryOne(
    `SELECT total_outstanding, current_amt, overdue_1_30, overdue_31_60,
            overdue_61_90, overdue_over_90, open_bill_count
       FROM v_supplier_balances WHERE supplier_id = $1`,
    [supplier.id],
  );

  const payments = await query(
    `SELECT p.payment_no, p.payment_date, p.method, p.reference_no,
            p.currency, p.amount, p.status,
            COALESCE(
              array_agg(b.bill_no ORDER BY b.bill_no)
                FILTER (WHERE b.bill_no IS NOT NULL),
              '{}'
            ) AS settles
       FROM payments p
       LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
       LEFT JOIN bills b ON b.id = pa.bill_id
      WHERE p.supplier_id = $1 AND p.status = 'confirmed'
      GROUP BY p.id
      ORDER BY p.payment_date DESC
      LIMIT 100`,
    [supplier.id],
  );

  return ok({ invoices: bills, balance, payments });
});

const SubmitBody = z.object({
  poId: z.string().uuid().optional(),
  supplierInvoiceNo: z.string().min(1, 'Your invoice number is required.').max(60),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  lines: z
    .array(
      z.object({
        poLineId: z.string().uuid().optional(),
        description: z.string().min(1).max(300),
        uom: z.string().max(20).optional(),
        qty: z.number().gt(0, 'Quantity must be greater than zero.'),
        unitPrice: z.number().min(0),
        isVatable: z.boolean().optional(),
      }),
    )
    .min(1, 'An invoice needs at least one line.')
    .max(200),
});

/**
 * POST /api/portal/invoices
 *
 * The supplier submits an invoice. It arrives as 'submitted' — never as a
 * payable — and is checked against the purchase order and the goods actually
 * received before anyone can approve it.
 *
 * The match runs here, at submission, rather than waiting for a reviewer: the
 * supplier finds out immediately that they billed for more than they delivered,
 * which is far cheaper to fix than a dispute three weeks later. A mismatch is
 * recorded, not rejected — our own receiving records can be the thing that is
 * wrong, and refusing the invoice outright would leave the supplier no way to
 * raise that.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = SubmitBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid invoice.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { auth, supplier } = await requireAccredited(request);
  const body = parsed.data;

  // An invoice dated in the future is not yet a valid claim for payment.
  const today = new Date().toISOString().slice(0, 10);
  if (body.invoiceDate > today) {
    return err('An invoice cannot be dated in the future.', 400);
  }

  // The unique constraint would catch this, but a 409 with a clear message
  // beats a raw constraint violation — duplicate submissions are common when a
  // supplier is unsure the first one went through.
  const dupe = await queryOne<{ bill_no: string; status: string }>(
    `SELECT bill_no, status FROM bills
      WHERE supplier_id = $1 AND supplier_invoice_no = $2`,
    [supplier.id, body.supplierInvoiceNo],
  );
  if (dupe) {
    return err(
      `You have already submitted invoice ${body.supplierInvoiceNo} ` +
        `(our reference ${dupe.bill_no}, currently ${dupe.status}).`,
      409,
    );
  }

  // A PO, if given, must be one of ours and one this supplier may bill against.
  if (body.poId) {
    const po = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM purchase_orders
        WHERE id = $1 AND supplier_id = $2 AND status <> 'draft'`,
      [body.poId, supplier.id],
    );
    if (!po) return err('That purchase order was not found.', 404);
    if (['cancelled', 'declined'].includes(po.status)) {
      return err(`That purchase order was ${po.status} and cannot be invoiced.`, 409);
    }
  }

  // Every referenced PO line must belong to the PO being billed.
  const poLineIds = body.lines.map((l) => l.poLineId).filter((v): v is string => Boolean(v));
  if (poLineIds.length) {
    if (!body.poId) {
      return err('Name the purchase order these lines belong to.', 400);
    }
    const okLines = await query<{ id: string }>(
      `SELECT id FROM po_lines WHERE id = ANY($1::uuid[]) AND po_id = $2`,
      [poLineIds, body.poId],
    );
    if (okLines.length !== new Set(poLineIds).size) {
      return err('One or more invoice lines do not belong to that purchase order.', 400);
    }
  }

  const result = await transaction(async (client) => {
    const noRow = await client.query<{ next_bill_no: string }>('SELECT next_bill_no()');
    const billNo = noRow.rows[0].next_bill_no;

    const bill = await client.query<{ id: string }>(
      `INSERT INTO bills
         (company_id, supplier_id, po_id, bill_no, supplier_invoice_no,
          invoice_date, due_date, currency, status, submitted_by, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6::date,
               ($6::date + make_interval(days => $7::int))::date,
               $8, 'submitted', $9, now())
       RETURNING id`,
      [
        supplier.company_id,
        supplier.id,
        body.poId ?? null,
        billNo,
        body.supplierInvoiceNo,
        body.invoiceDate,
        supplier.payment_terms_days,
        supplier.currency,
        auth.userId,
      ],
    );
    const billId = bill.rows[0].id;

    let lineNo = 0;
    for (const l of body.lines) {
      lineNo += 1;
      await client.query(
        `INSERT INTO bill_lines
           (bill_id, po_line_id, line_no, description, uom, qty, unit_price, is_vatable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          billId,
          l.poLineId ?? null,
          lineNo,
          l.description,
          l.uom ?? null,
          l.qty,
          l.unitPrice,
          l.isVatable ?? true,
        ],
      );
    }

    // Totals first — the match compares the invoice total against the PO's.
    await client.query('SELECT recalc_bill_totals($1)', [billId]);
    const match = await client.query<{ check_bill_match: string | null }>(
      'SELECT check_bill_match($1)',
      [billId],
    );

    const totals = await client.query(
      `SELECT bill_no, subtotal, vat_total, ewt_total, grand_total,
              amount_payable, due_date, match_status
         FROM bills WHERE id = $1`,
      [billId],
    );

    return {
      id: billId,
      ...totals.rows[0],
      matchProblems: match.rows[0].check_bill_match,
    };
  });

  return ok(
    {
      invoice: result,
      // Surfaced plainly so the supplier can correct a genuine error now rather
      // than discovering it when payment does not arrive.
      warning: result.matchProblems
        ? 'Submitted, but it does not match our records. Our team will review it: ' +
          result.matchProblems
        : null,
    },
    201,
  );
});
