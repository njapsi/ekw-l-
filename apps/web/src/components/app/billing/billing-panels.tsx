'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { billing } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import {
  cancelSubscriptionAction,
  changePlanAction,
  openBillingPortalAction,
  resumeSubscriptionAction,
  startCheckoutAction,
  type BillingActionResult,
} from '@/server/billing-actions';

type Interval = 'MONTH' | 'YEAR';

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return new Intl.NumberFormat('en').format(n);
}

function fmtMoneyMinor(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function BillingPanels({
  summary,
  configured,
  canManage,
}: {
  summary: billing.BillingSummary;
  configured: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [interval, setInterval] = useState<Interval>(summary.interval);

  const run = (fn: () => Promise<BillingActionResult>) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      if (r.ok && r.url) {
        window.location.href = r.url;
        return;
      }
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done.') : (r.error ?? 'Failed.') });
      if (r.ok) router.refresh();
    });

  const periodEnd = summary.currentPeriodEnd
    ? new Date(summary.currentPeriodEnd).toLocaleDateString()
    : null;

  return (
    <div className="space-y-6">
      {/* --- Current subscription --- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {summary.planName} plan{' '}
              <Badge variant={summary.entitled ? 'secondary' : 'destructive'}>
                {summary.statusLabel}
              </Badge>
            </CardTitle>
            <div className="text-muted-foreground text-xs">
              Billed {summary.interval === 'MONTH' ? 'monthly' : 'yearly'}
              {summary.seats > 1 ? ` · ${summary.seats} seats` : ''}
            </div>
          </div>
          <CardDescription>
            {summary.cancelAtPeriodEnd && periodEnd
              ? `Scheduled to cancel on ${periodEnd}. You keep access until then.`
              : periodEnd
                ? `Renews on ${periodEnd}.`
                : 'No renewal date — you are on the Free plan.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {canManage && summary.hasStripeCustomer ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(openBillingPortalAction)}
            >
              Manage billing & payment method
            </Button>
          ) : null}
          {canManage && summary.hasStripeSubscription && !summary.cancelAtPeriodEnd ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={pending}
              onClick={() => run(cancelSubscriptionAction)}
            >
              Cancel subscription
            </Button>
          ) : null}
          {canManage && summary.cancelAtPeriodEnd ? (
            <Button size="sm" disabled={pending} onClick={() => run(resumeSubscriptionAction)}>
              Resume subscription
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {msg ? (
        <Alert variant={msg.ok ? 'default' : 'destructive'}>
          <AlertDescription>{msg.text}</AlertDescription>
        </Alert>
      ) : null}

      {/* --- Usage this period --- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Usage this period</CardTitle>
          <CardDescription>
            {new Date(summary.usage.period.start).toLocaleDateString()} –{' '}
            {new Date(summary.usage.period.end).toLocaleDateString()}. Limits are enforced
            server-side.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {summary.usage.meters.map((m) => {
            const ratioPct = m.unlimited ? 0 : Math.min(100, Math.round(m.ratio * 100));
            const barColor =
              m.state === 'over'
                ? 'bg-destructive'
                : m.state === 'warn'
                  ? 'bg-amber-500'
                  : 'bg-primary';
            return (
              <div key={m.meter} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-muted-foreground">
                    {fmtNum(m.used)} / {m.unlimited ? 'Unlimited' : fmtNum(m.limit ?? 0)} {m.unit}
                  </span>
                </div>
                <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className={`h-full ${barColor}`}
                    style={{ width: `${m.unlimited ? 0 : ratioPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* --- Plans --- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Plans</CardTitle>
            <div className="flex gap-1 text-xs">
              {(['MONTH', 'YEAR'] as Interval[]).map((iv) => (
                <button
                  key={iv}
                  type="button"
                  className={`rounded border px-2 py-1 ${
                    interval === iv ? 'bg-muted border-foreground' : 'border-border'
                  }`}
                  onClick={() => setInterval(iv)}
                >
                  {iv === 'MONTH' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
          </div>
          <CardDescription>
            Prices and limits are defined in the plan catalog, not hard-coded per page.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-3 xl:grid-cols-5">
          {summary.plans.map((p) => {
            const isCurrent = p.tier === summary.tier;
            const price = p.priceUsd[interval];
            const priceLabel =
              price == null ? 'Custom' : price === 0 ? 'Free' : `$${price.toLocaleString('en')}`;
            return (
              <div
                key={p.tier}
                className={`rounded-lg border p-3 ${isCurrent ? 'border-primary' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{p.name}</p>
                  {isCurrent ? <Badge variant="secondary">Current</Badge> : null}
                </div>
                <p className="mt-1 text-lg font-semibold">
                  {priceLabel}
                  {price != null && price > 0 ? (
                    <span className="text-muted-foreground text-xs font-normal">
                      /{interval === 'MONTH' ? 'mo' : 'yr'}
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">{p.blurb}</p>
                <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
                  <li>{fmtNum(p.limits.AI_TOKENS ?? Infinity)} AI tokens</li>
                  <li>{fmtNum(p.limits.CRAWL_PAGES ?? Infinity)} crawl pages</li>
                  <li>{fmtNum(p.limits.CONNECTED_ACCOUNTS ?? Infinity)} connected accounts</li>
                  <li>{fmtNum(p.limits.SEATS ?? Infinity)} seats</li>
                </ul>
                {canManage && !isCurrent ? (
                  p.tier === 'ENTERPRISE' ? (
                    <Button size="sm" variant="outline" className="mt-3 w-full" asChild>
                      <a href="/docs">Contact sales</a>
                    </Button>
                  ) : p.tier === 'FREE' ? (
                    summary.hasStripeSubscription ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive mt-3 w-full"
                        disabled={pending}
                        onClick={() => run(cancelSubscriptionAction)}
                      >
                        Downgrade to Free
                      </Button>
                    ) : null
                  ) : (
                    <Button
                      size="sm"
                      className="mt-3 w-full"
                      disabled={pending || !configured}
                      onClick={() =>
                        run(() =>
                          summary.hasStripeSubscription
                            ? changePlanAction(p.tier, interval)
                            : startCheckoutAction(p.tier, interval),
                        )
                      }
                    >
                      {summary.hasStripeSubscription ? 'Switch to this plan' : `Choose ${p.name}`}
                    </Button>
                  )
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* --- Invoices --- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoices</CardTitle>
          <CardDescription>Mirrored from Stripe. Open one for the receipt or PDF.</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.invoices.length === 0 ? (
            <p className="text-muted-foreground text-sm">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Date</th>
                    <th className="py-1 pr-3 font-medium">Number</th>
                    <th className="py-1 pr-3 font-medium">Status</th>
                    <th className="py-1 pr-3 text-right font-medium">Amount</th>
                    <th className="py-1 pr-3 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {summary.invoices.map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="py-1 pr-3">{new Date(i.createdAt).toLocaleDateString()}</td>
                      <td className="py-1 pr-3">{i.number ?? '—'}</td>
                      <td className="py-1 pr-3">{i.status}</td>
                      <td className="py-1 pr-3 text-right">
                        {fmtMoneyMinor(i.amountPaid || i.amountDue, i.currency)}
                      </td>
                      <td className="py-1 pr-3 text-right">
                        {i.hostedInvoiceUrl ? (
                          <a
                            className="underline"
                            href={i.hostedInvoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
