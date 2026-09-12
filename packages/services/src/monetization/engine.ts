/**
 * The deterministic opportunity engine (master instruction, Phase 9
 * "OPPORTUNITY ENGINE"). For every channel it computes: Opportunity, Evidence,
 * Audience fit, Estimated difficulty, Estimated potential, Required action,
 * Confidence — and a `priorityScore` for ranking.
 *
 * Rules that are enforced structurally here:
 *   - `potential` / `difficulty` / `audienceFit` are LABELLED ESTIMATES, never a
 *     currency figure. `potentialBasis` always says how the estimate was formed.
 *   - PLATFORM_MONETIZATION never asserts the creator "qualifies" — it reflects
 *     the careful `assessMonetization` output (official criteria + API data +
 *     user attestations) and defers the decision to YouTube (ADR-0024).
 *   - Revenue is never fabricated; it is only ever a user-entered signal.
 */
import type { MonetizationSignals } from './signals.js';
import {
  type AudienceFit,
  type Difficulty,
  type MonetizationChannelKey,
  type OpportunityDraft,
  type PotentialLabel,
  audienceBand,
} from './schemas.js';

type Band = ReturnType<typeof audienceBand>;

const BAND_SCORE: Record<Band, number> = {
  unknown: 0.2,
  nascent: 0.25,
  small: 0.45,
  mid: 0.65,
  large: 0.85,
  major: 1,
};

const DIFF_LEVEL: Record<Difficulty, number> = { low: 1, medium: 2, high: 3 };
const LEVEL_DIFF: Record<number, Difficulty> = { 1: 'low', 2: 'medium', 3: 'high' };

interface ChannelSpec {
  channel: MonetizationChannelKey;
  title: string;
  /** Baseline difficulty before adjusting for what's already in place. */
  baseDifficulty: Difficulty;
  /** Ceiling on the potential label for this channel (audience-linked income
   * caps out differently per channel). */
  ceiling: PotentialLabel;
  /** Is this channel even worth surfacing given the signals? */
  applicable: (s: MonetizationSignals, band: Band) => boolean;
  /** Already active for this org? */
  active: (s: MonetizationSignals) => boolean;
  actions: (s: MonetizationSignals) => string[];
  evidence: (
    s: MonetizationSignals,
  ) => Array<{ statement: string; kind: OpportunityDraft['evidence'][number]['kind'] }>;
  description: (s: MonetizationSignals) => string;
}

function audienceEvidence(
  s: MonetizationSignals,
): Array<{ statement: string; kind: 'fact' | 'calculated_metric' | 'assumption' }> {
  const out: Array<{ statement: string; kind: 'fact' | 'calculated_metric' | 'assumption' }> = [];
  if (s.youtube.connected && s.youtube.subscriberCount != null) {
    out.push({
      statement: `YouTube channel "${s.youtube.channelTitle ?? 'channel'}" has ${s.youtube.subscriberCount.toLocaleString()} subscribers and ${(s.youtube.videoCount ?? 0).toLocaleString()} videos.`,
      kind: 'fact',
    });
  }
  if (s.tiktok.connected && s.tiktok.followerCount != null) {
    out.push({
      statement: `TikTok account "${s.tiktok.displayName ?? 'account'}" has ${s.tiktok.followerCount.toLocaleString()} followers.`,
      kind: 'fact',
    });
  }
  if (s.business.emailListSize) {
    out.push({
      statement: `Email list of about ${s.business.emailListSize.toLocaleString()} (user-provided).`,
      kind: 'fact',
    });
  }
  if (s.business.niche)
    out.push({ statement: `Stated niche: ${s.business.niche} (user-provided).`, kind: 'fact' });
  return out;
}

