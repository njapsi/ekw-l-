/**
 * Playwright-backed `PageRenderer` for the crawler's HEADLESS / AUTO modes
 * (docs/SEO-ENGINE.md §1 "Render decision"). Lives in the worker so
 * `packages/services` stays browser-free.
 *
 * Safety: JS runs, but downloads / popups / geolocation / notifications /
 * service workers are all off, there is a strict per-page time budget, a
 * request interceptor applies the SAME SSRF allowlist (`assertSafeUrl`) to
 * every subresource, AND — since Chromium's own DNS resolution happens after
 * that check and is never pinned to what we validated — every context is
 * routed through a local `PinningProxy` that re-resolves and PINS the actual
 * socket to the validated address, closing the DNS-rebinding TOCTOU gap the
 * route-interceptor check alone cannot (CRAWLER-SECURITY-AUDIT.md CRITICAL-3).
 */
import { seo } from '@growth-agent/services';
import type { Browser } from 'playwright';
import { logger } from '../logger.js';

type RenderResult = Awaited<ReturnType<seo.PageRenderer['render']>>;

export class PlaywrightRenderer implements seo.PageRenderer {
  private browser: Browser | null = null;
  private proxy: seo.PinningProxy | null = null;
  private proxyPort: number | null = null;

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    return this.browser;
  }

  private async getProxyPort(): Promise<number> {
    if (this.proxyPort != null) return this.proxyPort;
    this.proxy = new seo.PinningProxy();
    const { port } = await this.proxy.start();
    this.proxyPort = port;
    return port;
  }

  async render(url: string, opts: { timeoutMs: number }): Promise<RenderResult> {
    let context;
    try {
      const [browser, proxyPort] = await Promise.all([this.getBrowser(), this.getProxyPort()]);
      context = await browser.newContext({
        userAgent: seo.DEFAULT_USER_AGENT,
        serviceWorkers: 'block',
        javaScriptEnabled: true,
        bypassCSP: false,
        proxy: { server: `http://127.0.0.1:${proxyPort}` },
      });
      context.setDefaultTimeout(opts.timeoutMs);
      const page = await context.newPage();

      // SSRF-safe subresource filter: every request must pass assertSafeUrl.
      await page.route('**/*', async (route) => {
        const reqUrl = route.request().url();
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
          await route.continue();
          return;
        }
        try {
          await seo.assertSafeUrl(reqUrl);
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      page.on('download', (d) => void d.delete().catch(() => undefined));
      page.on('popup', (p) => void p.close().catch(() => undefined));

      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: opts.timeoutMs });
      const html = await page.content();

      let labMetrics: RenderResult['labMetrics'];
      try {
        // Evaluated as a string so it is not type-checked against Node's lib.
        const raw: unknown = await page.evaluate(
          `(() => { try {
             var lcp = performance.getEntriesByType('largest-contentful-paint').slice(-1)[0];
             return { lcpMs: lcp ? Math.round(lcp.startTime) : null };
           } catch (e) { return null; } })()`,
        );
        if (raw && typeof raw === 'object' && 'lcpMs' in raw) {
          const lcp = Number((raw as { lcpMs?: unknown }).lcpMs);
          labMetrics = Number.isFinite(lcp) ? { lcpMs: lcp } : undefined;
        }
      } catch {
        labMetrics = undefined;
      }

      return { ok: Boolean(resp), html, timedOut: false, labMetrics };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'render error';
      logger.warn({ url, err: msg }, 'playwright render failed');
      return { ok: false, html: '', timedOut: /timeout/i.test(msg), error: msg };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    await this.proxy?.stop().catch(() => undefined);
    this.proxy = null;
    this.proxyPort = null;
  }
}
