import { type GroundingField, checkGroundingFields } from '../agents/grounding.js';
import type { FactSheet } from './fact-sheet.js';
import type { YouTubeAnalysis } from './analyst-schema.js';

export type { GroundingIssue } from '../agents/grounding.js';

function textFields(a: YouTubeAnalysis): GroundingField[] {
  const out: GroundingField[] = [{ path: 'dataCoverage', text: a.dataCoverage }];
  a.findings.forEach((f, i) =>
    out.push({
      path: `findings[${i}]`,
      text: `${f.title} ${f.detail}`,
      factIds: f.evidenceFactIds,
    }),
  );
  a.recommendations.forEach((r, i) =>
    out.push({
      path: `recommendations[${i}]`,
      text: `${r.title} ${r.reasoning} ${r.suggestedAction} ${r.expectedImpact}`,
      factIds: r.evidenceFactIds,
    }),
  );
  a.titleSuggestions.forEach((s, i) =>
    out.push({
      path: `titleSuggestions[${i}]`,
      text: `${s.suggestion} ${s.rationale}`,
      factIds: s.evidenceFactIds,
    }),
  );
  a.descriptionSuggestions.forEach((s, i) =>
    out.push({
      path: `descriptionSuggestions[${i}]`,
      text: `${s.suggestion} ${s.rationale}`,
      factIds: s.evidenceFactIds,
    }),
  );
  a.topicSuggestions.forEach((s, i) =>
    out.push({
      path: `topicSuggestions[${i}]`,
      text: `${s.topic} ${s.rationale}`,
      factIds: s.evidenceFactIds,
    }),
  );
  a.publishingRecommendations.forEach((s, i) =>
    out.push({
      path: `publishingRecommendations[${i}]`,
      text: `${s.suggestion} ${s.rationale}`,
      factIds: s.evidenceFactIds,
    }),
  );
  a.contentIdeas.forEach((c, i) =>
    out.push({
      path: `contentIdeas[${i}]`,
      text: `${c.title} ${c.rationale}`,
      factIds: c.evidenceFactIds,
    }),
  );
  return out;
}

export function checkGrounding(analysis: YouTubeAnalysis, sheet: FactSheet) {
  return checkGroundingFields(
    textFields(analysis),
    new Set(sheet.facts.map((f) => f.id)),
    sheet.numbers,
  );
}
