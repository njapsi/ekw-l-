/**
 * Headless-render decision + the renderer seam (docs/SEO-ENGINE.md §1 "Render
 * decision"). The heavy Playwright implementation lives in `apps/worker`
 * (`seo/playwright-renderer.ts`) behind this interface, so `packages/services`
 * stays browser-free and unit-testable. A crawl without a renderer wired simply
 * never renders — pages are recorded from their static HTML and flagged
 * `csrLikely` where appropriate.
 *
 * The renderer MUST apply the same SSRF/scheme/IP allowlist to every subresource
 * request (request interceptor) — see `RendererContract` below.
 */
import type { ExtractedPage } from './html.js';

export interface RenderResult {
  ok: boolean;
  /** Final serialized DOM after JS executed (empty when `ok` is false). */
  html: string;
  timedOut: boolean;
  error?: string;
  /** Lab (not field) timing metrics, when the renderer measured them. */
  labMetrics?: { lcpMs?: number; clsScore?: number; inpMs?: number };
}

export interface PageRenderer {
  /**
   * Render `url` with JS enabled, no downloads/popups/geolocation/service
   * workers, a strict time budget, and an SSRF-safe subresource interceptor.
   */
  render(url: string, opts: { timeoutMs: number }): Promise<RenderResult>;
  close(): Promise<void>;
}

/** No-op renderer — used when `renderMode` is STATIC or no engine is available. */
export const nullRenderer: PageRenderer = {
  render: () =>
    Promise.resolve({ ok: false, html: '', timedOut: false, error: 'rendering not enabled' }),
  close: () => Promise.resolve(),
};

export type RenderDecision = 'skip' | 'render';

/**
 * For `renderMode: AUTO` — decide whether the static HTML is thin enough that a
 * JS render is worth the budget.
 */
export function decideRender(
  renderMode: 'STATIC' | 'AUTO' | 'HEADLESS',
  extracted: Pick<ExtractedPage, 'wordCount' | 'scriptCount' | 'domNodeCount' | 'csrLikely'>,
): RenderDecision {
  if (renderMode === 'STATIC') return 'skip';
  if (renderMode === 'HEADLESS') return 'render';
  // AUTO
  if (extracted.csrLikely) return 'render';
  const thinText = extracted.wordCount < 120;
  const scriptHeavy = extracted.scriptCount >= 5;
  const shallowDom = extracted.domNodeCount < 150;
  return thinText && scriptHeavy && shallowDom ? 'render' : 'skip';
}
