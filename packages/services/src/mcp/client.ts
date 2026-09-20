/**
 * Opens a resilient connection to one organization's MCP server (Phase 5,
 * Parts 21, 37). Every call is wrapped in the same timeout + retry +
 * circuit-breaker composition every other integration client uses
 * (`integrations/resilience.ts`) — no second resilience implementation for
 * MCP. The breaker key is the server id, so one failing external server
 * never throttles a different one, and a credential is decrypted only for
 * the lifetime of a single connection attempt, never cached.
 */
import type { McpConnection, MCPTransport } from '@growth-agent/ai';
import { connectMcp } from '@growth-agent/ai';
import { breakerFor, resilientCall } from '../integrations/resilience.js';
import { McpError } from './types.js';
import type { McpConnectionSecret } from './registry.js';

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 20_000;
/** A hostile or buggy server's tool output is capped hard before it ever
 *  reaches a model prompt or gets persisted (Part 37). */
export const MCP_MAX_OUTPUT_CHARS = 20_000;

function authHeaders(secret: McpConnectionSecret): Record<string, string> {
  if (!secret.credential) return {};
  if (secret.authKind === 'BEARER_TOKEN') return { authorization: `Bearer ${secret.credential}` };
  if (secret.authKind === 'API_KEY') return { 'x-api-key': secret.credential };
  return {};
}

/**
 * `withMcpConnection` opens, uses, and always closes a connection — callers
 * never hold one open across a request boundary, so a slow or hung server
 * cannot leak a connection into the next request.
 */
export async function withMcpConnection<T>(
  serverId: string,
  secret: McpConnectionSecret,
  fn: (conn: McpConnection) => Promise<T>,
  opts: { transportOverride?: MCPTransport } = {},
): Promise<T> {
  if (secret.transport === 'STDIO' && !opts.transportOverride) {
    throw new McpError(
      'unsupported_transport',
      'STDIO MCP servers are not supported by this deployment yet. Use an HTTP/SSE endpoint.',
    );
  }
  const transport = opts.transportOverride ?? {
    type: 'sse' as const,
    url: secret.endpoint,
    headers: authHeaders(secret),
  };

  const conn = await resilientCall(() => connectMcp(transport, { name: 'growth-agent' }), {
    provider: `mcp:${serverId}`,
    breakerKey: `mcp:${serverId}`,
    timeoutMs: CONNECT_TIMEOUT_MS,
  }).catch((e: unknown) => {
    throw new McpError(
      'connection_failed',
      e instanceof Error ? e.message : 'Could not connect to the MCP server.',
      true,
    );
  });

  try {
    return await resilientCall(() => fn(conn), {
      provider: `mcp:${serverId}`,
      timeoutMs: CALL_TIMEOUT_MS,
      retries: 0, // a tool call may not be idempotent server-side; retries are the caller's decision
    });
  } finally {
    await conn.close().catch(() => undefined);
  }
}

/** Reset for tests — mirrors `resetBreakers()`'s own purpose, scoped through
 *  the shared registry so MCP and every other integration share one clock. */
export function mcpBreakerState(serverId: string): ReturnType<typeof breakerFor>['state'] {
  return breakerFor(`mcp:${serverId}`).state;
}
