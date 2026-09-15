'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main className="p-10 text-center text-slate-500">Loading…</main>}>
      <Verify />
    </Suspense>
  );
}

type State = 'working' | 'done' | 'failed';

function Verify() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<State>('working');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setState('failed');
      setMessage('This page needs the link from your email.');
      return;
    }

    (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const body = await res.json();

        if (!res.ok) {
          setState('failed');
          setMessage(body.error ?? 'That link could not be confirmed.');
          return;
        }
        setState('done');
        setMessage(
          body.alreadyVerified
            ? 'This address was already confirmed. Nothing more to do.'
            : `${body.email} is confirmed.`,
        );
      } catch {
        setState('failed');
        setMessage('Could not reach the server. Please try the link again.');
      }
    })();
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <Link href="/" className="mb-8 flex justify-center" aria-label="Home">
        <Logo height={112} />
      </Link>

      <div className="card p-6 text-center">
        {state === 'working' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Confirming…</h1>
            <p className="mt-3 text-sm text-slate-600">One moment.</p>
          </>
        )}

        {state === 'done' && (
          <>
            <h1 className="text-xl font-bold text-green-700">Email confirmed</h1>
            <p className="mt-3 text-sm text-slate-600">{message}</p>
            <Link href="/apply" className="btn-primary mt-6 w-full">
              Continue my application
            </Link>
          </>
        )}

        {state === 'failed' && (
          <>
            <h1 className="text-xl font-bold text-slate-900">Couldn&rsquo;t confirm</h1>
            <p className="mt-3 text-sm text-slate-600">{message}</p>
            <p className="mt-3 text-xs text-slate-500">
              Confirmation links expire after three days. You can request a new one from your
              account.
            </p>
            <Link href="/login" className="btn-secondary mt-6 w-full">
              Sign in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
