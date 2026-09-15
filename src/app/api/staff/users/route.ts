import type { NextRequest } from 'next/server';
import { ok, handler } from '@/lib/api';
import { query } from '@/lib/db';
import { requireStaff } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/staff/users — portal accounts, for finding the person who called in.
 *   ?q=acme       matches email, name or supplier code
 *   ?type=supplier|staff
 */
export const GET = handler(async (request: NextRequest) => {
  await requireStaff(request, 'user.manage');

  const sp = request.nextUrl.searchParams;
  const search = sp.get('q')?.trim() || null;
  const type = sp.get('type') === 'staff' ? 'staff' : sp.get('type') === 'supplier' ? 'supplier' : null;
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(sp.get('pageSize') ?? 25)));

  const users = await query(
    `SELECT u.id, u.email, u.full_name, u.phone, u.user_type, u.is_active,
            u.is_superadmin, u.must_change_password, u.last_login_at,
            u.locked_until, u.created_at, u.password_reset_at,
            c.code AS supplier_code, c.name AS supplier_name, c.status AS supplier_status,
            resetter.email AS password_reset_by_email
       FROM users u
       LEFT JOIN suppliers c    ON c.id = u.supplier_id
       LEFT JOIN users resetter ON resetter.id = u.password_reset_by
      WHERE ($1::text IS NULL OR (
              u.email      ILIKE '%' || $1 || '%'
           OR u.full_name  ILIKE '%' || $1 || '%'
           OR c.code       ILIKE '%' || $1 || '%'
           OR c.name       ILIKE '%' || $1 || '%'))
        AND ($2::text IS NULL OR u.user_type = $2)
      ORDER BY u.created_at DESC
      LIMIT $3 OFFSET $4`,
    [search, type, pageSize, (page - 1) * pageSize],
  );

  const counted = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM users u LEFT JOIN suppliers c ON c.id = u.supplier_id
      WHERE ($1::text IS NULL OR (
              u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%'
           OR c.code ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%'))
        AND ($2::text IS NULL OR u.user_type = $2)`,
    [search, type],
  );

  return ok({ users, page, pageSize, total: Number(counted[0]?.count ?? 0) });
});
