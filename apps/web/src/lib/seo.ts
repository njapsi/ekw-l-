import 'server-only';

/**
 * The crawler itself needs no third-party credentials — only the AI summary
 * needs a model key. `seoConfigured` therefore reflects whether the AI auditor
 * is available, not whether crawling works.
 */
export function seoAuditorConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  );
}

export function crawlingHaltedGlobally(): boolean {
  return process.env.CRAWLER_HALT === '1' || process.env.CRAWLER_HALT === 'true';
}

export const VERIFY_FILE_PATH = '/.well-known/growth-agent-verify.txt';
export const VERIFY_TXT_PREFIX = 'growth-agent-site-verification=';
