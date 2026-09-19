import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { audit, can } from '@growth-agent/services';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';

function pickCategory(v: string | null | undefined): audit.AuditCategory | undefined {
  return (audit.AUDIT_CATEGORIES as readonly string[]).includes(v ?? '')
    ? (v as audit.AuditCategory)
    : undefined;
}

function pickResult(v: string | null | undefined): 'SUCCESS' | 'FAILURE' | 'DENIED' | undefined {
  return v === 'SUCCESS' || v === 'FAILURE' || v === 'DENIED' ? v : undefined;
}

/** A YYYY-MM-DD filter value as a UTC bound; anything else is ignored. */
function utcDay(v: string | null | undefined, end: boolean): Date | undefined {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T${end ? '23:59:59' : '00:00:00'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export const metadata: Metadata = { title: 'Audit log · Settings' };

type Search = Record<string, string | undefined>;

const CATEGORY_LABEL: Record<string, string> = {
  auth: 'Sign-in & account',
  organization: 'Organization',
  member: 'Members',
  integration: 'Integrations',
  ai: 'AI agent & approvals',
  content: 'Content',
  seo: 'SEO',
  automation: 'Automations',
  report: 'Reports',
  billing: 'Billing',
  api_key: 'API keys',
  security: 'Security settings',
  data: 'Other',
};

const RESULT_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'outline'> = {
  SUCCESS: 'success',
  DENIED: 'warning',
  FAILURE: 'destructive',
};

function dayLabel(d: Date): string {
  const today = new Date();
  const key = (x: Date) => x.toISOString().slice(0, 10);
  if (key(d) === key(today)) return 'Today';
  const y = new Date(today.getTime() - 86_400_000);
  if (key(d) === key(y)) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function describeMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    parts.push(`${k}: ${String(v)}`);
    if (parts.length >= 4) break;
  }
  return parts.join(' · ');
}

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user, org } = await requireActiveOrg();
  if (!can(org.role, 'audit.view')) redirect('/app/settings');
  const sp = await searchParams;
  const filter = {
    q: sp.q || undefined,
    category: pickCategory(sp.category),
    actorId: sp.actor || undefined,
    result: pickResult(sp.result),
    from: utcDay(sp.from, false),
    to: utcDay(sp.to, true),
    cursor: sp.cursor || undefined,
    limit: 50,
  };
  const [{ events, nextCursor }, actors] = await Promise.all([
    audit.listAuditEvents(user.id, org.id, filter),
    audit.listAuditActors(user.id, org.id),
  ]);

  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const label = dayLabel(e.createdAt);
    groups.set(label, [...(groups.get(label) ?? []), e]);
  }
  const qs = new URLSearchParams(
    Object.entries({
      q: sp.q,
      category: sp.category,
      actor: sp.actor,
      result: sp.result,
      from: sp.from,
      to: sp.to,
    }).filter(([, v]) => v) as Array<[string, string]>,
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit log</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="a-q">Search</Label>
              <Input
                id="a-q"
                name="q"
                defaultValue={sp.q}
                placeholder="Event, resource or person"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-cat">Event type</Label>
              <select
                id="a-cat"
                name="category"
                defaultValue={sp.category ?? ''}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">All events</option>
                {audit.AUDIT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c] ?? c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-actor">Person</Label>
              <select
                id="a-actor"
                name="actor"
                defaultValue={sp.actor ?? ''}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">Anyone</option>
                {actors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name ?? a.email}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-result">Result</Label>
              <select
                id="a-result"
                name="result"
                defaultValue={sp.result ?? ''}
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">Any</option>
                <option value="SUCCESS">Success</option>
                <option value="DENIED">Denied</option>
                <option value="FAILURE">Failure</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-from">From (UTC)</Label>
              <Input id="a-from" name="from" type="date" defaultValue={sp.from} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-to">To (UTC)</Label>
              <Input id="a-to" name="to" type="date" defaultValue={sp.to} />
            </div>
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button type="submit" size="sm">
                Apply filters
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/app/settings/audit">Clear</Link>
              </Button>
              {can(org.role, 'audit.export') ? (
                <Button asChild size="sm" variant="outline" className="ml-auto">
                  <a href={`/app/settings/audit/export?${qs.toString()}`}>Export CSV</a>
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {events.length === 0 ? (
        <Card>
          <CardContent className="text-muted-foreground pt-6 text-sm">
            No events match these filters.
          </CardContent>
        </Card>
      ) : (
        [...groups.entries()].map(([day, list]) => (
          <section key={day} aria-label={day} className="space-y-2">
            <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              {day}
            </h2>
            <Card>
              <CardContent className="divide-border divide-y pt-2">
                {list.map((e) => (
                  <div
                    key={e.id}
                    className="grid gap-1 py-3 sm:grid-cols-[4.5rem_1fr_auto] sm:gap-4"
                  >
                    <time
                      className="text-muted-foreground font-mono text-xs"
                      dateTime={e.createdAt.toISOString()}
                    >
                      {e.createdAt.toISOString().slice(11, 16)}
                    </time>
                    <div className="min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">
                          {e.actor
                            ? (e.actor.name ?? e.actor.email)
                            : e.actorType === 'AGENT'
                              ? 'AI agent'
                              : 'System'}
                        </span>{' '}
                        — {e.label}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {e.resourceType
                          ? `${e.resourceType}${e.resourceId ? ` · ${e.resourceId}` : ''}`
                          : ''}
                        {describeMeta(e.metadata) ? ` · ${describeMeta(e.metadata)}` : ''}
                        {e.requestId ? ` · ref ${e.requestId}` : ''}
                      </p>
                    </div>
                    <Badge variant={RESULT_VARIANT[e.result] ?? 'outline'} className="h-fit w-fit">
                      {e.result.toLowerCase()}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        ))
      )}

      {nextCursor ? (
        <Button asChild variant="outline">
          <Link
            href={`/app/settings/audit?${new URLSearchParams([...qs.entries(), ['cursor', nextCursor]]).toString()}`}
          >
            Older events
          </Link>
        </Button>
      ) : null}
      <p className="text-muted-foreground text-xs">
        Times are UTC. Secrets are never recorded in this log.
      </p>
    </>
  );
}
