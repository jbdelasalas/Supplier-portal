'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';

// useSearchParams needs a Suspense boundary in the App Router.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="p-10 text-center text-slate-500">Loading…</main>}>
      <ResetForm />
    </Suspense>
  );
}

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (password.length < 10) {
      setError('Please use a password of at least 10 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'Could not reset the password.');
        return;
      }
      setDone(true);
      setTimeout(() => router.push('/login'), 2500);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-8 flex justify-center" aria-label="Home">
          <Logo height={112} />
        </Link>
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">Link incomplete</h1>
          <p className="mt-3 text-sm text-slate-600">
            This page needs the link from your email. Try opening it again, or request a new one.
          </p>
          <Link href="/forgot-password" className="btn-primary mt-6 w-full">
            Request a new link
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 flex justify-center" aria-label="Home">
        <Logo height={112} />
      </Link>

      {done ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">Password changed</h1>
          <p className="mt-3 text-sm text-slate-600">
            You&rsquo;ve been signed out everywhere else. Taking you to sign in…
          </p>
          <Link href="/login" className="btn-primary mt-6 w-full">
            Sign in now
          </Link>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-bold text-slate-900">Choose a new password</h1>

          <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <div>
              <label htmlFor="password" className="label">New password</label>
              <input
                id="password"
                type="password"
                className="input"
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
        </>
      )}
    </main>
  );
}
