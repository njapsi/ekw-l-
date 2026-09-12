import { describe, expect, it } from 'vitest';
import {
  GSC_SCOPE_EMAIL,
  GSC_SCOPE_OPENID,
  GSC_SCOPE_READONLY,
  searchConsoleScopes,
  youtubeScopes,
} from './google.js';
import { hasProviderOAuth } from './oauth-token.js';

describe('Google integration scopes + provider registration', () => {
  it('Search Console requests only webmasters.readonly + openid + userinfo.email', () => {
    expect(searchConsoleScopes()).toEqual([GSC_SCOPE_READONLY, GSC_SCOPE_OPENID, GSC_SCOPE_EMAIL]);
    expect(GSC_SCOPE_READONLY).toBe('https://www.googleapis.com/auth/webmasters.readonly');
  });

  it('YouTube scopes are unchanged and separate from GSC', () => {
    expect(youtubeScopes(false)).not.toContain(GSC_SCOPE_READONLY);
  });

  it('registers an OAuth implementation for GOOGLE_SEARCH_CONSOLE (refresh + revoke)', () => {
    expect(hasProviderOAuth('GOOGLE_SEARCH_CONSOLE')).toBe(true);
    expect(hasProviderOAuth('YOUTUBE')).toBe(true);
  });
});
