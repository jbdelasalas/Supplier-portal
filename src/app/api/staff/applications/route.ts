import type { NextRequest } from 'next/server';
import { ok, handler } from '@/lib/api';
import { query } from '@/lib/db';
import { requireStaff } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = [
  'draft', 'submitted', 'under_review', 'info_requested',
  'approved', 'rejected', 'withdrawn',
];

/**
 * GET /api/staff/applications — the review queue.
 *   ?status=submitted,under_review   default: everything awaiting action
 *   ?q=acme                          matches reference no, business name, email
 *   ?page=1&pageSize=25
 */
export const GET = handler(async (request: NextRequest) => {
  await requireStaff(request, 'application.view');

  const sp = request.nextUrl.searchParams;
  const statuses = (sp.get('status') ?? 'submitted,under_review,info_requested')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => VALID_STATUSES.includes(s));

  const search = sp.get('q')?.trim() || null;
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(sp.get('pageSize') ?? 25)));
  const offset = (page - 1) * pageSize;

  const where = `
    WHERE ($1::text[] IS NULL OR a.status = ANY($1))
      AND ($2::text IS NULL OR (
            a.reference_no ILIKE '%' || $2 || '%'
         OR a.business_name ILIKE '%' || $2 || '%'
         OR a.applicant_email ILIKE '%' || $2 || '%'))
  `;

  const rows = await query(
    `SELECT a.id, a.reference_no, a.status, a.business_name,
            a.applicant_email, a.applicant_name, a.submitted_at, a.created_at,
            a.supplier_id, co.name AS company_name,
            reviewer.full_name AS reviewed_by_name,
            (SELECT count(*) FROM application_documents d WHERE d.application_id = a.id) AS document_count
       FROM applications a
       JOIN companies co     ON co.id = a.company_id
       LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
       ${where}
      ORDER BY a.submitted_at DESC NULLS LAST, a.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}`,
    [statuses.length ? statuses : null, search],
  );

  const counted = await query<{ count: string }>(
    `SELECT count(*) FROM applications a ${where}`,
    [statuses.length ? statuses : null, search],
  );

  // Queue badges, independent of the current filter.
  const summary = await query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM applications GROUP BY status`,
  );

  return ok({
    applications: rows,
    page,
    pageSize,
    total: Number(counted[0]?.count ?? 0),
    summary: Object.fromEntries(summary.map((s) => [s.status, Number(s.count)])),
  });
});
