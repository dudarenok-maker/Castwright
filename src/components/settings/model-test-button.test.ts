import { describe, it, expect } from 'vitest';
import { describeTestOutcome } from './model-test-button';
import type { AnalyzerCatalogEntry } from '../../lib/types';

function entry(overrides: Partial<AnalyzerCatalogEntry['structuredOutput']>): AnalyzerCatalogEntry {
  return {
    id: 'qwen3.5:4b',
    label: 'qwen3.5:4b',
    capability: { serverUrl: 'http://localhost:11434', testedAt: '2026-10-09T00:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: {} },
    engine: 'local',
    model: 'qwen3.5:4b',
    structuredOutput: { mode: 'schema', dropped: [], label: 'schema', ...overrides },
    testPlan: { configured: 2, all: 3, attempts: 1 },
  };
}

describe('describeTestOutcome (#3084 W3c)', () => {
  it('returns null with no recorded capability', () => {
    const e = entry({});
    delete (e as { capability?: unknown }).capability;
    expect(describeTestOutcome(e)).toBeNull();
  });

  it('shows the catalog label for a passing outcome', () => {
    expect(describeTestOutcome(entry({ outcome: 'enforced' }))).toBe('schema · tested 2026-10-09');
  });

  it('names the rejection explicitly instead of reusing the label — reverting to `entry.structuredOutput.label` reddens this (the label is plain "schema" for a rejected mode too, P7)', () => {
    expect(describeTestOutcome(entry({ outcome: 'rejected' }))).toBe('schema · rejected · tested 2026-10-09');
  });

  it('names the rejection for a non-schema mode too', () => {
    expect(describeTestOutcome(entry({ mode: 'json', label: 'json', outcome: 'rejected' }))).toBe('json · rejected · tested 2026-10-09');
  });

  it('shows the not-enforced label for an ignored outcome, not a bare pass', () => {
    expect(describeTestOutcome(entry({ outcome: 'ignored', label: 'schema (not enforced)' }))).toBe('schema (not enforced) · tested 2026-10-09');
  });

  it('shows the plain mode for an accepted outcome', () => {
    expect(describeTestOutcome(entry({ mode: 'json', label: 'json', outcome: 'accepted' }))).toBe('json · tested 2026-10-09');
  });

  it('does not claim a mode was tested when the record has no outcome for it — reverting to `${label} · tested` reddens this', () => {
    expect(describeTestOutcome(entry({ mode: 'json', label: 'json' }))).toBe('json · not tested in this mode · last test 2026-10-09');
  });
});
