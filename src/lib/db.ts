import { Pool, type PoolClient, type PoolConfig } from 'pg';

let _pool: Pool | undefined;

/**
 * The schema this app owns.
 *
 * The database is SHARED with the customer portal, which owns `public` and
 * holds live customer accounts. Both systems have tables called users,
 * companies, applications, invoices, notifications and audit_log, so resolving
 * an unqualified name to the wrong schema would not error — it would read or
 * write the other system's data and look like it worked.
 *
 * Two things prevent that:
 *   1. every connection gets `search_path = supplier` (below), with public
 *      NOT on the path, so an unqualified name cannot silently fall through
 *      to a customer-portal table;
 *   2. scripts/migrate.mjs refuses any migration that writes outside it.
 *
 * `pg_catalog` is always implicitly first, so built-ins still resolve. The
 * extensions live in public but are reached as `public.uuid_generate_v4()`
 * from DEFAULT clauses that migrations already qualify.
 */
export const SCHEMA = 'supplier';

// Supabase's Supavisor exposes two ports: 6543 = transaction mode (correct for
// serverless — a client is only held for the duration of a query), 5432 =
// session mode (holds a backend for the whole connection). Force the
// transaction port so a misconfigured env var can't exhaust the session pool.
function normalizeUrl(raw: string): string {
  let url = raw.replace(/([?&])sslmode=[^&]*/g, '$1').replace(/[?&]$/, '');
  if (/\.pooler\.supabase\.com:5432\b/.test(url)) {
    url = url.replace('.pooler.supabase.com:5432', '.pooler.supabase.com:6543');
  }
  return url;
}

export function getPool(): Pool {
  if (_pool) return _pool;

  const raw = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!raw) throw new Error('No database URL configured (set POSTGRES_URL or DATABASE_URL)');

  const url = normalizeUrl(raw);
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');

  // Every warm serverless instance keeps its own Pool, so keep each one small
  // and release quickly.
  const cfg: PoolConfig = {
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: isLocal ? 10 : 1,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    // Applied by the server to every session this pool opens. Set here rather
    // than per query because the transaction pooler may hand a later query a
    // different backend — a one-off SET would not follow it.
    options: `-c search_path=${SCHEMA}`,
  };

  _pool = new Pool(cfg);

  // Belt and braces: if `options` is ever stripped by a pooler, this still
  // pins each fresh connection before the app runs a query on it.
  _pool.on('connect', (client) => {
    client.query(`SET search_path = ${SCHEMA}`).catch(() => {
      /* the query that follows will surface any real problem */
    });
  });

  _pool.on('error', () => {
    _pool = undefined;
  });
  return _pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, params as never[]);
  return res.rows as T[];
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on
 * any throw. Use for every multi-statement write — approving an application
 * touches four tables and must not half-apply.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
