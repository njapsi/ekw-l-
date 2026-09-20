/**
 * A controlled, in-process test MCP server (Phase 5, Part 114: "connect a
 * controlled test MCP server"). This is the MCP-module equivalent of
 * `youtube/fixtures-client.ts` / `tiktok/fixtures-client.ts` — a real
 * implementation of the wire protocol our MCP client actually speaks
 * (JSON-RPC 2.0 `initialize` → `notifications/initialized` → `tools/list` /
 * `tools/call`, matching the installed `ai@4.3.19` MCP client exactly, verified
 * against its compiled source), with no network socket, so `client.ts` and
 * `discovery.ts` can be exercised end-to-end in a unit test without a real
 * external server. It is not a general-purpose MCP server implementation —
 * only what this codebase's client needs to drive.
 *
 * No production code imports this file.
 */
import type { JSONRPCMessage } from 'ai';

export interface FixtureTool {
  name: string;
  description: string;
  /** JSON Schema, matching what a real server's `tools/list` returns. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown> };
  /** Called for `tools/call`. Throw to simulate a tool-level error result. */
  handler: (args: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
}

export interface FixtureServerBehavior {
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  tools: FixtureTool[];
  /** Simulate a slow/hanging server for timeout tests. */
  delayMs?: number;
  /** Simulate a server that fails the initial handshake outright. */
  failInitialize?: boolean;
  /** Simulate a server whose `tools/list` response is malformed. */
  malformedToolsList?: boolean;
}

/**
 * Implements the `MCPTransport` shape (`start`/`send`/`close` +
 * `onmessage`/`onerror`/`onclose` setters) that `ai`'s `createMCPClient`
 * accepts as a custom transport in place of its built-in SSE config.
 */
export class FixtureMcpTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  closed = false;
  readonly sent: JSONRPCMessage[] = [];

  constructor(private readonly behavior: FixtureServerBehavior) {}

  async start(): Promise<void> {
    // Nothing to open — this transport never touches the network.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    if (this.behavior.delayMs) {
      await new Promise((r) => setTimeout(r, this.behavior.delayMs));
    }
    if (!('method' in message)) return; // a response we sent to ourselves — never happens
    const reply = (result: unknown) => {
      if ('id' in message && message.id !== undefined) {
        this.onmessage?.({ jsonrpc: '2.0', id: message.id, result } as JSONRPCMessage);
      }
    };
    const replyError = (code: number, msg: string) => {
      if ('id' in message && message.id !== undefined) {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: { code, message: msg },
        });
      }
    };

    switch (message.method) {
      case 'initialize':
        if (this.behavior.failInitialize) {
          replyError(-32000, 'fixture: initialization refused');
          return;
        }
        reply({
          protocolVersion: this.behavior.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: this.behavior.serverInfo ?? { name: 'fixture-mcp-server', version: '0.0.1' },
        });
        return;
      case 'notifications/initialized':
        return; // no response for a notification
      case 'tools/list':
        if (this.behavior.malformedToolsList) {
          reply({ tools: 'not-an-array' });
          return;
        }
        reply({
          tools: this.behavior.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      case 'tools/call': {
        const params = (message as { params?: { name?: string; arguments?: unknown } }).params;
        const tool = this.behavior.tools.find((t) => t.name === params?.name);
        if (!tool) {
          replyError(-32601, `fixture: unknown tool "${String(params?.name)}"`);
          return;
        }
        try {
          const out = await tool.handler((params?.arguments ?? {}) as Record<string, unknown>);
          reply({ content: [{ type: 'text', text: out.text }] });
        } catch (e) {
          reply({
            content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
            isError: true,
          });
        }
        return;
      }
      default:
        replyError(-32601, `fixture: unsupported method "${message.method}"`);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
    return Promise.resolve();
  }
}
