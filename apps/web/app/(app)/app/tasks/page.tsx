import type { Metadata } from 'next';
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
import { agent } from '@growth-agent/services';
import { TaskControls } from '@/components/app/agent/task-controls';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Tasks' };

const STATUS_ORDER = ['IN_PROGRESS', 'PENDING', 'BLOCKED', 'DONE', 'CANCELLED'] as const;
const STATUS_LABEL: Record<string, string> = {
  IN_PROGRESS: 'In progress',
  PENDING: 'To do',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};
const PRIORITY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'secondary',
  low: 'outline',
};

export default async function TasksPage() {
  const { org } = await requireActiveOrg();
  const tasks = await agent.listTasks(org.id);

  if (tasks.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Tasks"
          description="Recommendations you have promoted to trackable work. Created from the AI Growth Agent or the SEO / YouTube / TikTok recommendation lists."
        />
        <EmptyState
          title="No tasks yet."
          description="Ask the AI Growth Agent for recommendations, then click ‘Create task’ on any of them."
        />
      </div>
    );
  }

  const grouped = STATUS_ORDER.map((s) => ({
    status: s,
    items: tasks.filter((t) => t.status === s),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tasks"
        description="Recommendations promoted to trackable work. Tasks are internal — actions that would change an external account (publishing, metadata) are done from that platform’s own approval screen."
      />
      {grouped.map((g) => (
        <div key={g.status} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide">
            {STATUS_LABEL[g.status]} ({g.items.length})
          </h2>
          <div className="grid gap-3">
            {g.items.map((t) => (
              <Card key={t.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">{t.title}</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant={PRIORITY_VARIANT[t.priority] ?? 'secondary'}>
                        {t.priority}
                      </Badge>
                      <Badge variant="outline">{t.domain.toLowerCase()}</Badge>
                    </div>
                  </div>
                  <CardDescription>
                    {t.description} · created {relDate(t.createdAt)}
                    {t.requiresExternalAction ? ' · needs external confirmation' : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground whitespace-pre-wrap">{t.instructions}</p>
                  {t.affectedUrls.length > 0 ? (
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {t.affectedUrls.slice(0, 6).join(' · ')}
                      {t.affectedUrls.length > 6 ? ` +${t.affectedUrls.length - 6} more` : ''}
                    </p>
                  ) : null}
                  <TaskControls taskId={t.id} status={t.status} />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
