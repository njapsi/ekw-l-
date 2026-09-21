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
import { GenerateCalendarForm } from '@/components/app/youtube/youtube-actions';
import { YouTubeEmpty } from '@/components/app/youtube/youtube-empty';
import { requireActiveOrg } from '@/lib/auth';
import { loadYouTubeState } from '@/lib/youtube-state';

export const metadata: Metadata = { title: 'YouTube — Content calendar' };

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  IDEA: 'outline',
  PLANNED: 'secondary',
  SCHEDULED: 'default',
  PUBLISHED: 'default',
  COMPLETED: 'default',
  CANCELLED: 'outline',
};

export default async function YouTubeCalendarPage() {
  const { org } = await requireActiveOrg();
  const state = await loadYouTubeState(org.id);
  if (state.kind !== 'ready') return <YouTubeEmpty state={state} />;

  const entries = await youtube.listCalendarEntries(org.id, {});

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate a content calendar</CardTitle>
          <CardDescription>
            Spreads your current content opportunities across the requested weeks at the requested
            cadence. When there are no opportunities yet, slots are left as an honest placeholder —
            never a fabricated topic.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GenerateCalendarForm />
        </CardContent>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          title="No calendar entries yet."
          description="Generate a calendar above to plan your next few weeks of content."
        />
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <div
              key={e.id}
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{e.title}</p>
                <p className="text-muted-foreground text-xs">
                  {e.scheduledDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}{' '}
                  · {e.format === 'short' ? 'Short' : e.format === 'live' ? 'Live' : 'Long-form'}
                </p>
                {e.rationale ? (
                  <p className="text-muted-foreground text-xs">{e.rationale}</p>
                ) : null}
              </div>
              <Badge variant={STATUS_VARIANT[e.status] ?? 'outline'}>
                {e.status.toLowerCase().replace(/_/g, ' ')}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
