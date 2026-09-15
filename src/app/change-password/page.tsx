'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';

export default function ChangePasswordPage() {
  return (
    <Suspense fallback={<main className="p-10 text-center text-slate-500">Loading…</main>}>
      <ChangeForm />
    </Suspense>
  );
}

function ChangeForm() {
  const router = useRouter();
  // Set when staff issued a temporary password, so the copy explains why the
  // supplier is here rather than in the portal.
  const forced = useSearchParams().get('required') === '1';

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (next !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }
    if (next.length < 10) {
      setError('Please use a password of at least 10 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'Could not change the password.');
        return;
      }

      // Where they were headed before this interrupted them.
      const me = await fetch('/api/auth/me');
      const info = me.ok ? await me.json() : null;
      if (info?.user?.userType === 'staff') router.push('/staff/applications');
      else if (info?.user?.supplier) router.push('/portal');
      else router.push('/apply');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 flex justify-center" aria-label="Home">
        <Logo height={112} />
      </Link>

      <h1 className="text-2xl font-bold text-slate-900">
        {forced ? 'Choose your own password' : 'Change your password'}
      </h1>

      {forced && (
        <p className="mt-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You signed in with a temporary password issued by our team. Please set your own
          before continuing — nobody else should know your password.
        </p>
      )}

      <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div>
          <label htmlFor="current" className="label">
            {forced ? 'Temporary password' : 'Current password'}
          </label>
          <input
            id="current"
            type="password"
            className="input"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="next" className="label">New password</label>
          <input
            id="next"
            type="password"
            className="input"
            required
            minLength={10}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>
        </div>

        <div>
          <label htmlFor="confirm" className="label">Confirm new password</label>
          <input
            id="confirm"
            type="password"
            className="input"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
      </form>
    </main>
  );
}
