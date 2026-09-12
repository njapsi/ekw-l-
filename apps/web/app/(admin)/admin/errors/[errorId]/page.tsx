import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@growth-agent/db';
import { observability } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Error · Admin' };
export const dynamic = 'force-dynamic';

export default async function AdminErrorDetail({
  params,
}: {
  params: Promise<{ errorId: string }>;
}) {
  const { errorId } = await params;
  const e = await observability.getErrorEvent(prisma, errorId);
  if (!e) notFound();

  return (
    <div className="space-y-4">
      <PageHeader title={`${e.name}`} description={e.message} />
      <Link href="/admin/errors" className="text-xs underline">
        ← All errors
      </Link>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            <Badge variant="outline">{e.source}</Badge>{' '}
            <span className="text-muted-foreground">
              seen ×{e.count} · first {relDate(e.firstSeenAt)} · last {relDate(e.lastSeenAt)}
            </span>
          </p>
          <p className="text-muted-foreground">
            Route: <span className="font-mono">{e.route ?? '—'}</span>{' '}
            {e.method ? `(${e.method})` : ''} · status {e.statusCode ?? '—'}
          </p>
          <p className="text-muted-foreground">
            Correlation id: <span className="font-mono">{e.correlationId ?? '—'}</span>
          </p>
          <p className="text-muted-foreground">
            Org: <span className="font-mono">{e.organizationId ?? '—'}</span> · Actor:{' '}
            <span className="font-mono">{e.actorId ?? '—'}</span>
          </p>
          <p className="text-muted-foreground font-mono text-[11px]">fingerprint {e.fingerprint}</p>
        </CardContent>
      </Card>

      {e.stack ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Stack (scrubbed)</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px] leading-relaxed">
              {e.stack}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {e.context ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Context</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px]">
              {JSON.stringify(e.context, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
