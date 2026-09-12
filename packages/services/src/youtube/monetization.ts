import { type DailyMetricLike, windowTotals } from './metrics.js';

/**
 * YouTube Partner Program readiness assessment.
 *
 * Hard rule (master instruction, section A): never claim monetization approval
 * or revenue is guaranteed. Every field is explicitly tagged as one of:
 *   1. official  — YouTube's published requirements (a `fact`, with a source)
 *   2. apiData    — what our synced API data shows (a `calculated_metric`) OR
 *                   an explicit `unavailable` marker with `howToVerify`
 *   3. userProvided — attestations the user entered (an `assumption`)
 *   4. estimate   — a derived readiness view (a `prediction`, with confidence)
 */

export const NEVER_GUARANTEE_NOTICE =
  'This is an estimate of eligibility against public requirements. It is not a guarantee of acceptance into the YouTube Partner Program or of any revenue. Only YouTube can approve monetization.';

export interface OfficialRequirement {
  id: string;
  kind: 'fact';
  requirement: string;
  source: string;
}

export const YPP_REQUIREMENTS: OfficialRequirement[] = [
  {
    id: 'subs',
    kind: 'fact',
    requirement: 'At least 1,000 subscribers.',
    source: 'YouTube Help — YouTube Partner Program overview & eligibility',
  },
  {
    id: 'watch_hours',
    kind: 'fact',
    requirement:
      'At least 4,000 valid public watch hours in the last 12 months, OR 10 million valid public Shorts views in the last 90 days.',
    source: 'YouTube Help — YouTube Partner Program overview & eligibility',
  },
  {
    id: 'policies',
    kind: 'fact',
    requirement:
      'Follow all YouTube monetization policies and Community Guidelines; no active Community Guidelines strikes.',
    source: 'YouTube Help — YouTube channel monetization policies',
  },
  {
    id: 'twostep',
    kind: 'fact',
    requirement: 'Turn on 2-Step Verification for the Google Account.',
    source: 'YouTube Help — YouTube Partner Program eligibility',
  },
  {
    id: 'adsense',
    kind: 'fact',
    requirement: 'Have an approved AdSense account linked to the channel.',
    source: 'YouTube Help — YouTube Partner Program eligibility',
  },
  {
    id: 'region',
    kind: 'fact',
    requirement: 'Live in a country/region where the YouTube Partner Program is available.',
    source: 'YouTube Help — YouTube Partner Program availability',
  },
];

export interface ApiDatum {
  id: string;
  label: string;
  status: 'available' | 'unavailable';
  kind: 'calculated_metric' | 'fact';
  value?: string;
  detail?: string;
  /** For unavailable items: how the user can check it themselves. */
  howToVerify?: string;
  windowDays?: number;
}

export interface UserAttestation {
  id: string;
  label: string;
  kind: 'assumption';
  answered: boolean;
  value?: boolean;
}

export interface ReadinessEstimate {
  kind: 'prediction';
  /** 0..1 — confidence in the estimate itself, not in acceptance. */
  confidence: number;
  metThresholds: string[];
  unmetThresholds: string[];
  unverified: string[];
  summary: string;
  disclaimer: string;
}

export interface MonetizationAssessment {
  official: OfficialRequirement[];
  apiData: ApiDatum[];
  userProvided: UserAttestation[];
  estimate: ReadinessEstimate;
}

export interface MonetizationInputs {
  subscriberCount: bigint | null;
  hiddenSubscriberCount: boolean;
  /** Daily channel analytics rows, if analytics have been synced. */
  daily: DailyMetricLike[] | null;
  analyticsSyncedThrough: Date | null;
  /** User-attested facts we cannot read from the API. */
  attestations?: Partial<
    Record<'twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', boolean>
  >;
  now?: Date;
}

const USER_ITEMS: Array<{
  id: keyof NonNullable<MonetizationInputs['attestations']>;
  label: string;
}> = [
  { id: 'twoStep', label: '2-Step Verification is enabled on the Google Account' },
  { id: 'noStrikes', label: 'No active Community Guidelines strikes' },
  { id: 'adsenseLinked', label: 'An approved AdSense account is linked' },
  { id: 'regionEligible', label: 'Channel is in a region where YPP is available' },
];

