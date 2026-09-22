/**
 * The WordPress capability matrix (Phase 9, §5). A pure read composition
 * over the existing Connection Center (`integrations/center.ts`) plus the
 * `WORDPRESS` entry in `integrations/contract.ts` — no new capability
 * model, mirroring the YouTube/TikTok capability matrices exactly.
 *
 * WordPress's contract registry only has six capability ids because those
 * are the only operations this deployment's WordPress client actually
 * implements (`wordpress/client.ts`: `posts`/`pages` read + create + update
 * only — no media, categories, tags, comments, custom post types, or
 * SEO-plugin metadata). This module reports the fuller, named list the
 * brief asks for, mapping every extra key onto either a real contract
 * capability or an explicit, documented absence — never inventing one.
 */
import type { Db } from '@growth-agent/db';
import { prisma } from '@growth-agent/db';
import { getConnectionCenter } from '../integrations/center.js';

export type WordPressCapabilityKey =
  | 'SITE_READ'
  | 'POST_READ'
  | 'PAGE_READ'
  | 'POST_CREATE'
  | 'PAGE_CREATE'
  | 'POST_UPDATE'
  | 'PAGE_UPDATE'
  | 'POST_PUBLISH'
  | 'PAGE_PUBLISH'
  | 'POST_DELETE'
  | 'PAGE_DELETE'
  | 'MEDIA_READ'
  | 'MEDIA_UPLOAD'
  | 'CATEGORY_READ'
  | 'TAG_READ'
  | 'COMMENT_READ'
  | 'SEO_METADATA_READ'
  | 'SEO_METADATA_UPDATE';

export type WordPressCapabilityAvailability = 'AVAILABLE' | 'REQUIRES_PERMISSION' | 'NOT_AVAILABLE';
export type WordPressCapabilityLevel = 'READ_ONLY' | 'WRITE' | 'PUBLISH' | 'DELETE';

export interface WordPressCapabilityStatus {
  key: WordPressCapabilityKey;
  level: WordPressCapabilityLevel;
  availability: WordPressCapabilityAvailability;
  reason: string;
}

export interface WordPressCapabilityMatrix {
  connected: boolean;
  capabilities: WordPressCapabilityStatus[];
}

const NO_API_REASON =
  'This deployment\'s WordPress client only implements core posts/pages read + create + update over the REST API. There is no code path for this yet — it is not a permission gap.';
const NO_PLUGIN_REASON =
  'Growth Agent does not assume any particular SEO plugin (Yoast, Rank Math, etc.) and does not write to arbitrary WordPress database tables. Reading or writing plugin-specific SEO metadata would require detecting and integrating with a specific plugin\'s REST fields, which has not been built.';

/**
 * The matrix for one organization. Read/draft/write/publish capabilities
 * come from the real Connection Center state (which itself reflects the
 * connected WordPress user's actual detected capabilities — never assumed
 * from a role name); every capability this deployment's client code simply
 * does not implement is always `NOT_AVAILABLE` with an explicit reason —
 * never silently omitted (§5: "Never pretend an unavailable WordPress
 * capability works").
 */
