/**
 * Planning + tool selection for the Growth Agent (master instruction:
 * "The central agent determines which specialized agents/tools are needed").
 *
 * A deterministic keyword router always produces a usable plan; when a model is
 * available it is asked to refine the capability selection and write a one-line
 * routing rationale. `org-context` is always run first by the orchestrator
 * regardless of the plan.
 */
import { createLogger } from '@growth-agent/observability';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import { CAPABILITIES, type AgentModel } from './capabilities.js';
import type { OrgContext } from './context.js';
import { type CapabilityId, TurnPlan } from './schemas.js';

const log = createLogger('agent.planner');

const PLAN_KEYWORDS: Array<{ id: CapabilityId; re: RegExp }> = [
  {
    id: 'growth-plan',
    re: /\b(30[-\s]?day|growth plan|road ?map|this month|next 30 days|quarter(ly)?|overall (plan|strategy))\b/i,
  },
  {
    id: 'content-repurpose',
    re: /\b(repurpose|turn (my|a|the) (youtube|video)|into (tik ?tok|a short|shorts)|cross[-\s]?post|adapt (my|this) video)\b/i,
  },
  {
    id: 'youtube-monetization',
    re: /\b(monet[iy]|revenue|make (more )?money|earn|sponsorship|rpm|cpm|partner program|ypp|income)\b/i,
  },
  {
    id: 'youtube-growth',
    re: /\b(content opportunit(y|ies)|content idea|content pattern|content calendar|what should i (post|make)|benchmark|outperform|underperform|compare (my |these )?videos?|run an experiment|a\/b test)\b/i,
  },
  {
    id: 'youtube-analyst',
    re: /\b(youtube|channel|subscribers?|watch time|thumbnail|remake|momentum|(post|publish).{0,12}(this )?week|which .*videos?)\b/i,
  },
  {
    id: 'tiktok-growth',
    re: /\b(content opportunit(y|ies)|content idea|content pattern|content calendar|what should i (post|make)|benchmark|outperform|underperform|compare (my |these )?videos?|run an experiment|a\/b test|hashtag)\b/i,
  },
  { id: 'tiktok-analyst', re: /\btik ?tok\b/i },
  {
    id: 'seo-agent',
    re: /\b(seo|website|site|crawl|canonical|sitemap|robots\.txt|index(able|ing)?|orphan|structured data|schema\.org|which pages|analy[sz]e my (website|site))\b/i,
  },
];

export function keywordPlan(message: string, context: OrgContext): TurnPlan {
  const hits = new Set<CapabilityId>();
  for (const { id, re } of PLAN_KEYWORDS) if (re.test(message)) hits.add(id);

  // "make more money" also wants the analyst; a bare "analyze my website" → seo.
  if (hits.has('youtube-monetization')) hits.add('youtube-analyst');
  if (hits.has('growth-plan')) {
    if (context.youtube.connected) hits.add('youtube-analyst');
    if (context.tiktok.connected) hits.add('tiktok-analyst');
    if (context.seo.latestCrawl) hits.add('seo-agent');
  }
  if (hits.size === 0) {
    // Fall back to whatever is connected.
    if (context.seo.latestCrawl) hits.add('seo-agent');
    if (context.youtube.connected) hits.add('youtube-analyst');
    if (context.tiktok.connected) hits.add('tiktok-analyst');
  }

  const capabilities = [...hits].slice(0, 4);
  const missing: string[] = [];
  if (hits.has('youtube-analyst') && !context.youtube.connected)
    missing.push('Connect a YouTube channel');
  if (hits.has('youtube-monetization') && !context.youtube.connected)
    missing.push('Connect a YouTube channel');
  if (hits.has('youtube-growth') && !context.youtube.connected)
    missing.push('Connect a YouTube channel');
  if (hits.has('tiktok-analyst') && !context.tiktok.connected)
    missing.push('Connect a TikTok account');
  if (hits.has('tiktok-growth') && !context.tiktok.connected)
    missing.push('Connect a TikTok account');
  if (hits.has('seo-agent') && !context.seo.latestCrawl) missing.push('Run a website crawl');

  return TurnPlan.parse({
    intent: message.slice(0, 160),
    capabilities,
    rationale:
      capabilities.length > 0
        ? `Routing to ${capabilities.join(', ')} based on the question and what is connected.`
        : 'Nothing is connected yet, so there is no data to analyze.',
    missingPrerequisites: [...new Set(missing)],
  });
}

export interface PlanDeps {
  model?: AgentModel;
}

const PLAN_SYSTEM = `You route a user's growth question to the specialized capabilities that can answer it. You do NOT answer the question. You do NOT reveal step-by-step reasoning — return only the fields asked for. Choose the smallest set of capabilities that covers the question (1-4). "rationale" is ONE sentence describing the routing choice.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

export async function planTurn(
  deps: PlanDeps,
  input: { message: string; context: OrgContext; history: string[] },
): Promise<TurnPlan> {
  const fallback = keywordPlan(input.message, input.context);
  if (!deps.model) return fallback;

  const catalogue = CAPABILITIES.filter((c) => c.id !== 'org-context')
    .map((c) => `- ${c.id}: ${c.description}`)
    .join('\n');
  const connected = [
    input.context.youtube.connected ? 'youtube' : null,
    input.context.tiktok.connected ? 'tiktok' : null,
    input.context.seo.latestCrawl
      ? 'seo(crawl available)'
      : input.context.seo.websites > 0
        ? 'seo(no crawl)'
        : null,
  ]
    .filter(Boolean)
    .join(', ');

  try {
    const res = await deps.model.generateObject({
      schema: TurnPlan,
      system: PLAN_SYSTEM,
      prompt: `CAPABILITIES:\n${catalogue}\n\nCONNECTED: ${connected || 'nothing'}\n\n${
        input.history.length
          ? `${wrapUntrusted('CHAT_HISTORY', input.history.slice(-4).join('\n'))}\n\n`
          : ''
      }${wrapUntrusted('USER_MESSAGE', input.message)}\n\nReturn the plan for the user message above.`,
    });
    const plan = res.object;
    // Never let the model invent capabilities or drop the keyword safety net for
    // an obviously-scoped ask.
    const merged = new Set<CapabilityId>([...plan.capabilities]);
    if (merged.size === 0) return fallback;
    return TurnPlan.parse({
      intent: plan.intent || fallback.intent,
      capabilities: [...merged].slice(0, 4),
      rationale: plan.rationale || fallback.rationale,
      missingPrerequisites: fallback.missingPrerequisites,
    });
  } catch (e) {
    log.warn({ err: String(e) }, 'model planning failed; using keyword plan');
    return fallback;
  }
}
