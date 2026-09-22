/**
 * The TikTok capability matrix (Phase 7, §2/§4). A pure read composition over
 * the existing Connection Center (`integrations/center.ts`) plus the
 * `TIKTOK` entry in `integrations/contract.ts` — no new capability model,
 * exactly like the YouTube capability matrix (`youtube/capability-matrix.ts`).
 *
 * TikTok's contract registry only has four capability ids
 * (`tiktok.get_profile`, `tiktok.get_videos`, `tiktok.get_analytics`,
 * `tiktok.publish`) because those are the only endpoints TikTok's public
 * APIs actually expose — this module reports the fuller, named list the
 * brief asks for (§4/§2's AVAILABLE/REQUIRES_APPROVAL/NOT_AVAILABLE and
 * READ_ONLY/WRITE/PUBLISH/DELETE vocabulary), mapping every extra key onto
 * either a real contract capability or an explicit, documented absence.
 * Nothing here invents a capability TikTok's API doesn't have.
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { getConnectionCenter } from '../integrations/center.js';

export type TikTokCapabilityKey =
  | 'ACCOUNT_READ'
  | 'VIDEO_READ'
  | 'VIDEO_ANALYTICS_READ'
  | 'CONTENT_ANALYTICS_READ'
  | 'AUDIENCE_ANALYTICS_READ'
  | 'COMMENTS_READ'
  | 'CONTENT_DRAFT'
  | 'CONTENT_PUBLISH'
  | 'VIDEO_UPDATE'
  | 'VIDEO_DELETE'
  | 'COMMENT_MANAGEMENT'
  | 'SCHEDULE_PUBLISH';

export type TikTokCapabilityAvailability = 'AVAILABLE' | 'REQUIRES_APPROVAL' | 'NOT_AVAILABLE';
export type TikTokCapabilityLevel = 'READ_ONLY' | 'WRITE' | 'PUBLISH' | 'DELETE';

export interface TikTokCapabilityStatus {
  key: TikTokCapabilityKey;
  level: TikTokCapabilityLevel;
  availability: TikTokCapabilityAvailability;
  reason: string;
}

export interface TikTokCapabilityMatrix {
  connected: boolean;
  capabilities: TikTokCapabilityStatus[];
}

const NO_PUBLIC_API_REASON =
  "TikTok's public Display/Content Posting APIs expose no endpoint for this. It is not a scope or permission gap — the capability does not exist to request, so it is never shown as available.";

/**
 * The matrix for one organization. Read/publish-draft capabilities come from
 * the real Connection Center state; the capabilities TikTok's public API
 * simply does not expose (audience demographics, comment reading/management,
 * video update/delete, native scheduling) are always `NOT_AVAILABLE` with the
 * same explicit reason — never silently omitted (§2: "Never represent an
 * unavailable capability as working").
 */
