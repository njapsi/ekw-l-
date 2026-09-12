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
  return new VercelAIProvider('openai', (id) => client(id), 'gpt-4o-mini');
}

export function googleProvider(apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY): AIProvider {
  const client = createGoogleGenerativeAI({ apiKey });
  return new VercelAIProvider('google', (id) => client(id), 'gemini-2.0-flash');
}
