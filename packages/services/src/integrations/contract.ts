import type { ConnectionStatus, IntegrationHealth, OAuthConnection } from '@growth-agent/db';
import { scrubSecrets } from '../observability/scrub.js';

/**
 * The unified integration contract (Phase 1, Part 1). Every integration —
 * OAuth-based (YouTube, Search Console, TikTok), credential-based
 * (WordPress), or credential-less (a crawled website) — is described by one
 * `IntegrationDescriptor` and reports one `ConnectionState`, so the
 * Connection Center and the agent tool layer can treat them uniformly
 * instead of each growing its own ad-hoc status vocabulary.
 *
 * This module is deliberately pure: it derives state and diagnostics from
 * rows that already exist (`OAuthConnection` + `IntegrationHealth`). It
 * performs no I/O, so every branch is unit-testable without a database.
 */

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/**
 * `CONNECTING` is transient and never persisted — it exists for the UI to
 * render the window between "user clicked Connect" and the callback landing.
 * Everything else is derivable from persisted rows.
 */
export type ConnectionState =
  | 'NOT_CONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'EXPIRED'
  | 'REAUTH_REQUIRED'
  | 'ERROR'
  | 'DISCONNECTED';

/** States a user can act on directly, and how. */
export type ConnectionAction = 'CONNECT' | 'RECONNECT' | 'RETRY' | 'CONFIGURE' | 'NONE';

// ---------------------------------------------------------------------------
// Capabilities and the permission model (Part 14)
// ---------------------------------------------------------------------------

/**
 * What a capability *does*, which drives the approval policy. The ordering is
 * meaningful: anything above DRAFT changes state the user can see outside
 * Growth Agent, so it needs explicit human approval (hard rule 4).
 */
export type CapabilityLevel = 'READ' | 'DRAFT' | 'WRITE' | 'PUBLISH' | 'DANGEROUS';

/** Whether a capability can actually be used right now, and if not, why not. */
export type CapabilityAvailability =
  | 'AVAILABLE'
  | 'REQUIRES_SCOPE' // the user didn't grant the OAuth scope it needs
  | 'REQUIRES_PROVIDER_APPROVAL' // the provider must approve/audit our app first (e.g. TikTok public posting)
  | 'REQUIRES_CONFIGURATION' // the deployment is missing credentials/config
  | 'LIMITED' // usable, but the provider's API restricts it in a way the user should know about
  | 'NOT_AVAILABLE'; // the provider offers no API for it at all

/**
 * Approval policy per level. READ/DRAFT run freely; everything that leaves a
 * visible mark on an external system requires explicit human approval, and
 * destructive actions require it every single time (never "remember this").
 */
export const APPROVAL_POLICY: Record<
  CapabilityLevel,
  { requiresApproval: boolean; reApprovePerAction: boolean }
> = {
  READ: { requiresApproval: false, reApprovePerAction: false },
  DRAFT: { requiresApproval: false, reApprovePerAction: false },
  WRITE: { requiresApproval: true, reApprovePerAction: false },
  PUBLISH: { requiresApproval: true, reApprovePerAction: false },
  DANGEROUS: { requiresApproval: true, reApprovePerAction: true },
};

export function requiresApproval(level: CapabilityLevel): boolean {
  return APPROVAL_POLICY[level].requiresApproval;
}

