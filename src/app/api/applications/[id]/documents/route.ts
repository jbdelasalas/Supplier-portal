import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { storeFile, mimeAllowed } from '@/lib/storage';
import type { FormSchema } from '@/lib/forms';

export const dynamic = 'force-dynamic';

const DEFAULT_MAX_MB = 10;

/**
 * POST /api/applications/:id/documents — multipart upload of one document.
 * Fields: `file` (the upload) and `docKey` (which schema slot it fills).
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);

    const app = await queryOne<{
      id: string;
      status: string;
      applicant_user_id: string | null;
      schema: FormSchema;
    }>(
      `SELECT a.id, a.status, a.applicant_user_id, fv.schema
         FROM applications a
         JOIN form_versions fv ON fv.id = a.form_version_id
        WHERE a.id = $1`,
      [params.id],
    );

    if (!app || app.applicant_user_id !== auth.userId) {
      return err('Application not found.', 404);
    }
    if (!['draft', 'info_requested'].includes(app.status)) {
      return err(`Documents cannot be added while the application is ${app.status}.`, 409);
    }

    const form = await request.formData();
    const file = form.get('file');
    const docKey = String(form.get('docKey') ?? '').trim();

    if (!(file instanceof File) || file.size === 0) {
      return err('A file is required.', 400);
    }
    if (!docKey) return err('A docKey is required.', 400);

    // Capture context, sent by PhotoCapture. Absent for a plain file upload.
    const captureSource = form.get('captureSource') === 'camera' ? 'camera' : 'upload';
    const capturedAtRaw = String(form.get('capturedAt') ?? '');
    const capturedAt = capturedAtRaw && !Number.isNaN(Date.parse(capturedAtRaw))
      ? capturedAtRaw
      : null;

    // Coordinates are advisory: a browser can be denied location, and any
    // client value can be forged, so treat them as a hint for the reviewer
    // rather than proof of where the photo was taken.
    const asCoord = (v: FormDataEntryValue | null, limit: number) => {
      const n = Number(v);
      return v !== null && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
    };
    const latitude = asCoord(form.get('latitude'), 90);
    const longitude = asCoord(form.get('longitude'), 180);
    const accuracy = asCoord(form.get('accuracy'), 1_000_000);

    // The schema decides what is acceptable — extras are allowed but
    // constrained by the defaults.
    const spec = (app.schema.documents ?? []).find((d) => d.key === docKey);
    const maxMb = spec?.maxSizeMb ?? DEFAULT_MAX_MB;

    if (file.size > maxMb * 1024 * 1024) {
      return err(`That file is larger than the ${maxMb} MB limit.`, 413);
    }
    if (spec && !mimeAllowed(file.type, spec.accept)) {
      return err(`${spec.label} must be one of: ${(spec.accept ?? []).join(', ')}`, 415);
    }

    const stored = await storeFile(file, `applications/${app.id}`);

    const saved = await transaction(async (client) => {
      // One current file per slot: supersede the previous upload.
      await client.query(
        `DELETE FROM application_documents WHERE application_id = $1 AND doc_key = $2`,
        [app.id, docKey],
      );

      const inserted = await client.query<{ id: string; uploaded_at: string }>(
        `INSERT INTO application_documents
           (application_id, doc_key, file_name, content_type, size_bytes,
            storage_path, checksum_sha256, uploaded_by,
            capture_source, captured_at, latitude, longitude, location_accuracy_m,
            capture_meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, uploaded_at`,
        [
          app.id,
          docKey,
          file.name.slice(0, 255),
          file.type || null,
          stored.size,
          stored.storagePath,
          stored.checksum,
          auth.userId,
          captureSource,
          capturedAt,
          latitude,
          longitude,
          accuracy,
          JSON.stringify({ userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null }),
        ],
      );

      await client.query(
        `INSERT INTO application_events
           (application_id, event_type, message, is_public, actor_user_id, metadata)
         VALUES ($1, $2, $3, true, $4, $5)`,
        [
          app.id,
          captureSource === 'camera' ? 'photo_captured' : 'document_uploaded',
          captureSource === 'camera'
            ? `Photo taken for ${spec?.label ?? docKey}.`
            : `Uploaded ${spec?.label ?? docKey}.`,
          auth.userId,
          JSON.stringify({
            docKey,
            fileName: file.name,
            captureSource,
            ...(latitude !== null && longitude !== null ? { latitude, longitude } : {}),
          }),
        ],
      );

      return inserted.rows[0];
    });

    return ok(
      {
        id: saved.id,
        docKey,
        fileName: file.name,
        sizeBytes: stored.size,
        uploadedAt: saved.uploaded_at,
      },
      201,
    );
  },
);

/** GET — list what has been uploaded so far. */
export const GET = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);

    const app = await queryOne<{ id: string; applicant_user_id: string | null }>(
      'SELECT id, applicant_user_id FROM applications WHERE id = $1',
      [params.id],
    );
    const isStaff = auth.userType === 'staff';
    if (!app || (!isStaff && app.applicant_user_id !== auth.userId)) {
      return err('Application not found.', 404);
    }

    const documents = await query(
      `SELECT id, doc_key, file_name, content_type, size_bytes, status,
              reject_reason, uploaded_at
         FROM application_documents
        WHERE application_id = $1
        ORDER BY uploaded_at`,
      [app.id],
    );

    return ok({ documents });
  },
);
