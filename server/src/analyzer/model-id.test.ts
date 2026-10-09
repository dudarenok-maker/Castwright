import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  inferEngineFromModelId,
  parseEndpointModelId,
  endpointModelId,
  ENDPOINT_ID_PATTERN,
  type AnalysisEngine,
} from './model-id.js';

interface Case {
  id: string;
  engine: AnalysisEngine;
  endpointId?: string;
  model?: string;
}

/* Read, not imported: NodeNext would require an import attribute for JSON, and
   the frontend test imports the same file by relative path. */
const CASES: Case[] = JSON.parse(
  readFileSync(new URL('./__fixtures__/model-id-cases.json', import.meta.url), 'utf8'),
);

describe('model-id grammar — server (#3084 spec §3)', () => {
  it('the shared case table covers all three engines', () => {
    expect(new Set(CASES.map((c) => c.engine))).toEqual(new Set(['local', 'gemini', 'openai']));
  });

  it.each(CASES)('infers $engine for $id', (c) => {
    expect(inferEngineFromModelId(c.id)).toBe(c.engine);
  });

  it.each(CASES)('parses $id', (c) => {
    const parsed = parseEndpointModelId(c.id);
    if (c.engine === 'openai') expect(parsed).toEqual({ endpointId: c.endpointId, model: c.model });
    else expect(parsed).toBeNull();
  });

  it.each(
    CASES.filter(
      (c) => c.engine === 'openai' && ENDPOINT_ID_PATTERN.test(c.endpointId!) && c.model !== '',
    ),
  )('round-trips $id through endpointModelId', (c) => {
    expect(endpointModelId(c.endpointId!, c.model!)).toBe(c.id);
  });

  it('refuses to build an id with an invalid endpoint id or an empty model', () => {
    expect(() => endpointModelId('Lab', 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('lab_1', 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('a'.repeat(41), 'm')).toThrow(/Invalid endpoint id/);
    expect(() => endpointModelId('lab', '')).toThrow(/non-empty model/);
  });
});
