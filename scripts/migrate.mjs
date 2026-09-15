#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order, once each, inside a
// transaction per file. Tracks what ran in supplier.schema_migrations.
//
//   node scripts/migrate.mjs            apply pending
//   node scripts/migrate.mjs --status   list applied/pending, apply nothing
//
// ## Why this script has a guard the customer portal's does not
//
// This portal shares its database with the customer portal, which owns the
// `public` schema and holds live customer accounts. Both systems want tables
// called users, companies, applications, invoices, notifications, audit_log.
//
// The customer portal's migrations are all CREATE TABLE IF NOT EXISTS, so a
// collision would NOT fail loudly — it would skip the create, leave the
// customer portal's table in place, and then run this portal's ALTERs and seed
// INSERTs against real customer data.
//
// So before applying anything, this refuses any migration that would write
// outside the `supplier` schema, and it keeps its own migration ledger inside
// that schema — sharing public.schema_migrations would make each app believe
// the other's migrations were already applied.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'db', 'migrations');
const SCHEMA = 'supplier';

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const text = readFileSync(join(__dirname, '..', file), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const value = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in process.env)) process.env[m[1]] = value;
      }
    } catch {
      /* file absent — fine */
    }
  }
}

/**
 * Strips comments and string literals so the guard below inspects only real
 * SQL. Without this, the word "public" in an explanatory comment would trip it.
 */
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $$BODY$$ ')
    .replace(/'(?:[^']|'')*'/g, " 'STR' ");
}

/**
 * Refuses a migration that would create or alter anything outside `supplier`.
 *
 * Deliberately conservative: it wants every CREATE/ALTER/DROP target to be
 * schema-qualified with `supplier.`, so an unqualified `CREATE TABLE users`
 * — which would land in whatever search_path happens to be, potentially
 * public — is caught before it runs rather than after.
 */
function checkScoping(file, sql) {
  const problems = [];
  const text = stripNoise(sql);

  // CREATE/ALTER/DROP of a schema-scoped object must name `supplier.`.
  const objectRe =
    /\b(CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|SEQUENCE|TYPE|INDEX|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z0-9_."]+)/gi;

  for (const m of text.matchAll(objectRe)) {
    const [, verb, kind, target] = m;
    const upperKind = kind.toUpperCase().replace(/\s+/g, ' ');

    // An index or trigger name is not schema-qualified in Postgres — it
    // inherits the schema of the table it is ON, which the ON clause names.
    if (upperKind === 'INDEX' || upperKind === 'TRIGGER') continue;

    if (target.toLowerCase().startsWith('public.')) {
      problems.push(`${verb} ${upperKind} ${target} — targets public directly`);
    } else if (!target.includes('.')) {
      problems.push(
        `${verb} ${upperKind} ${target} — not schema-qualified; write ${SCHEMA}.${target}`,
      );
    } else if (!target.toLowerCase().startsWith(`${SCHEMA}.`)) {
      problems.push(`${verb} ${upperKind} ${target} — outside the ${SCHEMA} schema`);
    }
  }

  // CREATE INDEX ... ON <table> / CREATE TRIGGER ... ON <table>
  for (const m of text.matchAll(/\bON\s+(public\.[A-Za-z0-9_."]+)/gi)) {
    problems.push(`${m[1]} — index or trigger on a public table`);
  }

  // Writes to public tables.
  for (const m of text.matchAll(
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(public\.[A-Za-z0-9_."]+)/gi,
  )) {
    problems.push(`${m[1]} ${m[2]} — writes to a public table`);
  }

  // A permanent search_path change would make later unqualified DDL land
  // wherever it resolves. SET LOCAL inside a migration transaction is fine.
  for (const m of text.matchAll(/\bSET\s+(?!LOCAL\b)search_path\b/gi)) {
    problems.push('SET search_path without LOCAL — use SET LOCAL inside a migration');
  }

  return problems;
}

async function main() {
  loadEnv();
  const statusOnly = process.argv.includes('--status');

  // Migrations use the direct connection: DDL and the pooler disagree.
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('No DATABASE_URL or POSTGRES_URL set. Copy .env.example to .env.local first.');
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  // Scope-check everything BEFORE opening a connection, so a badly scoped
  // migration cannot touch the shared database even partially.
  let blocked = false;
  for (const file of files) {
    const problems = checkScoping(file, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    if (problems.length) {
      blocked = true;
      console.error(`\n✗ ${file} would write outside the "${SCHEMA}" schema:`);
      for (const p of problems) console.error(`    ${p}`);
    }
  }
  if (blocked) {
    console.error(
      `\nRefusing to run. This database is shared with the customer portal, which owns` +
        `\n"public" and holds live customer data. Every object must be ${SCHEMA}.-qualified.\n`,
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  // Report what we are pointed at, so a wrong connection string is visible
  // before anything is written rather than after.
  const target = await client.query(
    `SELECT current_database() AS db,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema = 'public')   AS public_tables,
            (SELECT count(*)::int FROM information_schema.tables
              WHERE table_schema = $1)         AS supplier_tables`,
    [SCHEMA],
  );
  const t = target.rows[0];
  console.log(
    `\nDatabase "${t.db}" — ${t.public_tables} table(s) in public, ` +
      `${t.supplier_tables} in ${SCHEMA}.`,
  );
  if (t.public_tables > 0) {
    console.log('  public is occupied (the customer portal). Nothing below touches it.\n');
  }

  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Map(
    (await client.query(`SELECT filename, checksum FROM ${SCHEMA}.schema_migrations`)).rows.map(
      (r) => [r.filename, r.checksum],
    ),
  );

  let ran = 0;

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        console.warn(`  ~ ${file} — CHANGED since it was applied (not re-run).`);
      } else if (statusOnly) {
        console.log(`  = ${file}`);
      }
      continue;
    }

    if (statusOnly) {
      console.log(`  + ${file} (pending)`);
      continue;
    }

    process.stdout.write(`  + ${file} ... `);
    try {
      await client.query('BEGIN');
      // Belt and braces: even if a migration forgets its own SET LOCAL, an
      // unqualified object lands in supplier rather than public.
      // `extensions` is on the path because Supabase installs uuid-ossp and
      // pgcrypto there rather than in public (citext does land in public), so
      // uuid_generate_v4() in a DEFAULT clause cannot resolve without it.
      await client.query(`SET LOCAL search_path = ${SCHEMA}, public, extensions`);
      await client.query(sql);
      await client.query(
        `INSERT INTO ${SCHEMA}.schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [file, checksum],
      );
      await client.query('COMMIT');
      console.log('ok');
      ran++;
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      console.error(`\n${file}: ${e.message}\n`);
      await client.end();
      process.exit(1);
    }
  }

  if (!statusOnly) {
    console.log(ran ? `\nApplied ${ran} migration(s).` : '\nAlready up to date.');
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
