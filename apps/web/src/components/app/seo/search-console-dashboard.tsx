'use client';

import { useState, useTransition } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@growth-agent/ui';
import {
  disconnectSearchConsoleAction,
  inspectUrlAction,
  refreshPerformanceAction,
  selectPropertyAction,
} from '@/server/search-console-actions';

interface PerfRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
interface Totals {
  clicks: number;
  impressions: number;
  /** null with zero impressions — nothing to average, never a real 0. */
  ctr: number | null;
  position: number | null;
}
interface PerformanceData {
  rangeDays: number;
  totals: Totals;
  byDate: PerfRow[];
  byQuery: PerfRow[];
  byPage: PerfRow[];
  byCountry: PerfRow[];
  byDevice: PerfRow[];
  bySearchAppearance: PerfRow[];
}
interface SitemapEntry {
  path: string;
  lastDownloaded: string | null;
  warnings: number;
  errors: number;
  isPending: boolean;
  contents: Array<{ type: string; submitted: number; indexed: number }>;
}
interface Inspection {
  url: string;
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
}
interface HealthInfo {
  ok: boolean;
  detail: string | null;
  quotaUnitsUsedToday: number;
}
interface Dashboard {
  connection: {
    status: string;
    displayName: string | null;
    scopes: string[];
    lastError: string | null;
    health: HealthInfo | null;
  } | null;
  property: {
    id: string;
    siteUrl: string;
    propertyType: string;
    hostname: string;
    permissionLevel: string;
    verified: boolean;
    lastPerformanceAt: string | null;
  } | null;
  performance: {
    capturedAt: string;
    rangeStart: string | null;
    rangeEnd: string | null;
    data: PerformanceData;
  } | null;
  sitemaps: { capturedAt: string; data: { sitemaps: SitemapEntry[] } } | null;
  inspections: Array<{ capturedAt: string; data: Inspection }>;
}
interface Property {
  id: string;
  siteUrl: string;
  verified: boolean;
  permissionLevel: string;
  isSelected: boolean;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const num = (n: number) => n.toLocaleString();
const pos = (n: number) => n.toFixed(1);

export function SearchConsoleDashboard({
  dashboard,
  properties,
}: {
  dashboard: Dashboard;
  properties: Property[];
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done.') : (r.error ?? 'Failed.') });
    });

  const perf = dashboard.performance?.data;
  const sitemaps = dashboard.sitemaps?.data?.sitemaps;

  const [inspectUrl, setInspectUrl] = useState('');
  const [inspectResult, setInspectResult] = useState<Inspection | null>(null);

