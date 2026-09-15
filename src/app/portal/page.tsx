'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import SiteHeader from '@/components/SiteHeader';

interface Summary {
  totalOutstanding: number;
  overdue1to30: number;
  overdue31to60: number;
  overdue61to90: number;
  overdue90plus: number;
  availableCredit: number;
  ewtRate: number;
  currency: string;
}

interface OrderRow {
  id: string;
  order_no: string;
  status: string;
  total_amount: string;
  placed_at: string;
}

const money = (n: number, currency: string) =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(n);

export default function PortalDashboard() {
  const router = useRouter();
  const [supplier, setSupplier] = useState<{ name: string; code: string } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const me = await fetch('/api/auth/me');
      if (me.status === 401) {
        router.push('/login');
        return;
      }
      const body = await me.json();

      // Not approved yet — the portal has nothing to show them.
      if (!body.user?.supplier) {
        router.push('/apply');
        return;
      }
      setSupplier(body.user.supplier);

      const [inv, ord] = await Promise.all([
        fetch('/api/portal/invoices?openOnly=true'),
        fetch('/api/portal/orders?pageSize=5'),
      ]);
      if (inv.ok) setSummary((await inv.json()).summary);
      if (ord.ok) setOrders((await ord.json()).orders);
      setLoading(false);
    })();
  }, [router]);

  if (loading) return <main className="p-10 text-center text-slate-500">Loading…</main>;

  const currency = summary?.currency ?? 'PHP';
  const overdue = summary
    ? summary.overdue1to30 + summary.overdue31to60 + summary.overdue61to90 + summary.overdue90plus
    : 0;

  return (
    <>
      <SiteHeader href="/portal">
        <Link href="/portal/invoices" className="text-sm text-slate-600 hover:text-slate-900">
          Statement
        </Link>
        <Link href="/portal/orders" className="text-sm text-slate-600 hover:text-slate-900">
          Orders
        </Link>
      </SiteHeader>

    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{supplier?.name}</h1>
          <p className="mt-1 font-mono text-sm text-slate-500">{supplier?.code}</p>
        </div>
        <Link href="/portal/orders/new" className="btn-primary">
          Place an order
        </Link>
      </header>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Outstanding balance"
          value={money(summary?.totalOutstanding ?? 0, currency)}
        />
        <Stat
          label="Overdue"
          value={money(overdue, currency)}
          tone={overdue > 0 ? 'warn' : 'normal'}
        />
        <Stat
          label="Available credit"
          value={money(summary?.availableCredit ?? 0, currency)}
        />
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recent orders</h2>
          <Link href="/portal/orders" className="text-sm text-brand-600 hover:text-brand-700">
            View all
          </Link>
        </div>

        <div className="card mt-4 overflow-hidden">
          {orders.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500">
              No orders yet.{' '}
              <Link href="/portal/orders/new" className="text-brand-600">
                Place your first one.
              </Link>
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {orders.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/portal/orders/${o.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
                  >
                    <div>
                      <p className="font-mono text-sm text-brand-600">{o.order_no}</p>
                      <p className="text-xs text-slate-400">
                        {new Date(o.placed_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-slate-800">
                        {money(Number(o.total_amount), currency)}
                      </p>
                      <p className="text-xs text-slate-500">{o.status}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
    </>
  );
}

function Stat({
  label,
  value,
  tone = 'normal',
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warn';
}) {
  return (
    <div className="card p-5">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={`mt-2 text-2xl font-semibold ${
          tone === 'warn' ? 'text-red-600' : 'text-slate-900'
        }`}
      >
        {value}
      </p>
    </div>
  );
}
