#!/usr/bin/env node
// Seeds a company, a superadmin, and publishes the supplier accreditation form
// from db/seeds/supplier_accreditation_form.json.
//
// Idempotent: re-running publishes a NEW form version only if the JSON actually
// changed, and never touches an existing admin's password. (Use
// scripts/set-admin-login.mjs to change an admin login in place.)
//
//   node scripts/seed.mjs
//   SEED_ADMIN_EMAIL=me@x.com SEED_ADMIN_PASSWORD=... node scripts/seed.mjs
//
// Everything is written to the `supplier` schema. This database is shared with
// the customer portal, which owns `public` and holds live customer accounts —
// see the header of db/migrations/001_init.sql.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCHEMA = 'supplier';

function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        const value = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in process.env)) process.env[m[1]] = value;
      }
    } catch {
      /* absent — fine */
    }
  }
}

async function main() {
  loadEnv();
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error('No DATABASE_URL or POSTGRES_URL set.');
    process.exit(1);
  }

  const companyCode = process.env.SEED_COMPANY_CODE || 'AFCC';
  const companyName = process.env.SEED_COMPANY_NAME || 'AFCC';
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  // Refuse to seed a database that has not been migrated: without this the
  // INSERTs below would fail one at a time with a bare "relation does not
  // exist", which reads like a bug rather than a missing step.
  const ready = await client.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = $1 AND table_name IN ('companies','users','forms','form_versions')`,
    [SCHEMA],
  );
  if (ready.rows[0].n < 4) {
    console.error(
      `\nThe "${SCHEMA}" schema is not migrated yet (found ${ready.rows[0].n}/4 core tables).` +
        '\nRun: npm run db:migrate\n',
    );
    await client.end();
    process.exit(1);
  }

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path = ${SCHEMA}`);

    // --- Company -----------------------------------------------------------
    const company = await client.query(
      `INSERT INTO companies (code, name)
            VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, code`,
      [companyCode, companyName],
    );
    const companyId = company.rows[0].id;
    console.log(`  company  ${company.rows[0].code}`);

    // --- Superadmin --------------------------------------------------------
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    let adminId;
    if (existing.rows.length) {
      adminId = existing.rows[0].id;
      console.log(`  admin    ${adminEmail} (exists, password unchanged)`);
    } else {
      const hash = await bcrypt.hash(adminPassword, 10);
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, full_name, user_type, is_superadmin, email_verified_at)
              VALUES ($1, $2, $3, 'staff', true, now())
           RETURNING id`,
        [adminEmail, hash, 'Portal Administrator'],
      );
      adminId = inserted.rows[0].id;
      console.log(`  admin    ${adminEmail} / ${adminPassword}  <-- change this`);
    }

    await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'superadmin'
       ON CONFLICT DO NOTHING`,
      [adminId],
    );

    // --- Accreditation form ------------------------------------------------
    // The seed file wraps the schema in metadata (code, name, changelog), so
    // the published schema is the `schema` property, not the whole document.
    const seedFile = JSON.parse(
      readFileSync(join(ROOT, 'db', 'seeds', 'supplier_accreditation_form.json'), 'utf8'),
    );
    const schema = seedFile.schema;
    if (!schema?.sections?.length) {
      throw new Error('Seed form has no sections — check supplier_accreditation_form.json');
    }

    const form = await client.query(
      `INSERT INTO forms (company_id, code, name, description, kind)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, code)
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
         RETURNING id`,
      [
        companyId,
        seedFile.code || 'supplier_accreditation',
        seedFile.name || 'Supplier Accreditation Application',
        seedFile.description || null,
        seedFile.kind || 'supplier_accreditation',
      ],
    );
    const formId = form.rows[0].id;

    const current = await client.query(
      `SELECT id, version, schema FROM form_versions
        WHERE form_id = $1 AND status = 'published'
        ORDER BY version DESC LIMIT 1`,
      [formId],
    );

    const unchanged =
      current.rows.length &&
      JSON.stringify(current.rows[0].schema) === JSON.stringify(schema);

    if (unchanged) {
      console.log(`  form     v${current.rows[0].version} (unchanged)`);
    } else {
      const nextVersion = current.rows.length ? current.rows[0].version + 1 : 1;
      await client.query(
        `INSERT INTO form_versions
                (form_id, version, schema, status, changelog, published_at, published_by)
              VALUES ($1, $2, $3, 'published', $4, now(), $5)`,
        [
          formId,
          nextVersion,
          JSON.stringify(schema),
          nextVersion === 1
            ? seedFile.changelog || 'Initial version.'
            : 'Updated from db/seeds/supplier_accreditation_form.json',
          adminId,
        ],
      );
      // Retire the previous version rather than deleting it: applications
      // already in flight still point at it and must keep validating.
      if (current.rows.length) {
        await client.query(`UPDATE form_versions SET status = 'retired' WHERE id = $1`, [
          current.rows[0].id,
        ]);
      }
      console.log(`  form     v${nextVersion} published (${schema.sections.length} sections)`);
    }

    await client.query('COMMIT');
    console.log('\nSeed complete.');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\nSeed failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
