/* #3084 — one case table for structuredOutputLabel, shared with the frontend twin
   (src/lib/structured-output-label.ts, Task 3c.6). `expected` is captured from 3b's
   server function with CAPTURE_LABELS=1, never written by hand. The record is filed under
   `model-default`, the level an endpoint or Gemini request is sent at (P7). */
import { describe, it, expect } from 'vitest';
import cases from './__fixtures__/structured-output-label-cases.json' with { type: 'json' };
import { structuredOutputLabel } from './runner/schema-adapters.js';
import type { ModelCapabilityRecord } from './capabilities.js';
import type { StructuredOutputMode } from './runner/transport.js';

type LabelCase = {
  mode: StructuredOutputMode;
  dropped: string[];
  outcome: 'enforced' | 'ignored' | 'rejected' | null;
  expected?: string;
};

const LEVEL = 'model-default';

function recordFor(c: LabelCase): ModelCapabilityRecord | undefined {
  if (c.outcome === null) return undefined;
  return {
    serverUrl: 'http://127.0.0.1:8080/v1',
    testedAt: '2026-09-11T00:00:00.000Z',
    control: { ok: true },
    structuredOutput: { [c.mode]: { [LEVEL]: c.outcome } },
    reasoning: {},
  };
}

describe('structuredOutputLabel case table (#3084)', () => {
  it.runIf(process.env.CAPTURE_LABELS === '1')('prints the expected column (capture only)', () => {
    const out = (cases as LabelCase[]).map(({ expected: _e, ...c }) => ({
      ...c,
      expected: structuredOutputLabel(c.mode, c.dropped, recordFor(c), LEVEL),
    }));
    console.log(JSON.stringify(out, null, 2));
  });

  it.each(cases as LabelCase[])('$mode dropped=$dropped outcome=$outcome', (c) => {
    expect(c.expected, 'run the capture step and paste the expected column').toBeTypeOf('string');
    expect(structuredOutputLabel(c.mode, c.dropped, recordFor(c), LEVEL)).toBe(c.expected);
  });
});
