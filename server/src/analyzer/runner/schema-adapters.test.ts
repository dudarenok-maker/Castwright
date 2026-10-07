import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  adaptSchemaForGemini,
  adaptSchemaForOllama,
  adaptSchemaForOpenAI,
  buildStructuredOutputRequest,
  structuredOutputLabel,
  structuredOutputSchemaName,
} from './schema-adapters.js';
import {
  stage1GrammarSchema,
  stage1ChapterGrammarSchema,
  stage2ChapterSchema,
  emotionAnnotationSchema,
  nonStoryClassificationSchema,
  scriptReviewSchema,
  stage3ChapterSchema,
  escalationSchema,
} from '../../handoff/schemas.js';
import type { ModelCapabilityRecord } from '../capabilities.js';

const draft07 = (s: z.ZodType<unknown>) =>
  z.toJSONSchema(s, { target: 'draft-07', reused: 'inline' }) as Record<string, unknown>;

/* The grammar schema each stage sends today (research 03-code-map §2). */
const STAGE_SCHEMAS = {
  stage1: stage1GrammarSchema,
  stage1Chapter: stage1ChapterGrammarSchema,
  stage2Chapter: stage2ChapterSchema,
  emotion: emotionAnnotationSchema,
  nonStory: nonStoryClassificationSchema,
  scriptReview: scriptReviewSchema,
  stage3Chapter: stage3ChapterSchema,
  escalation: escalationSchema,
} as const;

const ADAPTERS = {
  ollama: adaptSchemaForOllama,
  gemini: adaptSchemaForGemini,
  openai: adaptSchemaForOpenAI,
} as const;

describe('dropped keywords per stage schema per provider (snapshot, #3084 spec Testing)', () => {
  for (const [provider, adapt] of Object.entries(ADAPTERS)) {
    for (const [stage, schema] of Object.entries(STAGE_SCHEMAS)) {
      it(`${provider} / ${stage}`, () => {
        expect(adapt(draft07(schema)).dropped).toMatchSnapshot();
      });
    }
  }
});

describe('adaptSchemaForGemini', () => {
  const input = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['name', 'id', 'score', 'items'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^x' },
      id: { type: 'integer', exclusiveMinimum: 0, minimum: -9007199254740991 },
      half: { type: 'integer', exclusiveMinimum: 0.5 },
      score: { type: 'number', exclusiveMinimum: 0 },
      minLength: { type: 'string', description: 'a property literally named minLength' },
      items: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string', minLength: 2 }, { type: 'null' }] } },
    },
  };

  it('removes $schema without recording it as a dropped constraint', () => {
    const out = adaptSchemaForGemini(input);
    expect(out.schema).not.toHaveProperty('$schema');
    expect(out.dropped).not.toContain('$schema');
  });

  it('drops unsupported keywords and records each path', () => {
    const out = adaptSchemaForGemini(input);
    expect(out.dropped).toEqual(
      expect.arrayContaining([
        'properties.name.minLength',
        'properties.name.maxLength',
        'properties.name.pattern',
        'properties.score.exclusiveMinimum',
        'properties.items.items.anyOf[0].minLength',
      ]),
    );
    expect((out.schema.properties as Record<string, Record<string, unknown>>).name).toEqual({ type: 'string' });
  });

  it('turns an integer exclusiveMinimum into minimum floor(n)+1, keeping the tighter bound', () => {
    const props = adaptSchemaForGemini(input).schema.properties as Record<string, Record<string, unknown>>;
    expect(props.id).toEqual({ type: 'integer', minimum: 1 });
    expect(props.half).toEqual({ type: 'integer', minimum: 1 });
  });

  it('treats property names as names, not keywords', () => {
    const props = adaptSchemaForGemini(input).schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty('minLength');
  });

  it('does not mutate its input', () => {
    const copy = structuredClone(input);
    adaptSchemaForGemini(input);
    expect(input).toEqual(copy);
  });
});

describe('adaptSchemaForOpenAI and adaptSchemaForOllama', () => {
  const input = { $schema: 'x', type: 'object', properties: { a: { type: 'string', minLength: 1 } } };
  it('OpenAI removes $schema only and records nothing', () => {
    expect(adaptSchemaForOpenAI(input)).toEqual({
      schema: { type: 'object', properties: { a: { type: 'string', minLength: 1 } } },
      dropped: [],
    });
  });
  it('Ollama is the identity (today\'s `format` payload)', () => {
    expect(adaptSchemaForOllama(input)).toEqual({ schema: input, dropped: [] });
  });
});

describe('buildStructuredOutputRequest', () => {
  const adapt = (s: Record<string, unknown>) => ({ schema: { ...s, adapted: true }, dropped: ['p.minLength'] });
  it('json and off never call the adapter', () => {
    expect(buildStructuredOutputRequest('json', 'n', { type: 'object' }, () => { throw new Error('called'); })).toEqual({
      request: { mode: 'json' },
      dropped: [],
    });
    expect(buildStructuredOutputRequest('off', 'n', { type: 'object' }, () => { throw new Error('called'); })).toEqual({
      request: { mode: 'off' },
      dropped: [],
    });
  });
  it('schema sends the adapted schema and reports what was dropped', () => {
    expect(buildStructuredOutputRequest('schema', 'n', { type: 'object' }, adapt)).toEqual({
      request: { mode: 'schema', name: 'n', schema: { type: 'object', adapted: true } },
      dropped: ['p.minLength'],
    });
  });
  it('schema names satisfy the OpenAI json_schema name rule', () => {
    expect(structuredOutputSchemaName('escalation-ch3-w2')).toBe('castwright_escalation-ch3-w2');
    expect(structuredOutputSchemaName('1-ch12')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('structuredOutputLabel', () => {
  const record = (outcome: 'enforced' | 'ignored'): ModelCapabilityRecord => ({
    serverUrl: 'http://h',
    testedAt: '2026-09-11T00:00:00.000Z',
    control: { ok: true },
    structuredOutput: { schema: { configured: outcome } },
    reasoning: {},
  });
  it('states only what was observed', () => {
    expect(structuredOutputLabel('json', [], undefined, 'configured')).toBe('json');
    expect(structuredOutputLabel('off', ['x'], undefined, 'configured')).toBe('off');
    expect(structuredOutputLabel('schema', [], undefined, 'configured')).toBe('schema');
    expect(structuredOutputLabel('schema', ['properties.a.minLength'], undefined, 'configured')).toBe('schema (partial)');
    expect(structuredOutputLabel('schema', [], record('enforced'), 'configured')).toBe('schema');
    expect(structuredOutputLabel('schema', ['x'], record('ignored'), 'configured')).toBe('schema (not enforced)');
    expect(structuredOutputLabel('schema', [], record('ignored'), 'high')).toBe('schema');
  });
});
