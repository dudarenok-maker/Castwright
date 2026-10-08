import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  STAGE_GRAMMAR_SCHEMAS,
  draft07,
  largestStageSchema,
  withMarker,
  MARKER_KEY,
  classifyMarkerProbe,
  capabilityRecordFor,
  assertConfiguredCapabilitiesAllowed,
  plannedTestRequestCount,
  defaultReasoningKey,
  ALL_STRUCTURED_OUTPUT_MODES,
  type ModelCapabilityRecord,
} from './capabilities.js';
import { AnalyzerCapabilityRejectedError } from './errors.js';
import { DEFAULT_USER_SETTINGS, modelCapabilityRecordSchema } from '../workspace/user-settings.js';

const record = (over: Partial<ModelCapabilityRecord> = {}): ModelCapabilityRecord => ({
  serverUrl: 'http://127.0.0.1:8080/v1',
  testedAt: '2026-09-11T10:00:00.000Z',
  control: { ok: true },
  structuredOutput: { schema: { 'model-default': 'rejected' } },
  reasoning: {},
  ...over,
});

describe('probe schema', () => {
  it('largestStageSchema is the stage grammar with the longest serialised draft-07 JSON', () => {
    const sizes = STAGE_GRAMMAR_SCHEMAS.map(({ name, schema }) => ({
      name,
      chars: JSON.stringify(draft07(schema)).length,
    }));
    console.info('[capabilities] stage schema sizes', JSON.stringify(sizes)); // paste into the PR body
    const max = sizes.reduce((a, b) => (b.chars > a.chars ? b : a));
    expect(largestStageSchema().name).toBe(max.name);
    expect(JSON.stringify(largestStageSchema().schema).length).toBe(max.chars);
  });

  it('covers exactly the eight grammar schemas the stage runner sends', () => {
    expect(STAGE_GRAMMAR_SCHEMAS.map((s) => s.name).sort()).toEqual([
      'emotionAnnotationSchema',
      'escalationSchema',
      'nonStoryClassificationSchema',
      'scriptReviewSchema',
      'stage1ChapterGrammarSchema',
      'stage1GrammarSchema',
      'stage2ChapterSchema',
      'stage3ChapterSchema',
    ]);
  });

  it('withMarker adds one required single-value enum property and leaves the rest intact', () => {
    const base = draft07(z.object({ a: z.string() }));
    const out = withMarker(base, 'mk-abc');
    const props = out.properties as Record<string, unknown>;
    expect(props[MARKER_KEY]).toEqual({ type: 'string', enum: ['mk-abc'] });
    expect(out.required).toEqual(['a', MARKER_KEY]);
    expect(props.a).toEqual((base.properties as Record<string, unknown>).a);
  });
});

describe('classifyMarkerProbe — the runner extraction and repair chain before the marker check', () => {
  it('enforced only when the marker key carries the exact value', () => {
    expect(classifyMarkerProbe(`{"${MARKER_KEY}":"mk-1","characters":[]}`, 'mk-1')).toBe('enforced');
    expect(classifyMarkerProbe(`<think>hm</think>\n\`\`\`json\n{"${MARKER_KEY}":"mk-1"}\n\`\`\``, 'mk-1')).toBe('enforced');
    expect(classifyMarkerProbe('{"characters":[]}', 'mk-1')).toBe('ignored');
    expect(classifyMarkerProbe(`{"${MARKER_KEY}":"mk-2"}`, 'mk-1')).toBe('ignored');
    expect(classifyMarkerProbe('not json', 'mk-1')).toBe('ignored');
  });

  it('JSON followed by trailing prose is still enforced (trimTrailingProse, as a run would accept it)', () => {
    expect(
      classifyMarkerProbe(`{"${MARKER_KEY}":"mk-1","characters":[]}\n\nI filled every required field with a placeholder.`, 'mk-1'),
    ).toBe('enforced');
  });

  it('a missing comma between two properties is still enforced (repairStructuralPunctuation)', () => {
    expect(classifyMarkerProbe(`{"note":"x" "${MARKER_KEY}":"mk-1"}`, 'mk-1')).toBe('enforced');
  });

  it('JSON after a reasoning prefix that is not a <think> block is still enforced', () => {
    expect(
      classifyMarkerProbe(
        `Thinking Process:\n1. The response format requires an object.\n2. Use placeholders.\n\n{"${MARKER_KEY}":"mk-1","characters":[]}`,
        'mk-1',
      ),
    ).toBe('enforced');
    expect(classifyMarkerProbe(`[THINK]plan the object[/THINK]{"${MARKER_KEY}":"mk-1"} Done.`, 'mk-1')).toBe('enforced');
  });
});

