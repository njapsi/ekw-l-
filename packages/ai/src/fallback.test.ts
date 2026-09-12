import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiAllProvidersFailedError, AiDisabledError } from './errors.js';
import { FallbackProvider } from './fallback.js';
import type { AIProvider, GenerateObjectOptions, ProviderName } from './types.js';

const SCHEMA = z.object({ ok: z.boolean() });

function provider(name: ProviderName, behaviour: 'ok' | (() => never)): AIProvider {
  return {
    name,
    generateText: vi.fn(),
    streamText: vi.fn(),
    async generateObject<TSchema extends z.ZodTypeAny>(_o: GenerateObjectOptions<TSchema>) {
      if (behaviour !== 'ok') behaviour();
      return {
        object: { ok: true, via: name } as unknown as z.infer<TSchema>,
        usage: {
          provider: name,
          model: 'm',
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimatedCostUsd: 0,
        },
      };
    },
  };
}

const boom = (msg: string) => (): never => {
  throw new Error(msg);
};

describe('FallbackProvider', () => {
  it('uses the head provider when it succeeds and never touches the tail', async () => {
    const head = provider('anthropic', 'ok');
    const tail = provider('openai', 'ok');
    const tailSpy = vi.spyOn(tail, 'generateObject');
    const fb = new FallbackProvider([
      { provider: head, model: 'a' },
      { provider: tail, model: 'b' },
    ]);
    const res = await fb.generateObject({ schema: SCHEMA, prompt: 'x' });
    expect((res.object as unknown as { via: string }).via).toBe('anthropic');
    expect(tailSpy).not.toHaveBeenCalled();
  });

  it('advances to the next entry when the head throws', async () => {
    const log = vi.fn();
    const fb = new FallbackProvider(
      [
        { provider: provider('anthropic', boom('529 overloaded')), model: 'a' },
        { provider: provider('openai', 'ok'), model: 'b' },
      ],
      log,
    );
    const res = await fb.generateObject({ schema: SCHEMA, prompt: 'x' });
    expect((res.object as unknown as { via: string }).via).toBe('openai');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ from: 'anthropic', index: 0 }));
  });

  it('throws AiAllProvidersFailedError with the last error when every entry fails', async () => {
    const fb = new FallbackProvider([
      { provider: provider('anthropic', boom('a down')), model: 'a' },
      { provider: provider('openai', boom('b down')), model: 'b' },
    ]);
    await expect(fb.generateObject({ schema: SCHEMA, prompt: 'x' })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AiAllProvidersFailedError &&
        (e.lastError as Error).message === 'b down' &&
        e.attempts === 2,
    );
  });

  it('surfaces AiDisabledError when the whole layer is disabled (every entry)', async () => {
    const disabled = (): never => {
      throw new AiDisabledError('AI_DISABLED is set');
    };
    const fb = new FallbackProvider([
      { provider: provider('anthropic', disabled), model: 'a' },
      { provider: provider('openai', disabled), model: 'b' },
    ]);
    await expect(fb.generateObject({ schema: SCHEMA, prompt: 'x' })).rejects.toBeInstanceOf(
      AiDisabledError,
    );
  });

  it('name reflects the head provider', () => {
    const fb = new FallbackProvider([
      { provider: provider('google', 'ok'), model: 'g' },
      { provider: provider('openai', 'ok'), model: 'o' },
    ]);
    expect(fb.name).toBe('google');
  });
});
