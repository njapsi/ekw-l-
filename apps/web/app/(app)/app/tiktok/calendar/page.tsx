import type { Metadata } from 'next';
import { tiktok } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
} from '@growth-agent/ui';
import { GenerateTikTokContentPlanForm } from '@/components/app/tiktok/tiktok-actions';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Content plan' };

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  IDEA: 'outline',
  PLANNED: 'secondary',
  SCHEDULED: 'default',
  PUBLISHED: 'default',
  COMPLETED: 'default',
  CANCELLED: 'outline',
};

export default async function TikTokCalendarPage() {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;

  const entries = await tiktok.listContentPlanEntries(org.id, {});

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generate a content plan</CardTitle>
          <CardDescription>
            Spreads your current content opportunities across the requested weeks at the requested
            cadence. When there are no opportunities yet, slots are left as an honest placeholder —
            never a fabricated topic.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GenerateTikTokContentPlanForm />
        </CardContent>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          title="No content plan entries yet."
          description="Generate a plan above to map out your next few weeks of content."
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
                  · {e.format === 'short' ? 'Short (≤60s)' : 'Extended (>60s)'}
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