export async function getTikTokCapabilityMatrix(
  organizationId: string,
  db: Db = prisma,
): Promise<TikTokCapabilityMatrix> {
  const entries = await getConnectionCenter(organizationId, new Date(), db);
  const entry = entries.find((e) => e.descriptor.key === 'TIKTOK');
  const cap = (id: string) => entry?.capabilities.find((c) => c.id === id);
  const connected = Boolean(entry && entry.state !== 'NOT_CONNECTED');

  const readAvailability = (
    id: string,
  ): { availability: TikTokCapabilityAvailability; reason: string } => {
    const c = cap(id);
    if (!entry || entry.state === 'NOT_CONNECTED') {
      return {
        availability: 'NOT_AVAILABLE',
        reason: 'No TikTok account is connected to this organization.',
      };
    }
    if (!c?.usable) {
      return {
        availability: 'NOT_AVAILABLE',
        reason:
          c?.unavailableReason ??
          entry.diagnostic.explanation ??
          'This capability is not currently usable.',
      };
    }
    return { availability: 'AVAILABLE', reason: 'Available.' };
  };

  const profile = readAvailability('tiktok.get_profile');
  const videos = readAvailability('tiktok.get_videos');

  // tiktok.publish's contract descriptor has a *static* baseline of
  // REQUIRES_PROVIDER_APPROVAL (public posting needs a TikTok app audit),
  // and `resolveCapabilities` deliberately never promotes that baseline to
  // AVAILABLE the way it does for REQUIRES_SCOPE — so `cap.usable` for this
  // one capability is always false, by design, regardless of the connection.
  // That is correct for the Connection Center's *display* purpose (it always
  // shows "needs approval"), but checking `.usable` here would wrongly
  // report drafting as unavailable even when the scope IS granted and a
  // SELF_ONLY draft would work today (exactly what `publish.ts`'s real
  // `createPublishDraft` already allows, unaudited). So this checks the
  // connection's actual granted scope directly instead.
  const hasPublishScope = Boolean(entry?.scopes?.includes('video.publish'));
  let publish: { availability: TikTokCapabilityAvailability; reason: string };
  if (!entry || entry.state === 'NOT_CONNECTED') {
    publish = {
      availability: 'NOT_AVAILABLE',
      reason: 'No TikTok account is connected to this organization.',
    };
  } else if (!hasPublishScope) {
    publish = {
      availability: 'NOT_AVAILABLE',
      reason:
        'This connection does not include the video.publish scope. Reconnect and opt in to publishing to enable this.',
    };
  } else {
    publish = {
      availability: 'REQUIRES_APPROVAL',
      reason:
        "Drafts can be created and submitted, but every submission needs explicit user approval (this app's own policy) and public visibility needs TikTok to have audited this app — until then, posts are limited to private/self-only visibility.",
    };
  }

  const capabilities: TikTokCapabilityStatus[] = [
    { key: 'ACCOUNT_READ', level: 'READ_ONLY', ...profile },
    { key: 'VIDEO_READ', level: 'READ_ONLY', ...videos },
    // TikTok's video.list response already carries each video's lifetime
    // view/like/comment/share counts — there is no separate "analytics"
    // endpoint for videos, so this tracks the same scope as VIDEO_READ.
    { key: 'VIDEO_ANALYTICS_READ', level: 'READ_ONLY', ...videos },
    {
      key: 'CONTENT_ANALYTICS_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason:
        "TikTok's Display API exposes no day-by-day analytics endpoint — only lifetime per-video counts and periodic account snapshots. This is a product/API absence, not a permission gap.",
    },
    {
      key: 'AUDIENCE_ANALYTICS_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `Audience demographics ${NO_PUBLIC_API_REASON}`,
    },
    {
      key: 'COMMENTS_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `Comment reading ${NO_PUBLIC_API_REASON}`,
    },
    {
      key: 'CONTENT_DRAFT',
      level: 'WRITE',
      availability: publish.availability === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : 'AVAILABLE',
      reason:
        publish.availability === 'NOT_AVAILABLE'
          ? publish.reason
          : 'A draft can be created and held for review; nothing is sent to TikTok until it is explicitly approved.',
    },
    { key: 'CONTENT_PUBLISH', level: 'PUBLISH', ...publish },
    {
      key: 'VIDEO_UPDATE',
      level: 'WRITE',
      availability: 'NOT_AVAILABLE',
      reason: `Updating a published video's metadata ${NO_PUBLIC_API_REASON}`,
    },
    {
      key: 'VIDEO_DELETE',
      level: 'DELETE',
      availability: 'NOT_AVAILABLE',
      reason: `Deleting a video ${NO_PUBLIC_API_REASON}`,
    },
    {
      key: 'COMMENT_MANAGEMENT',
      level: 'WRITE',
      availability: 'NOT_AVAILABLE',
      reason: `Comment management ${NO_PUBLIC_API_REASON}`,
    },
    {
      key: 'SCHEDULE_PUBLISH',
      level: 'PUBLISH',
      availability: 'NOT_AVAILABLE',
      reason:
        'TikTok\'s Content Posting API has no native "publish at a future time" parameter, and this deployment has not built its own scheduler for it — a draft can be created now and approved later, but there is no automated future-submit.',
    },
  ];

  return { connected, capabilities };
}
