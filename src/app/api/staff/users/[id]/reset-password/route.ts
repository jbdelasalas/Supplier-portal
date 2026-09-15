import { randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ok, err, handler } from '@/lib/api';
import { queryOne, transaction } from '@/lib/db';
import { requireStaff, hashPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Readable temporary password — this gets dictated over the phone, so it
 * avoids characters that sound alike or vanish in handwriting: no O/0, I/l/1,
 * and no symbols. Grouped for legibility.
 */
function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const bytes = randomBytes(15);
  let out = '';
  for (let i = 0; i < 15; i++) {
    if (i === 5 || i === 10) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out; // e.g. "Kp7Rt-9mWqx-Ub4Ns"
}

/**
 * POST /api/staff/users/:id/reset-password
 *
 * Issues a one-time password for a supplier who cannot get in. Email delivery
 * is not configured yet, so this is currently the only recovery route.
 *
 * Three things this deliberately does NOT do:
 *  - let the admin choose the password, which invites reuse of a house
 *    default across every supplier;
 *  - leave the temporary password usable indefinitely — must_change_password
 *    forces the supplier to set their own before doing anything;
 *  - allow resetting another staff account, which would let one staff member
 *    take over a colleague's (or a superadmin's) login.
 */
export const POST = handler(
  async (request: NextRequest, { params }: { params: { id: string } }) => {
    const auth = await requireStaff(request, 'user.manage');

    const target = await queryOne<{
      id: string;
      email: string;
      full_name: string;
      user_type: 'supplier' | 'staff';
      is_superadmin: boolean;
      is_active: boolean;
      supplier_code: string | null;
    }>(
      `SELECT u.id, u.email, u.full_name, u.user_type, u.is_superadmin, u.is_active,
              c.code AS supplier_code
         FROM users u LEFT JOIN suppliers c ON c.id = u.supplier_id
        WHERE u.id = $1`,
      [params.id],
    );

    if (!target) return err('That account was not found.', 404);

    // Staff passwords are not resettable this way. Only a superadmin may reset
    // another staff member, and never a fellow superadmin.
    if (target.user_type === 'staff') {
      if (!auth.isSuperadmin) {
        return err('Only a superadmin can reset a staff password.', 403);
      }
      if (target.is_superadmin && target.id !== auth.userId) {
        return err('A superadmin password cannot be reset by another account.', 403);
      }
    }

    if (!target.is_active) {
      return err('That account is deactivated. Reactivate it before resetting the password.', 409);
    }

    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);

    await transaction(async (client) => {
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                must_change_password = true,
                failed_logins = 0,
                locked_until = NULL,
                password_reset_by = $3,
                password_reset_at = now()
          WHERE id = $1`,
        [target.id, passwordHash, auth.userId],
      );

      // Any reset links the supplier already has are now void.
      await client.query(
        `UPDATE auth_tokens SET consumed_at = now()
          WHERE user_id = $1 AND purpose = 'reset_password' AND consumed_at IS NULL`,
        [target.id],
      );

      // Sign them out everywhere: if the account was compromised, this is what
      // removes the intruder.
      await client.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [target.id],
      );

      // Resetting someone's credentials is exactly what an audit log is for.
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_email, action, entity, entity_id, after, ip_address, user_agent)
              VALUES ($1, $2, 'password.reset', 'user', $3, $4, $5, $6)`,
        [
          auth.userId,
          auth.email,
          target.id,
          JSON.stringify({
            targetEmail: target.email,
            supplierCode: target.supplier_code,
            mustChangePassword: true,
          }),
          request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null,
          request.headers.get('user-agent')?.slice(0, 400) ?? null,
        ],
      );

      await client.query(
        `INSERT INTO notifications (user_id, title, body, category, link_url)
              VALUES ($1, 'Your password was reset',
                      'A member of our team issued you a temporary password. You will be asked to choose a new one when you sign in.',
                      'account', '/login')`,
        [target.id],
      );
    });

    // The only time this value is ever visible. It is not stored in plain
    // text and cannot be retrieved again.
    return ok({
      user: {
        id: target.id,
        email: target.email,
        fullName: target.full_name,
        supplierCode: target.supplier_code,
      },
      temporaryPassword: password,
      mustChangePassword: true,
    });
  },
);
