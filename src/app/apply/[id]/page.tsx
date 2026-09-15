'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface ApplicationView {
  application: {
    id: string;
    referenceNo: string;
    status: string;
    businessName: string | null;
    submittedAt: string | null;
    decisionNotes: string | null;
    supplierId: string | null;
    companyName: string;
  };
  events: {
    id: string;
    event_type: string;
    message: string | null;
    actor_label: string | null;
    created_at: string;
  }[];
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-blue-100 text-blue-700',
  under_review: 'bg-amber-100 text-amber-700',
  info_requested: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  withdrawn: 'bg-slate-100 text-slate-500',
};

const STATUS_COPY: Record<string, string> = {
  submitted: 'We have received your application and it is queued for review.',
  under_review: 'Someone from our team is reviewing your application now.',
  info_requested: 'We need a little more information before we can proceed.',
  approved: 'Your account is open. You can start placing orders.',
  rejected:
    'We were unable to approve this application. You can update your answers and submit it again — everything you entered and uploaded is still saved.',
};

export default function ApplicationStatusPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [view, setView] = useState<ApplicationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  // Kept apart from `error`, which replaces the whole page: a failed reopen
  // should leave the application on screen.
  const [reopenError, setReopenError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/applications/${params.id}`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Application not found.');
        return;
      }
      setView(await res.json());
    })();
  }, [params.id]);

  if (error) return <main className="p-10 text-center text-red-600">{error}</main>;
  if (!view) return <main className="p-10 text-center text-slate-500">Loading…</main>;

  const { application, events } = view;
  const editable = ['draft', 'info_requested'].includes(application.status);

  /** Move a rejected application back to draft, then continue editing it. */
  async function reopen() {
    setReopening(true);
    setReopenError(null);
    try {
      const res = await fetch(`/api/applications/${application.id}/reopen`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setReopenError(body.error ?? 'Could not reopen this application.');
        return;
      }
      router.push('/apply');
    } catch {
      setReopenError('Could not reopen this application. Please try again.');
    } finally {
      setReopening(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="text-sm font-medium text-brand-600">{application.companyName}</p>
      <h1 className="mt-1 text-2xl font-bold text-slate-900">
        {application.businessName ?? 'Your application'}
      </h1>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className={`badge ${STATUS_STYLES[application.status] ?? 'bg-slate-100'}`}>
          {application.status.replace(/_/g, ' ')}
        </span>
        <span className="font-mono text-sm text-slate-500">{application.referenceNo}</span>
      </div>

      {STATUS_COPY[application.status] && (
        <p className="mt-4 rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700">
          {STATUS_COPY[application.status]}
        </p>
      )}

      {application.decisionNotes && (
        <div className="card mt-4 p-4">
          <p className="text-sm font-medium text-slate-800">Notes from our team</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
            {application.decisionNotes}
          </p>
        </div>
      )}

      {reopenError && <p className="mt-4 text-sm text-red-600">{reopenError}</p>}

      <div className="mt-6 flex gap-3">
        {editable && (
          <Link href="/apply" className="btn-primary">
            Continue editing
          </Link>
        )}
        {application.status === 'rejected' && (
          <button type="button" className="btn-primary" onClick={reopen} disabled={reopening}>
            {reopening ? 'Reopening…' : 'Edit and resubmit'}
          </button>
        )}
        {application.status === 'approved' && (
          <Link href="/portal" className="btn-primary">
            Go to the portal
          </Link>
        )}
      </div>

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Progress
        </h2>
        <ol className="mt-4 space-y-4 border-l-2 border-slate-200 pl-5">
          {events.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full bg-brand-500 ring-4 ring-white" />
              <p className="text-sm text-slate-800">
                {e.message ?? e.event_type.replace(/_/g, ' ')}
              </p>
              <p className="text-xs text-slate-400">
                {new Date(e.created_at).toLocaleString()}
                {e.actor_label ? ` · ${e.actor_label}` : ''}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
