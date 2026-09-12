import type { Metadata } from 'next';
import Link from 'next/link';
import { billing } from '@growth-agent/services';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@growth-agent/ui';

export const metadata: Metadata = { title: 'Pricing' };

const fmt = (n: number | null): string => (n == null ? '∞' : new Intl.NumberFormat('en').format(n));

export default function PricingPage() {
  // Single source of truth — the same catalog the app enforces against.
  const plans = billing.listPlans();

  return (
    <div className="container flex flex-col gap-8 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="text-muted-foreground max-w-2xl">
          Every plan meters the expensive resources — AI usage, crawled pages, connected accounts —
          so heavy use pays its way. Card details are handled by Stripe; we never store them.
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-3 xl:grid-cols-5">
        {plans.map((p) => {
          const monthly = p.priceUsd.MONTH;
          const priceLabel = monthly == null ? 'Custom' : monthly === 0 ? '$0' : `$${monthly}`;
          const highlight = p.tier === 'PRO';
          return (
            <Card key={p.tier} className={highlight ? 'border-primary shadow-md' : undefined}>
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  {highlight ? <Badge>Popular</Badge> : null}
                </div>
                <p className="text-2xl font-semibold">
                  {priceLabel}
                  {monthly != null && monthly > 0 ? (
                    <span className="text-muted-foreground text-sm font-normal"> / mo</span>
                  ) : null}
                </p>
                <p className="text-muted-foreground text-xs">{p.blurb}</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="text-muted-foreground space-y-1.5 text-sm">
                  <li>{fmt(p.limits.SEATS)} seats</li>
                  <li>{fmt(p.limits.AI_TOKENS)} AI tokens / mo</li>
                  <li>{fmt(p.limits.CRAWL_PAGES)} crawl pages / mo</li>
                  <li>{fmt(p.limits.CONNECTED_ACCOUNTS)} connected accounts</li>
                  {p.features.exports ? <li>PDF / CSV export</li> : null}
                  {p.features.whiteLabelReports ? <li>White-label reports</li> : null}
                  {p.features.sso ? <li>SSO / SCIM</li> : null}
                </ul>
                <Button asChild variant={highlight ? 'default' : 'outline'} className="w-full">
                  <Link href={p.tier === 'ENTERPRISE' ? '/docs' : '/signup'}>
                    {p.tier === 'ENTERPRISE' ? 'Contact sales' : `Start with ${p.name}`}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      <p className="text-muted-foreground text-sm">
        Need SSO, SCIM, an SLA, or invoicing?{' '}
        <Link href="/docs" className="underline">
          Talk to us about Enterprise
        </Link>
        .
      </p>
    </div>
  );
}
