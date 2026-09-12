import { describe, expect, it } from 'vitest';
import { modelForRole, parseModelRef } from './roles.js';

describe('parseModelRef', () => {
  it('parses a provider:model pair', () => {
    expect(parseModelRef('anthropic:claude-haiku-4-5')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
  });
  it('rejects malformed or unknown-provider input', () => {
    expect(parseModelRef('')).toBeNull();
    expect(parseModelRef('claude-haiku')).toBeNull();
    expect(parseModelRef('mistral:big')).toBeNull();
    expect(parseModelRef('anthropic:')).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });
  it('keeps a model id that itself contains a colon', () => {
    expect(parseModelRef('openai:ft:gpt-4o:acme')).toEqual({
      provider: 'openai',
      model: 'ft:gpt-4o:acme',
    });
  });
});

describe('modelForRole', () => {
  it('honours an explicit AI_MODEL_<ROLE> override', () => {
    expect(modelForRole('analyst', { AI_MODEL_ANALYST: 'openai:gpt-4o' })).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('router falls back to a cheap model of the default provider', () => {
    expect(modelForRole('router', { AI_DEFAULT_PROVIDER: 'anthropic' })).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    expect(modelForRole('router', { AI_DEFAULT_PROVIDER: 'openai' })).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('analyst / long_context ride the default model', () => {
    const env = { AI_DEFAULT_PROVIDER: 'anthropic', AI_DEFAULT_MODEL: 'claude-sonnet-4-5' };
    expect(modelForRole('analyst', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(modelForRole('long_context', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
  });

  it('embedding resolves to an embedding model regardless of default provider', () => {
    expect(modelForRole('embedding', { AI_DEFAULT_PROVIDER: 'anthropic' })).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });
});
