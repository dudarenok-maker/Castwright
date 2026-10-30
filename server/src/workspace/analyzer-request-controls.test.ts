import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  analyzerRequestControlsPatchSchema,
  analyzerRequestControlsPatchSchemaFor,
  changedRequestControls,
  withNormalizedOllamaReasoningKeys,
} from './analyzer-request-controls.js';
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';

const messages = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof z.ZodError) return e.issues.map((i) => i.message); throw e; }
  return [];
};

describe('analyzerRequestControlsPatchSchemaFor — Ollama reasoning, per model (P18)', () => {
  const withRecords = (records: Record<string, Partial<Record<string, 'accepted' | 'rejected'>>>) =>
    analyzerRequestControlsPatchSchemaFor({ ollamaRecord: (model) => (records[model] ? { reasoning: records[model] } : undefined) });
  it('accepts model-default, off and on for any Ollama model with no Test record', () => {
    for (const level of ['model-default', 'off', 'on'] as const) {
      expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': level } } }))).toEqual([]);
    }
  });
  it("refuses a named level without that model's accepted Test record, naming model and level", () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } }))).toEqual([
      'Ollama reasoning "low" for qwen3.5:4b needs a Test of that model that accepted it (offered now: model-default, off, on).',
    ]);
  });
  it("accepts a named level the model's own Test accepted, and refuses it for another model", () => {
    expect(
      messages(() => withRecords({ 'qwen3.5:4b': { low: 'accepted' } }).parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low', 'qwen3.5:9b': 'low' } } })),
    ).toEqual(['Ollama reasoning "low" for qwen3.5:9b needs a Test of that model that accepted it (offered now: model-default, off, on).']);
  });
  it('refuses Ollama levels that only endpoints have, and endpoint model ids as keys', () => {
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'none', 'openai:lab::m': 'off' } } })),
    ).toEqual([
      'Ollama reasoning "none" for qwen3.5:4b is not an Ollama level (model-default, off, on, low, medium, high).',
      'Ollama reasoning map key "openai:lab::m" is an endpoint model id; endpoints carry their own Reasoning setting.',
    ]);
  });
});

describe('analyzerRequestControlsPatchSchema — Gemini reasoning', () => {
  it('refuses a Gemini level the model does not offer, naming model and level', () => {
    /* F2 — a 3.x id for the accepted half (gemini-3.8-flash rejects minimal; gemini-3.6-flash's own
       'low' is offered, so it produces no message). */
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'low' } } })),
    ).toEqual(['Gemini reasoning "minimal" is not available for gemini-3.8-flash (offered: model-default, low, medium, high).']);
  });
  it('refuses a non-Gemini id in the Gemini map', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerReasoningByEngine: { gemini: { 'qwen3.5:4b': 'model-default' } } }))).toEqual([
      'Gemini reasoning map key "qwen3.5:4b" is not a Gemini model id.',
    ]);
  });
  it('ignores patches that do not touch the field', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ displayName: 'x' }))).toEqual([]);
  });
});