export function assessMonetization(input: MonetizationInputs): MonetizationAssessment {
  const now = input.now ?? new Date();
  const apiData: ApiDatum[] = [];

  // --- Subscribers (from Data API) ---
  if (input.hiddenSubscriberCount) {
    apiData.push({
      id: 'subs',
      label: 'Subscribers',
      status: 'unavailable',
      kind: 'fact',
      detail: 'This channel hides its subscriber count, so the API does not return it.',
      howToVerify: 'Check the exact count in YouTube Studio → Analytics → Overview.',
    });
  } else if (input.subscriberCount != null) {
    apiData.push({
      id: 'subs',
      label: 'Subscribers',
      status: 'available',
      kind: 'calculated_metric',
      value: input.subscriberCount.toString(),
      detail: `Public subscriber count from the YouTube Data API${
        input.subscriberCount < 1000n ? '' : ' — meets the 1,000-subscriber threshold'
      }.`,
    });
  } else {
    apiData.push({
      id: 'subs',
      label: 'Subscribers',
      status: 'unavailable',
      kind: 'fact',
      detail: 'The API did not return a subscriber count.',
      howToVerify: 'Check YouTube Studio → Analytics.',
    });
  }

  // --- Watch hours (from Analytics API) ---
  if (input.daily && input.daily.length > 0) {
    const w = windowTotals(input.daily, 365, now);
    const coverageNote = input.analyticsSyncedThrough
      ? ` Based on analytics synced through ${input.analyticsSyncedThrough.toISOString().slice(0, 10)}; the 12-month window may not be fully covered yet.`
      : '';
    apiData.push({
      id: 'watch_hours',
      label: 'Watch hours (last 365 days)',
      status: 'available',
      kind: 'calculated_metric',
      value: `${Math.round(w.watchHours).toLocaleString()} h`,
      windowDays: 365,
      detail:
        `Sum of estimatedMinutesWatched over the last 365 days ÷ 60.` +
        ` This includes all watch time; the YouTube Partner Program counts only *valid public* watch hours, which the API does not break out.` +
        coverageNote,
      howToVerify:
        'YouTube Studio → Earnings (or Analytics → Overview) shows your official public watch-hour progress toward the 4,000-hour threshold.',
    });
  } else {
    apiData.push({
      id: 'watch_hours',
      label: 'Watch hours',
      status: 'unavailable',
      kind: 'fact',
      detail:
        'Analytics have not been synced (or returned no rows), so a watch-hour estimate is not available.',
      howToVerify:
        'Connect analytics and run a sync, or check YouTube Studio → Earnings for the official figure.',
    });
  }

  // --- Things the API simply cannot tell us ---
  apiData.push(
    {
      id: 'policy_status',
      label: 'Monetization policy / strike status',
      status: 'unavailable',
      kind: 'fact',
      detail: 'The API does not expose policy-review or Community Guidelines strike status.',
      howToVerify:
        'YouTube Studio → Content → Monetization tab, and the Channel dashboard for strikes.',
    },
    {
      id: 'ypp_decision',
      label: 'YouTube Partner Program review decision',
      status: 'unavailable',
      kind: 'fact',
      detail: 'Only YouTube makes and shows this decision; it is never available through the API.',
      howToVerify: 'YouTube Studio → Earnings shows your application status once you apply.',
    },
  );

  // --- User attestations ---
  const userProvided: UserAttestation[] = USER_ITEMS.map((item) => {
    const val = input.attestations?.[item.id];
    return {
      id: item.id,
      label: item.label,
      kind: 'assumption',
      answered: val !== undefined,
      value: val,
    };
  });

  // --- Estimate ---
  const met: string[] = [];
  const unmet: string[] = [];
  const unverified: string[] = [];

  if (!input.hiddenSubscriberCount && input.subscriberCount != null) {
    (input.subscriberCount >= 1000n ? met : unmet).push('1,000 subscribers');
  } else {
    unverified.push('1,000 subscribers');
  }

  const watch = apiData.find((d) => d.id === 'watch_hours');
  if (watch?.status === 'available' && input.daily) {
    const hrs = windowTotals(input.daily, 365, now).watchHours;
    (hrs >= 4000 ? met : unmet).push('4,000 public watch hours (12 months) — estimated');
  } else {
    unverified.push('4,000 public watch hours (12 months)');
  }

  for (const a of userProvided) {
    if (!a.answered) unverified.push(a.label);
    else if (a.value === false) unmet.push(a.label);
    else met.push(a.label);
  }

  // Confidence in the *estimate*: higher when we have more direct signal.
  const directSignals = [
    !input.hiddenSubscriberCount && input.subscriberCount != null,
    Boolean(input.daily && input.daily.length >= 300),
  ].filter(Boolean).length;
  const answered = userProvided.filter((a) => a.answered).length;
  const confidence = Math.min(0.9, 0.25 + directSignals * 0.25 + answered * 0.05);

  const summary =
    unmet.length === 0 && unverified.length === 0
      ? 'All checks we can evaluate are met. Confirm the remaining items in YouTube Studio and apply there.'
      : `${met.length} of the checks we can evaluate look met. ` +
        (unmet.length ? `${unmet.length} appear unmet. ` : '') +
        (unverified.length ? `${unverified.length} cannot be verified from available data.` : '');

  return {
    official: YPP_REQUIREMENTS,
    apiData,
    userProvided,
    estimate: {
      kind: 'prediction',
      confidence: Number(confidence.toFixed(2)),
      metThresholds: met,
      unmetThresholds: unmet,
      unverified,
      summary,
      disclaimer: NEVER_GUARANTEE_NOTICE,
    },
  };
}
