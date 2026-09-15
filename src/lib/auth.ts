import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { err } from '@/lib/api';

// Distinct from the customer portal's `cp_*` cookies. If the two portals are
// ever served from one apex domain, sharing a cookie name would have one
// portal's session silently overwrite the other's.
export const ACCESS_COOKIE = 'sp_access';
export const REFRESH_COOKIE = 'sp_refresh';

function accessSecret(): Uint8Array {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_ACCESS_SECRET is required in production');
    }
    return new TextEncoder().encode('dev-only-insecure-secret');
  }
  return new TextEncoder().encode(s);
}

export interface JwtPayload {
  sub: string;
  email: string;
  userType: 'supplier' | 'staff';
  supplierId: string | null;
  isSuperadmin: boolean;
  permissions: string[];
}

export interface AuthContext extends Omit<JwtPayload, 'sub'> {
  userId: string;
}

export async function signAccess(payload: JwtPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_ACCESS_EXPIRES ?? '30m')
    .sign(accessSecret());
}

export async function verifyAccess(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, accessSecret());
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

// --- password hashing -------------------------------------------------------

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// --- refresh tokens ---------------------------------------------------------

/** Returns the raw token (given to the client) and its hash (stored). */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// --- permission loading -----------------------------------------------------

export async function loadPermissions(userId: string): Promise<string[]> {
  const rows = await query<{ code: string }>(
    `SELECT DISTINCT p.code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p       ON p.id = rp.permission_id
      WHERE ur.user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.code);
}

// --- request guards ---------------------------------------------------------

function bearerFrom(request: NextRequest): string {
  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return request.cookies.get(ACCESS_COOKIE)?.value ?? '';
}

/** Throws a 401 Response when there is no valid session. */
export async function requireAuth(request: NextRequest): Promise<AuthContext> {
  const token = bearerFrom(request);
  const payload = token ? await verifyAccess(token) : null;

  if (!payload?.sub) throw err('Unauthorized', 401);

  return {
    userId: payload.sub,
    email: payload.email,
    userType: payload.userType,
    supplierId: payload.supplierId ?? null,
    isSuperadmin: Boolean(payload.isSuperadmin),
    permissions: payload.permissions ?? [],
  };
}

export function hasPermission(auth: AuthContext, permission: string): boolean {
  return auth.isSuperadmin || auth.permissions.includes(permission);
}

/** Staff-only guard. Throws 401/403. */
export async function requireStaff(
  request: NextRequest,
  permission?: string,
): Promise<AuthContext> {
  const auth = await requireAuth(request);
  if (auth.userType !== 'staff') throw err('Staff access required', 403);
  if (permission && !hasPermission(auth, permission)) {
    throw err(`Missing permission: ${permission}`, 403);
  }
  return auth;
}

export interface PortalSupplier {
  id: string;
  company_id: string;
  code: string;
  name: string;
  status: string;
  payment_terms_days: number;
  currency: string;
  accreditation_expires_at: string | null;
  /** True when the accreditation date has passed. Computed in SQL. */
  accreditation_expired: boolean;
}

/**
 * Resolves the supplier behind a portal session.
 *
 * Every supplier-facing route MUST go through this and scope its queries to
 * the returned id — it is the single thing standing between one supplier and
 * another's purchase orders, prices and payment records. Leaking a competitor's
 * quoted prices would be a commercial injury, not just a privacy one.
 *
 * It re-reads supplier_id from the database rather than trusting the JWT, so
 * suspending a supplier takes effect on the next request instead of at token
 * expiry.
 */
export async function requireSupplier(
  request: NextRequest,
): Promise<{ auth: AuthContext; supplier: PortalSupplier }> {
  const auth = await requireAuth(request);
  if (auth.userType !== 'supplier') throw err('Supplier account required', 403);

  const row = await queryOne<{ supplier_id: string | null }>(
    `SELECT supplier_id FROM users WHERE id = $1 AND is_active`,
    [auth.userId],
  );
  if (!row?.supplier_id) {
    throw err('This account is not linked to an accredited supplier yet.', 403);
  }

  const supplier = await queryOne<PortalSupplier>(
    `SELECT id, company_id, code, name, status, payment_terms_days, currency,
            accreditation_expires_at,
            (accreditation_expires_at IS NOT NULL
              AND accreditation_expires_at < current_date) AS accreditation_expired
       FROM suppliers WHERE id = $1`,
    [row.supplier_id],
  );
  if (!supplier) throw err('Linked supplier not found.', 404);

  if (supplier.status === 'closed' || supplier.status === 'suspended') {
    throw err(`This account is ${supplier.status}. Please contact the purchasing team.`, 403);
  }
  if (supplier.status === 'blacklisted') {
    // Deliberately vague: the reason is an internal commercial judgement.
    throw err('This account is not active. Please contact the purchasing team.', 403);
  }

  return { auth, supplier };
}

/**
 * Read access is allowed with a lapsed accreditation — a supplier must still
 * be able to see history and chase payment on work already done. This guard is
 * for the actions that create new commitments (acknowledging a PO, submitting
 * a price list), which a lapsed accreditation must not permit.
 */
export async function requireAccredited(
  request: NextRequest,
): Promise<{ auth: AuthContext; supplier: PortalSupplier }> {
  const ctx = await requireSupplier(request);
  if (ctx.supplier.accreditation_expired) {
    throw err(
      'Your accreditation expired on ' +
        `${ctx.supplier.accreditation_expires_at}. Renew it before taking this action.`,
      403,
    );
  }
  if (ctx.supplier.status === 'on_hold') {
    throw err('This account is on hold. Please contact the purchasing team.', 403);
  }
  return ctx;
}

// --- cookie helpers ---------------------------------------------------------

export function setAuthCookies(accessToken: string, refreshToken: string): void {
  const jar = cookies();
  const secure = process.env.NODE_ENV === 'production';

  jar.set(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });
  jar.set(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAuthCookies(): void {
  const jar = cookies();
  jar.delete(ACCESS_COOKIE);
  jar.delete(REFRESH_COOKIE);
}
