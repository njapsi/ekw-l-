import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const generateTextMock = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  generateObject: vi.fn(),
  streamText: vi.fn(),
  tool: (def: unknown) => def,
}));

describe('VercelAIProvider.generateText with tools', () => {
  beforeEach(() => {
    generateTextMock.mockClear();
  });

  it('omits tools/maxSteps from the SDK call when no tools are given', async () => {
    generateTextMock.mockResolvedValue({
      text: 'hi',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1 },
      steps: [],
    });
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('anthropic', () => ({}) as never, 'claude-x');
    await provider.generateText({ prompt: 'hello' });
    const call = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.tools).toBeUndefined();
    expect(call.maxSteps).toBeUndefined();
  });

  it('maps ToolDefinition[] to an SDK ToolSet and flattens tool calls/results across steps', async () => {
    const execute = vi.fn(async (input: { q: string }) => ({ found: input.q }));
    generateTextMock.mockResolvedValue({
      text: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 5 },
      steps: [
        {
          toolCalls: [{ toolCallId: 't1', toolName: 'search', args: { q: 'seo' } }],
          toolResults: [{ toolCallId: 't1', result: { found: 'seo' } }],
        },
        { toolCalls: [], toolResults: [] },
      ],
    });
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('anthropic', () => ({}) as never, 'claude-x');

    const result = await provider.generateText({
      prompt: 'search for seo',
      maxSteps: 4,
      tools: [
        {
          name: 'search',
          description: 'search',
          parameters: z.object({ q: z.string() }),
          execute,
        },
      ],
    });

    const call = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.maxSteps).toBe(4);
    expect(Object.keys(call.tools as object)).toEqual(['search']);
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([
      { name: 'search', args: { q: 'seo' }, result: { found: 'seo' } },
    ]);
  });

  it('defaults maxSteps to 1 when tools are given but maxSteps is omitted', async () => {
    generateTextMock.mockResolvedValue({
      text: 'done',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1 },
      steps: [{ toolCalls: [], toolResults: [] }],
    });
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('anthropic', () => ({}) as never, 'claude-x');
    await provider.generateText({
      prompt: 'x',
      tools: [{ name: 't', description: 'd', parameters: z.object({}), execute: async () => null }],
    });
    const call = generateTextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.maxSteps).toBe(1);
  });
});