describe('defaultReasoningKey (P7: records are keyed by the level actually sent)', () => {
  it('Ollama sends think:false → off; Gemini and endpoints send no reasoning field → model-default', () => {
    expect(defaultReasoningKey('ollama')).toBe('off');
    expect(defaultReasoningKey('gemini')).toBe('model-default');
    expect(defaultReasoningKey('openai')).toBe('model-default');
  });
});

describe('capabilityRecordFor', () => {
  it('returns the record while the server URL matches (trailing slash tolerated)', () => {
    const settings = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'openai:lab::m': record() } };
    expect(capabilityRecordFor(settings, 'openai:lab::m', 'http://127.0.0.1:8080/v1/')).toEqual(record());
  });

  it('discards the record after the base URL changes', () => {
    const settings = { ...DEFAULT_USER_SETTINGS, analyzerCapabilitiesByModel: { 'openai:lab::m': record() } };
    expect(capabilityRecordFor(settings, 'openai:lab::m', 'http://10.0.0.5:8080/v1')).toBeUndefined();
  });

  it('A3 — discards a record whose digest differs from the installed model, keeps it when they match or either is unknown', () => {
    const url = 'http://localhost:11434';
    const stamped = record({ serverUrl: url, digest: 'sha256:old' });
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      analyzerCapabilitiesByModel: { 'qwen3.5:4b': stamped, 'mistral:7b': record({ serverUrl: url }) },
    };
    expect(capabilityRecordFor(settings, 'qwen3.5:4b', url, 'sha256:new')).toBeUndefined();
    expect(capabilityRecordFor(settings, 'qwen3.5:4b', url, 'sha256:old')).toEqual(stamped);
    expect(capabilityRecordFor(settings, 'qwen3.5:4b', url)).toEqual(stamped); // installed digest unknown → kept
    expect(capabilityRecordFor(settings, 'mistral:7b', url, 'sha256:new')).toEqual(record({ serverUrl: url })); // unstamped → kept
  });

  it('A3 — modelCapabilityRecordSchema accepts and keeps digest', () => {
    expect(modelCapabilityRecordSchema.parse(record({ digest: 'sha256:abc' })).digest).toBe('sha256:abc');
  });
});

describe('assertConfiguredCapabilitiesAllowed', () => {
  it('throws AnalyzerCapabilityRejectedError naming the setting and test date for a mode rejected at the level the run sends', () => {
    let caught: unknown;
    try {
      assertConfiguredCapabilitiesAllowed(record(), { structuredOutput: 'schema', reasoning: 'model-default' }, 'openai:lab::m');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AnalyzerCapabilityRejectedError);
    expect(caught).toMatchObject({
      modelId: 'openai:lab::m',
      setting: 'structuredOutput',
      value: 'schema',
      testedAt: '2026-09-11T10:00:00.000Z',
    });
  });

  it('allows a mode the record did not reject, a missing record, and a record whose control failed', () => {
    expect(() =>
      assertConfiguredCapabilitiesAllowed(record(), { structuredOutput: 'json', reasoning: 'model-default' }, 'm'),
    ).not.toThrow();
    expect(() =>
      assertConfiguredCapabilitiesAllowed(undefined, { structuredOutput: 'schema', reasoning: 'model-default' }, 'm'),
    ).not.toThrow();
    expect(() =>
      assertConfiguredCapabilitiesAllowed(
        record({ control: { ok: false, error: 'boom' } }),
        { structuredOutput: 'schema', reasoning: 'model-default' },
        'm',
      ),
    ).not.toThrow();
  });

  it('a rejection recorded at another reasoning level does not refuse the run (P7)', () => {
    expect(() =>
      assertConfiguredCapabilitiesAllowed(
        record({ structuredOutput: { schema: { high: 'rejected' } } }),
        { structuredOutput: 'schema', reasoning: 'model-default' },
        'm',
      ),
    ).not.toThrow();
  });

  it('throws for a rejected configured reasoning level', () => {
    expect(() =>
      assertConfiguredCapabilitiesAllowed(
        record({ structuredOutput: {}, reasoning: { high: 'rejected' } }),
        { structuredOutput: 'schema', reasoning: 'high' },
        'm',
      ),
    ).toThrow(AnalyzerCapabilityRejectedError);
  });
});

describe('plannedTestRequestCount', () => {
  const deps = { configuredMode: 'schema' as const, offeredModes: ALL_STRUCTURED_OUTPUT_MODES };
  it('configured = control + one mode step; all = control + the schema and json steps (the off step is the control)', () => {
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, deps)).toBe(2);
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'all' }, deps)).toBe(3);
  });
  it('a configured off mode sends only the control request', () => {
    expect(plannedTestRequestCount({ modelId: 'm', scope: 'configured' }, { ...deps, configuredMode: 'off' })).toBe(1);
  });
});
