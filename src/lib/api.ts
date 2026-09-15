import { NextResponse } from 'next/server';

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function err(message: string, status: number, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * Misconfiguration reads as a server fault otherwise, which sends whoever is
 * setting this up hunting through application code for what is really a
 * missing line in .env.local.
 */
function configProblem(e: unknown): string | null {
  if (!(e instanceof Error)) return null;

  if (/No database URL configured/i.test(e.message)) {
    return 'The database is not configured. Set POSTGRES_URL (or DATABASE_URL) in .env.local.';
  }
  if (/JWT_ACCESS_SECRET is required/i.test(e.message)) {
    return 'Authentication is not configured. Set JWT_ACCESS_SECRET in the environment.';
  }
  // The pool is configured but nothing is listening / DNS is wrong.
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(e.message)) {
    return 'Could not reach the database. Check POSTGRES_URL and that the database is running.';
  }
  // Migrations have not been run against an otherwise reachable database.
  if (/relation ".+" does not exist/i.test(e.message)) {
    return 'The database schema is missing. Run `npm run db:migrate`.';
  }
  if (/File storage is not configured|Supabase storage is not configured/i.test(e.message)) {
    return 'File uploads are not configured on this deployment. Set UPLOAD_DRIVER and the Supabase storage keys.';
  }
  return null;
}

/**
 * Wraps a route handler so a thrown Response (how requireAuth/requireStaff
 * bail out) becomes the response, and anything else becomes a clean 500
 * instead of leaking a stack trace to the client.
 */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error('[api]', e);

      // Safe to surface in any environment: it names a setting, not internals.
      const config = configProblem(e);
      if (config) return err(config, 503);

      const message = e instanceof Error ? e.message : 'Internal server error';
      return err(
        process.env.NODE_ENV === 'production' ? 'Internal server error' : message,
        500,
      );
    }
  };
}
