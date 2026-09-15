import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/applications/:id/reopen — reopen a rejected application.
 *
 * Rejection used to be the end of the line: the answers and every uploaded
 * document sat on a row nobody could edit, so trying again meant re-keying the
 * whole form and re-uploading eleven files. This moves the same row back to
 * 'draft' instead.
 *
 * Nothing is deleted. The rejection stays in the event trail, and
 * `reopen_count` records that this is not the first attempt, so a reviewer can
 * still see what happened. Only the decision fields are cleared, because they
 * describe a decision that no longer applies to a pending application.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireAuth(request);

    const app = await queryOne<{
      id: string;
      status: string;
      applicant_user_id: string | null;
      reopen_count: number;
    }>(
      `SELECT id, status, applicant_user_id, reopen_count
         FROM applications WHERE id = $1`,
      [params.id],
    );

    // Same 404-not-403 as the other applicant routes: whether someone else's
    // application exists is not this account's business.
    if (!app || app.applicant_user_id !== auth.userId) {
      return err('Application not found.', 404);
    }

    if (['draft', 'info_requested'].includes(app.status)) {
      return err('This application is already open for editing.', 409);
    }
    if (app.status !== 'rejected') {
      return err(`An application that is ${app.status} cannot be reopened.`, 409);
    }

    const attempt = app.reopen_count + 1;

    await transaction(async (client) => {
      // Guard against a double-click reopening twice: the second UPDATE
      // matches no row, and the event below would otherwise double-count.
      const updated = await client.query(
        `UPDATE applications
            SET status = 'draft',
                reopen_count = $2,
                decided_by = NULL,
                decided_at = NULL,
                decision_notes = NULL,
                submitted_at = NULL
          WHERE id = $1 AND status = 'rejected'`,
        [app.id, attempt],
      );
      // `handler` returns a thrown Response as-is, which rolls back the
      // transaction and answers with a real status rather than a 500.
      if (updated.rowCount === 0) {
        throw err('This application was already reopened.', 409);
      }

      await client.query(
        `INSERT INTO application_events
           (application_id, event_type, from_status, to_status, message,
            is_public, actor_user_id, actor_label, metadata)
         VALUES ($1, 'reopened', 'rejected', 'draft', $2, true, $3, $4, $5)`,
        [
          app.id,
          'Applicant reopened this application to revise and resubmit it.',
          auth.userId,
          auth.email,
          JSON.stringify({ attempt }),
        ],
      );
    });

    return ok({ id: app.id, status: 'draft', attempt });
  },
);
