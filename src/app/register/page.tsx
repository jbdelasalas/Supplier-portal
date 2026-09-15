'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    confirm: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (form.password.length < 10) {
      setError('Please use a password of at least 10 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName,
          email: form.email,
          phone: form.phone || undefined,
          password: form.password,
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'Registration failed.');
        return;
      }
      // Straight into the application form — that is the point of signing up.
      router.push('/apply');
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

      <h1 className="text-2xl font-bold text-slate-900">Create your account</h1>
      <p className="mt-2 text-sm text-slate-600">
        You&apos;ll use this to fill in your application and, once approved, to place orders.
      </p>

      <form onSubmit={submit} className="card mt-6 space-y-4 p-6">
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}

        <div>
          <label htmlFor="fullName" className="label">Your name</label>
          <input id="fullName" className="input" required value={form.fullName} onChange={set('fullName')} />
        </div>

        <div>
          <label htmlFor="email" className="label">Email</label>
          <input id="email" type="email" className="input" required value={form.email} onChange={set('email')} />
        </div>

        <div>
          <label htmlFor="phone" className="label">Mobile <span className="font-normal text-slate-400">(optional)</span></label>
          <input id="phone" type="tel" className="input" value={form.phone} onChange={set('phone')} />
        </div>

        <div>
          <label htmlFor="password" className="label">Password</label>
          <input id="password" type="password" className="input" required minLength={10} value={form.password} onChange={set('password')} />
          <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>
        </div>

        <div>
          <label htmlFor="confirm" className="label">Confirm password</label>
          <input id="confirm" type="password" className="input" required value={form.confirm} onChange={set('confirm')} />
        </div>

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-slate-600">
        Already registered?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">
          Sign in
        </Link>
      </p>
    </main>
  );
}
