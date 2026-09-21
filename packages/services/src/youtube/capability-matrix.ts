/**
 * The YouTube capability matrix (Phase 6, Part 6). A pure read composition
 * over the existing Connection Center (`integrations/center.ts`) — no new
 * capability model, exactly like Phase 5's Capability Discovery. Every
 * capability the brief asks about is reported explicitly, including ones
 * this deployment can never satisfy (no write scope is ever requested —
 * `integrations/google.ts`), so the agent never claims access it doesn't
 * have (hard rule 1, Part 5).
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { getConnectionCenter } from '../integrations/center.js';

export type YouTubeCapabilityKey =
  | 'CHANNEL_READ'
  | 'VIDEO_READ'
  | 'ANALYTICS_READ'
  | 'AUDIENCE_ANALYTICS_READ'
  | 'TRAFFIC_ANALYTICS_READ'
  | 'REVENUE_ANALYTICS_READ'
  | 'PLAYLIST_READ'
  | 'VIDEO_CREATE'
  | 'VIDEO_UPDATE'
  | 'VIDEO_PUBLISH'
  | 'VIDEO_DELETE'
  | 'PLAYLIST_CREATE'
  | 'PLAYLIST_UPDATE'
  | 'PLAYLIST_DELETE';

export interface YouTubeCapabilityStatus {
  key: YouTubeCapabilityKey;
  available: boolean;
  reason: string;
}

const NEVER_REQUESTED_REASON =
  'This deployment only ever requests read-only YouTube scopes (youtube.readonly, yt-analytics.readonly, and optionally yt-analytics-monetary.readonly). No write scope is requested, so this action can never succeed regardless of connection state.';

export interface YouTubeCapabilityMatrix {
  connected: boolean;
  capabilities: YouTubeCapabilityStatus[];
}

/**
 * The matrix for one organization. `connected`/scope-derived capabilities
 * come from the real Connection Center state; the four write-shaped
 * capabilities this deployment has no scope for are always `available:
 * false` with the same explicit reason — never silently omitted, per the
 * brief's own "never fake capabilities" instruction (Part 6).
 */
export async function getYouTubeCapabilityMatrix(
  organizationId: string,
  db: Db = prisma,
): Promise<YouTubeCapabilityMatrix> {
  const entries = await getConnectionCenter(organizationId, new Date(), db);
  const entry = entries.find((e) => e.descriptor.key === 'YOUTUBE');
  const usable = (id: string) => entry?.capabilities.find((c) => c.id === id)?.usable ?? false;
  const reasonFor = (id: string): string => {
    const cap = entry?.capabilities.find((c) => c.id === id);
    if (!entry || entry.state === 'NOT_CONNECTED') {
      return 'No YouTube account is connected to this organization.';
    }
    if (!cap?.usable) {
      return (
        cap?.unavailableReason ??
        entry.diagnostic.explanation ??
        'This capability is not currently usable.'
      );
    }
    return 'Available.';
  };

  const connected = Boolean(entry && entry.state !== 'NOT_CONNECTED');

  const capabilities: YouTubeCapabilityStatus[] = [
    {
      key: 'CHANNEL_READ',
      available: usable('youtube.get_channel'),
      reason: reasonFor('youtube.get_channel'),
    },
    {
      key: 'VIDEO_READ',
      available: usable('youtube.get_videos'),
      reason: reasonFor('youtube.get_videos'),
    },
    {
      key: 'ANALYTICS_READ',
      available: usable('youtube.get_analytics'),
      reason: reasonFor('youtube.get_analytics'),
    },
    {
      key: 'AUDIENCE_ANALYTICS_READ',
      available: false,
      reason:
        'Audience demographic breakdowns (age/gender/subscribed-status) are not synced by this deployment yet — see docs/YOUTUBE-GROWTH-AGENT.md for why this was deferred rather than built without live API verification.',
    },
    {
      key: 'TRAFFIC_ANALYTICS_READ',
      available: false,
      reason:
        'Traffic-source breakdowns (Search/Suggested/Browse/External) are not synced by this deployment yet — same reason as AUDIENCE_ANALYTICS_READ.',
    },
    {
      key: 'REVENUE_ANALYTICS_READ',
      available: usable('youtube.get_revenue'),
      reason: reasonFor('youtube.get_revenue'),
    },
    {
      key: 'PLAYLIST_READ',
      available: connected,
      reason: connected
        ? 'The uploads playlist is read to discover videos; arbitrary playlist reads beyond that are not exposed as a separate feature.'
        : 'No YouTube account is connected to this organization.',
    },
    { key: 'VIDEO_CREATE', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'VIDEO_UPDATE', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'VIDEO_PUBLISH', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'VIDEO_DELETE', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'PLAYLIST_CREATE', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'PLAYLIST_UPDATE', available: false, reason: NEVER_REQUESTED_REASON },
    { key: 'PLAYLIST_DELETE', available: false, reason: NEVER_REQUESTED_REASON },
  ];

  return { connected, capabilities };
}
