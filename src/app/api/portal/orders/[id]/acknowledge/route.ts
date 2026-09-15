import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { requireAccredited } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('acknowledge'),
    // The date the supplier can actually meet. Kept apart from our requested
    // date so slippage is recorded rather than overwritten.
    promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal('decline'),
    reason: z.string().min(1, 'Tell us why you cannot supply this order.').max(1000),
  }),
]);

/**
 * POST /api/portal/orders/:id/acknowledge
 *
 * The supplier's own action on a purchase order, and the reason this portal
 * exists: today a PO is emailed as a PDF and nobody knows whether it was seen.
 * This turns it into a commitment with a timestamp.
 *
 * Guarded by requireAccredited rather than requireSupplier — accepting a PO
 * creates a new commercial commitment, which a lapsed accreditation must not
 * permit. Reading orders stays open, so a supplier can still see history and
 * chase payment while renewing.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return err('Invalid request.', 400, {
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

    const { auth, supplier } = await requireAccredited(request);

    const po = await queryOne<{ id: string; status: string; po_no: string; requested_date: string | null }>(
      `SELECT id, status, po_no, requested_date
         FROM purchase_orders
        WHERE id = $1 AND supplier_id = $2 AND status <> 'draft'`,
      [params.id, supplier.id],
    );
    if (!po) return err('Purchase order not found.', 404);

    // Only an issued PO is awaiting an answer. Saying so explicitly beats a
    // generic 409, because "already acknowledged" and "cancelled by us" need
    // different reactions from the supplier.
    if (po.status !== 'issued') {
      const explanation: Record<string, string> = {
        acknowledged: 'This order has already been acknowledged.',
        in_transit: 'This order is already in transit.',
        partially_received: 'This order has already been partly received.',
        received: 'This order has already been received in full.',
        closed: 'This order is closed.',
        cancelled: 'This order was cancelled. Please contact the purchasing team.',
        declined: 'This order was already declined.',
      };
      return err(explanation[po.status] ?? `This order cannot be acknowledged (${po.status}).`, 409);
    }

    if (body.action === 'decline') {
      await transaction(async (client) => {
        await client.query(
          `UPDATE purchase_orders
              SET status = 'declined', decline_reason = $2,
                  acknowledged_by = $3, acknowledged_at = now()
            WHERE id = $1`,
          [po.id, body.reason, auth.userId],
        );
        await client.query(
          `INSERT INTO po_events
             (po_id, event_type, from_status, to_status, message, is_public, actor_user_id, actor_label)
           VALUES ($1, 'declined', 'issued', 'declined', $2, true, $3, $4)`,
          [po.id, body.reason, auth.userId, `${supplier.code} — ${auth.email}`],
        );
      });

      return ok({ id: po.id, status: 'declined' });
    }

    // A promised date before today is either a typo or a claim about the past;
    // either way purchasing cannot plan against it.
    const promised = new Date(`${body.promisedDate}T00:00:00Z`);
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    if (promised < today) {
      return err('The delivery date you promise cannot be in the past.', 400);
    }

    const late = po.requested_date ? body.promisedDate > po.requested_date : false;

    await transaction(async (client) => {
      await client.query(
        `UPDATE purchase_orders
            SET status = 'acknowledged', promised_date = $2,
                acknowledged_by = $3, acknowledged_at = now()
          WHERE id = $1`,
        [po.id, body.promisedDate, auth.userId],
      );

      await client.query(
        `INSERT INTO po_events
           (po_id, event_type, from_status, to_status, message, is_public,
            actor_user_id, actor_label, metadata)
         VALUES ($1, 'acknowledged', 'issued', 'acknowledged', $2, true, $3, $4, $5)`,
        [
          po.id,
          body.notes ?? null,
          auth.userId,
          `${supplier.code} — ${auth.email}`,
          // Recorded on the event so a later dispute about the date has a
          // source, and so purchasing can see the slip without a date diff.
          JSON.stringify({
            promisedDate: body.promisedDate,
            requestedDate: po.requested_date,
            laterThanRequested: late,
          }),
        ],
      );
    });

    return ok({
      id: po.id,
      status: 'acknowledged',
      promisedDate: body.promisedDate,
      // The UI warns on this rather than rejecting it: a late-but-honest date
      // is more useful than a date the supplier cannot meet.
      laterThanRequested: late,
    });
  },
);
