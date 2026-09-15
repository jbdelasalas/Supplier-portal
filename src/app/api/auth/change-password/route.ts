import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { requireAuth, hashPassword, verifyPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const Body = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Password must be at least 10 characters.'),
});

/**
 * POST /api/auth/change-password — the signed-in user replaces their own
 * password. Also how a temporary password issued by staff gets retired.
 *
 * The current password is required even though the caller is authenticated:
 * it stops someone who finds an unlocked screen from silently taking the
 * account over.
 */
export const POST = handler(async (request: NextRequest) => {
  const auth = await requireAuth(request);

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid request.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1 AND is_active',
    [auth.userId],
  );
  if (!user) return err('Account not found.', 404);

  if (!(await verifyPassword(currentPassword, user.password_hash))) {
    return err('The current password is not correct.', 401);
  }

  if (await verifyPassword(newPassword, user.password_hash)) {
    return err('Please choose a password different from your current one.', 400);
  }

  const passwordHash = await hashPassword(newPassword);

  await transaction(async (client) => {
    await client.query(
      `UPDATE users
          SET password_hash = $2,
              must_change_password = false,
              password_changed_at = now(),
              failed_logins = 0,
              locked_until = NULL
        WHERE id = $1`,
      [auth.userId, passwordHash],
    );

    // Other sessions are dropped, but not this one — logging someone out
    // immediately after they set a password is a poor experience, and they
    // have just proved they know the current one.
    await client.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [auth.userId],
    );
  });

  return ok({ ok: true });
});
