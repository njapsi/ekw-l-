import { beforeEach, describe, expect, it } from 'vitest';
import {
  incr,
  observe,
  recordAiCall,
  recordHttpRequest,
  renderProm,
  resetMetricsForTest,
  setGauge,
  snapshot,
  statusClass,
} from './metrics.js';

beforeEach(() => resetMetricsForTest());

describe('counters & gauges', () => {
  it('accumulates counters by label set and keeps the key stable regardless of label order', () => {
    incr('c_total', 1, { b: '2', a: '1' });
    incr('c_total', 2, { a: '1', b: '2' });
    const snap = snapshot();
    const row = snap.counters.find((c) => c.name === 'c_total{a="1",b="2"}');
    expect(row?.value).toBe(3);
  });

  it('gauges hold the last value', () => {
    setGauge('g', 5);
    setGauge('g', 9);
    expect(snapshot().gauges.find((g) => g.name === 'g')?.value).toBe(9);
  });
});

describe('histograms', () => {
  it('computes approximate quantiles from buckets', () => {
    for (const v of [10, 10, 10, 10, 10, 10, 10, 10, 10, 900]) observe('h_ms', v);
    const h = snapshot().histograms.find((x) => x.name === 'h_ms');
    expect(h?.count).toBe(10);
    expect(h?.p50).toBeLessThanOrEqual(25);
    expect(h?.p99).toBeGreaterThanOrEqual(900);
  });

  it('renders Prometheus bucket/sum/count lines', () => {
    observe('req_ms', 30, { route: 'x' });
    const text = renderProm();
    expect(text).toMatch(/req_ms_bucket\{route="x",le="50"\} 1/);
    expect(text).toMatch(/req_ms_bucket\{route="x",le="\+Inf"\} 1/);
    expect(text).toMatch(/req_ms_count\{route="x"\} 1/);
  });
});

describe('semantic helpers', () => {
  it('statusClass buckets by hundreds', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('recordHttpRequest bumps totals and only counts 5xx as an error', () => {
    recordHttpRequest({ route: 'r', method: 'GET', status: 200, durationMs: 5 });
    recordHttpRequest({ route: 'r', method: 'GET', status: 500, durationMs: 5 });
    const snap = snapshot();
    expect(
      snap.counters.find((c) => c.name.startsWith('http_requests_total') && c.name.includes('2xx'))
        ?.value,
    ).toBe(1);
    expect(snap.counters.find((c) => c.name === 'http_errors_total{route="r"}')?.value).toBe(1);
  });

  it('recordAiCall accumulates token + cost counters', () => {
    recordAiCall({
      provider: 'anthropic',
      model: 'claude',
      ok: true,
      durationMs: 100,
      promptTokens: 10,
      completionTokens: 4,
      costUsd: 0.002,
    });
    const snap = snapshot();
    expect(snap.counters.find((c) => c.name.startsWith('ai_prompt_tokens_total'))?.value).toBe(10);
    expect(snap.counters.find((c) => c.name.startsWith('ai_completion_tokens_total'))?.value).toBe(
      4,
    );
  });
});
