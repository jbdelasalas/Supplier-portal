import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { hashPassword, newOpaqueToken, signAccess, setAuthCookies } from '@/lib/auth';
import { send, verifyEmailMail } from '@/lib/mail';

export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
  fullName: z.string().min(2).max(160),
  phone: z.string().max(40).optional(),
});

/**
 * Public self-signup. Creates a 'supplier' user with NO supplier_id — the
 * account can fill in an application and nothing else until staff approve it
 * and the link is made.
 */
export const POST = handler(async (request: NextRequest) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return err('Invalid registration details.', 400, {
      details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }

  const { email, password, fullName, phone } = parsed.data;

  const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    // Deliberately vague: don't confirm which emails already hold accounts.
    return err('That email cannot be registered. Try signing in or resetting your password.', 409);
  }

  const passwordHash = await hashPassword(password);

  const { userId, refreshToken, verifyToken } = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, phone, user_type)
            VALUES ($1, $2, $3, $4, 'supplier')
         RETURNING id`,
      [email, passwordHash, fullName, phone ?? null],
    );
    const id = inserted.rows[0].id;

    const { token, hash } = newOpaqueToken();
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, expires_at)
            VALUES ($1, $2, $3, now() + interval '30 days')`,
      [id, hash, request.headers.get('user-agent')?.slice(0, 400) ?? null],
    );

    const verify = newOpaqueToken();
    await client.query(
      `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
            VALUES ($1, 'verify_email', $2, now() + interval '3 days')`,
      [id, verify.hash],
    );

    return { userId: id, refreshToken: token, verifyToken: verify.token };
  });

  // Sent after the transaction commits, and deliberately not awaited into the
  // failure path: a provider outage must not undo a completed registration.
  // The applicant can request a fresh link from their account either way.
  send(verifyEmailMail(email, verifyToken, fullName)).catch(() => {});

  const accessToken = await signAccess({
    sub: userId,
    email,
    userType: 'supplier',
    supplierId: null,
    isSuperadmin: false,
    permissions: [],
  });

  setAuthCookies(accessToken, refreshToken);

  return ok(
    {
      user: { id: userId, email, fullName, userType: 'supplier', supplierId: null },
      nextStep: 'application',
    },
    201,
  );
});
