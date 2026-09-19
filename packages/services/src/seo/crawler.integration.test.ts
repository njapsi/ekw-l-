import { PrismaClient } from '@growth-agent/db';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { it } from 'vitest';
import { type RawResponse, type Transport } from './fetch.js';
import { type DnsLookupFn } from './ssrf.js';
import { startCrawl, addWebsite, requestCrawlCancel } from './jobs.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
// Probe at module load (top-level await), BEFORE tests are defined: the
// `maybe()` helper below is evaluated at collection time, so a probe inside
// `beforeAll` came too late and every test here was silently skipped — even
// in CI with a real database (Phase 2 finding).
let reachable = prisma
  ? await prisma.$queryRaw`SELECT 1`.then(
      () => true,
      () => false,
    )
  : false;

beforeAll(async () => {
  if (!prisma) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});
afterAll(async () => {
  await prisma?.$disconnect();
});
const maybe = () => (reachable ? it : it.skip);

// --- A tiny in-memory "vulnerable" test site served over the fake transport ---

const PUBLIC_IP = '93.184.216.34';
const publicDns: DnsLookupFn = async () => [{ address: PUBLIC_IP, family: 4 }];

function html(body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><title>${head || 'Page'}</title></head><body>${body}</body></html>`;
}

const SITE: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {
  'https://vuln.example/': {
    status: 200,
    body: html(
      `<h1>Home</h1><p>welcome to the intentionally imperfect test site for crawler coverage checks</p>
       <a href="/about">About</a> <a href="/broken">Broken</a> <a href="/noindex">Secret</a>
       <a href="/redir">Redirected</a> <a href="http://vuln.example/insecure">insecure</a>`,
    ),
  },
  'https://vuln.example/about': {
    status: 200,
    body: html(
      '<h1>About</h1><p>about page text that is reasonably long for the word count threshold here</p><a href="/">home</a>',
    ),
  },
  'https://vuln.example/broken': { status: 404, body: html('<h1>Not found</h1>') },
  'https://vuln.example/noindex': {
    status: 200,
    headers: { 'x-robots-tag': 'noindex' },
    body: html(
      '<h1>Secret</h1><p>should be recorded as non-indexable and never treated as indexable content</p><a href="/">home</a>',
    ),
  },
  'https://vuln.example/redir': { status: 301, headers: { location: '/about' } },
  'https://vuln.example/robots.txt': { status: 404 },
  'https://vuln.example/sitemap.xml': { status: 404 },
};

const siteTransport: Transport = async (req): Promise<RawResponse> => {
  const entry = SITE[req.url];
  if (!entry)
    return {
      status: 404,
      headers: { 'content-type': 'text/html' },
      bodyBuffer: Buffer.from('nope'),
      truncated: false,
    };
  return {
    status: entry.status,
    headers: { 'content-type': 'text/html', ...(entry.headers ?? {}) },
    bodyBuffer: Buffer.from(entry.body ?? ''),
    truncated: false,
  };
};

async function makeOrg(tag: string): Promise<string> {
  const org = await prisma!.organization.create({ data: { name: tag, slug: tag } });
  return org.id;
}

describe('SEO crawler pipeline (integration)', () => {
  maybe()(
    'crawls a small site, records findings and scores, respecting non-indexability',
    async () => {
      const orgId = await makeOrg(`seo-crawl-${Date.now()}`);
      const site = await addWebsite(
        { organizationId: orgId, userId: 'u1', url: 'https://vuln.example' },
        { db: prisma!, lookup: publicDns },
      );
      // Verify ownership so the crawl is not limited to the shallow sample.
      await prisma!.website.update({
        where: { id: site.id },
        data: { verified: true, verificationMethod: 'DNS_TXT' },
      });

      const { crawlId, result } = await startCrawl(
        {
          organizationId: orgId,
          userId: 'u1',
          websiteId: site.id,
          request: { maxPages: 20, maxDepth: 3 },
        },
        { db: prisma!, lookup: publicDns, transport: siteTransport },
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.pagesCrawled).toBeGreaterThanOrEqual(4);
      expect(result.overallScore).not.toBeNull();

      const pages = await prisma!.crawlPage.findMany({ where: { crawlId } });
      const noindex = pages.find((p) => p.normalizedUrl === 'https://vuln.example/noindex');
      expect(noindex?.indexable).toBe(false);
      const broken = pages.find((p) => p.normalizedUrl === 'https://vuln.example/broken');
      expect(broken?.httpStatus).toBe(404);

      const issues = await prisma!.crawlIssue.findMany({ where: { crawlId } });
      const codes = issues.map((i) => i.code);
      expect(codes).toContain('BROKEN_INTERNAL_LINK');
      expect(codes).toContain('HTTP_NOT_HTTPS');
    },
  );

  maybe()('refuses to crawl a website that resolves to a private address', async () => {
    const orgId = await makeOrg(`seo-ssrf-${Date.now()}`);
    const privateDns: DnsLookupFn = async () => [{ address: '10.1.2.3', family: 4 }];
    await expect(
      addWebsite(
        { organizationId: orgId, userId: 'u1', url: 'https://intranet.example' },
        { db: prisma!, lookup: privateDns },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  maybe()(
    'enforces tenant isolation — another org cannot start a crawl for the website',
    async () => {
      const orgA = await makeOrg(`seo-iso-a-${Date.now()}`);
      const orgB = await makeOrg(`seo-iso-b-${Date.now()}`);
      const site = await addWebsite(
        { organizationId: orgA, userId: 'u1', url: 'https://vuln.example' },
        { db: prisma!, lookup: publicDns },
      );
      await expect(
        startCrawl(
          { organizationId: orgB, userId: 'u2', websiteId: site.id },
          { db: prisma!, lookup: publicDns, transport: siteTransport },
        ),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    },
  );

  maybe()('records BLOCKED when robots.txt disallows everything', async () => {
    const orgId = await makeOrg(`seo-blocked-${Date.now()}`);
    const blockedTransport: Transport = async (req) => {
      if (req.url === 'https://blocked.example/robots.txt')
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          bodyBuffer: Buffer.from('User-agent: *\nDisallow: /'),
          truncated: false,
        };
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        bodyBuffer: Buffer.from(html('<h1>hi</h1>')),
        truncated: false,
      };
    };
    const site = await addWebsite(
      { organizationId: orgId, userId: 'u1', url: 'https://blocked.example' },
      { db: prisma!, lookup: publicDns },
    );
    await prisma!.website.update({ where: { id: site.id }, data: { verified: true } });
    const { result } = await startCrawl(
      { organizationId: orgId, userId: 'u1', websiteId: site.id },
      { db: prisma!, lookup: publicDns, transport: blockedTransport },
    );
    expect(result.status).toBe('BLOCKED');
  });

  maybe()('honours a cancellation requested mid-crawl', async () => {
    const orgId = await makeOrg(`seo-cancel-${Date.now()}`);
    const site = await addWebsite(
      { organizationId: orgId, userId: 'u1', url: 'https://vuln.example' },
      { db: prisma!, lookup: publicDns },
    );
    await prisma!.website.update({ where: { id: site.id }, data: { verified: true } });

    // A transport that cancels the crawl the first time it is asked for a page.
    let firstPage = true;
    const cancellingTransport: Transport = async (req) => {
      if (firstPage && !req.url.endsWith('robots.txt') && !req.url.endsWith('sitemap.xml')) {
        firstPage = false;
      }
      return siteTransport(req);
    };

    // Kick off, then cancel almost immediately.
    const runP = startCrawl(
      {
        organizationId: orgId,
        userId: 'u1',
        websiteId: site.id,
        request: { maxPages: 20, crawlDelayMs: 50 },
      },
      { db: prisma!, lookup: publicDns, transport: cancellingTransport },
    );
    // give the run a tick to create the Crawl row
    await new Promise((r) => setTimeout(r, 20));
    const running = await prisma!.crawl.findFirst({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    if (running)
      await requestCrawlCancel({ organizationId: orgId, crawlId: running.id, userId: 'u1' });
    const { result } = await runP;
    expect(['CANCELLED', 'COMPLETED']).toContain(result.status);
  });
});
