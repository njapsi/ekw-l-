import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, reports } from '@growth-agent/services';
import { Alert, AlertDescription, AlertTitle, Badge, PageHeader } from '@growth-agent/ui';
import { ReportActionsBar } from '@/components/app/reports/report-actions-bar';
import { ReportSnapshotView } from '@/components/app/reports/report-snapshot-view';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Report' };

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const { org } = await requireActiveOrg();
  const report = await reports.getReport(org.id, reportId);
  if (!report) notFound();

  const canGenerate = can(org.role, 'report:generate');
  const canShare = can(org.role, 'report:share');

  return (
    <div className="space-y-6">
      <PageHeader title={report.title} description={reports.REPORT_TYPE_LABEL[report.type]} />
      <div className="-mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline">{reports.REPORT_TYPE_LABEL[report.type]}</Badge>
        <Badge variant={report.status === 'READY' ? 'secondary' : 'destructive'}>
          {report.status.toLowerCase()}
        </Badge>
        <Link href="/app/reports" className="text-muted-foreground text-xs underline">
          All reports
        </Link>
      </div>

      {report.status === 'FAILED' ? (
        <Alert variant="destructive">
          <AlertTitle>This report failed to generate</AlertTitle>
          <AlertDescription>{report.error ?? 'Unknown error.'}</AlertDescription>
        </Alert>
      ) : null}

      {report.status === 'READY' && report.snapshot ? (
        <>
          <ReportActionsBar
            reportId={report.id}
            canGenerate={canGenerate}
            canShare={canShare}
            share={{
              hasLink: report.share.hasLink,
              active: report.share.active,
              url: report.share.url,
              expiresAt: report.share.expiresAt,
            }}
          />
          <ReportSnapshotView snapshot={report.snapshot} />
        </>
      ) : report.status !== 'FAILED' ? (
        <p className="text-muted-foreground text-sm">This report is still being built.</p>
      ) : null}
    </div>
  );
}
