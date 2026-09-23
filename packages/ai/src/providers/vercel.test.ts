import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const generateTextMock = vi.fn();
const embedManyMock = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  generateObject: vi.fn(),
  streamText: vi.fn(),
  embedMany: (...args: unknown[]) => embedManyMock(...args),
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

describe('VercelAIProvider.embed', () => {
  beforeEach(() => {
    embedManyMock.mockClear();
  });

  it('is undefined when the provider was constructed without embedding support', async () => {
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('anthropic', () => ({}) as never, 'claude-x');
    expect(provider.embed).toBeUndefined();
  });

  it('resolves the embedding model, calls embedMany, and returns a priced usage record', async () => {
    embedManyMock.mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      usage: { tokens: 12 },
    });
    const resolve = vi.fn(() => ({}) as never);
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('openai', () => ({}) as never, 'gpt-4o-mini', {
      resolve,
      defaultModelId: 'text-embedding-3-small',
    });
    expect(provider.embed).toBeTypeOf('function');
    const result = await provider.embed!({ values: ['a', 'b'] });
    expect(resolve).toHaveBeenCalledWith('text-embedding-3-small');
    expect(embedManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ values: ['a', 'b'] }),
    );
    expect(result.embeddings).toHaveLength(2);
    expect(result.usage).toMatchObject({ provider: 'openai', model: 'text-embedding-3-small', promptTokens: 12 });
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('uses an explicit per-call model override instead of the default', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 3 } });
    const resolve = vi.fn(() => ({}) as never);
    const { VercelAIProvider } = await import('./vercel.js');
    const provider = new VercelAIProvider('openai', () => ({}) as never, 'gpt-4o-mini', {
      resolve,
      defaultModelId: 'text-embedding-3-small',
    });
    await provider.embed!({ values: ['x'], model: { provider: 'openai', model: 'text-embedding-3-large' } });
    expect(resolve).toHaveBeenCalledWith('text-embedding-3-large');
  });
});
