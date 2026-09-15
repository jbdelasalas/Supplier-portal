import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { requireAuth, hasPermission, type AuthContext } from '@/lib/auth';
import { validateSubmission, type FormSchema } from '@/lib/forms';

export const dynamic = 'force-dynamic';

interface ApplicationRow {
  id: string;
  reference_no: string;
  status: string;
  data: Record<string, unknown>;
  business_name: string | null;
  applicant_user_id: string | null;
  applicant_email: string;
  submitted_at: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  supplier_id: string | null;
  created_at: string;
  reopen_count: number;
  schema: FormSchema;
  version: number;
  company_name: string;
}

/**
 * Loads an application and enforces who may see it: the applicant who owns it,
 * or staff holding application.view. Everyone else gets a 404 rather than a
 * 403, so the endpoint doesn't confirm that a reference number exists.
 */
async function loadForActor(id: string, auth: AuthContext): Promise<ApplicationRow> {
  const row = await queryOne<ApplicationRow>(
    `SELECT a.id, a.reference_no, a.status, a.data, a.business_name,
            a.applicant_user_id, a.applicant_email, a.submitted_at,
            a.decided_at, a.decision_notes, a.supplier_id, a.created_at,
            a.reopen_count, fv.schema, fv.version, co.name AS company_name
       FROM applications a
       JOIN form_versions fv ON fv.id = a.form_version_id
       JOIN companies co     ON co.id = a.company_id
      WHERE a.id = $1`,
    [id],
  );
  if (!row) throw err('Application not found.', 404);

  const isOwner = row.applicant_user_id === auth.userId;
  const isReviewer = auth.userType === 'staff' && hasPermission(auth, 'application.view');
  if (!isOwner && !isReviewer) throw err('Application not found.', 404);

  return row;
}

export const GET = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);
    const app = await loadForActor(params.id, auth);

    const documents = await query(
      `SELECT id, doc_key, file_name, content_type, size_bytes, status, uploaded_at,
              capture_source, captured_at, latitude, longitude, location_accuracy_m
         FROM application_documents WHERE application_id = $1
        ORDER BY uploaded_at`,
      [app.id],
    );

    // Applicants see only the public trail; staff see internal notes too.
    const isStaff = auth.userType === 'staff';
    const events = await query(
      `SELECT id, event_type, from_status, to_status, message, is_public,
              actor_label, created_at
         FROM application_events
        WHERE application_id = $1 AND ($2::boolean OR is_public)
        ORDER BY created_at`,
      [app.id, isStaff],
    );

    return ok({
      application: {
        id: app.id,
        referenceNo: app.reference_no,
        status: app.status,
        data: app.data,
        businessName: app.business_name,
        applicantEmail: app.applicant_email,
        submittedAt: app.submitted_at,
        decidedAt: app.decided_at,
        decisionNotes: app.decision_notes,
        supplierId: app.supplier_id,
        createdAt: app.created_at,
        companyName: app.company_name,
        reopenCount: app.reopen_count,
      },
      form: { schema: app.schema, version: app.version },
      documents,
      events,
    });
  },
);

const PatchBody = z.object({ data: z.record(z.unknown()) });

/** PATCH — save draft answers. Only the applicant, only while editable. */
export const PATCH = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);
    const app = await loadForActor(params.id, auth);

    if (app.applicant_user_id !== auth.userId) {
      return err('Only the applicant can edit this application.', 403);
    }
    // 'info_requested' is editable so an applicant can answer a reviewer's query.
    if (!['draft', 'info_requested'].includes(app.status)) {
      return err(`An application that is ${app.status} can no longer be edited.`, 409);
    }

    const parsed = PatchBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return err('A data object is required.', 400);

    const merged = { ...app.data, ...parsed.data.data };
    const errors = validateSubmission(app.schema, merged, { partial: true });
    if (errors.length) return err('Some answers are invalid.', 422, { details: errors });

    await queryOne(
      `UPDATE applications SET data = $2 WHERE id = $1`,
      [app.id, JSON.stringify(merged)],
    );

    return ok({ id: app.id, data: merged, saved: true });
  },
);