export interface IntegrationCapability {
  /** Stable id, also the agent-facing tool namespace (e.g. `youtube.get_videos`). */
  id: string;
  label: string;
  level: CapabilityLevel;
  /**
   * Baseline availability, before per-connection scope checks. A capability
   * marked AVAILABLE here can still resolve to REQUIRES_SCOPE for a specific
   * connection that didn't grant `requiredScopes`.
   */
  availability: CapabilityAvailability;
  /** OAuth scopes this capability needs. Empty for non-OAuth integrations. */
  requiredScopes?: string[];
  /** Shown to the user when availability is not AVAILABLE — never a vague string. */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Integration descriptors
// ---------------------------------------------------------------------------

/**
 * Broader than Prisma's `IntegrationProvider` enum on purpose: a website is a
 * first-class integration with no credentials at all, and WordPress uses
 * Application Passwords rather than OAuth. Keeping the key type separate
 * means the Connection Center can render all five uniformly without forcing
 * unrelated rows into the OAuth table.
 */
export type IntegrationKey =
  'YOUTUBE' | 'GOOGLE_SEARCH_CONSOLE' | 'TIKTOK' | 'WEBSITE' | 'WORDPRESS';

export type AuthKind = 'oauth' | 'application_password' | 'none';

export interface IntegrationDescriptor {
  key: IntegrationKey;
  label: string;
  description: string;
  authKind: AuthKind;
  /**
   * False when there is no implementation behind this descriptor yet. The UI
   * must render these as explicitly unavailable rather than offering a
   * Connect button that goes nowhere (Part 16: never simulate a connection).
   */
  implemented: boolean;
  capabilities: IntegrationCapability[];
  /** Where the operator finds setup instructions. */
  docsPath: string;
}

const YT_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
const YT_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const YT_ANALYTICS_MONETARY = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';
const GSC_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';

export const INTEGRATIONS: Record<IntegrationKey, IntegrationDescriptor> = {
  YOUTUBE: {
    key: 'YOUTUBE',
    label: 'YouTube',
    description: 'Channel, video and analytics data from the official YouTube APIs.',
    authKind: 'oauth',
    implemented: true,
    docsPath: 'docs/YOUTUBE-INTEGRATION.md',
    capabilities: [
      {
        id: 'youtube.get_channel',
        label: 'Channel information',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [YT_READONLY],
      },
      {
        id: 'youtube.get_videos',
        label: 'Videos and metadata',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [YT_READONLY],
      },
      {
        id: 'youtube.get_analytics',
        label: 'Channel and video analytics',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [YT_ANALYTICS],
      },
      {
        id: 'youtube.get_revenue',
        label: 'Revenue analytics',
        level: 'READ',
        availability: 'REQUIRES_SCOPE',
        requiredScopes: [YT_ANALYTICS_MONETARY],
        unavailableReason:
          'Revenue data needs the monetary analytics scope, which is only requested if you opt in.',
      },
      {
        id: 'youtube.update_metadata',
        label: 'Update video metadata',
        level: 'WRITE',
        availability: 'REQUIRES_SCOPE',
        requiredScopes: ['https://www.googleapis.com/auth/youtube'],
        unavailableReason:
          'Growth Agent requests read-only YouTube access. Writing metadata needs a broader scope that is not requested today.',
      },
    ],
  },

  GOOGLE_SEARCH_CONSOLE: {
    key: 'GOOGLE_SEARCH_CONSOLE',
    label: 'Google Search Console',
    description: 'Search performance, sitemaps and URL inspection for verified properties.',
    authKind: 'oauth',
    implemented: true,
    docsPath: 'docs/GOOGLE-SEARCH-CONSOLE.md',
    capabilities: [
      {
        id: 'search_console.get_properties',
        label: 'Property discovery',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [GSC_READONLY],
      },
      {
        id: 'search_console.get_analytics',
        label: 'Search analytics (queries, pages, countries, devices)',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [GSC_READONLY],
      },
      {
        id: 'search_console.get_sitemaps',
        label: 'Sitemaps',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [GSC_READONLY],
      },
      {
        id: 'search_console.inspect_url',
        label: 'URL inspection / indexing status',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: [GSC_READONLY],
      },
    ],
  },

  TIKTOK: {
    key: 'TIKTOK',
    label: 'TikTok',
    description: 'Account, video and publishing access via the official TikTok APIs.',
    authKind: 'oauth',
    implemented: true,
    docsPath: 'docs/TIKTOK-INTEGRATION.md',
    capabilities: [
      {
        id: 'tiktok.get_profile',
        label: 'Account profile',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: ['user.info.basic'],
      },
      {
        id: 'tiktok.get_videos',
        label: 'Videos and basic stats',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: ['video.list'],
      },
      {
        id: 'tiktok.get_analytics',
        label: 'Time-series analytics',
        level: 'READ',
        availability: 'NOT_AVAILABLE',
        unavailableReason:
          "TikTok's Display API exposes no daily analytics endpoint. Growth Agent records periodic snapshots instead and labels values between snapshots as interpolated.",
      },
      {
        id: 'tiktok.publish',
        label: 'Publish video',
        level: 'PUBLISH',
        availability: 'REQUIRES_PROVIDER_APPROVAL',
        requiredScopes: ['video.publish'],
        unavailableReason:
          'Posting publicly requires TikTok to audit this app. Until that audit passes, posts are limited to private/self-only visibility.',
      },
    ],
  },

  WEBSITE: {
    key: 'WEBSITE',
    label: 'Website',
    description: 'Crawl and technically audit a website you own. No credentials required.',
    authKind: 'none',
    implemented: true,
    docsPath: 'docs/SEO-ENGINE.md',
    capabilities: [
      {
        id: 'website.crawl',
        label: 'Crawl site',
        level: 'READ',
        availability: 'AVAILABLE',
      },
      {
        id: 'website.analyze',
        label: 'Technical SEO analysis',
        level: 'READ',
        availability: 'AVAILABLE',
      },
      {
        id: 'website.get_sitemap',
        label: 'Sitemap and robots.txt',
        level: 'READ',
        availability: 'AVAILABLE',
      },
    ],
  },

  WORDPRESS: {
    key: 'WORDPRESS',
    label: 'WordPress',
    description:
      'Read posts and pages, create drafts, and — only with your approval — update or publish content on a self-hosted WordPress site.',
    authKind: 'application_password',
    implemented: true,
    docsPath: 'docs/WORDPRESS-INTEGRATION.md',
    // For WordPress the "scopes" are the WordPress capabilities detected for
    // the connected user (users/me?context=edit), so an Author account is
    // shown exactly what an Author can do — nothing is assumed from the role.
    capabilities: [
      {
        id: 'wordpress.get_site',
        label: 'Site information',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: ['read'],
      },
      {
        id: 'wordpress.get_posts',
        label: 'Posts',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: ['read'],
      },
      {
        id: 'wordpress.get_pages',
        label: 'Pages',
        level: 'READ',
        availability: 'AVAILABLE',
        requiredScopes: ['read'],
      },
      {
        id: 'wordpress.create_draft',
        label: 'Create draft',
        level: 'DRAFT',
        availability: 'AVAILABLE',
        requiredScopes: ['edit_posts'],
      },
      {
        id: 'wordpress.update_post',
        label: 'Update content',
        level: 'WRITE',
        availability: 'AVAILABLE',
        requiredScopes: ['edit_posts'],
      },
      {
        id: 'wordpress.publish',
        label: 'Publish',
        level: 'PUBLISH',
        availability: 'AVAILABLE',
        requiredScopes: ['publish_posts'],
      },
    ],
  },
};

export function describeIntegration(key: IntegrationKey): IntegrationDescriptor {
  return INTEGRATIONS[key];
}

// ---------------------------------------------------------------------------
// State resolution
// ---------------------------------------------------------------------------

/** The subset of an `OAuthConnection` state resolution actually needs. */
export type ConnectionStateInput = Pick<OAuthConnection, 'status' | 'expiresAt' | 'lastError'> & {
  /** Whether a refresh token is stored — decides EXPIRED vs REAUTH_REQUIRED. */
  hasRefreshToken: boolean;
};

export type HealthInput = Pick<IntegrationHealth, 'ok' | 'detail' | 'lastCheckAt'> | null;

/**
 * Map persisted rows onto the unified state.
 *
 * The EXPIRED / REAUTH_REQUIRED split is the important one: EXPIRED means the
 * access token lapsed but we hold a refresh token and can recover without
 * bothering the user, so the UI should not shout. REAUTH_REQUIRED means we
 * genuinely cannot recover — no refresh token, or the provider revoked us —
 * and the only fix is the user re-consenting.
 */
export function resolveConnectionState(
  connection: ConnectionStateInput | null,
  health: HealthInput = null,
  now: Date = new Date(),
): ConnectionState {
  if (!connection) return 'NOT_CONNECTED';

  const status: ConnectionStatus = connection.status;
  if (status === 'REVOKED') return 'DISCONNECTED';
  if (status === 'ERROR') return 'ERROR';
  if (status === 'EXPIRED') {
    return connection.hasRefreshToken ? 'EXPIRED' : 'REAUTH_REQUIRED';
  }

  // status === 'ACTIVE' below.
  const lapsed = connection.expiresAt != null && connection.expiresAt.getTime() <= now.getTime();
  if (lapsed) {
    return connection.hasRefreshToken ? 'EXPIRED' : 'REAUTH_REQUIRED';
  }

  // A failed health probe means the credential is fine but calls are failing
  // (quota, provider outage, a revoked individual scope). Degraded, not dead.
  if (health && health.ok === false) return 'DEGRADED';

  return 'CONNECTED';
}

/** States where data may be stale or absent — the UI must not render zeros. */
export function isUsable(state: ConnectionState): boolean {
  return state === 'CONNECTED' || state === 'DEGRADED';
}

/** What the user can do about this state. */
export function actionFor(state: ConnectionState): ConnectionAction {
  switch (state) {
    case 'NOT_CONNECTED':
    case 'DISCONNECTED':
      return 'CONNECT';
    case 'REAUTH_REQUIRED':
      return 'RECONNECT';
    case 'EXPIRED':
    case 'DEGRADED':
    case 'ERROR':
      return 'RETRY';
    case 'CONNECTING':
    case 'CONNECTED':
      return 'NONE';
  }
}

// ---------------------------------------------------------------------------
// Per-connection capability resolution
// ---------------------------------------------------------------------------

export interface ResolvedCapability extends IntegrationCapability {
  /** Availability after checking this connection's actually-granted scopes. */
  resolved: CapabilityAvailability;
  usable: boolean;
  /** Required scopes this connection does not hold (empty when none). */
  missingScopes: string[];
}

/**
 * Narrow a descriptor's baseline capabilities against what a specific
 * connection actually holds. A capability whose scopes were not granted
 * resolves to REQUIRES_SCOPE regardless of its baseline — this is what stops
 * the UI claiming "✓ Analytics" for a connection that never got the
 * analytics scope.
 */
export function resolveCapabilities(
  descriptor: IntegrationDescriptor,
  grantedScopes: string[],
  state: ConnectionState,
): ResolvedCapability[] {
  const granted = new Set(grantedScopes);
  return descriptor.capabilities.map((cap) => {
    let resolved: CapabilityAvailability = cap.availability;

    if (resolved === 'AVAILABLE' && cap.requiredScopes?.length) {
      const missing = cap.requiredScopes.some((s) => !granted.has(s));
      if (missing) resolved = 'REQUIRES_SCOPE';
    }
    // A granted scope can promote a baseline REQUIRES_SCOPE capability (e.g.
    // the user opted into revenue analytics after all).
    if (resolved === 'REQUIRES_SCOPE' && cap.requiredScopes?.length) {
      const allGranted = cap.requiredScopes.every((s) => granted.has(s));
      if (allGranted) resolved = 'AVAILABLE';
    }

    const missingScopes = (cap.requiredScopes ?? []).filter((s) => !granted.has(s));
    return {
      ...cap,
      resolved,
      usable: resolved === 'AVAILABLE' && isUsable(state),
      missingScopes,
      // A scope-gated capability without a hand-written reason still says
      // exactly what is missing, never just "not available".
      unavailableReason:
        cap.unavailableReason ??
        (resolved === 'REQUIRES_SCOPE' && missingScopes.length
          ? `This connection was not granted: ${missingScopes.join(', ')}.`
          : undefined),
    };
  });
}

// ---------------------------------------------------------------------------
// Diagnostics (Part 9)
// ---------------------------------------------------------------------------

export type DiagnosticCategory =
  'NONE' | 'AUTH' | 'PERMISSION' | 'QUOTA' | 'PROVIDER' | 'NETWORK' | 'CONFIG';

export interface ConnectionDiagnostic {
  state: ConnectionState;
  category: DiagnosticCategory;
  /** Short headline, e.g. "YouTube authorization expired". */
  title: string;
  /** Plain-language explanation for the user — never "Something went wrong". */
  explanation: string;
  /** What the user should actually do next. */
  recommendedAction: string;
  action: ConnectionAction;
  /**
   * Provider/technical text, secret-scrubbed. Safe to show behind a
   * "details" disclosure; may be null when there is nothing to add.
   */
  technicalDetail: string | null;
  /** Stable, greppable id to quote in a support request. */
  referenceId: string;
}

/**
 * Classify a raw provider error string. Deliberately conservative: anything
 * unrecognised is PROVIDER rather than guessing, so we never tell a user
 * "reconnect your account" for what was actually a provider outage.
 */
function categorize(state: ConnectionState, lastError: string | null): DiagnosticCategory {
  if (state === 'CONNECTED' || state === 'CONNECTING') return 'NONE';
  if (state === 'EXPIRED' || state === 'REAUTH_REQUIRED' || state === 'DISCONNECTED') return 'AUTH';
  if (state === 'NOT_CONNECTED') return 'CONFIG';

  const err = (lastError ?? '').toLowerCase();
  if (err.includes('quota') || err.includes('rate limit') || err.includes('429')) return 'QUOTA';
  if (err.includes('forbidden') || err.includes('403') || err.includes('scope'))
    return 'PERMISSION';
  if (err.includes('401') || err.includes('unauthor') || err.includes('invalid_grant'))
    return 'AUTH';
  if (err.includes('timeout') || err.includes('econn') || err.includes('network')) return 'NETWORK';
  return 'PROVIDER';
}

/**
 * Deterministic so the same fault always yields the same reference — a user
 * quoting `yt-3f2a91` twice is reporting the same thing, and it is greppable
 * in logs. Contains no secret and no PII (connection ids are opaque cuids).
 */
function referenceFor(key: IntegrationKey, connectionId: string | null, category: string): string {
  const prefix = key.slice(0, 2).toLowerCase();
  const idPart = connectionId ? connectionId.slice(-6) : 'noconn';
  return `${prefix}-${category.slice(0, 4).toLowerCase()}-${idPart}`;
}

export function diagnoseConnection(input: {
  key: IntegrationKey;
  state: ConnectionState;
  connectionId?: string | null;
  lastError?: string | null;
  healthDetail?: string | null;
}): ConnectionDiagnostic {
  const { key, state } = input;
  // A key with no descriptor means a provider was added to the database enum
  // before this registry. Degrade to a generic label rather than throwing —
  // a diagnostic function must never be the thing that crashes.
  const label = INTEGRATIONS[key]?.label ?? 'This integration';
  const lastError = input.lastError ?? null;
  const category = categorize(state, lastError);
  const rawDetail = lastError ?? input.healthDetail ?? null;
  const technicalDetail = rawDetail ? scrubSecrets(rawDetail).slice(0, 500) : null;
  const referenceId = referenceFor(key, input.connectionId ?? null, category);
  const action = actionFor(state);

  const base = { state, category, action, technicalDetail, referenceId };

  switch (state) {
    case 'CONNECTED':
      return {
        ...base,
        title: `${label} is connected`,
        explanation: `Growth Agent can read your ${label} data.`,
        recommendedAction: 'No action needed.',
      };
    case 'CONNECTING':
      return {
        ...base,
        title: `Connecting to ${label}…`,
        explanation: `Waiting for ${label} to confirm authorization.`,
        recommendedAction: 'Finish the authorization in the window that opened.',
      };
    case 'NOT_CONNECTED':
      return {
        ...base,
        title: `${label} is not connected`,
        explanation: `No ${label} account is linked to this organization yet.`,
        recommendedAction: `Connect ${label} to start pulling data.`,
      };
    case 'DISCONNECTED':
      return {
        ...base,
        title: `${label} access was revoked`,
        explanation: `The ${label} connection was disconnected, either from Growth Agent or from your ${label} account settings. Stored credentials have been cleared.`,
        recommendedAction: `Reconnect ${label} if you want Growth Agent to resume.`,
      };
    case 'EXPIRED':
      return {
        ...base,
        title: `${label} session expired`,
        explanation: `The short-lived access token lapsed. Growth Agent holds a refresh token and will renew it automatically on the next sync.`,
        recommendedAction:
          'No action needed — retry now if you do not want to wait for the next sync.',
      };
    case 'REAUTH_REQUIRED':
      return {
        ...base,
        title: `${label} needs to be reconnected`,
        explanation: `Growth Agent can no longer renew access on its own — the refresh token is missing or ${label} rejected it. This usually happens after a password change or after access is revoked in your ${label} account.`,
        recommendedAction: `Reconnect ${label} and approve the permission prompt.`,
      };
    case 'DEGRADED':
      return {
        ...base,
        ...degradedCopy(label, category),
      };
    case 'ERROR':
      return {
        ...base,
        title: `${label} connection error`,
        explanation:
          category === 'PERMISSION'
            ? `${label} refused a request because a required permission is missing.`
            : `Growth Agent could not complete its last ${label} request.`,
        recommendedAction:
          category === 'PERMISSION'
            ? `Reconnect ${label} and make sure every requested permission is approved.`
            : 'Retry. If it keeps failing, quote the reference id below in a support request.',
      };
  }
}

function degradedCopy(
  label: string,
  category: DiagnosticCategory,
): Pick<ConnectionDiagnostic, 'title' | 'explanation' | 'recommendedAction'> {
  switch (category) {
    case 'QUOTA':
      return {
        title: `${label} API quota reached`,
        explanation: `${label} is rate-limiting Growth Agent, so the most recent sync was skipped or truncated. Existing data is unchanged; it is just not fresh.`,
        recommendedAction: 'Quota windows reset automatically — this usually clears within a day.',
      };
    case 'PERMISSION':
      return {
        title: `${label} is missing a permission`,
        explanation: `The connection works, but ${label} refused part of the data Growth Agent asked for.`,
        recommendedAction: `Reconnect ${label} and approve all requested permissions.`,
      };
    case 'NETWORK':
      return {
        title: `${label} was unreachable`,
        explanation: `The last request to ${label} timed out or the network failed.`,
        recommendedAction: 'Retry. This is usually transient.',
      };
    default:
      return {
        title: `${label} is degraded`,
        explanation: `The connection is valid, but the most recent ${label} request did not succeed, so data may be stale.`,
        recommendedAction: 'Retry the connection test to see the current error.',
      };
  }
}
