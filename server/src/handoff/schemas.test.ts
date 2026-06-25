import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  stage1Schema,
  stage2Schema,
  characterSchema,
  stage1ChapterSchema,
  sentenceSchema,
  emotionAnnotationSchema,
  EMOTIONS,
  analyzerCharacterSchema,
  stage1ChapterGrammarSchema,
  stage1GrammarSchema,
  scriptReviewSchema,
  ScriptReviewOp,
  ScriptReviewOutput,
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

describe('analyzer grammar schemas — required tone (Task 6)', () => {
  const charWithoutTone = { id: 'a', name: 'Alice', role: 'protagonist', color: '#abc' };
  const charWithTone = {
    ...charWithoutTone,
    tone: { warmth: 50, pace: 60, authority: 70, emotion: 40 },
  };

  it('analyzerCharacterSchema rejects a character with NO tone (grammar strict)', () => {
    expect(analyzerCharacterSchema.safeParse(charWithoutTone).success).toBe(false);
  });

  it('characterSchema still accepts a character with NO tone (validation tolerant)', () => {
    expect(characterSchema.safeParse(charWithoutTone).success).toBe(true);
  });

  it('analyzerCharacterSchema accepts a character with all four tone axes', () => {
    expect(analyzerCharacterSchema.safeParse(charWithTone).success).toBe(true);
  });

  it('stage1ChapterGrammarSchema JSON-schema marks tone required on character and axes required on tone', () => {
    const json = z.toJSONSchema(stage1ChapterGrammarSchema, {
      target: 'draft-07',
      reused: 'inline',
    }) as Record<string, unknown>;

    // Walk: properties.characters.items → character item schema
    const props = json['properties'] as Record<string, unknown>;
    const charArraySchema = props['characters'] as Record<string, unknown>;
    const charItemSchema = charArraySchema['items'] as Record<string, unknown>;

    // tone must appear in the character's required array
    const charRequired = charItemSchema['required'] as string[];
    expect(Array.isArray(charRequired)).toBe(true);
    expect(charRequired).toContain('tone');

    // tone's own JSON schema must list all four axes in its required array
    const charItemProps = charItemSchema['properties'] as Record<string, unknown>;
    const toneJsonSchema = charItemProps['tone'] as Record<string, unknown>;
    const toneRequired = toneJsonSchema['required'] as string[];
    expect(Array.isArray(toneRequired)).toBe(true);
    expect(toneRequired).toContain('warmth');
    expect(toneRequired).toContain('pace');
    expect(toneRequired).toContain('authority');
    expect(toneRequired).toContain('emotion');
  });

  it('stage1GrammarSchema rejects a character with no tone', () => {
    const result = stage1GrammarSchema.safeParse({
      characters: [charWithoutTone],
      chapters: [{ id: 1, title: 'Chapter 1' }],
    });
    expect(result.success).toBe(false);
  });

  it('stage1ChapterSchema (validation) still accepts characters with no tone', () => {
    expect(stage1ChapterSchema.safeParse({ characters: [charWithoutTone] }).success).toBe(true);
  });
});

