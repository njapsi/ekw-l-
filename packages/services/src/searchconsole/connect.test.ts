import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { signState } from '../integrations/state.js';

// Stub the Google OAuth round-trip + property sync so the test is offline.
const exchangeCode = vi.fn(async () => ({
  access_token: 'at',
  refresh_token: 'rt',
  expires_in: 3600,
  scope: 'https://www.googleapis.com/auth/webmasters.readonly openid',
}));
const fetchGoogleUserInfo = vi.fn(async () => ({ sub: 'google-sub-1', email: 'a@b.com' }));
const storeConnection = vi.fn(async () => ({
  id: 'conn_1',
  organizationId: 'org_1',
  provider: 'GOOGLE_SEARCH_CONSOLE',
}));
const syncProperties = vi.fn(async () => 2);

vi.mock('../integrations/google.js', () => ({
  exchangeCode,
  fetchGoogleUserInfo,
  googleConfig: () => ({ clientId: 'c', clientSecret: 's', redirectUri: 'r' }),
  buildAuthUrl: () => 'https://accounts.google.com/consent',
  searchConsoleScopes: () => ['https://www.googleapis.com/auth/webmasters.readonly'],
}));
vi.mock('../integrations/connections.js', () => ({ storeConnection }));
vi.mock('./sites.js', () => ({ syncProperties }));

const { completeSearchConsoleConnect, GSC_PROVIDER_STATE } = await import('./connect.js');

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-0123456789abcdef';
  vi.clearAllMocks();
});

describe('completeSearchConsoleConnect', () => {
  it('happy path: exchange → userinfo → storeConnection → syncProperties', async () => {
    const state = signState({
      organizationId: 'org_1',
      userId: 'user_1',
      provider: GSC_PROVIDER_STATE,
    });
    const res = await completeSearchConsoleConnect(
      { state, code: 'code', redirectUri: 'https://app/cb', actingUserId: 'user_1' },
      {} as never,
    );
    expect(res).toEqual({ connectionId: 'conn_1', organizationId: 'org_1', propertyCount: 2 });
    expect(storeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'GOOGLE_SEARCH_CONSOLE',
        externalAccountId: 'google-sub-1',
      }),
      expect.anything(),
    );
  });

  it('rejects a state for a different provider', async () => {
    const state = signState({ organizationId: 'org_1', userId: 'user_1', provider: 'youtube' });
    await expect(
      completeSearchConsoleConnect(
        { state, code: 'c', redirectUri: 'r', actingUserId: 'user_1' },
        {} as never,
      ),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'validation_failed');
  });

  it('rejects when the acting user does not match the state (session bind)', async () => {
    const state = signState({
      organizationId: 'org_1',
      userId: 'user_1',
      provider: GSC_PROVIDER_STATE,
    });
    await expect(
      completeSearchConsoleConnect(
        { state, code: 'c', redirectUri: 'r', actingUserId: 'user_2' },
        {} as never,
      ),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === 'permission_denied');
  });

  it('rejects an expired / tampered state', async () => {
    await expect(
      completeSearchConsoleConnect(
        { state: 'garbage.sig', code: 'c', redirectUri: 'r', actingUserId: 'user_1' },
        {} as never,
      ),
    ).rejects.toThrow();
  });

  it('still connects when property discovery fails', async () => {
    syncProperties.mockRejectedValueOnce(new Error('quota'));
    const state = signState({
      organizationId: 'org_1',
      userId: 'user_1',
      provider: GSC_PROVIDER_STATE,
    });
    const res = await completeSearchConsoleConnect(
      { state, code: 'c', redirectUri: 'r', actingUserId: 'user_1' },
      {} as never,
    );
    expect(res.propertyCount).toBe(0);
    expect(storeConnection).toHaveBeenCalled();
  });
});
