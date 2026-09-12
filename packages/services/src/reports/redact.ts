/**
 * Public-link redaction. A shared report URL must not expose private account
 * information (docs/SECURITY.md). We: replace the subject label + org name with
 * generic text, strip anything that identifies the account or a specific
 * resource from every free-text field (handles, emails, URLs, long ids), and
 * hide raw monetary amounts. Aggregate metrics, scores, deltas and
 * recommendation guidance stay — that is the point of sharing a report.
 */
import type { ReportSnapshot, ReportType } from '@growth-agent/core';

const GENERIC_SUBJECT: Record<ReportType, string> = {
  YOUTUBE: 'a YouTube channel',
  TIKTOK: 'a TikTok account',
  SEO: 'a website',
  WEBSITE_HEALTH: 'a website',
  AI_RECOMMENDATIONS: 'an organization',
  GROWTH: 'an organization',
  MONETIZATION: 'an organization',
};

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;
const HANDLE_RE = /(^|\s)@[A-Za-z0-9._-]{2,}/g;
const LONG_ID_RE = /\b[A-Za-z0-9_-]{20,}\b/g;

export function scrubText(input: string): string {
  return input
    .replace(EMAIL_RE, '[redacted]')
    .replace(URL_RE, 'a page')
    .replace(HANDLE_RE, '$1[handle]')
    .replace(LONG_ID_RE, '[id]')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function scrubList(items: string[]): string[] {
  return items.map(scrubText);
}

export function redactSnapshotForPublic(snapshot: ReportSnapshot): ReportSnapshot {
  const generic = GENERIC_SUBJECT[snapshot.meta.type];
  const replaceSubject = (s: string): string =>
    scrubText(s.split(snapshot.meta.subjectLabel).join(generic));

  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      title: replaceSubject(snapshot.meta.title),
      subjectLabel: generic,
      orgName: 'Shared report',
      isPublic: true,
    },
    executiveSummary: {
      ...snapshot.executiveSummary,
      headline: replaceSubject(snapshot.executiveSummary.headline),
      paragraphs: snapshot.executiveSummary.paragraphs.map(replaceSubject),
    },
    keyMetrics: snapshot.keyMetrics.map((m) => {
      const isMoney = /revenue|earnings|payout/i.test(m.label);
      return {
        ...m,
        value: isMoney ? 'recorded (amount hidden on shared links)' : m.value,
        raw: isMoney ? null : m.raw,
        note: m.note ? scrubText(m.note) : m.note,
        delta: isMoney && m.delta ? { ...m.delta, previous: 'hidden', changePct: null } : m.delta,
      };
    }),
    problems: snapshot.problems.map((p) => ({
      ...p,
      title: scrubText(p.title),
      detail: replaceSubject(p.detail),
      evidence: scrubList(p.evidence),
    })),
    opportunities: snapshot.opportunities.map((o) => ({
      ...o,
      title: scrubText(o.title),
      detail: replaceSubject(o.detail),
    })),
    recommendations: snapshot.recommendations.map((r) => ({
      ...r,
      title: scrubText(r.title),
      why: replaceSubject(r.why),
      actions: scrubList(r.actions),
      expectedImpact: scrubText(r.expectedImpact),
    })),
    priorityActions: snapshot.priorityActions.map((a) => ({
      ...a,
      title: scrubText(a.title),
      rationale: replaceSubject(a.rationale),
    })),
    historicalChanges: {
      ...snapshot.historicalChanges,
      changes: snapshot.historicalChanges.changes.map((c) => {
        const isMoney = /revenue|earnings|payout/i.test(c.label);
        return isMoney ? { ...c, from: 'hidden', to: 'hidden', changePct: c.changePct } : c;
      }),
      notes: scrubList(snapshot.historicalChanges.notes),
    },
    disclaimers: scrubList(snapshot.disclaimers),
    dataGaps: scrubList(snapshot.dataGaps),
  };
}
