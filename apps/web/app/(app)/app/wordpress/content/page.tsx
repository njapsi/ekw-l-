import type { Metadata } from 'next';
import Link from 'next/link';
import { wordpress } from '@growth-agent/services';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { loadWordPressState } from '@/lib/wordpress-state';
import { WordPressEmpty } from '@/components/app/wordpress/wordpress-empty';

export const metadata: Metadata = { title: 'WordPress — Content' };

const CONFIDENCE_VARIANT: Record<string, 'success' | 'warning' | 'outline'> = {
  HIGH: 'success',
  MEDIUM: 'warning',
  LOW: 'outline',
};

export default async function WordPressContentPage() {
  const { org } = await requireActiveOrg();
  const state = await loadWordPressState(org.id);
  if (state.kind !== 'ready') return <WordPressEmpty />;

  const candidates = await wordpress.findRefreshCandidates(org.id, { siteId: state.site.id, limit: 20 });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Refresh candidates</CardTitle>
          <CardDescription>
            Ranked by real age, word count, and matched SEO crawl issues only — never a fabricated
            traffic or ranking signal. Manage individual posts/pages from{' '}
            <Link href="/app/integrations/wordpress" className="underline">
              Connections → WordPress
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No published WordPress content is synced yet. Run a sync from Connections →
              WordPress.
            </p>
          ) : (
            <div className="space-y-3">
              {candidates.map((c) => (
                <div key={c.wordPressContentId} className="border-border rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      {c.link ? (
                        <a
                          href={c.link}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="font-medium underline"
                        >
                          {c.title}
                        </a>
                      ) : (
                        <p className="font-medium">{c.title}</p>
                      )}
                      <p className="text-muted-foreground mt-1 text-xs">{c.evidence.join(' ')}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant={CONFIDENCE_VARIANT[c.confidence] ?? 'outline'}>
                        {c.confidence.toLowerCase()} confidence
                      </Badge>
                      <Badge variant="outline">score {c.score.toFixed(2)}</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
