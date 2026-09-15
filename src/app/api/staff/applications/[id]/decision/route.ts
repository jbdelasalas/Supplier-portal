import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { requireStaff } from '@/lib/auth';
import { mapToSupplier, type FormSchema } from '@/lib/forms';
import { send, applicationApprovedMail, infoRequestedMail } from '@/lib/mail';

export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    notes: z.string().max(2000).optional(),
    // Commercial terms are the reviewer's call, never the applicant's — the
    // form only captures what the supplier ASKED for.
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    // Withholding tax rate as a percentage (1 for goods, 2 for services).
    ewtRate: z.number().min(0).max(100).optional(),
    // How long this accreditation is good for. Permits lapse, so an
    // accreditation without an expiry quietly becomes permanent.
    accreditationMonths: z.number().int().min(1).max(60).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    notes: z.string().min(1, 'A reason is required when rejecting.').max(2000),
  }),
  z.object({
    action: z.literal('request_info'),
    notes: z.string().min(1, 'Say what is needed.').max(2000),
  }),
  z.object({
    action: z.literal('start_review'),
    notes: z.string().max(2000).optional(),
  }),
]);

interface AppRow {
  id: string;
  company_id: string;
  status: string;
  data: Record<string, unknown>;
  business_name: string | null;
  category: string | null;
  applicant_user_id: string | null;
  applicant_email: string;
  applicant_name: string | null;
  applicant_phone: string | null;
  supplier_id: string | null;
  schema: FormSchema;
}

/** Default accreditation validity when the reviewer does not set one. */
const DEFAULT_ACCREDITATION_MONTHS = 12;

