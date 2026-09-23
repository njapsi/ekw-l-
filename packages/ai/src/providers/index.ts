import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { VercelAIProvider } from './vercel.js';
import type { AIProvider } from '../types.js';

export { VercelAIProvider };

export function anthropicProvider(apiKey = process.env.ANTHROPIC_API_KEY): AIProvider {
  const client = createAnthropic({ apiKey });
  return new VercelAIProvider('anthropic', (id) => client(id), 'claude-sonnet-4-5');
}

export function openaiProvider(apiKey = process.env.OPENAI_API_KEY): AIProvider {
  const client = createOpenAI({ apiKey });
  // OpenAI is currently the only provider whose Vercel AI SDK client exposes an
  // embedding model — `modelForRole('embedding')` already defaults here
  // (roles.ts), so Knowledge/Research (Phase 11) get a real `embed()` for free
  // whenever `OPENAI_API_KEY` is configured, with no provider-specific code
  // outside this factory.
  return new VercelAIProvider('openai', (id) => client(id), 'gpt-4o-mini', {
    resolve: (id) => client.textEmbeddingModel(id),
    defaultModelId: 'text-embedding-3-small',
  });
}

export function googleProvider(apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY): AIProvider {
  const client = createGoogleGenerativeAI({ apiKey });
  return new VercelAIProvider('google', (id) => client(id), 'gemini-2.0-flash');
}
