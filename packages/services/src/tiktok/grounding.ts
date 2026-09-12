import { type GroundingField, checkGroundingFields } from '../agents/grounding.js';
import type { FactSheet } from './fact-sheet.js';
import type { TikTokAnalysis } from './analyst-schema.js';

export type { GroundingIssue } from '../agents/grounding.js';

function textFields(a: TikTokAnalysis): GroundingField[] {
  const out: GroundingField[] = [{ path: 'dataCoverage', text: a.dataCoverage }];
  a.observations.forEach((o, i) =>
    out.push({
      path: `observations[${i}]`,
      text: `${o.title} ${o.detail}`,
      factIds: o.evidenceFactIds,
    }),
  );
  a.recommendations.forEach((r, i) =>
    out.push({
      path: `recommendations[${i}]`,
      text: `${r.title} ${r.reasoning} ${r.suggestedAction} ${r.expectedImpact}`,
      factIds: r.evidenceFactIds,
    }),
  );
  a.contentIdeas.forEach((c, i) =>
    out.push({
      path: `contentIdeas[${i}]`,
      text: `${c.title} ${c.rationale}`,
      factIds: c.evidenceFactIds,
    }),
  );
  a.captionIdeas.forEach((c, i) =>
    out.push({
      path: `captionIdeas[${i}]`,
      text: `${c.caption} ${c.rationale}`,
      factIds: c.evidenceFactIds,
    }),
  );
  a.hashtagSuggestions.forEach((h, i) =>
    out.push({
      path: `hashtagSuggestions[${i}]`,
      text: `${h.hashtags.join(' ')} ${h.rationale}`,
      factIds: h.evidenceFactIds,
    }),
  );
  a.contentThemes.forEach((t, i) =>
    out.push({
      path: `contentThemes[${i}]`,
      text: `${t.theme} ${t.rationale}`,
      factIds: t.evidenceFactIds,
    }),
  );
  a.postingRecommendations.forEach((p, i) =>
    out.push({
      path: `postingRecommendations[${i}]`,
      text: `${p.suggestion} ${p.rationale}`,
      factIds: p.evidenceFactIds,
    }),
  );
  a.repurposingRecommendations.forEach((p, i) =>
    out.push({
      path: `repurposingRecommendations[${i}]`,
      text: `${p.suggestion} ${p.rationale}`,
      factIds: p.evidenceFactIds,
    }),
  );
  return out;
}

export function checkGrounding(analysis: TikTokAnalysis, sheet: FactSheet) {
  return checkGroundingFields(
    textFields(analysis),
    new Set(sheet.facts.map((f) => f.id)),
    sheet.numbers,
  );
}
