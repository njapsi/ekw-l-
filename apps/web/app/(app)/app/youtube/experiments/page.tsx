import type { Metadata } from 'next';
import { youtube } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@growth-agent/ui';
import { CreateExperimentForm } from '@/components/app/youtube/youtube-actions';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Experiments' };

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  PLANNED: 'outline',
  RUNNING: 'secondary',
  COMPLETED: 'default',
  CANCELLED: 'outline',
};

const CONCLUSION_LABEL: Record<string, string> = {
  SUPPORTED: 'Hypothesis supported',
  NOT_SUPPORTED: 'Hypothesis not supported',
  INCONCLUSIVE: 'Inconclusive',
};

export default async function YouTubeExperimentsPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const experiments = await youtube.listExperiments(org.id, {});

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create an experiment</CardTitle>
          <CardDescription>
            A controlled test you run deliberately. A conclusion (SUPPORTED / NOT SUPPORTED /
            INCONCLUSIVE) is only ever set from a real before/after measurement you enter after the
            experiment runs — never forced or guessed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateExperimentForm />
        </CardContent>
      </Card>

      {experiments.length === 0 ? (
        <EmptyState
          title="No experiments yet."
          description="Create one above to test a specific hypothesis about your content."
        />
      ) : (
        <div className="space-y-3">
          {experiments.map((e) => (
            <Card key={e.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_VARIANT[e.status] ?? 'outline'}>
                    {e.status.toLowerCase()}
                  </Badge>
                  {e.conclusion ? (
                    <Badge variant="outline">
                      {CONCLUSION_LABEL[e.conclusion] ?? e.conclusion}
                    </Badge>
                  ) : null}
                  {e.confidence ? <Badge variant="outline">{e.confidence} confidence</Badge> : null}
                </div>
                <CardTitle className="text-sm">{e.hypothesis}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                <p>
                  <span className="text-muted-foreground">Variable:</span> {e.variable}
                </p>
                <p>
                  <span className="text-muted-foreground">Success metric:</span> {e.successMetric} (
                  expected to {e.expectedDirection.toLowerCase()})
                </p>
                {e.experimentNote ? (
                  <p className="text-muted-foreground">{e.experimentNote}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