describe('fs-58 — script review schema (flat envelope)', () => {
  it('parses a heterogeneous ops array with extract_dialogue including both anchor and anchorEnd', () => {
    const payload = {
      ops: [
        {
          id: 1,
          op: 'extract_dialogue',
          anchor: 'She said,',
          anchorEnd: 'goodbye"',
          rationale: 'Extracted dialogue from narration',
          confidence: 0.95,
        },
        {
          id: 2,
          op: 'strip_tag',
          newText: 'corrected text',
          rationale: 'Removed formatting tag',
          confidence: 0.88,
        },
        {
          id: 3,
          op: 'split',
          pieceCharacterIds: ['char-a', 'char-b'],
          rationale: 'Split sentence across speakers',
        },
        {
          id: 4,
          op: 'merge',
          mergeIds: [5, 6],
          rationale: 'Merged two related sentences',
        },
        {
          id: 5,
          op: 'fix_emotion',
          emotion: 'angry',
          rationale: 'Changed emotion for delivery',
          confidence: 0.92,
        },
      ],
    };

    const result = scriptReviewSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ops).toHaveLength(5);
      expect(result.data.ops[0].op).toBe('extract_dialogue');
      expect(result.data.ops[0].anchor).toBe('She said,');
      expect(result.data.ops[0].anchorEnd).toBe('goodbye"');
      expect(result.data.ops[4].emotion).toBe('angry');
    }
  });

  it('rejects an unknown op type', () => {
    const payload = {
      ops: [
        {
          id: 1,
          op: 'frobnicate',
          rationale: 'This op does not exist',
        },
      ],
    };

    const result = scriptReviewSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects an op with an unknown emotion value', () => {
    const payload = {
      ops: [
        {
          id: 1,
          op: 'fix_emotion',
          emotion: 'furious',
          rationale: 'Invalid emotion',
        },
      ],
    };

    const result = scriptReviewSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects strict violations — extra fields on op or root', () => {
    const payloadExtraOpField = {
      ops: [
        {
          id: 1,
          op: 'strip_tag',
          rationale: 'test',
          unknownField: 'should not be here',
        },
      ],
    };

    const payloadExtraRootField = {
      ops: [{ id: 1, op: 'strip_tag', rationale: 'test' }],
      unknownField: 'should not be here',
    };

    expect(scriptReviewSchema.safeParse(payloadExtraOpField).success).toBe(false);
    expect(scriptReviewSchema.safeParse(payloadExtraRootField).success).toBe(false);
  });

  it('accepts an empty ops array — a chapter with no suggestions', () => {
    const payload = { ops: [] };
    const result = scriptReviewSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ops).toEqual([]);
    }
  });

  it('types ScriptReviewOp and ScriptReviewOutput correctly', () => {
    const payload: ScriptReviewOutput = {
      ops: [
        {
          id: 1,
          op: 'extract_dialogue',
          anchor: 'text',
          anchorEnd: 'text2',
          rationale: 'reason',
        },
      ],
    };

    // This is a type-only check; if it compiles, the types are correct.
    // We can also access individual ops:
    const op: ScriptReviewOp = payload.ops[0];
    expect(op.op).toBe('extract_dialogue');
  });
});

describe('sentenceSchema excludeFromSynthesis (fs-58 Unit B)', () => {
  it('accepts a sentence carrying excludeFromSynthesis', () => {
    const r = sentenceSchema.safeParse({
      id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.', excludeFromSynthesis: true,
    });
    expect(r.success).toBe(true);
  });
  it('still accepts a sentence WITHOUT the field (additive)', () => {
    const r = sentenceSchema.safeParse({ id: 1, chapterId: 1, characterId: 'narrator', text: 'A line.' });
    expect(r.success).toBe(true);
  });
});

describe('scriptReviewSchema reattribute + flag_nonstory (fs-58 Unit B)', () => {
  const wrap = (op: object) => scriptReviewSchema.safeParse({ ops: [op] });

  it('accepts on-roster reattribute (characterId only)', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'said Ferra', characterId: 'ferra', rationale: 'wrong speaker' }).success).toBe(true);
  });
  it('accepts off-roster reattribute (proposed only)', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'said Ferra', proposed: { name: 'Ferra', gender: 'female' }, rationale: 'uncast' }).success).toBe(true);
  });
  it('rejects reattribute with BOTH characterId and proposed', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'x', characterId: 'ferra', proposed: { name: 'Ferra' }, rationale: 'r' }).success).toBe(false);
  });
  it('rejects reattribute with NEITHER characterId nor proposed', () => {
    expect(wrap({ id: 3, op: 'reattribute', anchor: 'x', rationale: 'r' }).success).toBe(false);
  });
  it('accepts flag_nonstory', () => {
    expect(wrap({ id: 9, op: 'flag_nonstory', anchor: 'p. 42', rationale: 'page number' }).success).toBe(true);
  });
  it('still rejects an unknown op', () => {
    expect(wrap({ id: 1, op: 'rewrite_everything', rationale: 'r' }).success).toBe(false);
  });
});

describe('sentenceSchema fs-57 fields', () => {
  const base = { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' };

  it('parses without instruct/vocalization (pre-fs-57 analysis)', () => {
    expect(sentenceSchema.parse(base)).toMatchObject(base);
  });

  it('accepts optional instruct + vocalization', () => {
    const s = { ...base, text: 'Ah! Hello.', instruct: 'a short gasp', vocalization: true };
    expect(sentenceSchema.parse(s)).toMatchObject(s);
  });

  it('rejects a non-string instruct (string validator)', () => {
    expect(() => sentenceSchema.parse({ ...base, instruct: 5 })).toThrow();
  });
  it('still rejects unknown keys (.strict preserved)', () => {
    expect(() => sentenceSchema.parse({ ...base, bogus: 1 })).toThrow();
  });
});
