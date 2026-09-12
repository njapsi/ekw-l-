import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TikTokApiError,
  TikTokAuthExpiredError,
  TikTokMalformedDataError,
  TikTokPermissionError,
  TikTokRateLimitError,
} from './client.js';
import { DisplayTikTokClient } from './display-client.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DisplayTikTokClient', () => {
  it('parses a well-formed user/info response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({
          data: { user: { open_id: 'o1', display_name: 'Cara', follower_count: 4321 } },
          error: { code: 'ok' },
        }),
      ),
    );
    const info = await new DisplayTikTokClient('t').getUserInfo();
    expect(info.data.user.open_id).toBe('o1');
    expect(info.data.user.follower_count).toBe(4321);
  });

  it('maps access_token_invalid to TikTokAuthExpiredError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: { code: 'access_token_invalid' } })),
    );
    await expect(new DisplayTikTokClient('t').getUserInfo()).rejects.toBeInstanceOf(
      TikTokAuthExpiredError,
    );
  });

  it('maps scope_not_authorized to TikTokPermissionError with the required scope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: { code: 'scope_not_authorized' } })),
    );
    const err = await new DisplayTikTokClient('t').listVideos().catch((e) => e);
    expect(err).toBeInstanceOf(TikTokPermissionError);
    expect((err as TikTokPermissionError).requiredScope).toBe('video.list');
  });

  it('retries a rate limit then surfaces TikTokRateLimitError', async () => {
    const fetchMock = vi.fn(async () => jsonRes({ error: { code: 'rate_limit_exceeded' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new DisplayTikTokClient('t').getUserInfo()).rejects.toBeInstanceOf(
      TikTokRateLimitError,
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  }, 20_000);

  it('flags a malformed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ data: { videos: [{ create_time: 1 }] }, error: { code: 'ok' } })),
    );
    await expect(new DisplayTikTokClient('t').listVideos()).rejects.toBeInstanceOf(
      TikTokMalformedDataError,
    );
  });

  it('surfaces a generic publish error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes({ error: { code: 'spam_risk_too_many_pending_share', message: 'slow down' } }),
      ),
    );
    const err = await new DisplayTikTokClient('t')
      .initDirectPost({ title: 't', privacyLevel: 'SELF_ONLY', sourceUrl: 'https://x/y.mp4' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TikTokApiError);
    expect((err as TikTokApiError).code).toBe('spam_risk_too_many_pending_share');
  });
});
