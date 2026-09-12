import type {
  PublishInitResponse,
  PublishStatusResponse,
  UserInfoResponse,
  VideoListResponse,
} from './schemas.js';

/**
 * Provider-agnostic TikTok client. `display-client.ts` is the real
 * implementation; `fixtures-client.ts` is used by tests. Only capabilities the
 * approved products/scopes actually expose are represented here — no scraping,
 * no private data.
 */
export interface DirectPostInput {
  title: string; // caption + hashtags, TikTok's "title" field
  privacyLevel:
    'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  /** Phase 4 supports PULL_FROM_URL (a publicly reachable direct video URL). */
  sourceUrl: string;
}

export interface TikTokClient {
  getUserInfo(): Promise<UserInfoResponse>;
  listVideos(cursor?: number, maxCount?: number): Promise<VideoListResponse>;
  initDirectPost(input: DirectPostInput): Promise<PublishInitResponse>;
  fetchPublishStatus(publishId: string): Promise<PublishStatusResponse>;
}

// --- Typed errors --------------------------------------------------------

export class TikTokApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TikTokApiError';
  }
}

/** `access_token_invalid` / expired — caller should refresh + retry once. */
export class TikTokAuthExpiredError extends TikTokApiError {
  constructor(code = 'access_token_invalid') {
    super('TikTok rejected the access token.', code, 401);
    this.name = 'TikTokAuthExpiredError';
  }
}

/** `scope_not_authorized` / `scope_permission_missed` — the app/user did not grant it. */
export class TikTokPermissionError extends TikTokApiError {
  constructor(
    readonly requiredScope: string,
    code = 'scope_not_authorized',
  ) {
    super(
      `This action needs the "${requiredScope}" scope, which was not granted. Reconnect and approve it.`,
      code,
      403,
    );
    this.name = 'TikTokPermissionError';
  }
}

export class TikTokRateLimitError extends TikTokApiError {
  constructor(readonly retryAfterSec?: number) {
    super('TikTok API rate limit exceeded.', 'rate_limit_exceeded', 429);
    this.name = 'TikTokRateLimitError';
  }
}

export class TikTokMalformedDataError extends TikTokApiError {
  constructor(
    readonly endpoint: string,
    readonly issues: unknown,
  ) {
    super(`Malformed response from ${endpoint}.`, 'malformed', 200);
    this.name = 'TikTokMalformedDataError';
  }
}

/** A publish that TikTok rejected (spam risk, duplicate, unaudited client, …). */
export class TikTokPublishError extends TikTokApiError {
  constructor(message: string, code: string) {
    super(message, code, 200);
    this.name = 'TikTokPublishError';
  }
}

const AUTH_CODES = new Set(['access_token_invalid', 'access_token_expired']);
const PERMISSION_CODES = new Set([
  'scope_not_authorized',
  'scope_permission_missed',
  'permission_not_granted',
]);
const RATE_CODES = new Set(['rate_limit_exceeded', 'too_many_requests']);

export function mapTikTokError(
  endpoint: string,
  code: string,
  message: string | undefined,
  requiredScope?: string,
): TikTokApiError {
  if (AUTH_CODES.has(code)) return new TikTokAuthExpiredError(code);
  if (PERMISSION_CODES.has(code))
    return new TikTokPermissionError(requiredScope ?? 'unknown', code);
  if (RATE_CODES.has(code)) return new TikTokRateLimitError();
  return new TikTokApiError(message ?? `${endpoint} returned error ${code}`, code, 200);
}
