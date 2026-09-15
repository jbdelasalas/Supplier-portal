'use client';

import { useEffect, useState } from 'react';
import type { FormSchema } from '@/lib/forms';

/**
 * The completed CIS, laid out for printing and notarisation.
 *
 * Deliberately plain: no site header, no navigation, black on white, and the
 * print stylesheet drops anything that isn't the form. What comes out of the
 * printer should look like the paper CIS, because a notary is going to stamp
 * it and it has to read as a formal document.
 */

interface Signature {
  signatory_name: string;
  signatory_position: string | null;
  signature_data: string;
  signed_at: string;
}

interface DocRow {
  id: string;
  doc_key: string;
}

interface Loaded {
  documents?: DocRow[];
  application: {
    referenceNo: string;
    data: Record<string, unknown>;
    businessName: string | null;
    companyName: string;
    status: string;
  };
  form: { schema: FormSchema };
}

export default function PrintCisPage({ params }: { params: { id: string } }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [signature, setSignature] = useState<Signature | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/applications/${params.id}`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Application not found.');
        return;
      }
      setLoaded(await res.json());

      const sig = await fetch(`/api/applications/${params.id}/signature`);
      if (sig.ok) {
        const { signatures } = await sig.json();
        if (signatures?.length) setSignature(signatures[0]);
      }
    })();
  }, [params.id]);

  if (error) return <main className="p-10 text-center text-red-600">{error}</main>;
  if (!loaded) return <main className="p-10 text-center text-slate-500">Loading…</main>;

  const { application, form } = loaded;

  // The 2x2 photo on the paper form is the selfie captured during signup.
  const selfieKey = (form.schema.photos ?? []).find((p) => p.facing === 'user')?.key ?? 'selfie';
  const selfie = (loaded.documents ?? []).find((d) => d.doc_key === selfieKey);
  const d = application.data;

  const show = (key: string): string => {
    const raw = d[key];
    if (raw === undefined || raw === null || raw === '') return '';
    if (raw === true) return 'Yes';
    if (raw === false) return 'No';
    if (Array.isArray(raw)) return raw.join(', ');

    // Prefer the option label over the stored value.
    for (const s of form.schema.sections) {
      const f = s.fields.find((x) => x.key === key);
      const opt = f?.options?.find((o) => o.value === String(raw));
      if (opt) return opt.label;
    }
    return String(raw);
  };

  return (
    <>
      <style>{`
        @media print {
          .no-print { display: none !important; }
          @page { size: A4; margin: 12mm; }
          body { background: #fff !important; }
          /* Browsers strip background colours when printing by default, which
             would flatten the logo and the yellow section bars the paper form
             uses to separate sections. */
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 border-b border-slate-200 bg-white px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
          <p className="text-sm text-slate-600">
            Print this for the supplier to sign before a notary, then upload the notarised copy
            on the review page.
          </p>
          <button type="button" onClick={() => window.print()} className="btn-primary">
            Print
          </button>
        </div>
      </div>

      <main className="mx-auto max-w-3xl bg-white px-8 py-8 text-[11px] leading-snug text-black">
        <header className="border-b-2 border-black pb-3">
          <div className="flex items-start gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo.png"
              alt=""
              className="h-20 w-auto shrink-0 object-contain"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold tracking-wide">
                ART FRESH CHICKEN CORP.
              </p>
              <p className="mt-0.5 text-[9px] leading-tight">
                Unit 803 Park Trade Centre, Investment Drive,
                <br />
                Madrigal Business Park, Ayala-Alabang, Muntinlupa City
              </p>
              <h1 className="mt-2 text-lg font-bold tracking-wide">
                SUPPLIER INFORMATION SHEET
              </h1>
            </div>
            {/* The 2x2 photo box, as on the paper form. */}
            <div className="w-24 shrink-0">
              {selfie ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/documents/${selfie.id}`}
                  alt=""
                  className="h-24 w-24 border border-black object-cover"
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center border border-black text-center text-[8px] leading-tight text-slate-500">
                  SUPPLIER
                  <br />
                  2X2 PIC
                </div>
              )}
            </div>
          </div>

          <div className="mt-2 flex justify-between text-[10px]">
            <span>Reference: <strong>{application.referenceNo}</strong></span>
            <span>Date: {show('signed_date') || '____________'}</span>
          </div>
        </header>

        {form.schema.sections.map((section) => {
          const printable = section.fields.filter((f) => f.type !== 'section_note');
          const notes = section.fields.filter((f) => f.type === 'section_note');

          return (
            <section key={section.key} className="mt-4 break-inside-avoid">
              <h2 className="border-b border-black bg-yellow-100 px-1 py-0.5 text-[11px] font-bold uppercase">
                {section.title}
              </h2>

              {notes.map((n) => (
                <p key={n.key} className="mt-1.5 text-justify text-[9px] leading-relaxed">
                  {n.label}
                </p>
              ))}

              {printable.length > 0 && (
                <table className="mt-1.5 w-full border-collapse">
                  <tbody>
                    {printable.map((f) => (
                      <tr key={f.key} className="align-top">
                        <td className="w-2/5 border-b border-slate-300 py-1 pr-2 text-[10px] text-slate-700">
                          {f.label}
                        </td>
                        <td className="border-b border-slate-300 py-1 text-[10px] font-medium">
                          {show(f.key) || ' '}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}

        {/* Signature block */}
        <section className="mt-6 break-inside-avoid">
          <div className="flex items-end justify-between gap-8">
            <div className="flex-1">
              {signature?.signature_data ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={signature.signature_data}
                    alt="Signature"
                    className="mb-1 h-16 object-contain"
                  />
                  <div className="border-t border-black pt-1 text-center text-[10px]">
                    {signature.signatory_name}
                    {signature.signatory_position ? `, ${signature.signatory_position}` : ''}
                    <br />
                    <span className="text-[9px]">Supplier Signature Over Printed Name</span>
                  </div>
                </>
              ) : (
                <div className="mt-16 border-t border-black pt-1 text-center text-[9px]">
                  Supplier Signature Over Printed Name
                </div>
              )}
            </div>
            <div className="flex-1">
              <div className="mt-16 border-t border-black pt-1 text-center text-[9px]">
                Sales Coordinator Signature Over Printed Name
              </div>
            </div>
          </div>
          <p className="mt-6 text-center text-[10px]">Noted by:</p>
          <p className="mt-6 text-center text-[10px] font-semibold">
            ART FRESH PRESIDENT / CFO
          </p>
        </section>

        {/* Notarial acknowledgment, page 2 of the paper form */}
        <section className="mt-8 break-before-page pt-4">
          <h2 className="text-center text-sm font-bold tracking-wide">ACKNOWLEDGMENT</h2>

          <p className="mt-6 text-[11px]">
            Republic of the Philippines&nbsp;&nbsp;)
            <br />
            City of ____________________&nbsp;&nbsp;) S.S.
          </p>

          <p className="mt-6 text-[11px]">
            <strong>BEFORE</strong> me this ____ day of __________________, in the City of
            ____________________ personally appeared:
          </p>

          <table className="mt-6 w-full border-collapse text-[11px]">
            <thead>
              <tr>
                <th className="w-1/2 pb-1 text-center font-normal">NAME</th>
                <th className="w-1/2 pb-1 text-center font-normal">VALID IDENTIFICATION</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i}>
                  <td className="h-8 border-b border-black" />
                  <td className="h-8 border-b border-black pl-4" />
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-6 text-justify text-[11px]">
            Known to me to be the same persons who executed this instrument, consisting of two
            (2) pages, and they acknowledge to me that the same is their free and voluntary act
            and deed.
          </p>

          <p className="mt-6 text-[11px] font-semibold">
            WITNESS MY HAND AND SEAL on the day and place above-written.
          </p>

          <div className="mt-10 text-[11px]">
            <p>Doc. No.: _________;</p>
            <p>Page No.: _________;</p>
            <p>Book No.: _________;</p>
            <p>Series of {new Date().getFullYear()}.</p>
          </div>
        </section>
      </main>
    </>
  );
}
