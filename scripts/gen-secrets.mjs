#!/usr/bin/env node
// Prints freshly generated JWT secrets, ready to paste into .env.local or
// Vercel. Generates, never stores — run it again for a new pair.
//
//   node scripts/gen-secrets.mjs          human-readable
//   node scripts/gen-secrets.mjs --env    .env format

import { randomBytes } from 'node:crypto';

const secret = () => randomBytes(48).toString('base64url');

const access = secret();
const refresh = secret();

if (process.argv.includes('--env')) {
  console.log(`JWT_ACCESS_SECRET=${access}`);
  console.log(`JWT_REFRESH_SECRET=${refresh}`);
} else {
  console.log('\nGenerated secrets — treat these like passwords.\n');
  console.log(`  JWT_ACCESS_SECRET   ${access}`);
  console.log(`  JWT_REFRESH_SECRET  ${refresh}`);
  console.log(
    '\nChanging these later signs everyone out; it does not corrupt any data.\n',
  );
}