const SPECS: ChannelSpec[] = [
  {
    channel: 'PLATFORM_MONETIZATION',
    title: 'Platform monetization (YouTube Partner Program)',
    baseDifficulty: 'medium',
    ceiling: 'Moderate',
    applicable: (s) => s.youtube.connected,
    active: (s) =>
      Boolean(
        s.youtube.assessment &&
        s.youtube.assessment.estimate.unmetThresholds.length === 0 &&
        s.youtube.assessment.estimate.unverified.length === 0,
      ),
    actions: (s) => {
      const est = s.youtube.assessment?.estimate;
      const a: string[] = [];
      for (const t of est?.unmetThresholds ?? []) a.push(`Work toward: ${t}`);
      for (const t of est?.unverified ?? []) a.push(`Confirm in YouTube Studio: ${t}`);
      a.push(
        'When the criteria are met, apply in YouTube Studio → Earn. YouTube makes the eligibility decision.',
      );
      return a.length
        ? a
        : ['Apply in YouTube Studio → Earn once eligible; YouTube confirms eligibility.'];
    },
    evidence: (s) => {
      const est = s.youtube.assessment?.estimate;
      const out: Array<{ statement: string; kind: 'fact' | 'calculated_metric' | 'assumption' }> =
        [];
      for (const t of est?.metThresholds ?? [])
        out.push({ statement: `Met (from API/attestation): ${t}`, kind: 'calculated_metric' });
      for (const t of est?.unmetThresholds ?? [])
        out.push({ statement: `Not yet met: ${t}`, kind: 'calculated_metric' });
      for (const t of est?.unverified ?? [])
        out.push({ statement: `Cannot verify from the API: ${t}`, kind: 'fact' });
      out.push({
        statement:
          'Eligibility for the YouTube Partner Program is decided by YouTube, not this tool. The API never exposes the review decision.',
        kind: 'fact',
      });
      return out;
    },
    description: (s) => {
      const est = s.youtube.assessment?.estimate;
      if (est && est.unmetThresholds.length === 0 && est.unverified.length === 0) {
        return 'Every Partner Program criterion we can check appears to be met. This does not confirm you qualify — apply in YouTube Studio and YouTube will make the decision.';
      }
      return `The Partner Program criteria are not all confirmed yet (${(est?.unmetThresholds.length ?? 0) + (est?.unverified.length ?? 0)} open item(s)). This is not a claim that you do or do not qualify.`;
    },
  },
  {
    channel: 'SPONSORSHIP',
    title: 'Sponsorships (paid brand mentions / integrations)',
    baseDifficulty: 'medium',
    ceiling: 'High',
    applicable: (_s, band) => band !== 'unknown' && band !== 'nascent',
    active: (s) => s.business.doesSponsorships,
    actions: () => [
      'Assemble a one-page media kit: audience size, top-performing content, engagement, and 2–3 example integration formats.',
      'Build a target list of 15–25 brands your audience already uses.',
      'Set a rate range you will not go below; start outreach with warm contacts.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Sponsorship rates typically scale with audience size, niche relevance, and engagement.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Direct brand deals are usually the fastest audience-linked income once you have a defined niche and a few thousand engaged followers.',
  },
  {
    channel: 'AFFILIATE',
    title: 'Affiliate marketing',
    baseDifficulty: 'low',
    ceiling: 'Moderate',
    applicable: (s, band) =>
      band === 'small' ||
      band === 'mid' ||
      band === 'large' ||
      band === 'major' ||
      s.business.hasWebsite,
    active: (s) => s.business.doesAffiliates,
    actions: () => [
      'List the tools / products you already recommend and sign up for their affiliate programs.',
      'Add disclosed affiliate links to descriptions, pinned comments, and any resource pages.',
      'Create one "my toolkit / gear" reference page and link to it from your most-viewed content.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Affiliate income depends on how often your content prompts a purchase decision.',
        kind: 'assumption',
      },
      ...(s.business.hasWebsite
        ? [
            {
              statement: 'You have a website to host resource / comparison pages (user-provided).',
              kind: 'fact' as const,
            },
          ]
        : []),
    ],
    description: () =>
      'Low setup cost: earn a commission recommending products your audience is already deciding on. Best where your content is advice- or review-shaped.',
  },
  {
    channel: 'DIGITAL_PRODUCT',
    title: 'Digital products (templates, presets, ebooks, tools)',
    baseDifficulty: 'medium',
    ceiling: 'High',
    applicable: (s, band) =>
      band !== 'unknown' && band !== 'nascent' ? true : Boolean(s.business.emailListSize),
    active: (s) => s.business.sellsProducts,
    actions: () => [
      'Pick one concrete, repeatable problem your audience asks about and package the fix as a template / checklist / mini-tool.',
      'Price it low for the first launch; collect testimonials.',
      'Sell from a simple storefront; promote in content that addresses the same problem.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Digital products have near-zero marginal cost, so revenue tracks audience size × conversion.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Sell a reusable asset once and deliver it many times. Works best when your audience has a clear, recurring problem.',
  },
  {
    channel: 'SERVICE',
    title: 'Productized services (done-for-you work)',
    baseDifficulty: 'medium',
    ceiling: 'Moderate',
    applicable: (s) =>
      s.business.doesConsulting || s.business.offerings.length > 0 || Boolean(s.business.niche),
    active: (s) =>
      s.business.offerings.some((o) => /service|done.for.you|agency|freelance/i.test(o)),
    actions: () => [
      'Define one packaged service with a fixed scope, timeline, and price.',
      'Add a short "work with me" page and mention it in relevant content.',
      'Take 2–3 clients at a low intro rate to build proof.',
    ],
    evidence: (s) => [
      ...(s.business.niche
        ? [
            {
              statement: `Stated niche: ${s.business.niche} (user-provided).`,
              kind: 'fact' as const,
            },
          ]
        : []),
      {
        statement:
          'Service income depends on your available hours and rate, so it scales with time, not audience alone.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Sell your skill directly. Higher effort per unit than products, but you can start with a tiny audience.',
  },
  {
    channel: 'MEMBERSHIP',
    title: 'Membership / paid community',
    baseDifficulty: 'high',
    ceiling: 'Moderate',
    applicable: (_s, band) => band === 'mid' || band === 'large' || band === 'major',
    active: (s) => s.business.hasMembership,
    actions: () => [
      'Decide the single ongoing benefit members get (early access, a community, monthly calls, a resource library).',
      'Start a waitlist; commit to a weekly cadence before you launch.',
      'Launch small and raise the price as the value compounds.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Memberships need a reliable, ongoing reason to stay subscribed and a consistent cadence.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Recurring revenue from a small, committed slice of your audience. High ongoing effort — only worth it with a real cadence.',
  },
  {
    channel: 'SUBSCRIPTION',
    title: 'Paid subscription (newsletter / feed)',
    baseDifficulty: 'medium',
    ceiling: 'Moderate',
    applicable: (s, band) =>
      Boolean(s.business.emailListSize) || band === 'mid' || band === 'large' || band === 'major',
    active: (s) => s.business.hasMembership,
    actions: () => [
      'Run a free newsletter first; find the segment that opens every issue.',
      'Add a paid tier with one extra thing (depth, frequency, or archives).',
      'Keep the free tier strong so the paid tier is a genuine upgrade.',
    ],
    evidence: (s) => [
      ...(s.business.emailListSize
        ? [
            {
              statement: `Email list of about ${s.business.emailListSize.toLocaleString()} (user-provided).`,
              kind: 'fact' as const,
            },
          ]
        : []),
      {
        statement:
          'Paid-subscription conversion from a free list is commonly a low single-digit percentage.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'A paid tier on a publication you already run. Lower effort than a full membership if the free version already exists.',
  },
  {
    channel: 'LEAD_GENERATION',
    title: 'Lead generation for your own or a partner offer',
    baseDifficulty: 'medium',
    ceiling: 'Moderate',
    applicable: (s) =>
      s.business.hasWebsite || s.business.doesConsulting || s.seo.hasCompletedCrawl,
    active: (s) => Boolean(s.business.emailListSize && s.business.emailListSize > 200),
    actions: () => [
      'Create one lead magnet tied to your highest-intent content.',
      'Add an email capture to your site and content descriptions.',
      'Follow up with a short sequence that points to a paid offer.',
    ],
    evidence: (s) => [
      ...(s.business.hasWebsite
        ? [
            {
              statement: 'You have a website to host capture forms (user-provided).',
              kind: 'fact' as const,
            },
          ]
        : []),
      ...(s.seo.hasCompletedCrawl
        ? [
            {
              statement: 'A site crawl has run, so on-page capture placement can be reviewed.',
              kind: 'fact' as const,
            },
          ]
        : []),
      {
        statement: 'Lead-gen value depends on what the captured audience is eventually sold.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Turn attention into an owned audience (email) you can sell to repeatedly, or refer leads to a partner for a fee.',
  },
  {
    channel: 'CONSULTING',
    title: 'Consulting / coaching (1:1 or small group)',
    baseDifficulty: 'low',
    ceiling: 'Moderate',
    applicable: (s) => s.business.doesConsulting || Boolean(s.business.niche),
    active: (s) => s.business.doesConsulting,
    actions: () => [
      'Package a paid 60-minute session with a clear outcome.',
      'Add a booking link; mention it once per piece of content.',
      'Raise the rate every few clients until bookings slow.',
    ],
    evidence: (s) => [
      ...(s.business.niche
        ? [
            {
              statement: `Stated niche: ${s.business.niche} (user-provided).`,
              kind: 'fact' as const,
            },
          ]
        : []),
      {
        statement:
          'Consulting is high-rate but hour-bound; it scales with your time and price, not audience size.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'The fastest way to test willingness-to-pay: sell your time on a specific problem. Needs almost no audience.',
  },
  {
    channel: 'COURSE',
    title: 'Online course / cohort',
    baseDifficulty: 'high',
    ceiling: 'High',
    applicable: (s, band) =>
      band === 'mid' ||
      band === 'large' ||
      band === 'major' ||
      (s.business.emailListSize ?? 0) >= 500 ||
      s.business.hasCourse,
    active: (s) => s.business.hasCourse,
    actions: () => [
      'Validate with a paid cohort or workshop before building a full self-paced course.',
      'Teach the exact transformation your audience asks for, in the fewest lessons.',
      'Pre-sell to a waitlist; only build once people have paid.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Course revenue tracks audience size × launch conversion; production is front-loaded effort.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'Higher price point than a product, and a strong fit if your content already teaches a repeatable skill. Validate before you build.',
  },
  {
    channel: 'BRAND_PARTNERSHIP',
    title: 'Ongoing brand partnerships / ambassadorships',
    baseDifficulty: 'high',
    ceiling: 'High',
    applicable: (_s, band) => band === 'large' || band === 'major' || band === 'mid',
    active: (s) => s.business.doesSponsorships,
    actions: () => [
      'Turn a successful one-off sponsorship into a multi-month proposal (3–6 pieces + usage rights).',
      'Report results back to sponsors so renewals are easy.',
      'Diversify to 2–3 non-competing partners so no single deal dominates.',
    ],
    evidence: (s) => [
      ...audienceEvidence(s),
      {
        statement:
          'Longer-term partnerships pay more per piece and are more stable, but need a track record.',
        kind: 'assumption',
      },
    ],
    description: () =>
      'A step up from one-off sponsorships: recurring, higher-value deals with brands you have a proven fit with.',
  },
];

// --- scoring --------------------------------------------------------

function fitFor(s: MonetizationSignals, band: Band): AudienceFit {
  if (band === 'unknown') return 'unknown';
  if (band === 'nascent') return 'weak';
  if (band === 'small') return s.business.niche ? 'moderate' : 'weak';
  if (band === 'mid') return 'moderate';
  return 'strong';
}

const FIT_SCORE: Record<AudienceFit, number> = {
  unknown: 0.3,
  weak: 0.35,
  moderate: 0.6,
  strong: 0.85,
};
const CEIL_SCORE: Record<PotentialLabel, number> = { Low: 0.4, Moderate: 0.7, High: 1 };

function potentialLabel(score: number): PotentialLabel {
  if (score >= 0.66) return 'High';
  if (score >= 0.4) return 'Moderate';
  return 'Low';
}

export function buildOpportunities(signals: MonetizationSignals): OpportunityDraft[] {
  const band = audienceBand(signals.largestAudience);
  const out: OpportunityDraft[] = [];

  for (const spec of SPECS) {
    if (!spec.applicable(signals, band)) continue;
    const active = spec.active(signals);
    const readiness: OpportunityDraft['readiness'] = active
      ? 'current'
      : spec.channel === 'PLATFORM_MONETIZATION'
        ? 'potential'
        : 'potential';

    const audienceFit = fitFor(signals, band);
    const diffLevel = Math.max(1, DIFF_LEVEL[spec.baseDifficulty] - (active ? 1 : 0));
    const difficulty = LEVEL_DIFF[diffLevel]!;

    const potentialScore = Math.min(
      CEIL_SCORE[spec.ceiling],
      0.5 * BAND_SCORE[band] + 0.5 * FIT_SCORE[audienceFit],
    );
    const potential = potentialLabel(potentialScore);

    const evidence = spec.evidence(signals).slice(0, 5);
    const goalMatch = signals.business.goals.some((g) =>
      /money|monet|revenue|income|earn|sponsor|product|course|member/i.test(g),
    );

    const confidence = clamp01(
      0.35 +
        (active ? 0.25 : 0) +
        Math.min(0.25, evidence.filter((e) => e.kind !== 'assumption').length * 0.08) +
        (audienceFit === 'strong' ? 0.1 : audienceFit === 'moderate' ? 0.05 : 0),
    );

    const priorityScore = Math.round(
      100 *
        (0.28 * FIT_SCORE[audienceFit] +
          0.22 * potentialScore +
          0.2 * (1 - (diffLevel - 1) / 2) +
          0.15 * confidence +
          0.08 * (active ? 1 : 0.4) +
          0.07 * (goalMatch ? 1 : 0.3)),
    );

    out.push({
      channel: spec.channel,
      title: spec.title,
      description: spec.description(signals),
      readiness,
      evidence,
      audienceFit,
      difficulty,
      potential,
      potentialBasis: `Estimate only. Formed from your audience band (${band}) and audience fit (${audienceFit}) against typical outcomes for ${spec.title.toLowerCase()}. It is a relative label, not a revenue figure.`,
      requiredActions: spec.actions(signals),
      confidence,
      priorityScore,
    });
  }

  return out.sort((a, b) => b.priorityScore - a.priorityScore);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number(n.toFixed(3))));
}

export const PRIORITY_MODEL_NOTE =
  'priorityScore ranks which opportunity to pursue first: 100 × (0.28·audienceFit + 0.22·potential + 0.20·ease + 0.15·confidence + 0.08·already-active + 0.07·matches-a-stated-goal). It is not an income estimate.';
