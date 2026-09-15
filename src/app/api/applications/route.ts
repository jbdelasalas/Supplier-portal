import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { validateSubmission, type FormSchema } from '@/lib/forms';

export const dynamic = 'force-dynamic';

/** GET /api/applications — the signed-in applicant's own applications. */
export const GET = handler(async (request: NextRequest) => {
  const auth = await requireAuth(request);

  const rows = await query(
    `SELECT a.id, a.reference_no, a.status, a.business_name,
            a.submitted_at, a.decided_at, a.decision_notes, a.created_at,
            a.supplier_id, co.name AS company_name
       FROM applications a
       JOIN companies co ON co.id = a.company_id
      WHERE a.applicant_user_id = $1
      ORDER BY a.created_at DESC`,
    [auth.userId],
  );

  return ok({ applications: rows });
});

const CreateBody = z.object({
  formVersionId: z.string().uuid(),
  data: z.record(z.unknown()).default({}),
});

/**
 * POST /api/applications — start a draft application.
 *
 * One open draft per applicant: calling this again returns the existing draft
 * rather than littering the review queue with abandoned shells.
 */
export const POST = handler(async (request: NextRequest) => {
  const auth = await requireAuth(request);
  if (auth.userType !== 'supplier') {
    return err('Only supplier accounts can file an accreditation application.', 403);
  }

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err('A valid formVersionId is required.', 400);

  const { formVersionId, data } = parsed.data;

  const existing = await queryOne<{ id: string; reference_no: string }>(
    `SELECT id, reference_no FROM applications
      WHERE applicant_user_id = $1 AND status = 'draft'
      ORDER BY created_at DESC LIMIT 1`,
    [auth.userId],
  );
  if (existing) {
    return ok({ id: existing.id, referenceNo: existing.reference_no, reused: true });
  }

  const version = await queryOne<{ id: string; schema: FormSchema; company_id: string }>(
    `SELECT fv.id, fv.schema, f.company_id
       FROM form_versions fv
       JOIN forms f ON f.id = fv.form_id
      WHERE fv.id = $1 AND fv.status = 'published'`,
    [formVersionId],
  );
  if (!version) return err('That form version is not available.', 404);

  // Drafts validate partially: catch bad values early, but let the applicant
  // save and come back.
  const errors = validateSubmission(version.schema, data, { partial: true });
  if (errors.length) return err('Some answers are invalid.', 422, { details: errors });

  const me = await queryOne<{ email: string; full_name: string; phone: string | null }>(
    'SELECT email, full_name, phone FROM users WHERE id = $1',
    [auth.userId],
  );

  const created = await transaction(async (client) => {
    const ref = await client.query<{ next_application_ref: string }>(
      'SELECT next_application_ref()',
    );
    const referenceNo = ref.rows[0].next_application_ref;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO applications
         (company_id, form_version_id, reference_no, applicant_user_id,
          applicant_email, applicant_name, applicant_phone, data, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       RETURNING id`,
      [
        version.company_id,
        formVersionId,
        referenceNo,
        auth.userId,
        me?.email ?? auth.email,
        me?.full_name ?? null,
        me?.phone ?? null,
        JSON.stringify(data),
      ],
    );

    await client.query(
      `INSERT INTO application_events (application_id, event_type, to_status, actor_user_id, actor_label)
            VALUES ($1, 'created', 'draft', $2, $3)`,
      [inserted.rows[0].id, auth.userId, me?.full_name ?? auth.email],
    );

    return { id: inserted.rows[0].id, referenceNo };
  });

  return ok({ ...created, reused: false }, 201);
});
