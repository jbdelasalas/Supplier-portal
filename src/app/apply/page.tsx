'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import FormRenderer from '@/components/FormRenderer';
import SiteHeader from '@/components/SiteHeader';
import DocumentUpload from '@/components/DocumentUpload';
import PhotoCapture, { type CaptureMeta } from '@/components/PhotoCapture';
import SignaturePad from '@/components/SignaturePad';
import type { FormSchema, FormData, ValidationError } from '@/lib/forms';

interface LoadedForm {
  formVersionId: string;
  name: string;
  description: string | null;
  company: { id: string; name: string };
  schema: FormSchema;
}

type Save = 'idle' | 'saving' | 'saved' | 'error';

export default function ApplyPage() {
  const router = useRouter();

  const [form, setForm] = useState<LoadedForm | null>(null);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('draft');
  const [data, setData] = useState<FormData>({});
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [uploadedKeys, setUploadedKeys] = useState<string[]>([]);
  // docKey -> document id, so an already-captured photo renders as an image.
  const [uploadedIds, setUploadedIds] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [save, setSave] = useState<Save>('idle');
  const [submitting, setSubmitting] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestData = useRef<FormData>({});

  // Signature state. `signature` is the drawn PNG awaiting confirmation;
  // `signed` is the server-recorded timestamp once it is stored.
  const [signature, setSignature] = useState<string | null>(null);
  const [signed, setSigned] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  // --- bootstrap ------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const meRes = await fetch('/api/auth/me');
        if (meRes.status === 401) {
          router.push('/login');
          return;
        }
        const me = await meRes.json();

        // Already approved — the application step is behind them.
        if (me.user?.supplier) {
          router.push('/portal');
          return;
        }

        const formRes = await fetch('/api/public/form');
        if (!formRes.ok) {
          setFatal('No application form is published yet. Please contact us.');
          return;
        }
        const loaded: LoadedForm = await formRes.json();
        setForm(loaded);

        // Resume the existing application, or start one.
        const existingId: string | undefined = me.application?.id;
        if (existingId) {
          const appRes = await fetch(`/api/applications/${existingId}`);
          if (appRes.ok) {
            const app = await appRes.json();
            setApplicationId(app.application.id);
            setStatus(app.application.status);
            setData(app.application.data ?? {});
            latestData.current = app.application.data ?? {};
            const docs: { id: string; doc_key: string }[] = app.documents ?? [];
            setUploadedKeys(docs.map((d) => d.doc_key));
            setUploadedIds(Object.fromEntries(docs.map((d) => [d.doc_key, d.id])));

            // Show the declaration as already signed when resuming a draft,
            // rather than presenting an empty pad over a signature we hold.
            const sigRes = await fetch(`/api/applications/${existingId}/signature`);
            if (sigRes.ok) {
              const { signatures } = await sigRes.json();
              if (signatures?.length) setSigned(signatures[0].signed_at);
            }

            if (['submitted', 'under_review', 'approved', 'rejected'].includes(app.application.status)) {
              router.push(`/apply/${app.application.id}`);
              return;
            }
          }
        } else {
          const created = await fetch('/api/applications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ formVersionId: loaded.formVersionId, data: {} }),
          });
          if (created.ok) {
            const c = await created.json();
            setApplicationId(c.id);
          } else {
            setFatal((await created.json()).error ?? 'Could not start an application.');
          }
        }
      } catch {
        setFatal('Could not load the application form.');
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  // --- autosave -------------------------------------------------------------
  const persist = useCallback(
    async (payload: FormData) => {
      if (!applicationId) return;
      setSave('saving');
      try {
        const res = await fetch(`/api/applications/${applicationId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: payload }),
        });
        setSave(res.ok ? 'saved' : 'error');
      } catch {
        setSave('error');
      }
    },
    [applicationId],
  );

  function onChange(key: string, value: unknown) {
    setData((prev) => {
      const next = { ...prev, [key]: value };
      latestData.current = next;
      return next;
    });
    // Clear this field's error as soon as the applicant edits it.
    setErrors((prev) => prev.filter((e) => e.field !== key));

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(latestData.current), 1200);
  }

  /** Sends a captured photo with its context to the documents endpoint. */
  async function uploadPhoto(key: string, file: File, meta: CaptureMeta) {
    if (!applicationId) return;

    const body = new FormData();
    body.append('file', file);
    body.append('docKey', key);
    body.append('captureSource', meta.source);
    body.append('capturedAt', meta.capturedAt);
    if (meta.latitude !== undefined) body.append('latitude', String(meta.latitude));
    if (meta.longitude !== undefined) body.append('longitude', String(meta.longitude));
    if (meta.accuracy !== undefined) body.append('accuracy', String(meta.accuracy));

    const res = await fetch(`/api/applications/${applicationId}/documents`, {
      method: 'POST',
      body,
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.error ?? 'Upload failed.');
    }
    const saved = await res.json().catch(() => null);
    setUploadedKeys((k) => (k.includes(key) ? k : [...k, key]));
    if (saved?.id) setUploadedIds((m) => ({ ...m, [key]: saved.id }));
  }

  async function saveSignature() {
    if (!applicationId || !signature || !form?.schema.signature) return;

    const name = String(latestData.current.signatory_name ?? '').trim();
    const position = String(latestData.current.signatory_position ?? '').trim();

    // The signature is meaningless without knowing who signed, and these live
    // in the declaration section directly above the pad.
    if (name.length < 2) {
      setSignError('Please enter the name of the authorised signatory above before signing.');
      return;
    }

    setSigning(true);
    setSignError(null);
    try {
      // Flush the form first, so the stored name matches what was on screen.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await persist(latestData.current);

      const res = await fetch(`/api/applications/${applicationId}/signature`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureKey: form.schema.signature.key,
          signatureData: signature,
          signatoryName: name,
          signatoryPosition: position || undefined,
          declarationText: form.schema.signature.declarationText,
          method: 'drawn',
        }),
      });
      const body = await res.json();

      if (!res.ok) {
        setSignError(body.error ?? 'Could not record the signature.');
        return;
      }
      setSigned(body.signedAt);
      setSignature(null);
    } catch {
      setSignError('Could not reach the server. Please try again.');
    } finally {
      setSigning(false);
    }
  }

  async function submit() {
    if (!applicationId) return;
    setSubmitting(true);
    setErrors([]);

    try {
      // Flush any pending autosave first, so the server validates what the
      // applicant actually sees.
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await persist(latestData.current);

      const res = await fetch(`/api/applications/${applicationId}/submit`, { method: 'POST' });
      const body = await res.json();

      if (!res.ok) {
        if (body.details) setErrors(body.details);
        setFatal(body.details ? null : body.error);
        // Take them to the first problem.
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      router.push(`/apply/${applicationId}`);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="p-10 text-center text-slate-500">Loading…</main>;
  }
  if (fatal && !form) {
    return <main className="p-10 text-center text-red-600">{fatal}</main>;
  }
  if (!form) return null;

  const readOnly = !['draft', 'info_requested'].includes(status);

  return (
    <>
      <SiteHeader href="/" />
      <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-sm font-medium text-brand-600">{form.company.name}</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{form.name}</h1>
        {form.description && <p className="mt-2 text-sm text-slate-600">{form.description}</p>}

        <p className="mt-3 text-xs text-slate-400">
          {save === 'saving' && 'Saving…'}
          {save === 'saved' && 'Draft saved.'}
          {save === 'error' && <span className="text-red-500">Could not save your draft.</span>}
          {save === 'idle' && 'Your answers save automatically as you type.'}
        </p>
      </header>

      {errors.length > 0 && (
        <div className="mb-6 rounded-md bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">
            Please fix {errors.length} {errors.length === 1 ? 'item' : 'items'} before submitting:
          </p>
          <ul className="mt-2 list-inside list-disc text-sm text-red-700">
            {errors.slice(0, 8).map((e) => (
              <li key={e.field}>{e.message}</li>
            ))}
          </ul>
        </div>
      )}

      <FormRenderer
        schema={form.schema}
        data={data}
        errors={errors}
        disabled={readOnly}
        onChange={onChange}
      />

      {applicationId && form.schema.photos?.length ? (
        <section className="card mt-8 p-6">
          <h2 className="text-lg font-semibold text-slate-900">Photos</h2>
          <p className="mt-1 text-sm text-slate-500">
            Taken with your camera so we can verify your business. If your camera
            isn&rsquo;t available, you can upload a photo instead.
          </p>

          <div className="mt-5 space-y-4">
            {form.schema.photos.map((photo) => (
              <PhotoCapture
                key={photo.key}
                label={photo.label + (photo.required ? ' *' : '')}
                hint={photo.hint}
                facing={photo.facing ?? 'environment'}
                disabled={readOnly}
                existing={
                  uploadedIds[photo.key]
                    ? { url: `/api/documents/${uploadedIds[photo.key]}` }
                    : uploadedKeys.includes(photo.key)
                      ? { url: null }
                      : null
                }
                onCapture={(file, meta) => uploadPhoto(photo.key, file, meta)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {applicationId && form.schema.documents?.length ? (
        <div className="mt-8">
          <DocumentUpload
            applicationId={applicationId}
            documents={form.schema.documents}
            uploadedKeys={uploadedKeys}
            disabled={readOnly}
            onUploaded={(key) => setUploadedKeys((k) => (k.includes(key) ? k : [...k, key]))}
          />
        </div>
      ) : null}

      {applicationId && form.schema.signature ? (
        <section className="card mt-8 p-6">
          <h2 className="text-lg font-semibold text-slate-900">
            {form.schema.signature.label}
            {form.schema.signature.required && <span className="ml-0.5 text-red-500">*</span>}
          </h2>

          <p className="mt-3 rounded-md bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
            {form.schema.signature.declarationText}
          </p>

          {signed ? (
            <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-medium text-green-800">
                Signed by {String(data.signatory_name ?? '')}
              </p>
              <p className="mt-1 text-xs text-green-700">
                Recorded {new Date(signed).toLocaleString()}.
              </p>
              {!readOnly && (
                <button
                  type="button"
                  className="mt-2 text-xs text-brand-600 hover:text-brand-700"
                  onClick={() => setSigned(null)}
                >
                  Sign again
                </button>
              )}
            </div>
          ) : (
            <div className="mt-4">
              <SignaturePad onChange={setSignature} disabled={readOnly} />

              {signError && <p className="mt-2 text-sm text-red-600">{signError}</p>}

              <button
                type="button"
                className="btn-primary mt-3"
                disabled={readOnly || !signature || signing}
                onClick={saveSignature}
              >
                {signing ? 'Recording…' : 'Confirm signature'}
              </button>
              <p className="mt-2 text-xs text-slate-500">
                Enter your name and position above before signing.
              </p>
            </div>
          )}
        </section>
      ) : null}


      {!readOnly && (
        <div className="mt-8 flex items-center justify-end gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => persist(latestData.current)}
            disabled={save === 'saving'}
          >
            Save draft
          </button>
          <button type="button" className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit application'}
          </button>
        </div>
      )}
      </main>
    </>
  );
}
