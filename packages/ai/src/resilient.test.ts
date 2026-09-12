import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiDisabledError, AiTimeoutError } from './errors.js';
import { withResilience } from './resilient.js';
import type { AIProvider, GenerateObjectOptions } from './types.js';

const SCHEMA = z.object({ ok: z.boolean() });

type Step = 'ok' | 'hang' | { throw: unknown };

interface Fake {
  provider: AIProvider;
  count(): number;
}

/** A provider whose `generateObject` behaviour is scripted per call. */
function fakeProvider(script: Step[]): Fake {
  let calls = 0;
  const provider: AIProvider = {
    name: 'anthropic',
    generateText: vi.fn(),
    streamText: vi.fn(),
    async generateObject<TSchema extends z.ZodTypeAny>(o: GenerateObjectOptions<TSchema>) {
      const step: Step = script[calls] ?? 'ok';
      calls++;
      if (step === 'ok') {
        return {
          object: { ok: true } as z.infer<TSchema>,
          usage: {
            provider: 'anthropic' as const,
            model: 'm',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
            estimatedCostUsd: 0,
          },
        };
      }
      if (step === 'hang') {
        return new Promise<never>((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => {
            const reason = o.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        });
      }
      throw step.throw;
    },
  };
  return { provider, count: () => calls };
}

const call = (p: AIProvider, signal?: AbortSignal) =>
  p.generateObject({ schema: SCHEMA, prompt: 'x', signal });

describe('withResilience — kill switch', () => {
  it('AI_DISABLED throws AiDisabledError before any call', async () => {
    const fake = fakeProvider(['ok']);
    const wrapped = withResilience(fake.provider, { env: { AI_DISABLED: '1' } });
    await expect(call(wrapped)).rejects.toBeInstanceOf(AiDisabledError);
    expect(fake.count()).toBe(0);
  });

  it('AI_DISABLED_PROVIDERS disables just the named provider', async () => {
    const fake = fakeProvider(['ok']);
    const wrapped = withResilience(fake.provider, {
      env: { AI_DISABLED_PROVIDERS: 'openai, anthropic' },
    });
    await expect(call(wrapped)).rejects.toBeInstanceOf(AiDisabledError);
  });

  it('passes through when the kill switch is clear', async () => {
    const fake = fakeProvider(['ok']);
    const wrapped = withResilience(fake.provider, { env: {} });
    await expect(call(wrapped)).resolves.toMatchObject({ object: { ok: true } });
  });
});

describe('withResilience — timeout', () => {
  it('a call that never resolves is aborted and throws AiTimeoutError', async () => {
    const fake = fakeProvider(['hang']);
    const wrapped = withResilience(fake.provider, { env: {}, timeoutMs: 15, timeoutRetries: 0 });
    await expect(call(wrapped)).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it('retries a timed-out call and succeeds on the next attempt', async () => {
    const fake = fakeProvider(['hang', 'ok']);
    const wrapped = withResilience(fake.provider, { env: {}, timeoutMs: 15, timeoutRetries: 1 });
    await expect(call(wrapped)).resolves.toMatchObject({ object: { ok: true } });
    expect(fake.count()).toBe(2);
  });
});

describe('withResilience — error passthrough', () => {
  it('a non-transient error is rethrown unchanged (not wrapped)', async () => {
    const boom = new Error('schema mismatch');
    const fake = fakeProvider([{ throw: boom }]);
    const wrapped = withResilience(fake.provider, { env: {}, timeoutMs: 1000 });
    await expect(call(wrapped)).rejects.toBe(boom);
  });

  it('a caller abort is surfaced and not retried', async () => {
    const fake = fakeProvider(['hang', 'ok']);
    const wrapped = withResilience(fake.provider, { env: {}, timeoutMs: 1000, timeoutRetries: 3 });
    const ac = new AbortController();
    const p = call(wrapped, ac.signal);
    ac.abort(new Error('user cancelled'));
    await expect(p).rejects.toThrow('user cancelled');
    expect(fake.count()).toBe(1);
  });
});
