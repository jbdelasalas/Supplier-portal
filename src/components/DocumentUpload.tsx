'use client';

import { useState } from 'react';
import type { FormDocument } from '@/lib/forms';
import { compressImage, formatBytes } from '@/lib/compress-image';

interface Props {
  applicationId: string;
  documents: FormDocument[];
  uploadedKeys: string[];
  disabled?: boolean;
  onUploaded: (docKey: string) => void;
  /** Drop the card and heading when embedding this inside another section. */
  bare?: boolean;
}

/** One upload slot per document the form schema asks for. */
export default function DocumentUpload({
  applicationId,
  documents,
  uploadedKeys,
  disabled,
  onUploaded,
  bare = false,
}: Props) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function upload(doc: FormDocument, chosen: File) {
    setBusyKey(doc.key);
    setErrors((e) => ({ ...e, [doc.key]: '' }));
    setNotes((n) => ({ ...n, [doc.key]: '' }));

    try {
      // Shrink oversized photos before they cross the applicant's mobile data.
      // This runs ahead of the request, so a file over the slot's limit can
      // come back under it instead of being rejected.
      const { file, compressed, originalSize } = await compressImage(chosen);
      if (compressed) {
        setNotes((n) => ({
          ...n,
          [doc.key]: `optimised ${formatBytes(originalSize)} → ${formatBytes(file.size)}`,
        }));
      }

      const body = new FormData();
      body.append('file', file);
      body.append('docKey', doc.key);

      const res = await fetch(`/api/applications/${applicationId}/documents`, {
        method: 'POST',
        body,
      });

      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setErrors((e) => ({ ...e, [doc.key]: b.error ?? 'Upload failed.' }));
        return;
      }
      onUploaded(doc.key);
    } catch {
      setErrors((e) => ({ ...e, [doc.key]: 'Upload failed. Please try again.' }));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className={bare ? '' : 'card p-6'}>
      {!bare && (
        <>
          <h2 className="text-lg font-semibold text-slate-900">Supporting Documents</h2>
          <p className="mt-1 text-sm text-slate-500">
            Clear photos or scans are fine, as long as all details are readable.
          </p>
        </>
      )}

      <ul className={`divide-y divide-slate-100 ${bare ? '' : 'mt-5'}`}>
        {documents.map((doc) => {
          const done = uploadedKeys.includes(doc.key);
          const error = errors[doc.key];
          const note = notes[doc.key];
          const busy = busyKey === doc.key;

          return (
            <li key={doc.key} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800">
                  {doc.label}
                  {doc.required && <span className="ml-0.5 text-red-500">*</span>}
                </p>
                {error ? (
                  <p className="text-xs text-red-600">{error}</p>
                ) : (
                  <p className="text-xs text-slate-500">
                    {busy
                      ? 'Preparing…'
                      : done
                        ? note
                          ? `Uploaded · ${note}`
                          : 'Uploaded'
                        : `Max ${doc.maxSizeMb ?? 10} MB`}
                  </p>
                )}
              </div>

              {done && (
                <span className="badge bg-green-100 text-green-700">Received</span>
              )}

              <label className="btn-secondary cursor-pointer">
                {busy ? 'Uploading…' : done ? 'Replace' : 'Choose file'}
                <input
                  type="file"
                  className="hidden"
                  accept={doc.accept?.join(',')}
                  disabled={disabled || busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) upload(doc, file);
                    // Reset so choosing the same file again still fires.
                    e.target.value = '';
                  }}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
