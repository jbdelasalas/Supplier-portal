import type { NextRequest } from 'next/server';
import { ok, handler } from '@/lib/api';
import { query } from '@/lib/db';
import { REFRESH_COOKIE, clearAuthCookies, sha256 } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: NextRequest) => {
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;

  // Revoke server-side so the refresh token is dead even if the cookie survives.
  if (refresh) {
    await query(
      `UPDATE sessions SET revoked_at = now()
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
      [sha256(refresh)],
    );
  }

  clearAuthCookies();
  return ok({ ok: true });
});
