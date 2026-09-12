import { beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import { signState } from './state.js';
import { completeYouTubeConnect } from '../youtube/connect.js';
import { completeTikTokConnect } from '../tiktok/connect.js';

/**
 * Regression for SECURITY-AUDIT.md H-1: an OAuth callback must be bound to the
 * session that started the flow. A validly-signed `state` alone is not enough —
 * the acting user id must match the id inside the state — otherwise an attacker
 * can attach a victim's connected account (and its private analytics) to the
 * attacker's org.
 */
beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-0123456789abcdef';
});

describe('OAuth callback is session-bound', () => {
  it('completeYouTubeConnect refuses a state whose userId is not the acting user', async () => {
    const state = signState({
      organizationId: 'org_attacker',
      userId: 'user_attacker',
      provider: 'youtube',
    });
    await expect(
      completeYouTubeConnect({
        state,
        code: 'irrelevant',
        redirectUri: 'https://app.example/cb',
        actingUserId: 'user_victim',
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'permission_denied');
  });

  it('completeTikTokConnect refuses a mismatched acting user before any token exchange', async () => {
    const state = signState({
      organizationId: 'org_attacker',
      userId: 'user_attacker',
      provider: 'tiktok',
    });
    await expect(
      completeTikTokConnect({
        state,
        code: 'irrelevant',
        redirectUri: 'https://app.example/cb',
        pkceCookie: 'x.y',
        actingUserId: 'user_victim',
      }),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'permission_denied');
  });

  it('a matching acting user passes the binding check (fails later on config, not permission)', async () => {
    const state = signState({ organizationId: 'org_1', userId: 'user_1', provider: 'youtube' });
    const err = await completeYouTubeConnect({
      state,
      code: 'irrelevant',
      redirectUri: 'https://app.example/cb',
      actingUserId: 'user_1',
    }).catch((e: unknown) => e);
    expect(isAppError(err) && err.code === 'permission_denied').toBe(false);
  });
});
