import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { isAppError, knowledge } from '@growth-agent/services';
import { requireActiveOrg } from '@/lib/auth';
import { KnowledgeActionsBar } from '@/components/app/knowledge/knowledge-actions-bar';

export const metadata: Metadata = { title: 'Knowledge Item' };

interface PageProps {
  params: Promise<{ knowledgeId: string }>;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  DRAFT: 'outline',
  ACTIVE: 'success',
  VERIFIED: 'success',
  UNVERIFIED: 'secondary',
  STALE: 'warning',
  CONFLICTED: 'destructive',
  ARCHIVED: 'outline',
  EXPIRED: 'outline',
  REJECTED: 'outline',
};

export default async function KnowledgeDetailPage({ params }: PageProps) {
  const { knowledgeId } = await params;
  const { org } = await requireActiveOrg();

  let item: Awaited<ReturnType<typeof knowledge.getKnowledgeItem>>;
  try {
    item = await knowledge.getKnowledgeItem(org.id, knowledgeId);
  } catch (e) {
    if (isAppError(e) && e.code === 'resource_not_found') notFound();
    throw e;
  }
  const relations = await knowledge.listRelationsFor(org.id, knowledgeId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={item.title}
        description={item.summary ?? undefined}
        actions={<KnowledgeActionsBar knowledgeId={item.id} status={item.status} />}
      />

      <div className="flex flex-wrap gap-2">
        <Badge variant={STATUS_VARIANT[item.status] ?? 'outline'}>{item.status.toLowerCase()}</Badge>
        <Badge variant="outline">{item.type.replace(/_/g, ' ').toLowerCase()}</Badge>
        <Badge variant="outline">{item.classification.replace(/_/g, ' ').toLowerCase()}</Badge>
        <Badge variant="outline">{item.scope.toLowerCase()} scope</Badge>
        <Badge variant="outline">{Math.round(item.confidence * 100)}% confidence</Badge>
        <Badge variant="outline">{item.importance.toLowerCase()} importance</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Content</CardTitle>
        </CardHeader>
        <CardContent className="whitespace-pre-wrap text-sm">{item.content}</CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Source</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {item.primarySource ? (
              <div className="space-y-1">
                <p>{item.primarySource.type.replace(/_/g, ' ').toLowerCase()}</p>
                {item.primarySource.url ? (
                  <a
                    href={item.primarySource.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-primary break-all underline underline-offset-2"
                  >
                    {item.primarySource.url}
                  </a>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  Trust level: {item.primarySource.trustLevel.replace(/_/g, ' ').toLowerCase()}
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">No source recorded.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Freshness</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Created {item.createdAt.toLocaleDateString()}</p>
            <p>Updated {item.updatedAt.toLocaleDateString()}</p>
            <p>Last verified {item.lastVerifiedAt ? item.lastVerifiedAt.toLocaleDateString() : 'never'}</p>
            <p>Expires {item.expiresAt ? item.expiresAt.toLocaleDateString() : 'never (permanent record)'}</p>
            <p>Last used {item.lastUsedAt ? item.lastUsedAt.toLocaleDateString() : 'not yet used in an answer'}</p>
          </CardContent>
        </Card>
      </div>

      {item.evidence.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {item.evidence.map((e) => (
              <div key={e.id} className="border-border border-l-2 pl-3">
                <p className="font-medium">{e.claim}</p>
                <p className="text-muted-foreground">{e.evidence}</p>
                <p className="text-muted-foreground text-xs">
                  {e.source.url ? (
                    <a href={e.source.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                      {e.source.url}
                    </a>
                  ) : (
                    e.source.type.replace(/_/g, ' ').toLowerCase()
                  )}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {relations.outgoing.length > 0 || relations.incoming.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Related knowledge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {relations.outgoing.map((r, i) => (
              <p key={`o-${i}`}>
                {r.type.replace(/_/g, ' ').toLowerCase()} →{' '}
                <Link href={`/app/knowledge/${r.item.id}`} className="underline underline-offset-2">
                  {r.item.title}
                </Link>
              </p>
            ))}
            {relations.incoming.map((r, i) => (
              <p key={`i-${i}`}>
                <Link href={`/app/knowledge/${r.item.id}`} className="underline underline-offset-2">
                  {r.item.title}
                </Link>{' '}
                {r.type.replace(/_/g, ' ').toLowerCase()} this
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
