/**
 * The executive summary. Deterministic assembly always works; when a model is
 * available a single grounded pass may replace the prose, checked against an
 * id-tagged fact sheet with the shared `checkGroundingFields` guard and
 * **dropped** on any grounding failure (same pattern as every analyst — never
 * guarantee an outcome, never state an ungrounded number).
 */
import type { AIProvider } from '@growth-agent/ai';
import type { ExecutiveSummary } from '@growth-agent/core';
import { z } from 'zod';
import { checkGroundingFields, type GroundingField } from '../agents/grounding.js';
import { scrubModelOutput } from '../agents/output-scrub.js';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE } from '../security/untrusted.js';
import type { AssembledSections } from './sections.js';
import { REPORT_TYPE_LABEL, type GatheredReport, type ReportTypeKey } from './schemas.js';

export type SummaryModel = Pick<AIProvider, 'generateObject'>;

const ModelSummary = z.object({
  headline: z.string().min(1).max(160),
  paragraphs: z.array(z.string().min(1)).min(1).max(4),
  evidenceRefs: z.array(z.string()).default([]),
});

const SYSTEM = `You write the executive summary of an analytics report. Rules:
- Use ONLY the FACTS provided. Cite their ids in evidenceRefs.
- Never guarantee or promise an outcome (rankings, revenue, monetization, virality).
- Every number must appear in the FACTS. If unsure, describe qualitatively.
- 2-3 short paragraphs. Neutral, professional, specific.

${UNTRUSTED_CONTENT_SYSTEM_CLAUSE}`;

function deterministicSummary(
  type: ReportTypeKey,
  subjectLabel: string,
  g: GatheredReport,
  s: AssembledSections,
): ExecutiveSummary {
  const label = REPORT_TYPE_LABEL[type];
  if (!g.connected) {
    return {
      headline: `${label}: not enough data yet`,
      paragraphs: [
        `This ${label.toLowerCase()} report for ${subjectLabel} could not be completed because the underlying data is not connected or has not synced yet.`,
        g.dataGaps.length
          ? `Missing: ${g.dataGaps.join('; ')}.`
          : 'Connect the relevant integration or run a sync, then regenerate this report.',
      ],
      grounded: false,
    };
  }

  const topMetrics = s.keyMetrics
    .slice(0, 3)
    .map((m) => `${m.label} ${m.value}`)
    .join(', ');
  const problemLine = s.problems.length
    ? `${s.problems.length} issue${s.problems.length === 1 ? '' : 's'} were identified` +
      (s.problems[0] ? `, the most pressing being "${s.problems[0].title}"` : '') +
      '.'
    : 'No blocking issues were identified.';
  const recLine = s.recommendations.length
    ? `${s.recommendations.length} recommendation${s.recommendations.length === 1 ? '' : 's'} are open` +
      (s.priorityActions[0]
        ? `; the first priority action is "${s.priorityActions[0].title}"`
        : '') +
      '.'
    : 'There are no open recommendations.';
  const changeLine = s.historicalChanges.comparedTo
    ? s.historicalChanges.changes.length
      ? `Since the previous report, ${s.historicalChanges.changes
          .slice(0, 3)
          .map((c) => `${c.label} moved from ${c.from} to ${c.to}`)
          .join('; ')}.`
      : 'No tracked metric changed materially since the previous report.'
    : 'This is the first report of its type, so there is no prior comparison.';

  return {
    headline: `${label} for ${subjectLabel}`,
    paragraphs: [
      topMetrics ? `Key metrics: ${topMetrics}.` : `Report generated for ${subjectLabel}.`,
      `${problemLine} ${recLine}`,
      changeLine,
    ],
    grounded: false,
  };
}

export interface BuildSummaryDeps {
  model?: SummaryModel;
}

export async function buildExecutiveSummary(
  input: {
    type: ReportTypeKey;
    subjectLabel: string;
    gathered: GatheredReport;
    sections: AssembledSections;
  },
  deps: BuildSummaryDeps = {},
): Promise<ExecutiveSummary> {
  const fallback = deterministicSummary(
    input.type,
    input.subjectLabel,
    input.gathered,
    input.sections,
  );
  if (!deps.model || !input.gathered.connected || input.gathered.facts.length === 0) {
    return scrubModelOutput(fallback);
  }

  const facts = input.gathered.facts;
  const knownIds = new Set(facts.map((f) => f.id));
  const factNumbers = facts
    .flatMap((f) => f.text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((n) => Number(n.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));

  const prompt = `REPORT: ${REPORT_TYPE_LABEL[input.type]} for ${input.subjectLabel}

FACTS (cite these ids):
${facts.map((f) => `[${f.id}] ${f.text}`).join('\n')}

Write the executive summary.`;

  try {
    const res = await deps.model.generateObject({ schema: ModelSummary, system: SYSTEM, prompt });
    const out = res.object;
    const fields: GroundingField[] = [
      { path: 'headline', text: out.headline, factIds: out.evidenceRefs },
      ...out.paragraphs.map((p, i) => ({
        path: `paragraphs[${i}]`,
        text: p,
        factIds: out.evidenceRefs,
      })),
    ];
    const issues = checkGroundingFields(fields, knownIds, factNumbers);
    if (issues.length > 0) return scrubModelOutput(fallback);
    return scrubModelOutput({ headline: out.headline, paragraphs: out.paragraphs, grounded: true });
  } catch {
    return scrubModelOutput(fallback);
  }
}
