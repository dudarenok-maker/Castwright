import { describe, it, expect } from 'vitest';
import cases from '../../server/src/analyzer/__fixtures__/model-id-cases.json';
import {
  engineForModelId,
  parseEndpointModelId,
  endpointModelId,
  type AnalysisEngine,
} from './model-id';
import * as server from '../../server/src/analyzer/model-id';

interface Case {
  id: string;
  engine: AnalysisEngine;
  endpointId?: string;
  model?: string;
}
const CASES = cases as Case[];

describe('model-id grammar — frontend (shared case table with the server)', () => {
  it.each(CASES)('infers $engine for $id', (c) => {
    expect(engineForModelId(c.id)).toBe(c.engine);
  });

  it.each(CASES)('parses $id', (c) => {
    const parsed = parseEndpointModelId(c.id);
    if (c.engine === 'openai') expect(parsed).toEqual({ endpointId: c.endpointId, model: c.model });
    else expect(parsed).toBeNull();
  });

  it('agrees with the server implementation on every table id and its near-misses', () => {
    const probes = CASES.flatMap((c) => [c.id, `${c.id}:`, `x${c.id}`, c.id.toUpperCase(), c.id.replace('::', ':')]);
    for (const id of probes) {
      expect(engineForModelId(id), id).toBe(server.inferEngineFromModelId(id));
      expect(parseEndpointModelId(id), id).toEqual(server.parseEndpointModelId(id));
    }
  });

  it('builds the same endpoint id as the server', () => {
    expect(endpointModelId('lab', 'qwen3:30b')).toBe(server.endpointModelId('lab', 'qwen3:30b'));
    expect(() => endpointModelId('Lab', 'm')).toThrow(/Invalid endpoint id/);
  });
});

import { analyzerEngineName } from './model-id';

describe('analyzerEngineName', () => {
  it('names each engine, defaulting an unknown tag to Ollama as the popover always has', () => {
    expect(analyzerEngineName('gemini')).toBe('Gemini');
    expect(analyzerEngineName('openai')).toBe('Endpoint');
    expect(analyzerEngineName('local')).toBe('Ollama');
    expect(analyzerEngineName(undefined)).toBe('Ollama');
  });
});
