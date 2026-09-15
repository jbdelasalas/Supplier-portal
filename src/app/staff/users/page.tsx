'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  user_type: 'supplier' | 'staff';
  is_active: boolean;
  is_superadmin: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  locked_until: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  password_reset_at: string | null;
  password_reset_by_email: string | null;
}

interface Issued {
  user: { email: string; fullName: string; supplierCode: string | null };
  temporaryPassword: string;
}

export default function StaffUsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<UserRow | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('q', search.trim());
      const res = await fetch(`/api/staff/users?${qs}`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not load accounts.');
        return;
      }
      setUsers((await res.json()).users);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function reset(user: UserRow) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/staff/users/${user.id}/reset-password`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'The reset failed.');
        setConfirming(null);
        return;
      }
      setIssued(body);
      setConfirming(null);
      setCopied(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SiteHeader href="/staff/applications">
        <Link href="/staff/applications" className="text-sm text-slate-600 hover:text-slate-900">
          Applications
        </Link>
      </SiteHeader>

      <main className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Portal accounts</h1>
            <p className="mt-1 text-sm text-slate-600">
              Reset a password for a supplier who cannot sign in.
            </p>
          </div>
          <input
            className="input max-w-xs"
            placeholder="Search name, email or supplier code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {error && <p className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</p>}

        {/* The issued password, shown once. */}
        {issued && (
          <div className="mt-6 rounded-lg border-2 border-green-300 bg-green-50 p-5">
            <h2 className="font-semibold text-green-900">
              Temporary password for {issued.user.fullName}
            </h2>
            <p className="mt-1 text-sm text-green-800">
              {issued.user.email}
              {issued.user.supplierCode ? ` · ${issued.user.supplierCode}` : ''}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="rounded-md border border-green-300 bg-white px-4 py-2.5 font-mono text-lg tracking-wide text-slate-900">
                {issued.temporaryPassword}
              </code>
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(issued.temporaryPassword);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <p className="mt-4 text-sm text-green-900">
              Give this to the supplier directly — by phone or in person. They will be asked to
              choose their own password as soon as they sign in.
            </p>
            <p className="mt-2 text-xs text-green-700">
              This is the only time it is shown. It is not stored anywhere and cannot be
              retrieved again. Their other sessions have been signed out.
            </p>

            <button
              type="button"
              className="btn-secondary mt-4 text-sm"
              onClick={() => setIssued(null)}
            >
              Done
            </button>
          </div>
        )}

        {/* Confirmation, because this signs the supplier out everywhere. */}
        {confirming && (
          <div className="mt-6 rounded-lg border-2 border-amber-300 bg-amber-50 p-5">
            <h2 className="font-semibold text-amber-900">
              Reset the password for {confirming.full_name}?
            </h2>
            <p className="mt-2 text-sm text-amber-800">
              {confirming.email}
              {confirming.supplier_code ? ` · ${confirming.supplier_code}` : ''}
            </p>
            <p className="mt-3 text-sm text-amber-800">
              Their current password stops working immediately and they are signed out on every
              device. Only do this when you are confident who you are speaking to.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="btn-danger text-sm"
                disabled={busy}
                onClick={() => reset(confirming)}
              >
                {busy ? 'Resetting…' : 'Yes, reset it'}
              </button>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="card mt-6 overflow-hidden">
          {loading ? (
            <p className="p-8 text-center text-sm text-slate-500">Loading…</p>
          ) : users.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">No accounts found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Supplier</th>
                    <th className="px-4 py-3 font-medium">Last sign-in</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{u.full_name}</div>
                        <div className="text-xs text-slate-500">{u.email}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {u.supplier_code ? (
                          <>
                            <div className="font-mono text-xs">{u.supplier_code}</div>
                            <div className="text-xs text-slate-400">{u.supplier_name}</div>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {u.user_type === 'staff' ? 'Staff' : 'Not yet approved'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        {!u.is_active ? (
                          <span className="badge bg-slate-200 text-slate-600">Deactivated</span>
                        ) : u.must_change_password ? (
                          <span className="badge bg-amber-100 text-amber-700">Temp password</span>
                        ) : u.locked_until && new Date(u.locked_until) > new Date() ? (
                          <span className="badge bg-red-100 text-red-700">Locked</span>
                        ) : (
                          <span className="badge bg-green-100 text-green-700">Active</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          className="text-sm text-brand-600 hover:text-brand-700 disabled:text-slate-300"
                          disabled={!u.is_active}
                          onClick={() => {
                            setIssued(null);
                            setConfirming(u);
                          }}
                        >
                          Reset password
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
