import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import {
  verifyPassword,
  newOpaqueToken,
  signAccess,
  setAuthCookies,
  loadPermissions,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  user_type: 'supplier' | 'staff';
  supplier_id: string | null;
  is_active: boolean;
  must_change_password: boolean;
  is_superadmin: boolean;
  failed_logins: number;
  locked_until: string | null;
}

export const POST = handler(async (request: NextRequest) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err('Email and password are required.', 400);

  const { email, password } = parsed.data;

  const user = await queryOne<UserRow>(
    `SELECT id, email, password_hash, full_name, user_type, supplier_id,
            is_active, is_superadmin, failed_logins, locked_until,
            must_change_password
       FROM users WHERE email = $1`,
    [email],
  );

  // One message for every failure mode, so this can't be used to enumerate
  // which emails exist.
  const invalid = () => err('Invalid email or password.', 401);

  if (!user) {
    // Constant-ish work even for unknown emails, to avoid a timing oracle.
    await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu');
    return invalid();
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return err(`Account temporarily locked. Try again in ${LOCK_MINUTES} minutes.`, 423);
  }

  if (!user.is_active) return err('This account has been deactivated.', 403);

  const good = await verifyPassword(password, user.password_hash);
  if (!good) {
    const failed = user.failed_logins + 1;
    // Every parameter is cast explicitly. Without the casts Postgres sees $2
    // used both as an integer and inside a string concatenation and refuses
    // with "inconsistent types deduced for parameter $2" — which made this
    // whole branch throw, so lockout never actually engaged.
    await queryOne(
      `UPDATE users
          SET failed_logins = $2::int,
              locked_until = CASE
                WHEN $2::int >= $3::int
                  THEN now() + make_interval(mins => $4::int)
                ELSE NULL
              END
        WHERE id = $1::uuid`,
      [user.id, failed, MAX_FAILED, LOCK_MINUTES],
    );
    return invalid();
  }

  const permissions =
    user.user_type === 'staff' ? await loadPermissions(user.id) : [];

  const refreshToken = await transaction(async (client) => {
    await client.query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [user.id],
    );

    const { token, hash } = newOpaqueToken();
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, expires_at)
            VALUES ($1, $2, $3, now() + interval '30 days')`,
      [user.id, hash, request.headers.get('user-agent')?.slice(0, 400) ?? null],
    );
    return token;
  });

  const accessToken = await signAccess({
    sub: user.id,
    email: user.email,
    userType: user.user_type,
    supplierId: user.supplier_id,
    isSuperadmin: user.is_superadmin,
    permissions,
  });

  setAuthCookies(accessToken, refreshToken);

  return ok({
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      userType: user.user_type,
      supplierId: user.supplier_id,
      isSuperadmin: user.is_superadmin,
      permissions,
      // Set by an admin-issued reset. The client sends them straight to the
      // change-password screen rather than into the portal.
      mustChangePassword: user.must_change_password,
    },
  });
});
