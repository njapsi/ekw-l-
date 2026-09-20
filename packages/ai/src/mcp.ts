/**
 * The one place `packages/ai` touches the `ai` SDK's MCP (Model Context
 * Protocol) client, so `packages/services`'s MCP module never imports the
 * `ai` package directly — the same boundary this codebase already draws
 * around every other provider-facing primitive (CLAUDE.md: "Never import a
 * provider SDK from apps/* or packages/services — go through the
 * registry / model roles").
 *
 * The installed `ai@4.3.19` ships a real, if minimal, MCP client
 * (`experimental_createMCPClient`) that speaks JSON-RPC 2.0 over a
 * transport: `initialize` → `notifications/initialized` → `tools/list` /
 * `tools/call`. Its own doc comment states plainly what it does not cover
 * (no sampling/roots, no resumable SSE, no session management) — this
 * wrapper does not paper over those gaps, it just gives `packages/services`
 * a small, typed surface instead of the SDK's own class.
 *
 * Protocol version note: this SDK version implements the `2024-11-05` draft
 * of MCP, not a newer one. `docs/MCP.md` states this explicitly rather than
 * implying compliance with whatever specification a caller might expect.
 * Transport note: the SDK's *built-in* `MCPTransportConfig` covers SSE only
 * (`{ type: 'sse', url, headers }`); a stdio transport is not implemented
 * here (see `McpTransportKind.STDIO` in `packages/db`'s schema, which exists
 * for the data model but has no working connector yet — spawning an
 * arbitrary local process from a web/worker request is a materially
 * different security posture this phase does not attempt to get right).
 */
import { type MCPTransport, experimental_createMCPClient as createMCPClient } from 'ai';

export type { MCPTransport };

/** The SDK's own `CallToolResult` type is not exported from the package
 *  root; this is the minimal shape this codebase actually reads from it. */
export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpSseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpDiscoveredTool {
  name: string;
  description: string;
  /** Best-effort JSON Schema captured from the SDK's tool wrapper for
   *  display/audit; the SDK — not this object — validates real arguments
   *  at call time. Null when the underlying schema wrapper could not be
   *  introspected. */
  inputSchema: Record<string, unknown> | null;
}

export interface McpConnection {
  tools(): Promise<McpDiscoveredTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export class McpConnectError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'McpConnectError';
  }
}

/** Extracts the underlying JSON Schema object from an AI-SDK `jsonSchema()`
 *  wrapper without depending on its exact class shape — the wrapper's own
 *  public convention exposes it as `.jsonSchema`. */
function extractJsonSchema(parameters: unknown): Record<string, unknown> | null {
  if (parameters && typeof parameters === 'object' && 'jsonSchema' in parameters) {
    const raw = parameters.jsonSchema;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  }
  return null;
}

/**
 * The MCP spec's `tools/call` result has taken two shapes across draft
 * versions: `{ content: [...] }` (current) and the older `{ toolResult:
 * <anything> }`. Normalize both into one shape rather than assuming every
 * server sends the current one.
 */
function normalizeCallResult(result: unknown): McpCallToolResult {
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const r = result as { content: unknown[]; isError?: boolean };
    return {
      content: r.content.map((c) => {
        if (!c || typeof c !== 'object') return { type: 'text', text: String(c) };
        const rawType = (c as { type?: unknown }).type;
        return {
          type: typeof rawType === 'string' ? rawType : 'text',
          text: (c as { text?: string }).text,
        };
      }),
      isError: r.isError,
    };
  }
  if (result && typeof result === 'object' && 'toolResult' in result) {
    const legacy = result.toolResult;
    return { content: [{ type: 'text', text: JSON.stringify(legacy) }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export async function connectMcp(
  transport: McpSseTransportConfig | MCPTransport,
  opts: { name?: string } = {},
): Promise<McpConnection> {
  let client: Awaited<ReturnType<typeof createMCPClient>>;
  try {
    client = await createMCPClient({ transport, name: opts.name ?? 'growth-agent' });
  } catch (e) {
    throw new McpConnectError(
      `Could not connect to the MCP server: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }

  return {
    async tools() {
      const set = await client.tools();
      return Object.entries(set).map(([name, tool]) => ({
        name,
        description: tool.description ?? '',
        inputSchema: extractJsonSchema((tool as { parameters?: unknown }).parameters),
      }));
    },
    async callTool(name, args) {
      const set = await client.tools();
      const tool = set[name];
      if (!tool) throw new McpConnectError(`Server does not expose a tool named "${name}".`);
      const result = await tool.execute(args, { toolCallId: `mcp-${Date.now()}`, messages: [] });
      return normalizeCallResult(result);
    },
    close: () => client.close(),
  };
}
