import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Target } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { missions } from '@growth-agent/services';

export const metadata: Metadata = { title: 'Growth Missions' };

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  ACTIVE: 'success',
  DRAFT: 'outline',
  PLANNING: 'secondary',
  AWAITING_APPROVAL: 'warning',
  PAUSED: 'warning',
  BLOCKED: 'destructive',
  COMPLETED: 'secondary',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

type Mission = Awaited<ReturnType<typeof missions.listMissions>>[number];

function MissionCard({ mission }: { mission: Mission }) {
  return (
    <Link href={`/app/missions/${mission.id}`} className="block">
      <Card className="hover:border-primary/50 transition-colors">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">{mission.name}</CardTitle>
            <Badge variant={STATUS_VARIANT[mission.status] ?? 'outline'}>
              {mission.status.replace(/_/g, ' ').toLowerCase()}
            </Badge>
          </div>
          <CardDescription className="line-clamp-2">{mission.objective}</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex items-center justify-between text-xs">
          <span>{mission.autonomyLevel.toLowerCase()} autonomy</span>
          <span>{mission.taskCount} task(s)</span>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function MissionsPage() {
  const { org } = await requireActiveOrg();
  const all = await missions.listMissions(org.id);

  const active = all.filter((m) => m.status === 'ACTIVE');
  const planned = all.filter((m) => ['DRAFT', 'PLANNING', 'AWAITING_APPROVAL'].includes(m.status));
  const paused = all.filter((m) => ['PAUSED', 'BLOCKED'].includes(m.status));
  const history = all.filter((m) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(m.status));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Growth Missions"
        description="Define a goal; the AI plans it, works through it within the boundaries you set, and asks for approval before anything external happens."
        actions={
          <Button asChild>
            <Link href="/app/missions/new">
              <Plus className="size-4" /> New mission
            </Link>
          </Button>
        }
      />

      {all.length === 0 ? (
        <EmptyState
          icon={<Target />}
          title="No missions yet"
          description='Describe a growth goal — e.g. "grow my organic traffic over 90 days" — and the AI will propose a plan for you to review before anything runs.'
          action={
            <Button asChild>
              <Link href="/app/missions/new">Create a mission</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {active.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Active</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {active.map((m) => (
                  <MissionCard key={m.id} mission={m} />
                ))}
              </div>
            </section>
          ) : null}
          {planned.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Planned</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {planned.map((m) => (
                  <MissionCard key={m.id} mission={m} />
                ))}
              </div>
            </section>
          ) : null}
          {paused.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Paused / blocked</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {paused.map((m) => (
                  <MissionCard key={m.id} mission={m} />
                ))}
              </div>
            </section>
          ) : null}
          {history.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">History</h2>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {history.map((m) => (
                  <MissionCard key={m.id} mission={m} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
