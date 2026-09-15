#!/usr/bin/env node
// Checks whether the connection string works, and says specifically what is
// wrong when it doesn't. Reads POSTGRES_URL / DATABASE_URL from .env.local, or
// takes a URL as an argument.
//
//   node scripts/test-connection.mjs
//   node scripts/test-connection.mjs "postgresql://postgres.ref:pw@host:5432/postgres"
//
// Nothing is written to the database and the password is never printed.
//
// Unlike the customer portal's version, this one expects `public` to be
// OCCUPIED: the two portals share a database, and the customer portal owns
// public. What it checks is that we are pointed at the right project — and it
// warns loudly if the database looks like the ERP instead, because the ERP also
// has a populated public schema and the refs are easy to confuse.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'supplier';

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* absent — fine */
    }
  }
}

function describe(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username),
      hasPassword: Boolean(u.password),
      // Only the shape, never the value.
      passwordLength: u.password ? decodeURIComponent(u.password).length : 0,
      // Supabase encodes the project ref in the pooler username as
      // postgres.<ref>, and in the direct host as db.<ref>.supabase.co.
      ref:
        decodeURIComponent(u.username).split('.')[1] ||
        u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ||
        null,
    };
  } catch {
    return null;
  }
}

async function test(label, url) {
  const info = describe(url);
  console.log(`\n${label}`);

  if (!info) {
    console.log('  ✗ Not a valid URL. It should start with postgresql://');
    return false;
  }

  console.log(`  host      ${info.host}`);
  console.log(
    `  port      ${info.port}  ${
      info.port === '6543' ? '(transaction pooler)' : info.port === '5432' ? '(session/direct)' : ''
    }`,
  );
  console.log(`  user      ${info.user}`);
  console.log(`  password  ${info.hasPassword ? `${info.passwordLength} characters` : 'MISSING'}`);
  if (info.ref) console.log(`  project   ${info.ref}`);

  if (!info.hasPassword) {
    console.log('  ✗ No password in the URL. Replace [YOUR-PASSWORD] with the real one.');
    return false;
  }
  if (/\[YOUR-PASSWORD\]/i.test(url)) {
    console.log('  ✗ The URL still contains the [YOUR-PASSWORD] placeholder.');
    return false;
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    const r = await client.query(
      `SELECT current_database() AS db,
              (SELECT count(*)::int FROM information_schema.tables
                WHERE table_schema = 'public')  AS public_tables,
              (SELECT count(*)::int FROM information_schema.tables
                WHERE table_schema = $1)        AS supplier_tables,
              -- Tables only the ERP has, as a fingerprint.
              (SELECT count(*)::int FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN ('journal_entries','gl_accounts','dp_sizes','chart_of_accounts')
              ) AS erp_markers,
              -- Tables only the customer portal has.
              (SELECT count(*)::int FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN ('customers','applications','form_versions')
              ) AS portal_markers`,
      [SCHEMA],
    );
    const row = r.rows[0];

    console.log(`  ✓ CONNECTED — database "${row.db}"`);
    console.log(`    public    ${row.public_tables} table(s)`);
    console.log(`    ${SCHEMA}  ${row.supplier_tables} table(s)`);

    // The ERP is the dangerous mistake: its public schema holds real
    // accounting data, and running anything against it must not happen.
    if (row.erp_markers > 0) {
      console.log('');
      console.log('  ✗ STOP — this looks like the ERP database, not the portal database.');
      console.log('    Found ERP tables (journal_entries / gl_accounts / dp_sizes) in public.');
      console.log('    Do NOT migrate or seed here. Check the project ref against');
      console.log('    the portal project, not the ERP one.');
      await client.end();
      return false;
    }

    if (row.portal_markers > 0) {
      console.log('    public holds the customer portal, as expected for the shared database.');
    } else if (row.public_tables === 0) {
      console.log('    public is empty — this is a fresh project, which is fine, but confirm');
      console.log('    it is the project you meant to share with the customer portal.');
    }

    if (row.supplier_tables === 0) {
      console.log(`    No ${SCHEMA} schema yet. Run: npm run db:migrate`);
    }

    await client.end();
    return true;
  } catch (e) {
    const m = e.message.split('\n')[0];
    console.log(`  ✗ ${m}`);

    if (/password authentication failed/i.test(m)) {
      console.log('    The host and project are correct, but the password is not.');
      console.log('    Supabase → Settings → Database → Reset database password.');
      console.log('    Use the DATABASE password, not the anon/service_role key.');
      console.log('    Avoid % @ / # ? in it — they need URL-encoding.');
    } else if (/Tenant or user not found/i.test(m)) {
      console.log('    That project ref is not on this host. Copy the URI from');
      console.log('    Supabase → Connect rather than editing it by hand.');
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(m)) {
      console.log('    Hostname did not resolve. Check for a typo, or no internet.');
    } else if (/timeout/i.test(m)) {
      console.log('    Timed out — the project may be paused. Check the dashboard.');
    }
    try {
      await client.end();
    } catch {}
    return false;
  }
}

loadEnv();

const arg = process.argv[2];
let allOk = true;

if (arg) {
  allOk = await test('Supplied URL', arg);
} else {
  const urls = [
    ['POSTGRES_URL  (runtime)', process.env.POSTGRES_URL],
    ['DATABASE_URL  (migrations)', process.env.DATABASE_URL],
  ].filter(([, v]) => v);

  if (urls.length === 0) {
    console.log('\nNeither POSTGRES_URL nor DATABASE_URL is set in .env.local.');
    console.log('Paste the URI from Supabase → Connect, then run this again.\n');
    process.exit(1);
  }
  for (const [label, url] of urls) {
    if (!(await test(label, url))) allOk = false;
  }
}

console.log(allOk ? '\nReady. Next: npm run db:migrate\n' : '\nFix the above, then run this again.\n');
process.exit(allOk ? 0 : 1);
