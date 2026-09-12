import type { ReportSnapshot } from '@growth-agent/core';
import {
  Alert,
  AlertDescription,
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';

const SEVERITY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'secondary',
  low: 'outline',
  info: 'outline',
};

const PRIORITY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'secondary',
  low: 'outline',
};

function DirectionMark({ direction }: { direction: string }) {
  if (direction === 'up') return <span className="text-emerald-600">▲</span>;
  if (direction === 'down') return <span className="text-destructive">▼</span>;
  if (direction === 'flat') return <span className="text-muted-foreground">▬</span>;
  return null;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toISOString().slice(0, 10) : '—';
}

/**
 * Renders a `ReportSnapshot` — the same component for the authenticated
 * dashboard and the public (already-redacted) share view.
 */
export function ReportSnapshotView({
  snapshot,
  isPublic = false,
}: {
  snapshot: ReportSnapshot;
  isPublic?: boolean;
}) {
  const s = snapshot;
  return (
    <div className="space-y-6">
      {(isPublic || s.meta.isPublic) && (
        <Alert>
          <AlertDescription>
            This is a shared, read-only copy. Account identifiers and private figures have been
            removed.
          </AlertDescription>
        </Alert>
      )}

      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>Subject: {s.meta.subjectLabel}</span>
        <span>Generated: {fmtDate(s.meta.generatedAt)}</span>
        <span>Data through: {fmtDate(s.meta.dataThrough)}</span>
        {s.executiveSummary.grounded ? <span>AI summary</span> : <span>Deterministic summary</span>}
      </div>

      {/* Executive summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Executive summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="font-medium">{s.executiveSummary.headline}</p>
          {s.executiveSummary.paragraphs.map((p, i) => (
            <p key={i} className="text-sm">
              {p}
            </p>
          ))}
        </CardContent>
      </Card>

      {/* Key metrics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Key metrics</CardTitle>
        </CardHeader>
        <CardContent>
          {s.keyMetrics.length === 0 ? (
            <p className="text-muted-foreground text-sm">No metrics available.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {s.keyMetrics.map((m) => (
                <div key={m.label} className="rounded border p-3">
                  <p className="text-muted-foreground text-xs">{m.label}</p>
                  <p className="text-lg font-semibold">{m.value}</p>
                  {m.delta ? (
                    <p className="text-muted-foreground text-xs">
                      <DirectionMark direction={m.delta.direction} /> was {m.delta.previous}
                      {m.delta.changePct != null
                        ? ` (${m.delta.changePct > 0 ? '+' : ''}${m.delta.changePct}%)`
                        : ''}
                    </p>
                  ) : null}
                  {m.note ? <p className="text-muted-foreground mt-1 text-xs">{m.note}</p> : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Problems */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Problems ({s.problems.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {s.problems.length === 0 ? (
            <p className="text-muted-foreground text-sm">No problems identified.</p>
          ) : (
            s.problems.map((p) => (
              <div key={p.id} className="border-b pb-2 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY_VARIANT[p.severity] ?? 'outline'}>{p.severity}</Badge>
                  <span className="text-sm font-medium">{p.title}</span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{p.detail}</p>
                {p.evidence.map((e, i) => (
                  <p key={i} className="text-muted-foreground text-xs">
                    · {e}
                  </p>
                ))}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Opportunities */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Opportunities ({s.opportunities.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {s.opportunities.length === 0 ? (
            <p className="text-muted-foreground text-sm">No opportunities identified.</p>
          ) : (
            s.opportunities.map((o) => (
              <div key={o.id} className="border-b pb-2 last:border-0">
                <p className="text-sm font-medium">{o.title}</p>
                <p className="text-muted-foreground mt-1 text-sm">{o.detail}</p>
                <p className="text-muted-foreground text-xs">
                  {o.potential ? `Potential: ${o.potential}. ` : ''}
                  {o.effort ? `Effort: ${o.effort}.` : ''}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Recommendations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recommendations ({s.recommendations.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {s.recommendations.length === 0 ? (
            <p className="text-muted-foreground text-sm">No open recommendations.</p>
          ) : (
            s.recommendations.map((r) => (
              <div key={r.id} className="border-b pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PRIORITY_VARIANT[r.priority] ?? 'outline'}>{r.priority}</Badge>
                  <span className="text-sm font-medium">{r.title}</span>
                  <span className="text-muted-foreground text-xs">
                    effort {r.effort} · {Math.round(r.confidence * 100)}% confidence
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-sm">{r.why}</p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {r.actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-1 text-xs">
                  Expected impact: {r.expectedImpact}
                </p>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Priority actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Priority actions</CardTitle>
        </CardHeader>
        <CardContent>
          {s.priorityActions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No priority actions.</p>
          ) : (
            <ol className="space-y-2">
              {s.priorityActions.map((a) => (
                <li key={a.rank} className="rounded border p-3 text-sm">
                  <span className="font-medium">
                    {a.rank}. {a.title}
                  </span>
                  <p className="text-muted-foreground">{a.rationale}</p>
                  {a.effort ? (
                    <p className="text-muted-foreground text-xs">Effort: {a.effort}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Historical changes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historical changes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!s.historicalChanges.comparedTo ? (
            <p className="text-muted-foreground text-sm">
              {s.historicalChanges.notes[0] ??
                'This is the first report of its type; the next one will show what changed.'}
            </p>
          ) : (
            <>
              {s.historicalChanges.changes.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-muted-foreground text-xs">
                      <tr>
                        <th className="py-1 pr-3">Metric</th>
                        <th className="py-1 pr-3">From</th>
                        <th className="py-1 pr-3">To</th>
                        <th className="py-1 pr-3">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.historicalChanges.changes.map((c) => (
                        <tr key={c.label} className="border-t">
                          <td className="py-1 pr-3">{c.label}</td>
                          <td className="py-1 pr-3">{c.from}</td>
                          <td className="py-1 pr-3">{c.to}</td>
                          <td className="py-1 pr-3">
                            <DirectionMark direction={c.direction} />{' '}
                            {c.changePct != null
                              ? `${c.changePct > 0 ? '+' : ''}${c.changePct}%`
                              : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {s.historicalChanges.notes.map((n, i) => (
                <p key={i} className="text-muted-foreground text-sm">
                  {n}
                </p>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      {(s.dataGaps.length > 0 || s.disclaimers.length > 0) && (
        <div className="text-muted-foreground space-y-1 text-xs">
          {s.dataGaps.map((d, i) => (
            <p key={`g${i}`}>Data gap: {d}</p>
          ))}
          {s.disclaimers.map((d, i) => (
            <p key={`d${i}`}>{d}</p>
          ))}
        </div>
      )}
    </div>
  );
}
