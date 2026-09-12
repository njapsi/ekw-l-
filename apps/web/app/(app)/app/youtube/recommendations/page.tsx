import type { Metadata } from 'next';
import { youtube } from '@growth-agent/services';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@growth-agent/ui';
import { RunAnalystButton } from '@/components/app/youtube/youtube-actions';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { analystConfigured } from '@/lib/youtube';
import { relDate } from '@/lib/format';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Recommendations' };

interface Claimish {
  kind: string;
  statement: string;
  evidence?: Array<{ origin: string; reference?: string }>;
}

const priorityVariant: Record<string, 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'secondary',
  low: 'outline',
};

export default async function YouTubeRecommendationsPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const [recs, run] = await Promise.all([
    youtube.listYouTubeRecommendations(org.id),
    youtube.latestAnalystRun(org.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">
          {run
            ? `Last analysis ${relDate(run.createdAt)} · status ${run.status.toLowerCase()}`
            : 'No analysis has been run yet.'}
        </p>
        <RunAnalystButton disabled={!analystConfigured()} />
      </div>

      {recs.length === 0 ? (
        <EmptyState
          title="No recommendations yet."
          description={
            analystConfigured()
              ? 'Run the analysis. Recommendations are generated only from your synced data, each with its evidence, reasoning, confidence, and expected impact — and never as a guarantee.'
              : 'Configure an AI provider key, then run the analysis.'
          }
        />
      ) : (
        recs.map((r) => {
          const evidence = (r.evidence as unknown as Claimish[] | null) ?? [];
          return (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={priorityVariant[r.priority] ?? 'secondary'}>{r.priority}</Badge>
                  <Badge variant="outline">effort: {r.effort}</Badge>
                  <Badge variant="outline">confidence {(r.confidence * 100).toFixed(0)}%</Badge>
                  <Badge variant="outline">{r.status.toLowerCase()}</Badge>
                </div>
                <CardTitle className="text-base">{r.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <Field label="Suggested action">{r.explanation}</Field>
                <Field label="Reasoning">{r.reasoning}</Field>
                <Field label="Expected impact">{r.expectedImpact}</Field>
                {evidence.length > 0 ? (
                  <div>
                    <p className="text-muted-foreground text-xs font-medium">Evidence</p>
                    <ul className="text-muted-foreground mt-1 space-y-1 text-xs">
                      {evidence.map((e, i) => (
                        <li key={i}>
                          <span className="bg-muted rounded px-1 py-0.5 font-mono">{e.kind}</span>{' '}
                          {e.statement}
                          {e.evidence?.[0]?.origin ? (
                            <span className="opacity-70"> — {e.evidence[0].origin}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs font-medium">{label}</p>
      <p>{children}</p>
    </div>
  );
}