  return (
    <div className="space-y-6">
      {msg ? (
        <Alert variant={msg.ok ? 'default' : 'destructive'}>
          <AlertDescription>{msg.text}</AlertDescription>
        </Alert>
      ) : null}

      {/* Connection + property */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Connection</CardTitle>
            <Badge
              variant={dashboard.connection?.status === 'ACTIVE' ? 'secondary' : 'destructive'}
            >
              {(dashboard.connection?.status ?? 'unknown').toLowerCase()}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid gap-2 sm:grid-cols-2">
            <Row k="Account">{dashboard.connection?.displayName ?? '—'}</Row>
            <Row k="Health">
              {dashboard.connection?.health
                ? `${dashboard.connection.health.ok ? 'ok' : 'attention'} · ${dashboard.connection.health.detail ?? ''}`
                : 'unknown'}
            </Row>
          </dl>
          {dashboard.connection?.lastError ? (
            <p className="text-destructive">{dashboard.connection.lastError}</p>
          ) : null}

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="text-muted-foreground mb-1 block text-xs">Active property</span>
              <select
                className="border-input bg-background h-9 min-w-[16rem] rounded-md border px-3 text-sm"
                value={dashboard.property?.id ?? ''}
                disabled={pending}
                onChange={(e) => run(() => selectPropertyAction(e.target.value))}
              >
                <option value="" disabled>
                  Choose a property…
                </option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.siteUrl} {p.verified ? '' : '(unverified)'}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              disabled={pending || !dashboard.property}
              onClick={() => run(() => refreshPerformanceAction(28))}
            >
              {pending ? 'Working…' : 'Refresh data'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => disconnectSearchConsoleAction())}
            >
              Disconnect
            </Button>
          </div>
          {dashboard.property && !dashboard.property.verified ? (
            <p className="text-amber-600 dark:text-amber-500">
              This property is not verified for the connected account — Search Console will reject
              data requests until it is verified in Google Search Console.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {!dashboard.property ? (
        <Alert>
          <AlertTitle>No property selected</AlertTitle>
          <AlertDescription>Choose a property above, then refresh.</AlertDescription>
        </Alert>
      ) : !perf ? (
        <Alert>
          <AlertTitle>No data yet</AlertTitle>
          <AlertDescription>
            Click “Refresh data” to pull the last 28 days from Search Console.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Data through {dashboard.performance?.rangeEnd?.slice(0, 10) ?? '—'} · fetched{' '}
            {new Date(dashboard.performance!.capturedAt).toLocaleString()} · {perf.rangeDays}-day
            window · Search Console has a ~2–3 day reporting lag.
          </p>

          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Clicks" value={num(perf.totals.clicks)} />
            <Stat label="Impressions" value={num(perf.totals.impressions)} />
            <Stat label="Avg CTR" value={perf.totals.ctr != null ? pct(perf.totals.ctr) : '—'} />
            <Stat
              label="Avg position"
              value={perf.totals.position != null ? pos(perf.totals.position) : '—'}
            />
          </div>

          <Tabs defaultValue="queries">
            <TabsList className="flex-wrap">
              <TabsTrigger value="queries">Queries</TabsTrigger>
              <TabsTrigger value="pages">Pages</TabsTrigger>
              <TabsTrigger value="countries">Countries</TabsTrigger>
              <TabsTrigger value="devices">Devices</TabsTrigger>
              <TabsTrigger value="appearance">Search appearance</TabsTrigger>
              <TabsTrigger value="sitemaps">Sitemaps</TabsTrigger>
              <TabsTrigger value="indexing">Indexing</TabsTrigger>
            </TabsList>

            <TabsContent value="queries">
              <PerfTable rows={perf.byQuery} label="Query" />
            </TabsContent>
            <TabsContent value="pages">
              <PerfTable rows={perf.byPage} label="Page" mono />
            </TabsContent>
            <TabsContent value="countries">
              <PerfTable rows={perf.byCountry} label="Country" />
            </TabsContent>
            <TabsContent value="devices">
              <PerfTable rows={perf.byDevice} label="Device" />
            </TabsContent>
            <TabsContent value="appearance">
              {perf.bySearchAppearance.length ? (
                <PerfTable rows={perf.bySearchAppearance} label="Appearance" />
              ) : (
                <EmptyNote>
                  Search Console returned no search-appearance rows for this property. Rich-result
                  and special-appearance data only appears when the property earns those result
                  types.
                </EmptyNote>
              )}
            </TabsContent>

            <TabsContent value="sitemaps">
              {sitemaps?.length ? (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr className="border-b [&>th]:px-3 [&>th]:py-2 [&>th]:text-left">
                        <th scope="col">Sitemap</th>
                        <th scope="col">Type</th>
                        <th scope="col" className="text-right">
                          Submitted
                        </th>
                        <th scope="col" className="text-right">
                          Indexed
                        </th>
                        <th scope="col" className="text-right">
                          Warnings
                        </th>
                        <th scope="col" className="text-right">
                          Errors
                        </th>
                        <th scope="col">Last downloaded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sitemaps.flatMap((s) =>
                        (s.contents.length
                          ? s.contents
                          : [{ type: '—', submitted: 0, indexed: 0 }]
                        ).map((c, i) => (
                          <tr key={`${s.path}-${i}`} className="border-b [&>td]:px-3 [&>td]:py-2">
                            <td className="font-mono text-xs">{s.path}</td>
                            <td>{c.type}</td>
                            <td className="text-right tabular-nums">{num(c.submitted)}</td>
                            <td className="text-right tabular-nums">{num(c.indexed)}</td>
                            <td className="text-right tabular-nums">{s.warnings}</td>
                            <td className="text-right tabular-nums">{s.errors}</td>
                            <td className="text-muted-foreground text-xs">
                              {s.lastDownloaded ? s.lastDownloaded.slice(0, 10) : '—'}
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyNote>
                  No sitemaps have been submitted for this property in Search Console.
                </EmptyNote>
              )}
            </TabsContent>

            <TabsContent value="indexing" className="space-y-4">
              <p className="text-muted-foreground text-sm">
                Google’s API does not expose a bulk index-coverage export. Submitted-vs-indexed
                counts (from your sitemaps) are the closest aggregate; use URL Inspection below for
                a single page.
              </p>
              {sitemaps?.length ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  {aggregateContents(sitemaps).map((c) => (
                    <Stat
                      key={c.type}
                      label={`${c.type} · indexed / submitted`}
                      value={`${num(c.indexed)} / ${num(c.submitted)}`}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  className="min-w-[20rem] flex-1"
                  placeholder="https://example.com/a-page"
                  value={inspectUrl}
                  onChange={(e) => setInspectUrl(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={pending || !inspectUrl.trim()}
                  onClick={() =>
                    start(async () => {
                      const r = await inspectUrlAction(inspectUrl.trim());
                      setMsg({
                        ok: r.ok,
                        text: r.ok ? 'Inspection complete.' : (r.error ?? 'Failed.'),
                      });
                      if (r.ok && r.data) setInspectResult(r.data as Inspection);
                    })
                  }
                >
                  Inspect URL
                </Button>
              </div>
              {inspectResult ? <InspectionCard data={inspectResult} /> : null}
              {dashboard.inspections.length ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">Recent inspections</p>
                  {dashboard.inspections.slice(0, 5).map((s, i) => (
                    <InspectionCard key={i} data={s.data} at={s.capturedAt} />
                  ))}
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="border-border/50 flex justify-between gap-4 border-b py-1">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
      {children}
    </div>
  );
}

function PerfTable({ rows, label, mono }: { rows: PerfRow[]; label: string; mono?: boolean }) {
  if (!rows.length) return <EmptyNote>No rows for this dimension in the window.</EmptyNote>;
  const sorted = [...rows].sort((a, b) => b.impressions - a.impressions).slice(0, 100);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr className="border-b [&>th]:px-3 [&>th]:py-2 [&>th]:text-left">
            <th scope="col">{label}</th>
            <th scope="col" className="text-right">
              Clicks
            </th>
            <th scope="col" className="text-right">
              Impressions
            </th>
            <th scope="col" className="text-right">
              CTR
            </th>
            <th scope="col" className="text-right">
              Position
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-b [&>td]:px-3 [&>td]:py-2">
              <td className={mono ? 'max-w-[24rem] truncate font-mono text-xs' : ''}>
                {r.keys[0]}
              </td>
              <td className="text-right tabular-nums">{num(r.clicks)}</td>
              <td className="text-right tabular-nums">{num(r.impressions)}</td>
              <td className="text-right tabular-nums">{pct(r.ctr)}</td>
              <td className="text-right tabular-nums">{pos(r.position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InspectionCard({ data, at }: { data: Inspection; at?: string }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <p className="truncate font-mono text-xs">{data.url}</p>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        <Row k="Verdict">{data.verdict ?? '—'}</Row>
        <Row k="Coverage">{data.coverageState ?? '—'}</Row>
        <Row k="Robots">{data.robotsTxtState ?? '—'}</Row>
        <Row k="Last crawl">{data.lastCrawlTime ? data.lastCrawlTime.slice(0, 10) : '—'}</Row>
        <Row k="Google canonical">{data.googleCanonical ?? '—'}</Row>
        <Row k="User canonical">{data.userCanonical ?? '—'}</Row>
      </dl>
      {at ? (
        <p className="text-muted-foreground mt-1 text-xs">{new Date(at).toLocaleString()}</p>
      ) : null}
    </div>
  );
}

function aggregateContents(
  sitemaps: Array<{ contents: Array<{ type: string; submitted: number; indexed: number }> }>,
): Array<{ type: string; submitted: number; indexed: number }> {
  const byType = new Map<string, { type: string; submitted: number; indexed: number }>();
  for (const s of sitemaps) {
    for (const c of s.contents) {
      const cur = byType.get(c.type) ?? { type: c.type, submitted: 0, indexed: 0 };
      cur.submitted += c.submitted;
      cur.indexed += c.indexed;
      byType.set(c.type, cur);
    }
  }
  return [...byType.values()];
}