export async function getWordPressCapabilityMatrix(
  organizationId: string,
  db: Db = prisma,
): Promise<WordPressCapabilityMatrix> {
  const entries = await getConnectionCenter(organizationId, new Date(), db);
  const entry = entries.find((e) => e.descriptor.key === 'WORDPRESS');
  const cap = (id: string) => entry?.capabilities.find((c) => c.id === id);
  const connected = Boolean(entry && entry.state !== 'NOT_CONNECTED');

  const notConnected = { availability: 'NOT_AVAILABLE' as const, reason: 'No WordPress site is connected to this organization.' };

  const readAvailability = (id: string): { availability: WordPressCapabilityAvailability; reason: string } => {
    if (!entry || entry.state === 'NOT_CONNECTED') return notConnected;
    const c = cap(id);
    if (!c?.usable) {
      return {
        availability: 'NOT_AVAILABLE',
        reason: c?.unavailableReason ?? entry.diagnostic.explanation ?? 'This capability is not currently usable.',
      };
    }
    return { availability: 'AVAILABLE', reason: 'Available.' };
  };

  /** DRAFT-level capabilities run directly (no approval) once the scope is
   *  granted — `contract.ts`'s APPROVAL_POLICY never requires approval for
   *  DRAFT. WRITE/PUBLISH always require approval once the scope is granted
   *  (hard rule 4) — reported as REQUIRES_PERMISSION here, distinct from a
   *  missing WordPress-side scope which is NOT_AVAILABLE. */
  const approvalGatedAvailability = (id: string): { availability: WordPressCapabilityAvailability; reason: string } => {
    if (!entry || entry.state === 'NOT_CONNECTED') return notConnected;
    const c = cap(id);
    if (!c?.usable) {
      return {
        availability: 'NOT_AVAILABLE',
        reason: c?.unavailableReason ?? `The connected WordPress user lacks the scope this needs.`,
      };
    }
    return {
      availability: 'REQUIRES_PERMISSION',
      reason: 'This organization\'s WordPress scope allows it, but every use still requires explicit user approval before anything changes on the live site (never silent).',
    };
  };

  const capabilities: WordPressCapabilityStatus[] = [
    { key: 'SITE_READ', level: 'READ_ONLY', ...readAvailability('wordpress.get_site') },
    { key: 'POST_READ', level: 'READ_ONLY', ...readAvailability('wordpress.get_posts') },
    { key: 'PAGE_READ', level: 'READ_ONLY', ...readAvailability('wordpress.get_pages') },
    // create_draft is DRAFT level — the same underlying scope (edit_posts /
    // edit_pages) covers both posts and pages, but the contract only has one
    // capability id (`wordpress.create_draft`) for it.
    { key: 'POST_CREATE', level: 'WRITE', ...readAvailability('wordpress.create_draft') },
    { key: 'PAGE_CREATE', level: 'WRITE', ...readAvailability('wordpress.create_draft') },
    { key: 'POST_UPDATE', level: 'WRITE', ...approvalGatedAvailability('wordpress.update_post') },
    { key: 'PAGE_UPDATE', level: 'WRITE', ...approvalGatedAvailability('wordpress.update_post') },
    { key: 'POST_PUBLISH', level: 'PUBLISH', ...approvalGatedAvailability('wordpress.publish') },
    { key: 'PAGE_PUBLISH', level: 'PUBLISH', ...approvalGatedAvailability('wordpress.publish') },
    {
      key: 'POST_DELETE',
      level: 'DELETE',
      availability: 'NOT_AVAILABLE',
      reason: `Deletion ${NO_API_REASON}`,
    },
    {
      key: 'PAGE_DELETE',
      level: 'DELETE',
      availability: 'NOT_AVAILABLE',
      reason: `Deletion ${NO_API_REASON}`,
    },
    {
      key: 'MEDIA_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `The media library ${NO_API_REASON}`,
    },
    {
      key: 'MEDIA_UPLOAD',
      level: 'WRITE',
      availability: 'NOT_AVAILABLE',
      reason: `Media upload ${NO_API_REASON}`,
    },
    {
      key: 'CATEGORY_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `Categories ${NO_API_REASON}`,
    },
    {
      key: 'TAG_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `Tags ${NO_API_REASON}`,
    },
    {
      key: 'COMMENT_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: `Comments ${NO_API_REASON}`,
    },
    {
      key: 'SEO_METADATA_READ',
      level: 'READ_ONLY',
      availability: 'NOT_AVAILABLE',
      reason: NO_PLUGIN_REASON,
    },
    {
      key: 'SEO_METADATA_UPDATE',
      level: 'WRITE',
      availability: 'NOT_AVAILABLE',
      reason: NO_PLUGIN_REASON,
    },
  ];

  return { connected, capabilities };
}
