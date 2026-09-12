'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import { addRevenueEntryAction, deleteRevenueEntryAction } from '@/server/monetization-actions';
import { CHANNEL_OPTIONS, channelLabel } from './channels';

export interface RevenueEntryView {
  id: string;
  channel: string;
  source: string;
  amount: number;
  currency: string;
  periodStart: string | Date;
  periodEnd: string | Date;
  isRecurring: boolean;
  note: string | null;
}

export interface RevenueSummaryView {
  hasData: boolean;
  byCurrency: Record<string, number>;
  byChannel: Array<{ channel: string; byCurrency: Record<string, number>; entryCount: number }>;
  byMonth: Array<{ month: string; byCurrency: Record<string, number> }>;
  recurringMonthlyByCurrency: Record<string, number>;
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function fmtTotals(byCurrency: Record<string, number>): string {
  const parts = Object.entries(byCurrency).map(([c, v]) => fmtMoney(v, c));
  return parts.length ? parts.join(' · ') : '—';
}

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

export function RevenueTracker({
  entries,
  summary,
}: {
  entries: RevenueEntryView[];
  summary: RevenueSummaryView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [channel, setChannel] = useState(CHANNEL_OPTIONS[0]?.value ?? 'SPONSORSHIP');
  const [source, setSource] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [periodStart, setPeriodStart] = useState(monthStart());
  const [periodEnd, setPeriodEnd] = useState(today());
  const [isRecurring, setIsRecurring] = useState(false);
  const [note, setNote] = useState('');

  const add = () =>
    start(async () => {
      setMsg(null);
      const r = await addRevenueEntryAction({
        channel,
        source: source.trim(),
        amount,
        currency: currency.trim().toUpperCase() || 'USD',
        periodStart,
        periodEnd,
        isRecurring,
        note: note.trim() || undefined,
      });
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Added.') : (r.error ?? 'Failed') });
      if (r.ok) {
        setSource('');
        setAmount('');
        setNote('');
        router.refresh();
      }
    });

  const remove = (id: string) =>
    start(async () => {
      const r = await deleteRevenueEntryAction(id);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Removed.') : (r.error ?? 'Failed') });
      if (r.ok) router.refresh();
    });

  return (
    <div className="bg-card rounded-lg border p-4">
      <h2 className="text-base font-medium">Revenue tracking</h2>
      <p className="text-muted-foreground text-xs">
        Every dollar amount here is entered by you — nothing is pulled from a platform, and this
        engine never invents revenue.
      </p>

      {summary.hasData ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded border p-3">
            <p className="text-muted-foreground text-xs">Total recorded</p>
            <p className="text-sm font-medium">{fmtTotals(summary.byCurrency)}</p>
            {Object.keys(summary.recurringMonthlyByCurrency).length ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Estimated recurring ≈ {fmtTotals(summary.recurringMonthlyByCurrency)}/mo — this
                app&rsquo;s own calculation, spreading each recurring entry evenly across the months
                it covers
              </p>
            ) : null}
          </div>
          <div className="rounded border p-3">
            <p className="text-muted-foreground text-xs">By channel</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {summary.byChannel.map((c) => (
                <li key={c.channel}>
                  {channelLabel(c.channel)}: {fmtTotals(c.byCurrency)} ({c.entryCount})
                </li>
              ))}
            </ul>
          </div>
          {summary.byMonth.length ? (
            <div className="rounded border p-3 sm:col-span-2">
              <p className="text-muted-foreground text-xs">Monthly history</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                {summary.byMonth.map((m) => (
                  <li key={m.month}>
                    <span className="text-muted-foreground">{m.month}:</span>{' '}
                    {fmtTotals(m.byCurrency)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-muted-foreground mt-4 text-sm">
          No revenue recorded yet. Add your sources below to build a history.
        </p>
      )}

      <form
        className="mt-4 space-y-3 border-t pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="rev-channel">Channel</Label>
            <select
              id="rev-channel"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              {CHANNEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="rev-source">Source</Label>
            <Input
              id="rev-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. Acme Co. integration"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rev-amount">Amount</Label>
            <Input
              id="rev-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rev-currency">Currency</Label>
            <Input
              id="rev-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
              maxLength={3}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rev-start">Period start</Label>
            <Input
              id="rev-start"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rev-end">Period end</Label>
            <Input
              id="rev-end"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.target.checked)}
          />
          Recurring revenue (spread across the period for the monthly view)
        </label>
        <div className="space-y-1">
          <Label htmlFor="rev-note">Note (optional)</Label>
          <Input id="rev-note" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending || !amount.trim()}>
            {pending ? 'Saving…' : 'Add revenue entry'}
          </Button>
          {msg ? (
            <span
              role={msg.ok ? 'status' : 'alert'}
              className={`text-sm ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
            >
              {msg.text}
            </span>
          ) : null}
        </div>
      </form>

      {entries.length ? (
        <div className="mt-4 overflow-x-auto border-t pt-4">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Period
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Source
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="py-1 pr-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-1 pr-3">
                    {String(e.periodStart).slice(0, 10)} → {String(e.periodEnd).slice(0, 10)}
                    {e.isRecurring ? ' (recurring)' : ''}
                  </td>
                  <td className="py-1 pr-3">{channelLabel(e.channel)}</td>
                  <td className="py-1 pr-3">
                    {e.source}
                    {e.note ? <span className="text-muted-foreground"> — {e.note}</span> : null}
                  </td>
                  <td className="py-1 pr-3 text-right">{fmtMoney(e.amount, e.currency)}</td>
                  <td className="py-1 pr-3 text-right">
                    <button
                      type="button"
                      className="text-destructive underline disabled:opacity-40"
                      disabled={pending}
                      onClick={() => remove(e.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
