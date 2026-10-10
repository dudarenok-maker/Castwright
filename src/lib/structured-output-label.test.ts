import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/structured-output-label-cases.json';
import { structuredOutputLabel } from './structured-output-label';
import type { ModelCapabilityRecord, StructuredOutputMode } from './types';

type LabelCase = { mode: StructuredOutputMode; dropped: string[]; outcome: 'enforced' | 'ignored' | 'rejected' | null; expected: string };

describe('structuredOutputLabel frontend twin (#3084) — same table as the server', () => {
  it.each(cases as LabelCase[])('$mode dropped=$dropped outcome=$outcome → $expected', (c) => {
    const record: ModelCapabilityRecord | undefined =
      c.outcome === null
        ? undefined
        : { serverUrl: 'x', testedAt: '2026-09-11T00:00:00.000Z', control: { ok: true }, structuredOutput: { [c.mode]: { 'model-default': c.outcome } }, reasoning: {} };
    expect(structuredOutputLabel(c.mode, c.dropped, record, 'model-default')).toBe(c.expected);
  });
});
