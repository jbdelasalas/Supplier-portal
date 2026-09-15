#!/usr/bin/env node
// Sends one real email through the configured provider and reports exactly
// what happened. Run this after setting RESEND_API_KEY, before trusting the
// password-reset flow to a customer.
//
//   node scripts/test-email.mjs you@example.com

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* absent — fine */
  }
}

const to = process.argv[2];
if (!to) {
  console.error('\nUsage: node scripts/test-email.mjs <recipient@example.com>\n');
  process.exit(1);
}

const key = process.env.RESEND_API_KEY;
const from = process.env.MAIL_FROM ?? 'Art Fresh <onboarding@resend.dev>';

console.log(`\n  from:   ${from}`);
console.log(`  to:     ${to}`);
console.log(`  driver: ${key ? 'resend' : 'log (RESEND_API_KEY not set)'}\n`);

if (!key) {
  console.log('  Nothing was sent. Set RESEND_API_KEY in .env.local first.\n');
  process.exit(1);
}

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from,
    to: [to],
    subject: 'Art Fresh portal — email test',
    text:
      'This is a test from the Art Fresh customer portal.\n\n' +
      'If you are reading this, password resets and approval notices will reach suppliers.\n',
    html:
      '<p>This is a test from the Art Fresh customer portal.</p>' +
      '<p>If you are reading this, password resets and approval notices will reach suppliers.</p>',
  }),
});

const body = await res.text();

if (res.ok) {
  console.log(`  SENT — id ${JSON.parse(body).id}`);
  console.log('  Check the inbox, and the spam folder if it is not there.\n');
  process.exit(0);
}

console.log(`  FAILED (${res.status})`);
console.log(`  ${body}\n`);

// The two failures worth naming, because the message alone is cryptic.
if (/domain is not verified/i.test(body)) {
  console.log('  The sending domain is not verified in Resend yet.');
  console.log('  Add the DNS records Resend shows under Domains, then retry.\n');
} else if (/You can only send testing emails/i.test(body)) {
  console.log('  Resend sandbox: until a domain is verified, delivery is limited');
  console.log('  to the address that owns the Resend account.\n');
}
process.exit(1);
