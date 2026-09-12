import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';

const h = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock('../security/rate-limit.js', () => ({ checkRateLimit: h.checkRateLimit }));

const { checkAiUserLimit, enforceAiUserLimit } = await import('./ai-limit.js');

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_USER_RATE_LIMIT;
  delete process.env.AI_USER_RATE_WINDOW_SEC;
});

describe('enforceAiUserLimit', () => {
  it('passes when the limiter allows the request', async () => {
    h.checkRateLimit.mockResolvedValue({
      ok: true,
      remaining: 5,
      retryAfterSec: 0,
      degraded: false,
    });
    await expect(
      enforceAiUserLimit({ organizationId: 'org_1', userId: 'u_1' }),
    ).resolves.toBeUndefined();
  });

  it('throws rate_limited when the user is over the limit', async () => {
    h.checkRateLimit.mockResolvedValue({
      ok: false,
      remaining: 0,
      retryAfterSec: 30,
      degraded: false,
    });
    await expect(enforceAiUserLimit({ organizationId: 'org_1', userId: 'u_1' })).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'rate_limited',
    );
  });

  it('fails open when Redis is unreachable (limiter degraded → ok:true)', async () => {
    h.checkRateLimit.mockResolvedValue({
      ok: true,
      remaining: 30,
      retryAfterSec: 0,
      degraded: true,
    });
    await expect(
      enforceAiUserLimit({ organizationId: 'org_1', userId: 'u_1' }),
    ).resolves.toBeUndefined();
  });

  it('keys the bucket by org + user + scope and honours env defaults', async () => {
    process.env.AI_USER_RATE_LIMIT = '7';
    process.env.AI_USER_RATE_WINDOW_SEC = '120';
    h.checkRateLimit.mockResolvedValue({
      ok: true,
      remaining: 1,
      retryAfterSec: 0,
      degraded: false,
    });
    await checkAiUserLimit({ organizationId: 'org_A', userId: 'u_B', scope: 'chat' });
    expect(h.checkRateLimit).toHaveBeenCalledWith({
      key: 'ai-user:chat:org_A:u_B',
      limit: 7,
      windowSec: 120,
    });
  });

  it('an explicit limit/window overrides the env', async () => {
    process.env.AI_USER_RATE_LIMIT = '7';
    h.checkRateLimit.mockResolvedValue({
      ok: true,
      remaining: 1,
      retryAfterSec: 0,
      degraded: false,
    });
    await checkAiUserLimit({ organizationId: 'o', userId: 'u', limit: 3, windowSec: 10 });
    expect(h.checkRateLimit).toHaveBeenCalledWith({ key: 'ai-user:o:u', limit: 3, windowSec: 10 });
  });
});
