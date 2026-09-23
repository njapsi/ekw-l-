import { describe, expect, it } from 'vitest';
import { DEFAULT_FRESHNESS_BY_TYPE, evidenceKindFor, KNOWLEDGE_TYPES, trustLevelFor } from './schemas.js';

describe('evidenceKindFor', () => {
  it('maps a FACT/USER_PROVIDED/SYSTEM_OBSERVED/EXTERNAL_SOURCE classification to "fact"', () => {
    expect(evidenceKindFor('FACT')).toBe('fact');
    expect(evidenceKindFor('USER_PROVIDED')).toBe('fact');
    expect(evidenceKindFor('SYSTEM_OBSERVED')).toBe('fact');
    expect(evidenceKindFor('EXTERNAL_SOURCE')).toBe('fact');
  });

  it('maps INFERENCE to "calculated_metric"', () => {
    expect(evidenceKindFor('INFERENCE')).toBe('calculated_metric');
  });

  it('never presents a HYPOTHESIS or OPINION as a fact', () => {
    expect(evidenceKindFor('HYPOTHESIS')).toBe('assumption');
    expect(evidenceKindFor('OPINION')).toBe('assumption');
  });
});

describe('trustLevelFor', () => {
  it('rates internal analytics and mission/experiment results as VERY_HIGH', () => {
    expect(trustLevelFor('INTERNAL_ANALYTICS')).toBe('VERY_HIGH');
    expect(trustLevelFor('MISSION_RESULT')).toBe('VERY_HIGH');
    expect(trustLevelFor('EXPERIMENT_RESULT')).toBe('VERY_HIGH');
  });

  it('rates first-party connected platforms as HIGH', () => {
    expect(trustLevelFor('YOUTUBE')).toBe('HIGH');
    expect(trustLevelFor('GOOGLE_SEARCH_CONSOLE')).toBe('HIGH');
  });

  it('rates unauthenticated web research as LOW, not UNKNOWN or HIGH', () => {
    expect(trustLevelFor('WEB_RESEARCH')).toBe('LOW');
    expect(trustLevelFor('WEBSITE_CRAWL')).toBe('LOW');
  });

  it('rates AI-generated content as UNKNOWN — never an inflated trust level', () => {
    expect(trustLevelFor('AI_GENERATED')).toBe('UNKNOWN');
  });
});

describe('DEFAULT_FRESHNESS_BY_TYPE', () => {
  it('has an entry for every knowledge type — no type falls through to undefined', () => {
    for (const type of KNOWLEDGE_TYPES) {
      expect(DEFAULT_FRESHNESS_BY_TYPE[type]).toBeDefined();
    }
  });

  it('treats a business/brand profile as long-lived, per the brief\'s own example', () => {
    expect(DEFAULT_FRESHNESS_BY_TYPE.BUSINESS_PROFILE).toBe('long');
    expect(DEFAULT_FRESHNESS_BY_TYPE.BRAND_PROFILE).toBe('long');
  });

  it('treats a historical experiment/decision/learning as a permanent record', () => {
    expect(DEFAULT_FRESHNESS_BY_TYPE.EXPERIMENT).toBe('permanent');
    expect(DEFAULT_FRESHNESS_BY_TYPE.DECISION).toBe('permanent');
    expect(DEFAULT_FRESHNESS_BY_TYPE.LEARNING).toBe('permanent');
  });

  it('treats live platform performance and market data as short-lived', () => {
    expect(DEFAULT_FRESHNESS_BY_TYPE.YOUTUBE).toBe('short');
    expect(DEFAULT_FRESHNESS_BY_TYPE.PERFORMANCE).toBe('short');
    expect(DEFAULT_FRESHNESS_BY_TYPE.MARKET).toBe('very_short');
  });
});
