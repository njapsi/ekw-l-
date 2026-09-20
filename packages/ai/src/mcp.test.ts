import { describe, expect, it } from 'vitest';
import { FixtureMcpTransport } from './mcp-fixture.js';
import { McpConnectError, connectMcp } from './mcp.js';

function transport(overrides: Partial<ConstructorParameters<typeof FixtureMcpTransport>[0]> = {}) {
  return new FixtureMcpTransport({
    tools: [
      {
        name: 'echo',
        description: 'Echoes the input back.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        handler: (args) => ({ text: typeof args.text === 'string' ? args.text : '' }),
      },
      {
        name: 'boom',
        description: 'Always throws.',
        inputSchema: { type: 'object' },
        handler: () => {
          throw new Error('simulated tool failure');
        },
      },
    ],
    ...overrides,
  });
}

describe('connectMcp', () => {
  it('discovers tools with name, description and input schema', async () => {
    const conn = await connectMcp(transport());
    const tools = await conn.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo?.description).toBe('Echoes the input back.');
    await conn.close();
  });

  it('calls a tool and returns its text content', async () => {
    const conn = await connectMcp(transport());
    const result = await conn.callTool('echo', { text: 'hello' });
    expect(result.content[0]?.text).toBe('hello');
    await conn.close();
  });

  it('surfaces a tool-level error as content with isError, not a thrown exception', async () => {
    const conn = await connectMcp(transport());
    const result = await conn.callTool('boom', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('simulated tool failure');
    await conn.close();
  });

  it('rejects a connection whose initialize handshake fails', async () => {
    await expect(connectMcp(transport({ failInitialize: true }))).rejects.toBeInstanceOf(
      McpConnectError,
    );
  });

  it('rejects calling a tool name the server never advertised', async () => {
    const conn = await connectMcp(transport());
    await expect(conn.callTool('does-not-exist', {})).rejects.toBeInstanceOf(McpConnectError);
    await conn.close();
  });
});
