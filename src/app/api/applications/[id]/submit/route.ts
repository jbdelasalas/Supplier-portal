import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { validateSubmission, missingDocuments, missingPhotos, type FormSchema } from '@/lib/forms';

export const dynamic = 'force-dynamic';

/**
 * POST /api/applications/:id/submit — hand the application to the review queue.
 *
 * This is where validation turns strict: every required field and every
 * required document must be present.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);

    const app = await queryOne<{
      id: string;
      status: string;
      data: Record<string, unknown>;
      applicant_user_id: string | null;
      schema: FormSchema;
    }>(
      `SELECT a.id, a.status, a.data, a.applicant_user_id, fv.schema
         FROM applications a
         JOIN form_versions fv ON fv.id = a.form_version_id
        WHERE a.id = $1`,
      [params.id],
    );

    if (!app || app.applicant_user_id !== auth.userId) {
      return err('Application not found.', 404);
    }
    if (!['draft', 'info_requested'].includes(app.status)) {
      return err(`This application is already ${app.status}.`, 409);
    }

    const errors = validateSubmission(app.schema, app.data);
    if (errors.length) {
      return err('Please complete all required fields before submitting.', 422, {
        details: errors,
      });
    }

    const uploaded = await query<{ doc_key: string }>(
      `SELECT DISTINCT doc_key FROM application_documents
        WHERE application_id = $1 AND status <> 'rejected'`,
      [app.id],
    );
    const present = uploaded.map((d) => d.doc_key);

    // Documents and photos share a table, so one query serves both checks.
    const missing = [
      ...missingDocuments(app.schema, present).map((d) => ({
        field: d.key,
        message: `${d.label} is required.`,
      })),
      ...missingPhotos(app.schema, present).map((p) => ({
        field: p.key,
        message: `${p.label} is required.`,
      })),
    ];
    if (missing.length) {
      return err('Some required documents or photos are missing.', 422, { details: missing });
    }

    // The signature is the applicant's assent to the declaration; without it
    // there is nothing to hold them to.
    if (app.schema.signature?.required) {
      const signed = await queryOne<{ id: string }>(
        `SELECT id FROM application_signatures
          WHERE application_id = $1 AND signature_key = $2`,
        [app.id, app.schema.signature.key],
      );
      if (!signed) {
        return err('Please sign the declaration before submitting.', 422, {
          details: [{ field: 'signature', message: `${app.schema.signature.label} is required.` }],
        });
      }
    }

    // Denormalise a display name for the review queue from whichever field
    // the schema mapped to the supplier name.
    const businessName =
      (app.data.legal_name as string) ??
      (app.data.business_name as string) ??
      (app.data.trade_name as string) ??
      null;

    const result = await transaction(async (client) => {
      const updated = await client.query<{ reference_no: string; submitted_at: string }>(
        `UPDATE applications
            SET status = 'submitted', submitted_at = now(), business_name = $2
          WHERE id = $1
          RETURNING reference_no, submitted_at`,
        [app.id, businessName],
      );

      await client.query(
        `INSERT INTO application_events
           (application_id, event_type, from_status, to_status, message, is_public, actor_user_id)
         VALUES ($1, 'submitted', $2, 'submitted', $3, true, $4)`,
        [app.id, app.status, 'Application submitted for review.', auth.userId],
      );

      // Tell every reviewer who can act on it.
      await client.query(
        `INSERT INTO notifications (user_id, title, body, category, link_url)
         SELECT DISTINCT u.id,
                'New supplier application',
                COALESCE($2, 'An application') || ' was submitted for review.',
                'application',
                '/staff/applications/' || $1::text
           FROM users u
           JOIN user_roles ur        ON ur.user_id = u.id
           JOIN role_permissions rp  ON rp.role_id = ur.role_id
           JOIN permissions p        ON p.id = rp.permission_id
          WHERE u.is_active AND u.user_type = 'staff'
            AND p.code = 'application.review'`,
        [app.id, businessName],
      );

      return updated.rows[0];
    });

    return ok({
      id: app.id,
      referenceNo: result.reference_no,
      status: 'submitted',
      submittedAt: result.submitted_at,
    });
  },
);
