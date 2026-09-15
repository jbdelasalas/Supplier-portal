import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne } from '@/lib/db';
import { newOpaqueToken } from '@/lib/auth';
import { send, passwordResetMail } from '@/lib/mail';

export const dynamic = 'force-dynamic';

const Body = z.object({ email: z.string().email() });

/**
 * POST /api/auth/forgot-password — start a password reset.
 *
 * Always answers the same way, whether or not the address exists. Anything
 * else turns this endpoint into a way to discover which of your suppliers
 * have accounts.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err('A valid email address is required.', 400);

  const { email } = parsed.data;

  // The response every caller gets, regardless of what happens below.
  const sameAnswer = ok({
    ok: true,
    message: 'If that email has an account, a reset link is on its way.',
  });

  const user = await queryOne<{ id: string; full_name: string; is_active: boolean }>(
    'SELECT id, full_name, is_active FROM users WHERE email = $1',
    [email],
  );
  if (!user || !user.is_active) return sameAnswer;

  // Rate limit per account: three live reset tokens is plenty, and stops this
  // being used to flood someone's inbox.
  const recent = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_tokens
      WHERE user_id = $1 AND purpose = 'reset_password'
        AND consumed_at IS NULL AND expires_at > now()
        AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (Number(recent?.n ?? 0) >= 3) return sameAnswer;

  const { token, hash } = newOpaqueToken();

  // Only the hash is stored: a leaked database cannot be used to reset
  // anyone's password.
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
          VALUES ($1, 'reset_password', $2, now() + interval '1 hour')`,
    [user.id, hash],
  );

  const result = await send(passwordResetMail(email, token, user.full_name));

  // In development, with no provider configured, surface the link so the flow
  // is testable. Never in production — that would hand out reset tokens.
  if (result.logged && process.env.NODE_ENV !== 'production') {
    return ok({
      ok: true,
      message: 'Email is not configured; use the link below.',
      devResetToken: token,
    });
  }

  return sameAnswer;
});
