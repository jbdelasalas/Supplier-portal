'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'Sign in failed.');
        return;
      }

      const user = body.user;

      // A temporary password issued by staff: they choose their own before
      // going anywhere else.
      if (user.mustChangePassword) {
        router.push('/change-password?required=1');
        return;
      }

      // Staff go to the review queue; suppliers go to the portal, or to their
      // application if they have not been approved yet.
      if (user.userType === 'staff') router.push('/staff/applications');
      else if (user.supplierId) router.push('/portal');
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

      <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>

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

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className="label">Password</label>
            <Link
              href="/forgot-password"
              className="mb-1 text-xs text-brand-600 hover:text-brand-700"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            className="input"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-slate-600">
        New supplier?{' '}
        <Link href="/register" className="font-medium text-brand-600 hover:text-brand-700">
          Apply for an account
        </Link>
      </p>
    </main>
  );
}
