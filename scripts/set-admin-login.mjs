#!/usr/bin/env node
// Changes an existing admin's email and/or password in place, keeping the same
// user id so role grants and owned records stay attached.
//
//   node scripts/set-admin-login.mjs --from old@x.com --email new@x.com --password '...'
//
// Passwords are read from argv or ADMIN_PASSWORD and never printed back.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadEnv();

  const from = arg('from');
  const email = arg('email');
  const password = arg('password') || process.env.ADMIN_PASSWORD;

  if (!from || (!email && !password)) {
    console.error('usage: --from <current email> [--email <new>] [--password <new>]');
    process.exit(1);
  }

  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('No POSTGRES_URL / DATABASE_URL found in .env.local');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  // This database is shared with the supplier portal, which owns public.users
  // and holds live customer logins. Pin the search_path before any query so an
  // unqualified `users` below can only ever mean supplier.users.
  await client.query('SET search_path = supplier');

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id, email, is_superadmin FROM users WHERE email = $1',
      [from],
    );
    if (!existing.rows.length) {
      throw new Error(`No user with email ${from}`);
    }
    const user = existing.rows[0];

    if (email && email.toLowerCase() !== from.toLowerCase()) {
      const clash = await client.query(
        'SELECT id FROM users WHERE email = $1 AND id <> $2',
        [email, user.id],
      );
      if (clash.rows.length) {
        throw new Error(`${email} is already taken by another user`);
      }
    }

    const sets = ['updated_at = now()'];
    const values = [user.id];

    if (email) {
      values.push(email);
      // Re-verify: the address changed, so the old verification no longer applies.
      sets.push(`email = $${values.length}`, 'email_verified_at = now()');
    }
    if (password) {
      values.push(await bcrypt.hash(password, 10));
      sets.push(`password_hash = $${values.length}`);
      // A deliberate password change clears any lockout.
      sets.push('failed_logins = 0', 'locked_until = NULL');
    }

    const updated = await client.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, email, is_superadmin, email_verified_at`,
      values,
    );

    await client.query('COMMIT');

    const row = updated.rows[0];
    console.log('  updated  ' + row.email);
    console.log('  id       ' + row.id + '  (unchanged)');
    console.log('  superadmin ' + row.is_superadmin);
    if (password) console.log('  password set');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('failed: ' + err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
