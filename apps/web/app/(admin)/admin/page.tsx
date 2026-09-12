import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { HealthPill, Stat, StatGrid } from '@/components/admin/stat';
import { usd } from '@/lib/admin-format';
import { compactNumber, relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminHome() {
  const [counts, health, ai, jobs] = await Promise.all([
    observability.platformCounts(prisma),
    observability.runHealthChecks(prisma),
    observability.aiUsageSummary(prisma, { sinceMs: 24 * 60 * 60 * 1000 }),
    observability.jobDurationSummary(prisma),
  ]);

  const recentErrors = await observability.listErrorEvents(prisma, { limit: 6 });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Platform overview"
        description="Internal administration & operational health. Platform-staff only; no secrets are shown here."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">System health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 text-sm">
          {health.checks.map((c) => (
            <span key={c.name} className="flex items-center gap-1.5">
              <HealthPill state={c.state} />
              <span className="text-muted-foreground">{c.name.replace(/_/g, ' ')}</span>
            </span>
          ))}
          <Link href="/admin/system-health" className="ml-auto text-xs underline">
            Operational metrics →
          </Link>
        </CardContent>
      </Card>

      <StatGrid>
        <Stat label="Users" value={compactNumber(counts.users)} />
        <Stat
          label="Organizations"
          value={compactNumber(counts.orgs)}
          hint={`${counts.deletedOrgs} deleted`}
        />
        <Stat label="Active memberships" value={compactNumber(counts.memberships)} />
        <Stat label="Connected accounts" value={compactNumber(counts.connections)} />
        <Stat
          label="AI cost · 24h"
          value={usd(ai.costUsd)}
          hint={`${compactNumber(ai.runs)} runs · ${compactNumber(ai.promptTokens + ai.completionTokens)} tokens`}
        />
        <Stat
          label="Queue depth"
          value={compactNumber(jobs.totalDepth)}
          hint={`${jobs.totalFailed} failed`}
        />
        <Stat label="Crawls" value={compactNumber(counts.crawls)} />
        <Stat
          label="Errors · 24h"
          value={compactNumber(counts.errors24h)}
          hint={
            <Link href="/admin/errors" className="underline">
              view
            </Link>
          }
        />
      </StatGrid>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent errors</CardTitle>
        </CardHeader>
        <CardContent>
          {recentErrors.length === 0 ? (
            <p className="text-muted-foreground text-sm">No errors recorded.</p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {recentErrors.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-4 py-2">
                  <Link
                    href={`/admin/errors/${e.id}`}
                    className="min-w-0 truncate font-mono text-xs hover:underline"
                  >
                    [{e.source}] {e.name}: {e.message}
                  </Link>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    ×{e.count} · {relDate(e.lastSeenAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