describe('changedRequestControls — judge only what a save changes (N6)', () => {
  const stored = { analyzerReasoningByEngine: { ollama: { qwen3: 'low', 'q:9b': 'on' }, gemini: { 'gemini-3.8-flash': 'minimal' } } };
  it('keeps only reasoning entries whose value differs from the stored settings, comparing Ollama tags through normalizeModelTag', () => {
    expect(
      changedRequestControls(
        {
          displayName: 'x',
          analyzerReasoningByEngine: {
            ollama: { 'qwen3:latest': 'low', 'q:9b': 'off' },
            gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'low' },
          },
        },
        stored,
      ),
    ).toEqual({ displayName: 'x', analyzerReasoningByEngine: { ollama: { 'q:9b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } } });
  });
  it('returns a patch without reasoning maps as the same object', () => {
    const patch = { displayName: 'x' };
    expect(changedRequestControls(patch, stored)).toBe(patch);
  });
  it('an unchanged stale entry no longer blocks the rules; the same entry, changed, still does', () => {
    const body = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' }, gemini: { 'gemini-3.6-flash': 'low' } } };
    const staleStored = { analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } };
    expect(messages(() => analyzerRequestControlsPatchSchema.parse(changedRequestControls(body, staleStored)))).toEqual([]);
    expect(messages(() => analyzerRequestControlsPatchSchema.parse(changedRequestControls(body, {})))).toEqual([
      'Ollama reasoning "low" for qwen3.5:4b needs a Test of that model that accepted it (offered now: model-default, off, on).',
    ]);
  });
});

describe('withNormalizedOllamaReasoningKeys — one stored key per Ollama model (N7)', () => {
  it('rewrites Ollama reasoning keys through normalizeModelTag and leaves everything else as sent', () => {
    expect(
      withNormalizedOllamaReasoningKeys({
        displayName: 'x',
        analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on', 'q:4b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } },
      }),
    ).toEqual({ displayName: 'x', analyzerReasoningByEngine: { ollama: { qwen3: 'on', 'q:4b': 'off' }, gemini: { 'gemini-3.6-flash': 'low' } } });
    const patch = { displayName: 'x' };
    expect(withNormalizedOllamaReasoningKeys(patch)).toBe(patch);
  });
});

describe('stored schema stays lenient', () => {
  it('loads a stored level the rules no longer offer, or one this version does not know (xhigh), without resetting settings (N10)', () => {
    const parsed = userSettingsSchema.safeParse({
      ...DEFAULT_USER_SETTINGS,
      displayName: 'Kept',
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'high' }, gemini: { 'gemini-3.8-flash': 'minimal', 'gemini-3.6-flash': 'xhigh' } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.displayName).toBe('Kept');
    expect(parsed.success && parsed.data.analyzerReasoningByEngine.gemini?.['gemini-3.6-flash']).toBe('xhigh');
  });
  it('defaults to an empty map', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerReasoningByEngine).toEqual({});
  });
});

describe('analyzerRequestControlsPatchSchema — custom payload', () => {
  it('prefixes each validation error with the engine', () => {
    expect(
      messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerExtraParamsByEngine: { ollama: { options: { num_ctx: 8192 } }, gemini: { topK: 4 } } })),
    ).toEqual([
      'Ollama custom parameters: These keys are controlled by Castwright and cannot be set here: options.num_ctx.',
      'Gemini custom parameters: "topK" is not a Gemini request field — put generation options inside "config".',
    ]);
  });
  it('accepts valid payloads', () => {
    expect(messages(() => analyzerRequestControlsPatchSchema.parse({ analyzerExtraParamsByEngine: { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } } }))).toEqual([]);
  });
});

describe('stored schema stays lenient for payloads', () => {
  it('loads a stored payload a newer protected-key list would refuse, and keeps it', () => {
    const parsed = userSettingsSchema.safeParse({ ...DEFAULT_USER_SETTINGS, analyzerExtraParamsByEngine: { ollama: { think: true } } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.analyzerExtraParamsByEngine.ollama).toEqual({ think: true });
  });
  it('defaults to an empty map', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerExtraParamsByEngine).toEqual({});
  });
});

describe('changedRequestControls — payloads (N6)', () => {
  it('leaves out a sent engine payload identical to the stored one, and keeps a changed one', () => {
    const stored = { analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'X' } } } } };
    expect(
      changedRequestControls(
        { analyzerExtraParamsByEngine: { gemini: { config: { safetySettings: { category: 'X' } } }, ollama: { top_k: 1 } } },
        stored,
      ),
    ).toEqual({ analyzerExtraParamsByEngine: { ollama: { top_k: 1 } } });
  });
  it('leaves out a sent payload equal to the stored one with its keys in another order (5b-D14)', () => {
    const stored = { analyzerExtraParamsByEngine: { ollama: { top_k: 1, options: { min_p: 0.05, num_predict: 64 } } } };
    expect(
      changedRequestControls({ analyzerExtraParamsByEngine: { ollama: { options: { num_predict: 64, min_p: 0.05 }, top_k: 1 } } }, stored),
    ).toEqual({ analyzerExtraParamsByEngine: {} });
  });
});
