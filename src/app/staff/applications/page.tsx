'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';

interface Row {
  id: string;
  reference_no: string;
  status: string;
  business_name: string | null;
  applicant_email: string;
  applicant_name: string | null;
  submitted_at: string | null;
  company_name: string;
  document_count: string;
}

const FILTERS = [
  { key: 'submitted,under_review,info_requested', label: 'Needs action' },
  { key: 'submitted', label: 'New' },
  { key: 'under_review', label: 'In review' },
  { key: 'info_requested', label: 'Awaiting supplier' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const STATUS_STYLES: Record<string, string> = {
  submitted: 'bg-blue-100 text-blue-700',
  under_review: 'bg-amber-100 text-amber-700',
  info_requested: 'bg-orange-100 text-orange-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  draft: 'bg-slate-100 text-slate-600',
};

export default function ReviewQueuePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState(FILTERS[0].key);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: filter });
      if (search.trim()) qs.set('q', search.trim());

      const res = await fetch(`/api/staff/applications?${qs}`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'Could not load the queue.');
        return;
      }
      const body = await res.json();
      setRows(body.applications);
      setSummary(body.summary ?? {});
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  // Debounced so typing in the search box doesn't hammer the API.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <SiteHeader href="/staff/applications">
        <Link href="/staff/users" className="text-sm text-slate-600 hover:text-slate-900">
          Accounts
        </Link>
      </SiteHeader>

    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Supplier applications</h1>
          <p className="mt-1 text-sm text-slate-600">
            {summary.submitted ?? 0} new · {summary.under_review ?? 0} in review ·{' '}
            {summary.info_requested ?? 0} awaiting supplier
          </p>
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search reference, business, email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? 'bg-brand-600 text-white'
                : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <p className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">{error}</p>}

      <div className="card mt-6 overflow-hidden">
        {loading ? (
          <p className="p-8 text-center text-sm text-slate-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">Nothing here right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-medium">Reference</th>
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Applicant</th>
                  <th className="px-4 py-3 font-medium">Submitted</th>
                  <th className="px-4 py-3 font-medium">Docs</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/staff/applications/${r.id}`}
                        className="font-mono text-brand-600 hover:text-brand-700"
                      >
                        {r.reference_no}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-800">
                      {r.business_name ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      <div>{r.applicant_name ?? '—'}</div>
                      <div className="text-xs text-slate-400">{r.applicant_email}</div>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{r.document_count}</td>
                    <td className="px-4 py-3">
                      <span className={`badge ${STATUS_STYLES[r.status] ?? 'bg-slate-100'}`}>
                        {r.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
    </>
  );
}
