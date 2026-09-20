import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Circle, Target } from 'lucide-react';
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
import { agent, automation } from '@growth-agent/services';

export const metadata: Metadata = { title: 'Missions' };

/**
 * Growth Missions (Part 36) — a presentational grouping of existing data,
 * not a new persisted entity. This is a UI-only phase (Part 1: "do not
 * rebuild the backend"), so a mission is derived from what already exists:
 * the org's connection state (`loadOrgContext`) and its real automation
 * rules, grouped by growth area. A future phase that gives missions their
 * own goal/schedule/permission fields would add a real `Mission` model;
 * until then this stays an aggregation, never a fabricated one.
 */
const MISSIONS: {
  key: string;
  title: string;
  goal: string;
  taskTypes: automation.AutomationTaskTypeKey[];
  isConnected: (ctx: agent.OrgContext) => boolean;
  connectionLabel: string;
}[] = [
  {
    key: 'youtube',
    title: 'YouTube Growth',
    goal: 'Increase qualified channel growth.',
    taskTypes: ['YOUTUBE_ANALYSIS'],
    isConnected: (ctx) => ctx.youtube.connected,
    connectionLabel: 'YouTube',
  },
  {
    key: 'tiktok',
    title: 'TikTok Content',
    goal: 'Grow reach through consistent, high-performing content.',
    taskTypes: ['TIKTOK_ANALYSIS'],
    isConnected: (ctx) => ctx.tiktok.connected,
    connectionLabel: 'TikTok',
  },
  {
    key: 'seo',
    title: 'Website Optimization',
    goal: 'Improve technical SEO health and search visibility.',
    taskTypes: ['WEBSITE_CRAWL', 'SEO_ISSUE_ALERT'],
    isConnected: (ctx) => ctx.seo.websites > 0,
    connectionLabel: 'a website',
  },
  {
    key: 'content',
    title: 'Content Engine',
    goal: 'Keep a steady pipeline of repurposed, on-brand content.',
    taskTypes: ['CONTENT_OPPORTUNITY'],
    isConnected: () => true,
    connectionLabel: 'any connected source',
  },
  {
    key: 'monetization',
    title: 'Monetization',
    goal: 'Surface and track new revenue opportunities.',
    taskTypes: ['MONETIZATION_SCAN'],
    isConnected: (ctx) => ctx.youtube.connected || ctx.tiktok.connected,
    connectionLabel: 'YouTube or TikTok',
  },
];

export default async function MissionsPage() {
  const { org } = await requireActiveOrg();
  const [context, automations] = await Promise.all([
    agent.loadOrgContext(org.id),
    automation.listAutomations(org.id),
  ]);

  const hasAnyConnection =
    context.youtube.connected || context.tiktok.connected || context.seo.websites > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Growth Missions"
        description="Each mission groups a growth area with what it needs, its automations, and its recent status."
      />

      {!hasAnyConnection ? (
        <EmptyState
          icon={<Target />}
          title="No missions active yet"
          description="Connect a platform to activate its mission — each one tracks its own goal, connected sources, and automation status."
          action={
            <Button asChild>
              <Link href="/app/integrations">Connect a platform</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {MISSIONS.map((mission) => {
            const connected = mission.isConnected(context);
            const rules = automations.filter((a) =>
              (mission.taskTypes as string[]).includes(a.taskType),
            );
            const active = rules.filter((r) => r.status === 'ACTIVE');
            return (
              <Card key={mission.key}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{mission.title}</CardTitle>
                    <Badge
                      variant={
                        connected ? (active.length > 0 ? 'success' : 'secondary') : 'outline'
                      }
                    >
                      {connected ? (active.length > 0 ? 'Active' : 'Monitoring') : 'Not connected'}
                    </Badge>
                  </div>
                  <CardDescription>{mission.goal}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2 text-sm">
                    {connected ? (
                      <CheckCircle2 className="text-success size-4" aria-hidden />
                    ) : (
                      <Circle className="text-muted-foreground size-4" aria-hidden />
                    )}
                    <span className={connected ? '' : 'text-muted-foreground'}>
                      {connected
                        ? `Connected: ${mission.connectionLabel}`
                        : `Needs: ${mission.connectionLabel}`}
                    </span>
                  </div>
                  {rules.length > 0 ? (
                    <ul className="space-y-1.5">
                      {rules.map((rule) => (
                        <li key={rule.id} className="flex items-center gap-2 text-sm">
                          {rule.lastRun?.status === 'SUCCEEDED' ? (
                            <CheckCircle2 className="text-success size-4" aria-hidden />
                          ) : (
                            <Circle className="text-muted-foreground size-4" aria-hidden />
                          )}
                          <span className="text-muted-foreground flex-1 truncate">{rule.name}</span>
                          <Badge variant="outline">{rule.status.toLowerCase()}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No automation set up for this area yet.
                    </p>
                  )}
                  <Button asChild variant="outline" size="sm">
                    <Link href="/app/automations">
                      {rules.length > 0 ? 'Manage automation' : 'Set up automation'}{' '}
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
