/**
 * Restricted, read-only Search Console tools for the AI SEO Agent. They read the
 * latest persisted `SearchConsoleSnapshot` for the org's SELECTED property whose
 * hostname matches the site under analysis — so every figure the agent sees is
 * Google's own reported metric, never synthesised. When there is no connected /
 * selected / matching property, or no snapshot yet, the tool returns
 * `{ available: false, reason }` — it never fabricates numbers and never throws
 * into the agent.
 *
 * Scope comes from the tenant context (`organizationId`), never from tool input.
 * `gsc.inspect_url` is the only tool that reaches Google live (quota-scarce).
 */
import type { Db } from '@growth-agent/db';
import { z } from 'zod';
import {
  getPerformanceForAgent,
  getSitemapsForAgent,
  inspectUrl,
  listInspections,
} from './read.js';
import type { PerformanceSnapshotData } from './schemas.js';

export interface GscAgentToolContext {
  organizationId: string;
  db: Db;
  /** Needed only by `gsc.inspect_url` (a live, metered call). */
  redirectUri?: string;
}

export const GSC_AGENT_TOOL_NAMES = [
  'gsc.get_property',
  'gsc.get_performance',
  'gsc.get_top_queries',
  'gsc.get_top_pages',
  'gsc.get_sitemaps',
  'gsc.inspect_url',
] as const;
export type GscAgentToolName = (typeof GSC_AGENT_TOOL_NAMES)[number];

const HostRef = z.object({ hostname: z.string().min(1) });
const TopRef = z.object({
  hostname: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
});
const InspectRef = z.object({ hostname: z.string().min(1), url: z.string().url() });

type Unavailable = { available: false; reason: string };
const unavailable = (reason: string): Unavailable => ({ available: false, reason });

async function loadPerf(
  ctx: GscAgentToolContext,
  hostname: string,
): Promise<
  | {
      available: true;
      property: { siteUrl: string; permissionLevel: string };
      perf: PerformanceSnapshotData;
      dataThrough: string | null;
      capturedAt: string;
    }
  | Unavailable
> {
  const hit = await getPerformanceForAgent(ctx.organizationId, hostname, ctx.db);
  if (!hit) {
    return unavailable(
      'No Search Console property is connected and selected for this site (or it has no performance snapshot yet).',
    );
  }
  return {
    available: true,
    property: { siteUrl: hit.property.siteUrl, permissionLevel: hit.property.permissionLevel },
    perf: hit.performance,
    dataThrough: hit.dataThrough ? hit.dataThrough.toISOString().slice(0, 10) : null,
    capturedAt: hit.capturedAt.toISOString(),
  };
}

export interface GscAgentTools {
  get_property(input: z.infer<typeof HostRef>): Promise<unknown>;
  get_performance(input: z.infer<typeof HostRef>): Promise<unknown>;
  get_top_queries(input: z.infer<typeof TopRef>): Promise<unknown>;
  get_top_pages(input: z.infer<typeof TopRef>): Promise<unknown>;
  get_sitemaps(input: z.infer<typeof HostRef>): Promise<unknown>;
  inspect_url(input: z.infer<typeof InspectRef>): Promise<unknown>;
}

export function bindGscAgentTools(ctx: GscAgentToolContext): GscAgentTools {
  return {
    async get_property(raw) {
      const { hostname } = HostRef.parse(raw);
      const p = await loadPerf(ctx, hostname);
      if (!p.available) return p;
      return {
        available: true,
        siteUrl: p.property.siteUrl,
        permissionLevel: p.property.permissionLevel,
        dataThrough: p.dataThrough,
        capturedAt: p.capturedAt,
      };
    },
    async get_performance(raw) {
      const { hostname } = HostRef.parse(raw);
      const p = await loadPerf(ctx, hostname);
      if (!p.available) return p;
      return {
        available: true,
        dataThrough: p.dataThrough,
        totals: p.perf.totals,
        rangeDays: p.perf.rangeDays,
        byDate: p.perf.byDate,
        byCountry: p.perf.byCountry.slice(0, 15),
        byDevice: p.perf.byDevice,
        bySearchAppearance: p.perf.bySearchAppearance,
      };
    },
    async get_top_queries(raw) {
      const { hostname, limit } = TopRef.parse(raw);
      const p = await loadPerf(ctx, hostname);
      if (!p.available) return p;
      return {
        available: true,
        dataThrough: p.dataThrough,
        queries: p.perf.byQuery
          .slice()
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, limit)
          .map((r) => ({
            query: r.keys[0] ?? '',
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
          })),
      };
    },
    async get_top_pages(raw) {
      const { hostname, limit } = TopRef.parse(raw);
      const p = await loadPerf(ctx, hostname);
      if (!p.available) return p;
      return {
        available: true,
        dataThrough: p.dataThrough,
        pages: p.perf.byPage
          .slice()
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, limit)
          .map((r) => ({
            url: r.keys[0] ?? '',
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
          })),
      };
    },
    async get_sitemaps(raw) {
      const { hostname } = HostRef.parse(raw);
      const hit = await getPerformanceForAgent(ctx.organizationId, hostname, ctx.db);
      if (!hit) return unavailable('No connected/selected Search Console property for this site.');
      const data = await getSitemapsForAgent(ctx.organizationId, hit.property.id, ctx.db);
      if (!data) return unavailable('No sitemaps snapshot has been captured yet.');
      return { available: true, sitemaps: data.sitemaps };
    },
    async inspect_url(raw) {
      const { hostname, url } = InspectRef.parse(raw);
      if (!ctx.redirectUri) return unavailable('URL inspection is not available in this context.');
      const hit = await getPerformanceForAgent(ctx.organizationId, hostname, ctx.db);
      if (!hit) return unavailable('No connected/selected Search Console property for this site.');
      // Serve a cached inspection if one exists; otherwise perform one live.
      const cached = await listInspections(ctx.organizationId, hit.property.id, ctx.db);
      const found = cached.find((s) => (s.data as { url?: string }).url === url);
      if (found) return { available: true, cached: true, ...(found.data as object) };
      const data = await inspectUrl({
        organizationId: ctx.organizationId,
        userId: 'agent',
        redirectUri: ctx.redirectUri,
        url,
        siteId: hit.property.id,
        db: ctx.db,
      });
      return { available: true, cached: false, ...data };
    },
  };
}

export function describeGscAgentTools(): Array<{
  name: GscAgentToolName;
  description: string;
  readOnly: true;
}> {
  return [
    {
      name: 'gsc.get_property',
      description: 'The connected Search Console property for this site + its data window.',
      readOnly: true,
    },
    {
      name: 'gsc.get_performance',
      description:
        'Search Console totals + by-date / country / device / search-appearance for the window.',
      readOnly: true,
    },
    {
      name: 'gsc.get_top_queries',
      description: 'Top search queries by impressions (clicks, CTR, avg position).',
      readOnly: true,
    },
    {
      name: 'gsc.get_top_pages',
      description: 'Top pages by impressions (clicks, CTR, avg position).',
      readOnly: true,
    },
    {
      name: 'gsc.get_sitemaps',
      description: 'Submitted sitemaps and their submitted/indexed counts from Search Console.',
      readOnly: true,
    },
    {
      name: 'gsc.inspect_url',
      description:
        'Live URL Inspection for one URL (indexing verdict, coverage, canonical). Quota-scarce.',
      readOnly: true,
    },
  ];
}
