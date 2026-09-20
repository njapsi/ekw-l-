import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@growth-agent/db';
import { AppError } from '../errors.js';

const checkRateLimit = vi.fn(async () => ({
  ok: true,
  remaining: 10,
  retryAfterSec: 0,
  degraded: false,
}));
vi.mock('../security/rate-limit.js', () => ({
  checkRateLimit: (...a: unknown[]) => (checkRateLimit as (...x: unknown[]) => unknown)(...a),
}));

const checkUsage = vi.fn(async () => ({
  meter: 'TOOL_CALLS',
  unlimited: false,
  limit: 1000,
  used: 0,
  remaining: 1000,
  wouldExceed: false,
  ratio: 0,
  atLimit: false,
}));
const recordUsage = vi.fn(async () => ({
  recorded: true,
  deduped: false,
  used: 1,
  periodStart: new Date(),
}));
vi.mock('../usage/index.js', () => ({
  checkUsage: (...a: unknown[]) => (checkUsage as (...x: unknown[]) => unknown)(...a),
  recordUsage: (...a: unknown[]) => (recordUsage as (...x: unknown[]) => unknown)(...a),
}));

const runIntegrationTool = vi.fn(async () => ({ ok: true }));
vi.mock('./integration-tools.js', () => ({
  INTEGRATION_TOOL_NAMES: [
    'integrations.list_connections',
    'integrations.get_capabilities',
    'wordpress.list_content',
    'integrations.propose_action',
  ],
  runIntegrationTool: (...a: unknown[]) =>
    (runIntegrationTool as (...x: unknown[]) => unknown)(...a),
}));

const runResearchTool = vi.fn(async () => ({ available: false }));
vi.mock('../research/tools.js', () => ({
  RESEARCH_TOOL_NAMES: ['research.fetch', 'research.search'],
  runResearchTool: (...a: unknown[]) => (runResearchTool as (...x: unknown[]) => unknown)(...a),
}));

const executeMcpTool = vi.fn(async () => ({
  status: 'SUCCESS',
  tool: 'mcp.s.search',
  provider: 'mcp.s.search',
  durationMs: 1,
  data: { text: 'x' },
  warnings: [],
  resourceReferences: [],
}));
vi.mock('../mcp/execute.js', () => ({
  executeMcpTool: (...a: unknown[]) => (executeMcpTool as (...x: unknown[]) => unknown)(...a),
}));

const recordAgentRunEvent = vi.fn(async (_input: { type: string }) => {});
vi.mock('./events.js', () => ({
  recordAgentRunEvent: (...a: unknown[]) =>
    (recordAgentRunEvent as (...x: unknown[]) => unknown)(...a),
}));

const { executeAgentTool } = await import('./tool-executor.js');

afterEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ ok: true, remaining: 10, retryAfterSec: 0, degraded: false });
  checkUsage.mockResolvedValue({
    meter: 'TOOL_CALLS',
    unlimited: false,
    limit: 1000,
    used: 0,
    remaining: 1000,
    wouldExceed: false,
    ratio: 0,
    atLimit: false,
  } as never);
});

const CTX = { organizationId: 'org1', userId: 'user1', db: {} as Db };

describe('executeAgentTool', () => {
  it('rejects an unregistered tool name without calling any dispatcher', async () => {
    const env = await executeAgentTool(CTX, 'shell.execute', {});
    expect(env.status).toBe('FAILED');
    expect(env.error?.code).toBe('VALIDATION_FAILED');
    expect(runIntegrationTool).not.toHaveBeenCalled();
  });

  it('dispatches a native tool through runIntegrationTool and meters the call', async () => {
    const env = await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(env.status).toBe('SUCCESS');
    expect(runIntegrationTool).toHaveBeenCalledWith(
      'integrations.list_connections',
      expect.objectContaining({ organizationId: 'org1', userId: 'user1' }),
      {},
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('dispatches a research tool through runResearchTool', async () => {
    const env = await executeAgentTool(CTX, 'research.search', { query: 'x' });
    expect(env.status).toBe('SUCCESS');
    expect(runResearchTool).toHaveBeenCalledWith('research.search', { query: 'x' });
  });

  it('dispatches an mcp.* tool through executeMcpTool, not through the native/research path', async () => {
    const env = await executeAgentTool(CTX, 'mcp.s.search', { q: 'x' });
    expect(env.status).toBe('SUCCESS');
    expect(executeMcpTool).toHaveBeenCalledWith('org1', 'mcp.s.search', { q: 'x' }, CTX.db);
    expect(runIntegrationTool).not.toHaveBeenCalled();
  });

  it('short-circuits on a rate limit before dispatching or metering', async () => {
    checkRateLimit.mockResolvedValue({
      ok: false,
      remaining: 0,
      retryAfterSec: 30,
      degraded: false,
    });
    const env = await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(env.status).toBe('BLOCKED');
    expect(env.error?.code).toBe('RATE_LIMITED');
    expect(runIntegrationTool).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('short-circuits on quota exhaustion before dispatching', async () => {
    checkUsage.mockResolvedValue({
      meter: 'TOOL_CALLS',
      unlimited: false,
      limit: 10,
      used: 10,
      remaining: 0,
      wouldExceed: true,
      ratio: 1,
      atLimit: true,
    } as never);
    const env = await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(env.status).toBe('BLOCKED');
    expect(env.error?.code).toBe('QUOTA_EXCEEDED');
    expect(runIntegrationTool).not.toHaveBeenCalled();
  });

  it('maps a permission_denied AppError from a native tool to a DENY-shaped BLOCKED envelope, and does not meter it', async () => {
    runIntegrationTool.mockRejectedValueOnce(AppError.forbidden('not allowed'));
    const env = await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(env.status).toBe('BLOCKED');
    expect(env.error?.code).toBe('POLICY_DENIED');
    // The tool's own authorization check ran before any external resource
    // was touched — a BLOCKED outcome (pre-dispatch or from an
    // authorization throw) is never metered, only an actual attempt is.
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('never leaks a raw internal_error message — only the user-safe fallback', async () => {
    runIntegrationTool.mockRejectedValueOnce(new Error('raw stack trace with secrets'));
    const env = await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(env.status).toBe('FAILED');
    expect(env.error?.message).not.toContain('secrets');
  });

  it('records the full TOOL_SELECTED → TOOL_AUTHORIZATION_CHECK → TOOL_STARTED → TOOL_COMPLETED sequence when an agentRunId is supplied', async () => {
    await executeAgentTool({ ...CTX, agentRunId: 'run1' }, 'integrations.list_connections', {});
    const types = recordAgentRunEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual([
      'TOOL_SELECTED',
      'TOOL_AUTHORIZATION_CHECK',
      'TOOL_STARTED',
      'TOOL_COMPLETED',
    ]);
  });

  it('records no events at all when no agentRunId is supplied (a standalone call)', async () => {
    await executeAgentTool(CTX, 'integrations.list_connections', {});
    expect(recordAgentRunEvent).not.toHaveBeenCalled();
  });
});
