import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthExpiredError,
  MalformedApiDataError,
  QuotaExceededError,
  YouTubeApiError,
} from './client.js';
import { GoogleYouTubeClient } from './google-client.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GoogleYouTubeClient', () => {
  it('parses a well-formed channels.list response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'UC1',
              snippet: { title: 'Chan', publishedAt: '2020-01-01T00:00:00Z' },
              contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
              statistics: { subscriberCount: '1234', viewCount: '99999', videoCount: '10' },
            },
          ],
        }),
      ),
    );
    const c = new GoogleYouTubeClient('tok');
    const { data, quotaUnits } = await c.listMyChannels();
    expect(quotaUnits).toBe(1);
    expect(data.items[0]?.id).toBe('UC1');
    expect(data.items[0]?.contentDetails.relatedPlaylists.uploads).toBe('UU1');
  });

  it('maps 401 to AuthExpiredError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 401 } }, { status: 401 })),
    );
    await expect(new GoogleYouTubeClient('tok').listMyChannels()).rejects.toBeInstanceOf(
      AuthExpiredError,
    );
  });

  it('maps a 403 quotaExceeded to QuotaExceededError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
          { status: 403 },
        ),
      ),
    );
    await expect(new GoogleYouTubeClient('tok').getVideos(['v1'])).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it('retries transient 5xx then throws YouTubeApiError', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { code: 503 } }, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GoogleYouTubeClient('tok').listMyChannels()).rejects.toBeInstanceOf(
      YouTubeApiError,
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // retried
  }, 20_000);

  it('flags a malformed 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ items: [{ snippet: { title: 'no id here' } }] })),
    );
    await expect(new GoogleYouTubeClient('tok').listMyChannels()).rejects.toBeInstanceOf(
      MalformedApiDataError,
    );
  });

  it('returns empty analytics rows without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ columnHeaders: [{ name: 'day' }], rows: [] })),
    );
    const { data } = await new GoogleYouTubeClient('tok').queryAnalytics({
      ids: 'channel==UC1',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      metrics: ['views'],
    });
    expect(data.rows).toEqual([]);
  });
});
