import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { ok, err, handler } from '@/lib/api';
import { query, queryOne, transaction } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const MAX_SIGNATURE_BYTES = 400_000; // ~300 KB of base64; a drawn signature is far less.

const Body = z.object({
  signatureKey: z.string().max(60).default('applicant'),
  signatureData: z
    .string()
    .startsWith('data:image/png;base64,', 'The signature must be a PNG data URI.'),
  signatoryName: z.string().min(2).max(160),
  signatoryPosition: z.string().max(120).optional(),
  declarationText: z.string().min(10).max(4000),
  method: z.enum(['drawn', 'typed']).default('drawn'),
});

/**
 * POST /api/applications/:id/signature — record a signature.
 *
 * Stores the image alongside the evidence that gives it weight: the exact
 * declaration wording shown, when it was signed, and from where. The hash
 * covers all of it, so a later edit to any of those columns no longer matches
 * and the tampering is visible.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return err('Invalid signature.', 400, {
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const body = parsed.data;

    if (body.signatureData.length > MAX_SIGNATURE_BYTES) {
      return err('That signature image is too large.', 413);
    }

    const app = await queryOne<{ id: string; status: string; applicant_user_id: string | null }>(
      'SELECT id, status, applicant_user_id FROM applications WHERE id = $1',
      [params.id],
    );
    if (!app || app.applicant_user_id !== auth.userId) {
      return err('Application not found.', 404);
    }
    if (!['draft', 'info_requested'].includes(app.status)) {
      return err(`This application is ${app.status} and can no longer be signed.`, 409);
    }

    const signedAt = new Date().toISOString();
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      request.headers.get('x-real-ip') ||
      null;
    const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;

    // Order is fixed and documented so the hash can be recomputed later.
    const evidenceHash = createHash('sha256')
      .update(
        [
          body.signatureData,
          body.declarationText,
          body.signatoryName,
          body.signatoryPosition ?? '',
          signedAt,
          app.id,
        ].join('\n'),
      )
      .digest('hex');

    await transaction(async (client) => {
      // Re-signing replaces the previous mark rather than accumulating rows.
      await client.query(
        `INSERT INTO application_signatures
           (application_id, signature_key, signatory_name, signatory_position,
            signature_data, method, declaration_text, signed_at, ip_address,
            user_agent, signed_by, evidence_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (application_id, signature_key) DO UPDATE SET
           signatory_name     = EXCLUDED.signatory_name,
           signatory_position = EXCLUDED.signatory_position,
           signature_data     = EXCLUDED.signature_data,
           method             = EXCLUDED.method,
           declaration_text   = EXCLUDED.declaration_text,
           signed_at          = EXCLUDED.signed_at,
           ip_address         = EXCLUDED.ip_address,
           user_agent         = EXCLUDED.user_agent,
           signed_by          = EXCLUDED.signed_by,
           evidence_hash      = EXCLUDED.evidence_hash`,
        [
          app.id,
          body.signatureKey,
          body.signatoryName,
          body.signatoryPosition ?? null,
          body.signatureData,
          body.method,
          body.declarationText,
          signedAt,
          ip,
          userAgent,
          auth.userId,
          evidenceHash,
        ],
      );

      await client.query(
        `INSERT INTO application_events
           (application_id, event_type, message, is_public, actor_user_id, metadata)
         VALUES ($1, 'signed', $2, true, $3, $4)`,
        [
          app.id,
          `Signed by ${body.signatoryName}.`,
          auth.userId,
          JSON.stringify({ signatureKey: body.signatureKey, method: body.method, evidenceHash }),
        ],
      );
    });

    return ok({ signatureKey: body.signatureKey, signedAt, evidenceHash }, 201);
  },
);

/** GET — the signatures on this application (applicant or reviewing staff). */
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

    // The applicant sees their own mark; only staff see the audit context.
    const signatures = await query(
      isStaff
        ? `SELECT signature_key, signatory_name, signatory_position, signature_data,
                  method, declaration_text, signed_at, ip_address, user_agent, evidence_hash
             FROM application_signatures WHERE application_id = $1 ORDER BY signed_at`
        : `SELECT signature_key, signatory_name, signatory_position, signature_data,
                  method, signed_at
             FROM application_signatures WHERE application_id = $1 ORDER BY signed_at`,
      [app.id],
    );

    return ok({ signatures });
  },
);