/**
 * POST /api/staff/applications/:id/decision
 *
 * Approving does four things in ONE transaction: create the supplier, link the
 * applicant's login to it, stamp the application, and notify. A partial apply
 * here would leave someone accredited but unable to log in, so it must be
 * all-or-nothing.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return err('Invalid decision.', 400, {
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

    // Approve/reject is a higher bar than commenting on an application.
    const permission =
      body.action === 'approve' || body.action === 'reject'
        ? 'application.approve'
        : 'application.review';
    const auth = await requireStaff(request, permission);

    const app = await queryOne<AppRow>(
      `SELECT a.id, a.company_id, a.status, a.data, a.business_name, a.category,
              a.applicant_user_id, a.applicant_email, a.applicant_name,
              a.applicant_phone, a.supplier_id, fv.schema
         FROM applications a
         JOIN form_versions fv ON fv.id = a.form_version_id
        WHERE a.id = $1`,
      [params.id],
    );
    if (!app) return err('Application not found.', 404);

    if (['approved', 'rejected', 'withdrawn'].includes(app.status)) {
      return err(`This application is already ${app.status}.`, 409);
    }
    if (app.status === 'draft') {
      return err('This application has not been submitted yet.', 409);
    }

    const actorLabel = auth.email;

    // ---- non-terminal transitions -----------------------------------------
    if (body.action === 'start_review' || body.action === 'request_info') {
      const toStatus = body.action === 'start_review' ? 'under_review' : 'info_requested';

      await transaction(async (client) => {
        await client.query(
          `UPDATE applications SET status = $2, reviewed_by = $3, reviewed_at = now()
            WHERE id = $1`,
          [app.id, toStatus, auth.userId],
        );
        await client.query(
          `INSERT INTO application_events
             (application_id, event_type, from_status, to_status, message, is_public, actor_user_id, actor_label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            app.id,
            body.action === 'start_review' ? 'assigned' : 'info_requested',
            app.status,
            toStatus,
            body.notes ?? null,
            body.action === 'request_info',
            auth.userId,
            actorLabel,
          ],
        );

        if (body.action === 'request_info' && app.applicant_user_id) {
          await client.query(
            `INSERT INTO notifications (user_id, category, title, body, link_url)
                  VALUES ($1, 'application', 'More information needed', $2, $3)`,
            [app.applicant_user_id, body.notes, `/apply/${app.id}`],
          );
        }
      });

      // Emailed after the transaction, so a provider outage cannot roll back
      // a decision that has already been recorded.
      if (body.action === 'request_info') {
        send(infoRequestedMail(app.applicant_email, body.notes, app.id)).catch(() => {});
      }

      return ok({ id: app.id, status: toStatus });
    }

    // ---- rejection ---------------------------------------------------------
    if (body.action === 'reject') {
      await transaction(async (client) => {
        await client.query(
          `UPDATE applications
              SET status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = $3
            WHERE id = $1`,
          [app.id, auth.userId, body.notes],
        );
        await client.query(
          `INSERT INTO application_events
             (application_id, event_type, from_status, to_status, message, is_public, actor_user_id, actor_label)
           VALUES ($1, 'rejected', $2, 'rejected', $3, true, $4, $5)`,
          [app.id, app.status, body.notes, auth.userId, actorLabel],
        );
        if (app.applicant_user_id) {
          await client.query(
            `INSERT INTO notifications (user_id, category, title, body, link_url)
                  VALUES ($1, 'application', 'Application not approved', $2, $3)`,
            [app.applicant_user_id, body.notes, `/apply/${app.id}`],
          );
        }
      });

      return ok({ id: app.id, status: 'rejected' });
    }

    // ---- approval ----------------------------------------------------------
    const patch = mapToSupplier(app.schema, app.data);

    // `name` is what the rest of the system displays; fall back through the
    // likely form fields so an accredited supplier is never nameless.
    const name =
      (patch.name as string) ??
      (patch.legal_name as string) ??
      app.business_name ??
      app.applicant_name ??
      app.applicant_email;

    const months = body.accreditationMonths ?? DEFAULT_ACCREDITATION_MONTHS;

    const result = await transaction(async (client) => {
      const codeRow = await client.query<{ next_supplier_code: string }>(
        'SELECT next_supplier_code($1)',
        [app.company_id],
      );
      const code = codeRow.rows[0].next_supplier_code;

      const columns = Object.keys(patch).filter((c) => c !== 'name');
      const values = columns.map((c) => patch[c]);

      // Build the insert from the schema-driven patch, with the fixed columns
      // first so their positions are stable.
      const fixed = ['company_id', 'code', 'name', 'application_id', 'created_by'];
      const fixedValues = [app.company_id, code, name, app.id, auth.userId];
      const allColumns = [...fixed, ...columns];
      const allValues = [...fixedValues, ...values];
      const placeholders = allColumns.map((_, i) => `$${i + 1}`).join(', ');

      const inserted = await client.query<{ id: string; code: string }>(
        `INSERT INTO suppliers (${allColumns.join(', ')})
              VALUES (${placeholders})
           RETURNING id, code`,
        allValues,
      );
      const supplierId = inserted.rows[0].id;

      // Terms, tax treatment and the accreditation window are all set here
      // rather than mapped from the form. The expiry is always stamped: an
      // accreditation with no end date silently never lapses.
      await client.query(
        `UPDATE suppliers
            SET payment_terms_days = COALESCE($2, payment_terms_days),
                ewt_rate           = COALESCE($3, ewt_rate),
                category           = COALESCE(category, $4),
                accredited_at      = now(),
                accreditation_expires_at = (current_date + make_interval(months => $5::int))::date
          WHERE id = $1`,
        [
          supplierId,
          body.paymentTermsDays ?? null,
          body.ewtRate ?? null,
          app.category,
          months,
        ],
      );

      // Seed a default pickup site from the application's addresses, so the
      // first PO has somewhere to collect from.
      const pickup = (patch.pickup_address as string) ?? (patch.business_address as string);
      if (pickup) {
        await client.query(
          `INSERT INTO supplier_sites
             (supplier_id, name, address, city, province, contact_person, phone, is_default)
                VALUES ($1, 'Main', $2, $3, $4, $5, $6, true)`,
          [
            supplierId,
            pickup,
            (patch.city as string) ?? null,
            (patch.province as string) ?? null,
            (patch.contact_person as string) ?? null,
            (patch.phone as string) ?? (patch.mobile as string) ?? null,
          ],
        );
      }

      await client.query(
        `UPDATE applications
            SET status = 'approved', decided_by = $2, decided_at = now(),
                decision_notes = $3, supplier_id = $4
          WHERE id = $1`,
        [app.id, auth.userId, body.notes ?? null, supplierId],
      );

      // This is the step that actually unlocks the portal for the applicant.
      if (app.applicant_user_id) {
        await client.query(
          `UPDATE users SET supplier_id = $2 WHERE id = $1 AND user_type = 'supplier'`,
          [app.applicant_user_id, supplierId],
        );
        await client.query(
          `INSERT INTO notifications (user_id, category, title, body, link_url)
                VALUES ($1, 'application', 'Your accreditation is approved',
                        'Your vendor code is ' || $2 ||
                        '. Quote it on every invoice and delivery receipt.',
                        '/portal')`,
          [app.applicant_user_id, inserted.rows[0].code],
        );
      }

      await client.query(
        `INSERT INTO application_events
           (application_id, event_type, from_status, to_status, message, is_public, actor_user_id, actor_label, metadata)
         VALUES ($1, 'approved', $2, 'approved', $3, true, $4, $5, $6)`,
        [
          app.id,
          app.status,
          body.notes ?? 'Application approved.',
          auth.userId,
          actorLabel,
          JSON.stringify({
            supplierId,
            supplierCode: inserted.rows[0].code,
            accreditationMonths: months,
          }),
        ],
      );

      return { supplierId, code: inserted.rows[0].code };
    });

    send(
      applicationApprovedMail(app.applicant_email, result.code, app.applicant_name ?? undefined),
    ).catch(() => {});

    return ok({
      id: app.id,
      status: 'approved',
      supplier: { id: result.supplierId, code: result.code, name },
    });
  },
);
