'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import DocumentUpload from '@/components/DocumentUpload';
import type { FormSchema } from '@/lib/forms';

interface Detail {
  application: {
    id: string;
    referenceNo: string;
    status: string;
    data: Record<string, unknown>;
    businessName: string | null;
    applicantEmail: string;
    submittedAt: string | null;
    decisionNotes: string | null;
    supplierId: string | null;
    companyName: string;
    reopenCount: number;
  };
  form: { schema: FormSchema; version: number };
  documents: {
    id: string;
    doc_key: string;
    file_name: string;
    size_bytes: string;
    status: string;
    capture_source?: 'camera' | 'upload' | null;
    captured_at?: string | null;
    latitude?: string | null;
    longitude?: string | null;
  }[];
  events: {
    id: string;
    event_type: string;
    message: string | null;
    is_public: boolean;
    actor_label: string | null;
    created_at: string;
  }[];
}

interface SignatureRow {
  signature_key: string;
  signatory_name: string;
  signatory_position: string | null;
  signature_data: string;
  declaration_text: string;
  signed_at: string;
  ip_address: string | null;
  evidence_hash: string;
}

type Action = 'approve' | 'reject' | 'request_info' | 'start_review';

export default function ReviewApplicationPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState({ paymentTermsDays: '', ewtRate: '' });
  const [busy, setBusy] = useState<Action | null>(null);
  const [signatures, setSignatures] = useState<SignatureRow[]>([]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/applications/${params.id}`);
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? 'Application not found.');
      return;
    }
    setDetail(await res.json());

    // Signatures come from their own endpoint, which returns the audit
    // context (IP, hash, declaration text) only to staff.
    const sig = await fetch(`/api/applications/${params.id}/signature`);
    if (sig.ok) setSignatures((await sig.json()).signatures ?? []);
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: Action) {
    if (!detail) return;

    if ((action === 'reject' || action === 'request_info') && !notes.trim()) {
      setError('Please write a note explaining your decision.');
      return;
    }

    setBusy(action);
    setError(null);

    try {
      const payload: Record<string, unknown> = { action, notes: notes.trim() || undefined };
      if (action === 'approve') {
        if (terms.paymentTermsDays) payload.paymentTermsDays = Number(terms.paymentTermsDays);
        if (terms.ewtRate) payload.ewtRate = Number(terms.ewtRate);
      }

      const res = await fetch(`/api/staff/applications/${params.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();

      if (!res.ok) {
        setError(body.error ?? 'That action failed.');
        return;
      }

      if (action === 'approve') {
        router.push('/staff/applications');
        return;
      }
      setNotes('');
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error && !detail) return <main className="p-10 text-center text-red-600">{error}</main>;
  if (!detail) return <main className="p-10 text-center text-slate-500">Loading…</main>;

  const { application, form, documents, events } = detail;

  // Photos and documents share a table. The schema says which keys are photos.
  const photoKeys = new Set((form.schema.photos ?? []).map((p) => p.key));
  const photos = documents.filter((d) => photoKeys.has(d.doc_key));
  const notarisedKey = form.schema.notarisedDocument?.key;
  const notarised = notarisedKey ? documents.find((d) => d.doc_key === notarisedKey) : undefined;
  const files = documents.filter(
    (d) => !photoKeys.has(d.doc_key) && d.doc_key !== notarisedKey,
  );
  const decided = ['approved', 'rejected', 'withdrawn'].includes(application.status);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/staff/applications" className="text-sm text-brand-600 hover:text-brand-700">
        ← Back to the queue
      </Link>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            {application.businessName ?? 'Untitled application'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{application.referenceNo}</span> ·{' '}
            {application.applicantEmail} · {application.companyName}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A previously rejected application that has come back around: the
              reviewer should know before reading the answers. */}
          {application.reopenCount > 0 && (
            <span className="badge bg-purple-100 text-purple-700">
              Resubmission · attempt {application.reopenCount + 1}
            </span>
          )}
          <span className="badge bg-slate-100 text-slate-700">
            {application.status.replace(/_/g, ' ')}
          </span>
        </div>
      </header>

      {error && <p className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        {/* ---- submitted answers ------------------------------------------ */}
        <div className="space-y-6 lg:col-span-2">
          {form.schema.sections.map((section) => (
            <section key={section.key} className="card p-6">
              <h2 className="text-base font-semibold text-slate-900">{section.title}</h2>
              <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {section.fields
                  .filter((f) => f.type !== 'section_note')
                  .map((f) => {
                    const raw = application.data[f.key];
                    const shown =
                      raw === true ? 'Yes'
                      : raw === false ? 'No'
                      : Array.isArray(raw) ? raw.join(', ')
                      : raw === undefined || raw === null || raw === '' ? '—'
                      : String(raw);

                    // Show the option label rather than the stored value.
                    const label =
                      f.options?.find((o) => o.value === String(raw))?.label ?? shown;

                    return (
                      <div key={f.key}>
                        <dt className="text-xs uppercase tracking-wide text-slate-400">
                          {f.label}
                        </dt>
                        <dd className="mt-0.5 text-sm text-slate-800">{label}</dd>
                      </div>
                    );
                  })}
              </dl>
            </section>
          ))}

          {signatures.length > 0 && (
            <section className="card p-6">
              <h2 className="text-base font-semibold text-slate-900">Signature</h2>
              {signatures.map((s) => (
                <div key={s.signature_key} className="mt-4">
                  <div className="rounded-md border border-slate-200 bg-white p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.signature_data}
                      alt={`Signature of ${s.signatory_name}`}
                      className="max-h-32 object-contain"
                    />
                  </div>
                  <p className="mt-2 text-sm font-medium text-slate-800">
                    {s.signatory_name}
                    {s.signatory_position ? `, ${s.signatory_position}` : ''}
                  </p>

                  {/* The audit trail. This is what makes the signature hold up
                      if the supplier later disputes the account. */}
                  <dl className="mt-3 space-y-1 text-xs text-slate-500">
                    <div>Signed {new Date(s.signed_at).toLocaleString()}</div>
                    {s.ip_address && <div>IP {s.ip_address}</div>}
                    <div className="break-all">Evidence hash {s.evidence_hash?.slice(0, 32)}…</div>
                  </dl>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-brand-600">
                      Declaration agreed to
                    </summary>
                    <p className="mt-2 rounded bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                      {s.declaration_text}
                    </p>
                  </details>
                </div>
              ))}
            </section>
          )}

          {photos.length > 0 && (
            <section className="card p-6">
              <h2 className="text-base font-semibold text-slate-900">Photos</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {photos.map((p) => {
                  const label =
                    form.schema.photos?.find((x) => x.key === p.doc_key)?.label ?? p.doc_key;
                  return (
                    <figure key={p.id}>
                      <a
                        href={`/api/documents/${p.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block overflow-hidden rounded-md border border-slate-200 bg-slate-50"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/documents/${p.id}`}
                          alt={label}
                          className="h-48 w-full object-cover transition-opacity hover:opacity-90"
                          loading="lazy"
                        />
                      </a>
                      <figcaption className="mt-2">
                        <p className="text-sm font-medium text-slate-800">{label}</p>
                        <p className="text-xs text-slate-500">
                          {p.capture_source === 'camera' ? '📷 Taken with camera' : 'Uploaded file'}
                          {p.captured_at ? ` · ${new Date(p.captured_at).toLocaleString()}` : ''}
                        </p>
                        {p.latitude && p.longitude && (
                          <a
                            href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-brand-600 hover:text-brand-700"
                          >
                            View location on map ↗
                          </a>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card p-6">
            <h2 className="text-base font-semibold text-slate-900">Documents</h2>
            {files.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No documents were uploaded.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {files.map((d) => {
                  const label =
                    form.schema.documents?.find((x) => x.key === d.doc_key)?.label ?? d.doc_key;
                  return (
                    <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <a
                          href={`/api/documents/${d.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-brand-600 hover:text-brand-700"
                        >
                          {label} ↗
                        </a>
                        <p className="truncate text-xs text-slate-500">
                          {d.file_name} · {(Number(d.size_bytes) / 1024 / 1024).toFixed(2)} MB
                        </p>
                      </div>
                      <span className="badge bg-slate-100 text-slate-600">{d.status}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* ---- decision panel --------------------------------------------- */}
        <div className="space-y-6">
          {!decided && (
            <section className="card p-6">
              <h2 className="text-base font-semibold text-slate-900">Decision</h2>

              <label htmlFor="notes" className="label mt-4">
                Notes
              </label>
              <textarea
                id="notes"
                rows={4}
                className="input"
                placeholder="Required when rejecting or asking for more information."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="terms" className="label">Terms (days)</label>
                  <input
                    id="terms"
                    type="number"
                    min={0}
                    className="input"
                    placeholder="30"
                    value={terms.paymentTermsDays}
                    onChange={(e) => setTerms((t) => ({ ...t, paymentTermsDays: e.target.value }))}
                  />
                </div>
                <div>
                  <label htmlFor="credit" className="label">Credit limit</label>
                  <input
                    id="credit"
                    type="number"
                    min={0}
                    className="input"
                    placeholder="100000"
                    value={terms.ewtRate}
                    onChange={(e) => setTerms((t) => ({ ...t, ewtRate: e.target.value }))}
                  />
                </div>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Applied when you approve. The applicant&apos;s requested terms are only a request.
              </p>

              <div className="mt-5 space-y-2">
                <button
                  type="button"
                  className="btn-primary w-full"
                  disabled={busy !== null}
                  onClick={() => act('approve')}
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve & create supplier'}
                </button>
                <button
                  type="button"
                  className="btn-secondary w-full"
                  disabled={busy !== null}
                  onClick={() => act('request_info')}
                >
                  Ask for more information
                </button>
                <button
                  type="button"
                  className="btn-danger w-full"
                  disabled={busy !== null}
                  onClick={() => act('reject')}
                >
                  Reject
                </button>
                {application.status === 'submitted' && (
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    disabled={busy !== null}
                    onClick={() => act('start_review')}
                  >
                    Mark as in review
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Print the CIS for notarisation, and take the signed copy back. */}
          {form.schema.notarisedDocument && (
            <section className="card p-6">
              <h2 className="text-base font-semibold text-slate-900">
                Notarised CIS
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Print the completed sheet, have the supplier sign it before a notary, then
                upload the notarised copy here.
              </p>

              <a
                href={`/apply/${params.id}/print`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary mt-4 w-full text-sm"
              >
                Open printable CIS ↗
              </a>

              <div className="mt-4">
                {notarised ? (
                  <div className="rounded-md border border-green-200 bg-green-50 p-3">
                    <p className="text-sm font-medium text-green-800">Notarised copy on file</p>
                    <a
                      href={`/api/documents/${notarised.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 block truncate text-xs text-green-700 underline"
                    >
                      {notarised.file_name} ↗
                    </a>
                  </div>
                ) : (
                  <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    Not yet received.
                  </p>
                )}

                <div className="mt-3">
                  <DocumentUpload
                    applicationId={params.id}
                    documents={[form.schema.notarisedDocument]}
                    uploadedKeys={notarised ? [form.schema.notarisedDocument.key] : []}
                    onUploaded={() => load()}
                    bare
                  />
                </div>
              </div>
            </section>
          )}

          <section className="card p-6">
            <h2 className="text-base font-semibold text-slate-900">History</h2>
            <ol className="mt-4 space-y-3">
              {events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="text-slate-800">
                    {e.message ?? e.event_type.replace(/_/g, ' ')}
                    {!e.is_public && (
                      <span className="ml-1 text-xs text-slate-400">(internal)</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">
                    {new Date(e.created_at).toLocaleString()}
                    {e.actor_label ? ` · ${e.actor_label}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
