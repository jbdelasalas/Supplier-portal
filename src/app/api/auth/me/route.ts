import type { NextRequest } from 'next/server';
import { ok, handler } from '@/lib/api';
import { queryOne } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface MeRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  user_type: 'supplier' | 'staff';
  supplier_id: string | null;
  is_superadmin: boolean;
  email_verified_at: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  supplier_status: string | null;
}

/** The session bootstrap every page calls on load. */
export const GET = handler(async (request: NextRequest) => {
  const auth = await requireAuth(request);

  const row = await queryOne<MeRow>(
    `SELECT u.id, u.email, u.full_name, u.phone, u.user_type, u.supplier_id,
            u.is_superadmin, u.email_verified_at,
            c.code AS supplier_code, c.name AS supplier_name, c.status AS supplier_status
       FROM users u
       LEFT JOIN suppliers c ON c.id = u.supplier_id
      WHERE u.id = $1 AND u.is_active`,
    [auth.userId],
  );

  if (!row) {
    return ok({ user: null }, 401);
  }

  // A supplier with no linked supplier record is mid-onboarding: tell the UI
  // where to send them.
  const pendingApplication =
    row.user_type === 'supplier' && !row.supplier_id
      ? await queryOne<{ id: string; reference_no: string; status: string }>(
          `SELECT id, reference_no, status FROM applications
            WHERE applicant_user_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [auth.userId],
        )
      : null;

  return ok({
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone,
      userType: row.user_type,
      isSuperadmin: row.is_superadmin,
      emailVerified: Boolean(row.email_verified_at),
      permissions: auth.permissions,
      supplier: row.supplier_id
        ? { id: row.supplier_id, code: row.supplier_code, name: row.supplier_name, status: row.supplier_status }
        : null,
    },
    application: pendingApplication,
  });
});
