import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  stage1Schema,
  stage2Schema,
  characterSchema,
  sentenceSchema,
  emotionAnnotationSchema,
  EMOTIONS,
} from './schemas.js';

/* The Ollama analyzer (server/src/analyzer/ollama.ts) feeds these per-stage
   schemas through `z.toJSONSchema(schema, { target: 'draft-07', reused: 'inline' })`
   and hands the result to Ollama 0.5+ as the `format` for constrained decoding.
   The model literally cannot emit JSON that violates the schema, so the exact
   JSON-Schema shape is a load-bearing contract — these tests pin it across the
   Zod 3 → 4 bump (Zod 4's native z.toJSONSchema replaced zod-to-json-schema).
   Keep the options in sync with ollama.ts. */
const JSON_SCHEMA_OPTS = { target: 'draft-07', reused: 'inline' } as const;

/** Recursively collect every key name appearing anywhere in a JSON value. */
function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, acc);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

describe('handoff schemas → Ollama structured-output JSON Schema', () => {
  it('stage1: strict objects → additionalProperties:false, .min(1) → minItems:1', () => {
    const json = z.toJSONSchema(stage1Schema, JSON_SCHEMA_OPTS) as Record<string, any>;
    // Top-level object is strict.
    expect(json.additionalProperties).toBe(false);
    // characters: z.array(characterSchema).min(1)
    expect(json.properties.characters.type).toBe('array');
    expect(json.properties.characters.minItems).toBe(1);
    // Each character object is strict too (nested .strict()).
    expect(json.properties.characters.items.additionalProperties).toBe(false);
  });

  it('stage2: sentences array carries minItems:1 and strict items', () => {
    const json = z.toJSONSchema(stage2Schema, JSON_SCHEMA_OPTS) as Record<string, any>;
    expect(json.properties.sentences.minItems).toBe(1);
    expect(json.properties.sentences.items.additionalProperties).toBe(false);
  });

  it('is fully inlined — no $ref / $defs that Ollama would have to resolve', () => {
    for (const schema of [stage1Schema, stage2Schema, characterSchema]) {
      const keys = allKeys(z.toJSONSchema(schema, JSON_SCHEMA_OPTS));
      expect(keys.has('$ref')).toBe(false);
      expect(keys.has('$defs')).toBe(false);
      expect(keys.has('definitions')).toBe(false);
    }
  });
});

describe('fs-25 — sentence emotion (Phase-1 inline, 4a)', () => {
  const base = { id: 1, chapterId: 1, characterId: 'narrator', text: 'hello' };

  it('exposes the fixed emotion enum', () => {
    expect([...EMOTIONS]).toEqual(['neutral', 'whisper', 'angry', 'excited', 'sad']);
  });

  it('accepts a valid emotion', () => {
    expect(sentenceSchema.parse({ ...base, emotion: 'angry' }).emotion).toBe('angry');
  });

  it('accepts a sentence with no emotion (back-compat)', () => {
    expect(sentenceSchema.parse(base).emotion).toBeUndefined();
  });

  it('rejects an out-of-enum emotion', () => {
    expect(sentenceSchema.safeParse({ ...base, emotion: 'furious' }).success).toBe(false);
  });

  it('carries emotion into the Ollama JSON schema as an enum', () => {
    const json = z.toJSONSchema(stage2Schema, JSON_SCHEMA_OPTS) as Record<string, any>;
    expect(json.properties.sentences.items.properties.emotion.enum).toEqual([
      'neutral',
      'whisper',
      'angry',
      'excited',
      'sad',
    ]);
  });
});

describe('fs-33 — emotion-only annotation schema', () => {
  it('accepts an annotations array of {sentenceId, emotion}', () => {
    const parsed = emotionAnnotationSchema.parse({
      annotations: [
        { sentenceId: 3, emotion: 'angry' },
        { sentenceId: 7, emotion: 'whisper' },
      ],
    });
    expect(parsed.annotations).toHaveLength(2);
    expect(parsed.annotations[0]).toEqual({ sentenceId: 3, emotion: 'angry' });
  });

  it('accepts an empty annotations array (a chapter the model left all-neutral)', () => {
    expect(emotionAnnotationSchema.parse({ annotations: [] }).annotations).toEqual([]);
  });

  it('rejects a re-attribution attempt — characterId is not allowed (strict)', () => {
    expect(
      emotionAnnotationSchema.safeParse({
        annotations: [{ sentenceId: 1, emotion: 'sad', characterId: 'wren' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an out-of-enum emotion', () => {
    expect(
      emotionAnnotationSchema.safeParse({ annotations: [{ sentenceId: 1, emotion: 'furious' }] })
        .success,
    ).toBe(false);
  });

  it('rejects a non-positive / non-integer sentenceId', () => {
    expect(
      emotionAnnotationSchema.safeParse({ annotations: [{ sentenceId: 0, emotion: 'sad' }] })
        .success,
    ).toBe(false);
    expect(
      emotionAnnotationSchema.safeParse({ annotations: [{ sentenceId: 1.5, emotion: 'sad' }] })
        .success,
    ).toBe(false);
  });
});
