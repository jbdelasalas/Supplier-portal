import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { hashPassword, sha256 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(20),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
});

/**
 * POST /api/auth/reset-password — complete a reset.
 *
 * Consuming the token, changing the password and revoking existing sessions
 * happen in one transaction. Half of that would be dangerous: a password
 * changed but sessions left alive means whoever prompted the reset keeps
 * their access.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid request.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  const { token, password } = parsed.data;

  // The stored value is a hash, so look up by hash rather than by token.
  const row = await queryOne<{ id: string; user_id: string; email: string }>(
    `SELECT t.id, t.user_id, u.email
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.purpose = 'reset_password'
        AND t.consumed_at IS NULL
        AND t.expires_at > now()
        AND u.is_active`,
    [sha256(token)],
  );

  // One message for expired, used, and never-existed alike.
  if (!row) {
    return err('That reset link is invalid or has expired. Please request a new one.', 400);
  }

  const passwordHash = await hashPassword(password);

  await transaction(async (client) => {
    await client.query(
      `UPDATE users
          SET password_hash = $2, failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [row.user_id, passwordHash],
    );

    await client.query(`UPDATE auth_tokens SET consumed_at = now() WHERE id = $1`, [row.id]);

    // Any other outstanding reset links for this account are now void.
    await client.query(
      `UPDATE auth_tokens SET consumed_at = now()
        WHERE user_id = $1 AND purpose = 'reset_password' AND consumed_at IS NULL`,
      [row.user_id],
    );

    // Sign out everywhere. If someone else prompted this reset, this is what
    // removes them.
    await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [row.user_id],
    );
  });

  return ok({ ok: true, email: row.email });
});
