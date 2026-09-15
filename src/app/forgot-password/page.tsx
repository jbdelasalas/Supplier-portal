'use client';

import { useState } from 'react';
import Link from 'next/link';
import Logo from '@/components/Logo';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only ever populated in development, where no mail provider is configured.
  const [devToken, setDevToken] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'Something went wrong. Please try again.');
        return;
      }
      if (body.devResetToken) setDevToken(body.devResetToken);
      setSent(true);
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

      {sent ? (
        <div className="card p-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">Request received</h1>
          <p className="mt-3 text-sm text-slate-600">
            If <span className="font-medium">{email}</span> has an account, a reset link is on
            its way.
          </p>
          {/* Email delivery is not live yet, so pointing only at the inbox
              would leave people waiting for something that never arrives. */}
          <div className="mt-4 rounded-md bg-slate-50 px-4 py-3 text-left text-sm text-slate-700">
            <p className="font-medium">Need it sooner?</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Call us and our team can issue you a temporary password over the phone. Have your
              supplier code or business name ready so we can confirm who you are.
            </p>
          </div>

          {devToken && (
            <div className="mt-4 rounded-md bg-amber-50 p-3 text-left">
              <p className="text-xs font-medium text-amber-800">
                Email isn&rsquo;t configured on this environment. Use this link:
              </p>
              <Link
                href={`/reset-password?token=${devToken}`}
                className="mt-1 block break-all text-xs text-brand-600 underline"
              >
                /reset-password?token={devToken.slice(0, 24)}…
              </Link>
            </div>
          )}

          <Link href="/login" className="btn-secondary mt-6 w-full">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <h1 className="text-2xl font-bold text-slate-900">Forgot your password?</h1>
          <p className="mt-2 text-sm text-slate-600">
            Enter the email you registered with and we&rsquo;ll send you a link to set a new
            password.
          </p>

          <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            )}

            <div>
              <label htmlFor="email" className="label">Email</label>
              <input
                id="email"
                type="email"
                className="input"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-slate-600">
            Remembered it?{' '}
            <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">
              Sign in
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
