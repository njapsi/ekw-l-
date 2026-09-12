import { z } from 'zod';

/**
 * Zod schemas for the subset of YouTube Data API v3 and YouTube Analytics API
 * v2 responses we consume. Every API payload is parsed through these before it
 * reaches the sync engine — a shape mismatch becomes a typed
 * `MalformedApiDataError`, never a silent bad write.
 */

const thumb = z.object({ url: z.string().optional() }).partial();
const thumbnails = z.object({ default: thumb, medium: thumb, high: thumb }).partial().default({});

export const ChannelListResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        snippet: z
          .object({
            title: z.string().default(''),
            description: z.string().optional(),
            customUrl: z.string().optional(),
            publishedAt: z.string().optional(),
            country: z.string().optional(),
            thumbnails,
          })
          .default({ title: '' }),
        contentDetails: z
          .object({
            relatedPlaylists: z.object({ uploads: z.string().optional() }).partial().default({}),
          })
          .default({ relatedPlaylists: {} }),
        statistics: z
          .object({
            viewCount: z.string().optional(),
            subscriberCount: z.string().optional(),
            hiddenSubscriberCount: z.boolean().optional(),
            videoCount: z.string().optional(),
          })
          .default({}),
      }),
    )
    .default([]),
});
export type ChannelListResponse = z.infer<typeof ChannelListResponse>;

export const PlaylistItemsResponse = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        contentDetails: z
          .object({
            videoId: z.string().min(1),
            videoPublishedAt: z.string().optional(),
          })
          .partial()
          .default({}),
      }),
    )
    .default([]),
});
export type PlaylistItemsResponse = z.infer<typeof PlaylistItemsResponse>;

export const VideoListResponse = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        snippet: z
          .object({
            title: z.string().default(''),
            description: z.string().optional(),
            publishedAt: z.string().optional(),
            tags: z.array(z.string()).optional(),
            categoryId: z.string().optional(),
            defaultLanguage: z.string().optional(),
            liveBroadcastContent: z.string().optional(),
            thumbnails,
          })
          .default({ title: '' }),
        contentDetails: z.object({ duration: z.string().optional() }).partial().default({}),
        status: z
          .object({ privacyStatus: z.string().optional(), madeForKids: z.boolean().optional() })
          .partial()
          .default({}),
        statistics: z
          .object({
            viewCount: z.string().optional(),
            likeCount: z.string().optional(),
            commentCount: z.string().optional(),
            favoriteCount: z.string().optional(),
          })
          .partial()
          .default({}),
      }),
    )
    .default([]),
});
export type VideoListResponse = z.infer<typeof VideoListResponse>;

export const AnalyticsQueryResponse = z.object({
  columnHeaders: z
    .array(z.object({ name: z.string(), dataType: z.string().optional() }))
    .default([]),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
});
export type AnalyticsQueryResponse = z.infer<typeof AnalyticsQueryResponse>;

/** ISO 8601 duration (e.g. "PT4M13S") → seconds. Returns null when unparseable. */
export function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m.map((x) => (x ? Number(x) : 0));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (s ?? 0);
}

/** Parse a numeric string from the API; undefined/empty → null (never 0). */
export function parseBigIntish(v: string | undefined): bigint | null {
  if (v === undefined || v === '') return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}
