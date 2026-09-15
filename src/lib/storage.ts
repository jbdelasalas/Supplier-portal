import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredFile {
  storagePath: string;
  checksum: string;
  size: number;
}

/**
 * Writes an uploaded file and returns where it landed.
 *
 * Two drivers: 'local' (./uploads, for development) and 'supabase' (Storage,
 * for anything real). The stored name is always a fresh UUID — the applicant's
 * filename is kept in the database only, so it can never steer the write.
 */
export async function storeFile(
  file: File,
  prefix: string,
): Promise<StoredFile> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const ext = extensionFor(file.name, file.type);
  const objectName = `${prefix}/${randomUUID()}${ext}`;

  const driver = process.env.UPLOAD_DRIVER ?? 'local';

  // Serverless filesystems are ephemeral: a local write succeeds, returns 201,
  // and is gone by the next request — losing documents someone needs and
  // reporting success while doing it. Refuse rather than accept-and-lose.
  if (driver === 'local' && isServerless()) {
    throw new Error(
      'File storage is not configured for this environment. ' +
        'Set UPLOAD_DRIVER=supabase with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  if (driver === 'supabase') {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // A different default bucket from the customer portal on purpose: the two
    // share one Supabase project, and supplier documents must not land in the
    // customer onboarding bucket.
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'supplier-docs';
    if (!url || !key) throw new Error('Supabase storage is not configured.');

    const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: buffer,
    });
    if (!res.ok) {
      throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
    }
    return { storagePath: `${bucket}/${objectName}`, checksum, size: buffer.length };
  }

  const dir = join(process.cwd(), 'uploads', prefix);
  await mkdir(dir, { recursive: true });
  const full = join(process.cwd(), 'uploads', objectName);
  await writeFile(full, buffer);
  return { storagePath: `uploads/${objectName}`, checksum, size: buffer.length };
}

/** True on Vercel/AWS Lambda and similar, where only /tmp is writable. */
function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
  );
}

function extensionFor(name: string, mime: string): string {
  const fromName = name.match(/\.([a-z0-9]{1,8})$/i)?.[0];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
  };
  return map[mime] ?? '';
}

/**
 * A short-lived URL for reading a stored file.
 *
 * The bucket is private, so nothing is served by a guessable path — the caller
 * must already have passed the permission check, and the link it gets back
 * expires. Returns null for the local driver, where the file is served through
 * our own route instead.
 */
export async function signedUrlFor(
  storagePath: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  const driver = process.env.UPLOAD_DRIVER ?? 'local';
  if (driver !== 'supabase') return null;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase storage is not configured.');

  // storage_path is stored as "<bucket>/<object>"; the API wants them apart.
  const slash = storagePath.indexOf('/');
  const bucket = storagePath.slice(0, slash);
  const object = storagePath.slice(slash + 1);

  const res = await fetch(`${url}/storage/v1/object/sign/${bucket}/${object}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });

  if (!res.ok) return null;
  const body = (await res.json()) as { signedURL?: string };
  return body.signedURL ? `${url}/storage/v1${body.signedURL}` : null;
}

/** Reads a stored file back as bytes. Used by the local-driver read path. */
export async function readFile(storagePath: string): Promise<Buffer | null> {
  const driver = process.env.UPLOAD_DRIVER ?? 'local';

  if (driver === 'supabase') {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase storage is not configured.');

    const res = await fetch(`${url}/storage/v1/object/${storagePath}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  try {
    const { readFile: read } = await import('node:fs/promises');
    // storage_path already includes the "uploads/" prefix.
    return await read(join(process.cwd(), storagePath));
  } catch {
    return null;
  }
}

/** True when `mime` satisfies one of the schema's accept patterns. */
export function mimeAllowed(mime: string, accept?: string[]): boolean {
  if (!accept?.length) return true;
  return accept.some((rule) => {
    if (rule.endsWith('/*')) return mime.startsWith(rule.slice(0, -1));
    return rule === mime;
  });
}
