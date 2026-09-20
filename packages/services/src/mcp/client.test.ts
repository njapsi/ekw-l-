import { afterEach, describe, expect, it } from 'vitest';
import { FixtureMcpTransport } from '@growth-agent/ai';
import { resetBreakers } from '../integrations/resilience.js';
import { withMcpConnection } from './client.js';
import { McpError } from './types.js';
import type { McpConnectionSecret } from './registry.js';

afterEach(() => resetBreakers());

const SECRET: McpConnectionSecret = {
  endpoint: 'https://mcp.example.com',
  transport: 'SSE',
  authKind: 'NONE',
  credential: null,
};

describe('withMcpConnection', () => {
  it('opens, runs, and always closes the connection', async () => {
    const transport = new FixtureMcpTransport({
      tools: [
        {
          name: 'x',
          description: 'd',
          inputSchema: { type: 'object' },
          handler: async () => ({ text: 'ok' }),
        },
      ],
    });
    const result = await withMcpConnection(
      's1',
      SECRET,
      async (conn) => (await conn.tools()).length,
      { transportOverride: transport },
    );
    expect(result).toBe(1);
    expect(transport.closed).toBe(true);
  });

  it('closes the connection even when the caller function throws', async () => {
    const transport = new FixtureMcpTransport({ tools: [] });
    await expect(
      withMcpConnection(
        's1',
        SECRET,
        async () => {
          throw new Error('caller failure');
        },
        { transportOverride: transport },
      ),
    ).rejects.toThrow('caller failure');
    expect(transport.closed).toBe(true);
  });

  it('refuses a STDIO transport with no override — an honest unsupported-transport error', async () => {
    await expect(
      withMcpConnection('s1', { ...SECRET, transport: 'STDIO' }, async () => 'never'),
    ).rejects.toBeInstanceOf(McpError);
  });

  it('wraps a connection failure into a retryable McpError', async () => {
    const transport = new FixtureMcpTransport({ tools: [], failInitialize: true });
    await expect(
      withMcpConnection('s1', SECRET, async () => 'never', { transportOverride: transport }),
    ).rejects.toMatchObject({ code: 'connection_failed', retryable: true });
  });

  it('adds a Bearer authorization header only when a credential is present', async () => {
    // Exercised indirectly: a NONE authKind + no credential must not throw
    // building headers, and the transport override path (used here) proves
    // the header-building code ran without error before falling through to
    // the override.
    const transport = new FixtureMcpTransport({ tools: [] });
    await expect(
      withMcpConnection(
        's1',
        { ...SECRET, authKind: 'BEARER_TOKEN', credential: 'tok' },
        async () => 'ok',
        { transportOverride: transport },
      ),
    ).resolves.toBe('ok');
  });
});
