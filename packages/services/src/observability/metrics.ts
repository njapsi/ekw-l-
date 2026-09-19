/**
 * A tiny in-process metrics registry — counters, gauges and fixed-bucket
 * histograms held in memory and rendered as Prometheus text at
 * `GET /api/metrics` (web) and `:$WORKER_HEALTH_PORT/metrics` (worker).
 *
 * Deliberately dependency-free (ADR-0028): a full OpenTelemetry + collector
 * stack is deferred. The trade-off is that these series **reset when the
 * process restarts** and are per-instance — a scraper (Prometheus) is what
 * turns them into fleet-wide history. Durable, historical numbers on the admin
 * dashboards come from the database instead (see `admin-metrics.ts`).
 */

/** Millisecond-oriented buckets. Upper bounds, ascending. */
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

interface Histogram {
  bounds: readonly number[];
  counts: number[];
  sum: number;
  count: number;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, Histogram>();

function sanitizeLabelValue(v: string): string {
  return v.replace(/[\n\r"\\]/g, ' ').slice(0, 60);
}

/** `name{a="1",b="2"}` — labels sorted so the key is stable. */
function seriesKey(name: string, labels?: Record<string, string | number>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${sanitizeLabelValue(String(labels[k]))}"`);
  return `${name}{${parts.join(',')}}`;
}

export function incr(name: string, by = 1, labels?: Record<string, string | number>): void {
  const key = seriesKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function setGauge(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
): void {
  gauges.set(seriesKey(name, labels), value);
}

export function observe(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
): void {
  const key = seriesKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = {
      bounds: BUCKETS_MS,
      counts: new Array<number>(BUCKETS_MS.length + 1).fill(0),
      sum: 0,
      count: 0,
    };
    histograms.set(key, h);
  }
  h.sum += value;
  h.count += 1;
  let placed = false;
  for (let i = 0; i < h.bounds.length; i += 1) {
    const bound = h.bounds[i];
    if (bound !== undefined && value <= bound) {
      const c = h.counts[i];
      h.counts[i] = (c ?? 0) + 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    const last = h.counts.length - 1;
    h.counts[last] = (h.counts[last] ?? 0) + 1;
  }
}

/** Approximate quantile from bucket counts (returns the containing bucket's upper bound). */
function quantile(h: Histogram, q: number): number {
  if (h.count === 0) return 0;
  const target = q * h.count;
  let cumulative = 0;
  for (let i = 0; i < h.counts.length; i += 1) {
    cumulative += h.counts[i] ?? 0;
    if (cumulative >= target) {
      return h.bounds[i] ?? Number.POSITIVE_INFINITY;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface MetricsSnapshot {
  counters: { name: string; value: number }[];
  gauges: { name: string; value: number }[];
  histograms: {
    name: string;
    count: number;
    sum: number;
    avg: number;
    p50: number;
    p90: number;
    p99: number;
  }[];
  collectedAt: string;
}

export function snapshot(): MetricsSnapshot {
  return {
    counters: [...counters.entries()].map(([name, value]) => ({ name, value })).sort(byName),
    gauges: [...gauges.entries()].map(([name, value]) => ({ name, value })).sort(byName),
    histograms: [...histograms.entries()]
      .map(([name, h]) => ({
        name,
        count: h.count,
        sum: Math.round(h.sum),
        avg: h.count ? Math.round(h.sum / h.count) : 0,
        p50: quantile(h, 0.5),
        p90: quantile(h, 0.9),
        p99: quantile(h, 0.99),
      }))
      .sort(byName),
    collectedAt: new Date().toISOString(),
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Split `foo{a="1"}` back into the metric name and the label block. */
function splitKey(key: string): { base: string; labels: string } {
  const brace = key.indexOf('{');
  if (brace === -1) return { base: key, labels: '' };
  return { base: key.slice(0, brace), labels: key.slice(brace) };
}

/** Prometheus text exposition (format version 0.0.4). */
export function renderProm(): string {
  const lines: string[] = [];

  for (const [key, value] of counters) {
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of gauges) {
    lines.push(`${key} ${value}`);
  }
  for (const [key, h] of histograms) {
    const { base, labels } = splitKey(key);
    let cumulative = 0;
    for (let i = 0; i < h.bounds.length; i += 1) {
      cumulative += h.counts[i] ?? 0;
      const le = String(h.bounds[i]);
      lines.push(`${base}_bucket${withLe(labels, le)} ${cumulative}`);
    }
    cumulative += h.counts[h.counts.length - 1] ?? 0;
    lines.push(`${base}_bucket${withLe(labels, '+Inf')} ${cumulative}`);
    lines.push(`${base}_sum${labels} ${Math.round(h.sum)}`);
    lines.push(`${base}_count${labels} ${h.count}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '# no metrics collected yet\n';
}

function withLe(labels: string, le: string): string {
  if (!labels) return `{le="${le}"}`;
  return `${labels.slice(0, -1)},le="${le}"}`;
}

/** Test-only: wipe every series. */
export function resetMetricsForTest(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

// --- Semantic helpers used across the codebase -----------------------------

/** Bucket an HTTP status into a Prometheus-friendly class: `2xx`, `4xx`, … */
export function statusClass(status: number): string {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  if (status >= 200) return '2xx';
  return 'other';
}

export function recordHttpRequest(args: {
  route: string;
  method: string;
  status: number;
  durationMs: number;
}): void {
  const labels = { route: args.route, method: args.method, status: statusClass(args.status) };
  incr('http_requests_total', 1, labels);
  observe('http_request_duration_ms', args.durationMs, { route: args.route });
  if (args.status >= 500) incr('http_errors_total', 1, { route: args.route });
}

export function recordExternalCall(args: {
  provider: string;
  operation: string;
  ok: boolean;
  durationMs: number;
}): void {
  incr('external_api_calls_total', 1, { provider: args.provider, operation: args.operation });
  observe('external_api_duration_ms', args.durationMs, { provider: args.provider });
  if (!args.ok) incr('external_api_failures_total', 1, { provider: args.provider });
}

export function recordAiCall(args: {
  provider: string;
  model: string;
  ok: boolean;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
}): void {
  const labels = { provider: args.provider, model: args.model };
  incr('ai_calls_total', 1, labels);
  observe('ai_call_duration_ms', args.durationMs, labels);
  if (!args.ok) incr('ai_call_failures_total', 1, labels);
  if (args.promptTokens) incr('ai_prompt_tokens_total', args.promptTokens, labels);
  if (args.completionTokens) incr('ai_completion_tokens_total', args.completionTokens, labels);
  if (args.costUsd)
    incr('ai_cost_usd_total', Math.round(args.costUsd * 1_000_000) / 1_000_000, labels);
}

export function recordJob(args: { queue: string; ok: boolean; durationMs: number }): void {
  incr('jobs_processed_total', 1, { queue: args.queue });
  observe('job_duration_ms', args.durationMs, { queue: args.queue });
  if (!args.ok) incr('jobs_failed_total', 1, { queue: args.queue });
}

export function recordCrawlOutcome(ok: boolean): void {
  incr('crawls_total', 1);
  if (!ok) incr('crawl_failures_total', 1);
}

export function recordUsageRejection(meter: string): void {
  incr('usage_limit_rejections_total', 1, { meter });
}

/** A sustained rate here means a misconfigured `STRIPE_WEBHOOK_SECRET`, or
 * someone probing the endpoint — either way, an operator should know. */
export function recordWebhookSignatureFailure(provider: string): void {
  incr('webhook_signature_failures_total', 1, { provider });
}

/** Phase 1 — every integration sync attempt, by integration and outcome. */
export function recordIntegrationSync(args: {
  integration: string;
  status: 'COMPLETED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
}): void {
  incr('integration_sync_total', 1, { integration: args.integration, status: args.status });
  observe('integration_sync_duration_ms', args.durationMs, { integration: args.integration });
}

/** Phase 1 — token-lifecycle sweep outcomes (refreshed / reauth_needed / resealed / failed). */
export function recordTokenLifecycle(outcome: string, by = 1): void {
  if (by > 0) incr('integration_token_lifecycle_total', by, { outcome });
}
