import type { Metadata } from 'next';
import Link from 'next/link';
import { can, reports } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { NewReportForm } from '@/components/app/reports/new-report-form';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Reports' };

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  READY: 'secondary',
  BUILDING: 'outline',
  PENDING: 'outline',
  FAILED: 'destructive',
};

export default async function ReportsPage() {
  const { org } = await requireActiveOrg();
  const [rows, availability] = await Promise.all([
    reports.listReports(org.id),
    reports.reportTypeAvailability(org.id),
  ]);
  const canGenerate = can(org.role, 'report:generate');

  const options = availability.map((a) => ({
    type: a.type,
    label: reports.REPORT_TYPE_LABEL[a.type],
    blurb: reports.REPORT_TYPE_BLURB[a.type],
    available: a.available,
    reason: a.reason,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Professional summaries of your YouTube, TikTok, SEO, website health, AI recommendations, growth and monetization analyses. Every report has the same seven sections, can be exported to PDF / CSV / JSON, and is snapshotted so it never changes after it is generated."
      />

      {canGenerate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New report</CardTitle>
            <CardDescription>
              Pick a type. A report is built from the latest synced / crawled data and diffed
              against your previous report of that type.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <NewReportForm options={options} />
          </CardContent>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="No reports yet."
          description={
            canGenerate
              ? 'Generate one above.'
              : 'A member or admin can generate reports for this organization.'
          }
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <Link href={`/app/reports/${r.id}`} className="hover:underline">
                      {r.title}
                    </Link>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{reports.REPORT_TYPE_LABEL[r.type]}</Badge>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>
                      {r.status.toLowerCase()}
                    </Badge>
                    {r.shareActive ? <Badge variant="outline">shared</Badge> : null}
                  </div>
                </div>
                <CardDescription>
                  {r.headline ?? (r.status === 'FAILED' ? (r.error ?? 'Generation failed.') : '—')}{' '}
                  · generated {relDate(r.createdAt)}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
