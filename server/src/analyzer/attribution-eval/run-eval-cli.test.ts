import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runEval,
  slotLabel,
  parseFixtureFilename,
  formatReviewLine,
  partitionByTier,
  type ScoredFixture,
} from './run-eval-cli.js';
import type { ReviewAgg, Stat } from './run-eval.js';

describe('runEval gating', () => {
  it('SKIPs cleanly when the corpus dir is empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-corpus-'));
    const res = await runEval({ engines: ['qwen'], corpusDir: empty });
    expect(res.skipped).toMatch(/no corpus/i);
  });
});

describe('slotLabel', () => {
  it('labels qwen with the resolved model id', () => {
    const prev = process.env.EVAL_QWEN_MODEL;
    process.env.EVAL_QWEN_MODEL = 'qwen36-cw-iq4-32k';
    try {
      expect(slotLabel('qwen')).toBe('qwen:qwen36-cw-iq4-32k');
    } finally {
      if (prev === undefined) delete process.env.EVAL_QWEN_MODEL;
      else process.env.EVAL_QWEN_MODEL = prev;
    }
  });

  it('labels gemma with the resolved GEMINI_MODEL so flash-lite is not printed as bare "gemma"', () => {
    const prev = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemini-3.1-flash-lite');
    } finally {
      if (prev === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prev;
    }
  });

  it('falls back to the default gemma model id when GEMINI_MODEL is unset', () => {
    const prev = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemma-4-31b-it');
    } finally {
      if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    }
  });
});

describe('parseFixtureFilename', () => {
  it('tags a fixture with the .silver segment as silver', () => {
    expect(parseFixtureFilename('foo-ch12.en.silver.labelled.json')).toEqual({
      slug: 'foo',
      chapterId: 12,
      lang: 'en',
      tier: 'silver',
    });
  });

  it('tags a fixture without the .silver segment as gold', () => {
    expect(parseFixtureFilename('foo-ch12.en.labelled.json')).toEqual({
      slug: 'foo',
      chapterId: 12,
      lang: 'en',
      tier: 'gold',
    });
  });

  it('tags the committed Coalfall guardrail as gold (no .silver segment)', () => {
    expect(parseFixtureFilename('coalfall-ch1.en.labelled.json')).toEqual({
      slug: 'coalfall',
      chapterId: 1,
      lang: 'en',
      tier: 'gold',
    });
  });

  it('returns null for a non-matching filename (e.g. a roster sidecar)', () => {
    expect(parseFixtureFilename('foo.roster.json')).toBeNull();
  });
});

describe('formatReviewLine', () => {
  const st = (n: number): Stat => ({ mean: n, min: n, max: n });
  const baseAgg = (overrides: Partial<ReviewAgg> = {}): ReviewAgg => ({
    charFinal: st(0.7),
    charReviewed: st(0.75),
    lineFinal: st(0.6),
    lineReviewed: st(0.65),
    helped: st(10),
    harmed: st(2),
    churn: st(3),
    predictedDropped: st(0),
    truthDropped: st(0),
    opsByClass: {},
    dump: [],
    ...overrides,
  });

  it('renders the char Δ, the line pair, and helped/harmed/churn at runs=1', () => {
    const line = formatReviewLine(baseAgg(), 1);
    expect(line).toContain('final(char) 70.0% → reviewed(char) 75.0%');
    expect(line).toContain('Δ +5.0pp');
    expect(line).toContain('line 60.0l%→65.0l%');
    expect(line).toContain('helped 10 harmed 2 churn 3');
  });

  it('omits the coverage-health warning when predictedDropped.mean is 0', () => {
    const line = formatReviewLine(baseAgg(), 1);
    expect(line).not.toContain('unlocated');
  });

  it('renders a negative Δ when the reviewed stage regresses', () => {
    const line = formatReviewLine(baseAgg({ charFinal: st(0.8), charReviewed: st(0.75) }), 1);
    expect(line).toContain('Δ -5.0pp');
  });

  it('shows a min–max range for the char stats when runs > 1', () => {
    const agg = baseAgg({ charFinal: { mean: 0.7, min: 0.65, max: 0.75 } });
    const line = formatReviewLine(agg, 3);
    expect(line).toContain('[65.0%–75.0%]');
  });

  it('adds the coverage-health warning when predictedDropped.mean > 0', () => {
    const agg = baseAgg({ predictedDropped: st(4) });
    const line = formatReviewLine(agg, 1);
    expect(line).toContain('4 predicted units unlocated — char coverage incomplete');
  });
});

describe('partitionByTier', () => {
  it('splits gold (incl. the Coalfall guardrail) from silver, preserving relative order', () => {
    const gold1 = { fixture: 'a', tier: 'gold' } as unknown as ScoredFixture;
    const coalfall = { fixture: 'coalfall-ch1.en.labelled.json', tier: 'gold' } as unknown as ScoredFixture;
    const silver1 = { fixture: 'b', tier: 'silver' } as unknown as ScoredFixture;

    const { gold, silver } = partitionByTier([gold1, silver1, coalfall]);

    expect(gold.map((f) => f.fixture)).toEqual(['a', 'coalfall-ch1.en.labelled.json']);
    expect(silver.map((f) => f.fixture)).toEqual(['b']);
  });

  it('returns empty arrays for an empty fixture list', () => {
    expect(partitionByTier([])).toEqual({ gold: [], silver: [] });
  });
});
