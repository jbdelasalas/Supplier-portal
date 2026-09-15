import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireAuth, newOpaqueToken, sha256 } from '@/lib/auth';
import { send, verifyEmailMail } from '@/lib/mail';

export const dynamic = 'force-dynamic';

const Body = z.object({ token: z.string().min(20) });

/** POST — confirm an address from the emailed link. */
export const POST = handler(async (request: NextRequest) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return err('A verification token is required.', 400);

  const row = await queryOne<{ id: string; user_id: string; email: string; already: boolean }>(
    `SELECT t.id, t.user_id, u.email, (u.email_verified_at IS NOT NULL) AS already
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.purpose = 'verify_email'
        AND t.consumed_at IS NULL
        AND t.expires_at > now()`,
    [sha256(parsed.data.token)],
  );

  if (!row) {
    return err('That confirmation link is invalid or has expired.', 400);
  }
  if (row.already) {
    // Clicking an old link after verifying is harmless, not an error.
    return ok({ ok: true, email: row.email, alreadyVerified: true });
  }

  await transaction(async (client) => {
    await client.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [row.user_id]);
    await client.query(`UPDATE auth_tokens SET consumed_at = now() WHERE id = $1`, [row.id]);
  });

  return ok({ ok: true, email: row.email });
});

/** PUT — resend the confirmation to the signed-in user. */
export const PUT = handler(async (request: NextRequest) => {
  const auth = await requireAuth(request);

  const user = await queryOne<{ email: string; full_name: string; verified: boolean }>(
    `SELECT email, full_name, (email_verified_at IS NOT NULL) AS verified
       FROM users WHERE id = $1`,
    [auth.userId],
  );
  if (!user) return err('Account not found.', 404);
  if (user.verified) return ok({ ok: true, alreadyVerified: true });

  const recent = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_tokens
      WHERE user_id = $1 AND purpose = 'verify_email'
        AND created_at > now() - interval '1 hour'`,
    [auth.userId],
  );
  if (Number(recent?.n ?? 0) >= 5) {
    return err('Too many confirmation emails requested. Please try again later.', 429);
  }

  const { token, hash } = newOpaqueToken();
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
          VALUES ($1, 'verify_email', $2, now() + interval '3 days')`,
    [auth.userId, hash],
  );

  const result = await send(verifyEmailMail(user.email, token, user.full_name));

  if (result.logged && process.env.NODE_ENV !== 'production') {
    return ok({ ok: true, devVerifyToken: token });
  }
  return ok({ ok: true });
});
