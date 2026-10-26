import { describe, it, expect, expectTypeOf } from 'vitest';
import styleLevels from './__fixtures__/reasoning-style-levels.json' with { type: 'json' };
import { REASONING_STYLES } from '../workspace/analyzer-endpoints.js';
import { geminiModelThinks } from './catalog/gemini-catalog.js';
import { AnalyzerReasoningUnavailableError } from './errors.js';
import {
  GEMINI_REASONING_TABLE,
  REASONING_LEVELS,
  defaultReasoningLevel,
  geminiReasoningRow,
  geminiRequestThinks,
  levelsForReasoningStyle,
  offeredReasoningLevels,
  reasoningControlDescription,
  reasoningWireFragment,
  resolveReasoningSetting,
  testableReasoningLevels,
  type ReasoningLevel,
  type ReasoningStyle,
} from './reasoning.js';

const endpoint = (reasoningStyle: ReasoningStyle) => ({ id: 'lab', name: 'Lab box', reasoningStyle });

describe('endpoint control styles', () => {
  it('ReasoningStyle is exactly the endpoint schema enum', () => {
    expectTypeOf<ReasoningStyle>().toEqualTypeOf<(typeof REASONING_STYLES)[number]>();
    expect([...REASONING_STYLES].sort()).toEqual(Object.keys(styleLevels).sort());
  });

  it.each(Object.entries(styleLevels))('%s offers exactly the shared table', (style, levels) => {
    expect([...levelsForReasoningStyle(style as ReasoningStyle)]).toEqual(levels);
    expect(
      offeredReasoningLevels({ engine: 'openai', model: 'm', endpoint: endpoint(style as ReasoningStyle) }),
    ).toEqual(levels);
  });

  it('an endpoint selection with no endpoint offers model-default only', () => {
    expect(offeredReasoningLevels({ engine: 'openai', model: 'm' })).toEqual(['model-default']);
  });
});

describe('GEMINI_REASONING_TABLE — 3.x Flash family only (F2, 2026-09-13); 2.5 ids get model default only', () => {
  const THREE_X_FULL: ReasoningLevel[] = ['model-default', 'minimal', 'low', 'medium', 'high'];
  const NO_MINIMAL: ReasoningLevel[] = ['model-default', 'low', 'medium', 'high'];
  /* defaultLevel — the level Google's docs name as each model's own default (review item 2, 2026-09-13):
     verified on ai.google.dev/gemini-api/docs/generate-content/thinking, two independent reads 2026-09-13.
     Used only to decide whether a model-default overflow still has a lower rung to suggest (Task 5.5b);
     the wire itself keeps omitting the field at model-default (unchanged). */
  it.each<[string, string | undefined, ReasoningLevel[], ReasoningLevel | undefined]>([
    ['gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3.5-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3-flash-preview', 'thinkingLevel', THREE_X_FULL, 'high'],
    ['gemini-3.5-flash-lite', 'thinkingLevel', THREE_X_FULL, 'minimal'],
    ['gemini-3.1-flash-lite', 'thinkingLevel', THREE_X_FULL, 'minimal'],
    ['gemini-3.8-flash', 'thinkingLevel', NO_MINIMAL, 'medium'],
    ['gemini-3.7-flash', 'thinkingLevel', NO_MINIMAL, 'medium'],
    ['gemini-3.1-pro-preview', 'thinkingLevel', NO_MINIMAL, 'high'],
    ['gemma-4-31b-it', 'gemmaOnOff', ['model-default', 'off', 'on'], undefined],
    ['gemma-4-26b-a4b-it', 'gemmaOnOff', ['model-default', 'off', 'on'], undefined],
    ['models/gemini-3.6-flash', 'thinkingLevel', THREE_X_FULL, 'medium'],
    ['gemini-3.6-flash-lite', undefined, ['model-default'], undefined],
    ['gemini-9-ultra', undefined, ['model-default'], undefined],
    /* F2 — 2.5 is retired from the table; a 2.5 id gets model-default only, exactly like an unknown id. */
    ['gemini-2.5-flash', undefined, ['model-default'], undefined],
    ['gemini-2.5-flash-lite', undefined, ['model-default'], undefined],
    ['gemini-2.5-pro', undefined, ['model-default'], undefined],
  ])('%s → %s (defaultLevel %s)', (model, control, levels, defaultLevel) => {
    expect(geminiReasoningRow(model)?.control).toBe(control);
    expect(offeredReasoningLevels({ engine: 'gemini', model })).toEqual(levels);
    expect(geminiReasoningRow(model)?.defaultLevel).toBe(defaultLevel);
  });

  it('has exactly 6 rows: Flash-Lite, 3 Flash, 3.5/3.6 Flash, 3.7/3.8 Flash, 3.1 Pro, Gemma', () => {
    expect(GEMINI_REASONING_TABLE.length).toBe(6);
  });

  it('never sends thinkingBudget: no Gemini request ever carries it, in the fragment or the resolved settings (F2 — P9 retired)', () => {
    const ids = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemma-4-31b-it'];
    for (const model of ids) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = (reasoningWireFragment('gemini', { model }, level).thinkingConfig ?? {}) as Record<string, unknown>;
        expect('thinkingBudget' in cfg).toBe(false);
      }
    }
  });

  it('maps levels to the documented wire values', () => {
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'minimal')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'high')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'on')).toEqual({ thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true } });
    expect(reasoningWireFragment('gemini', { model: 'gemma-4-31b-it' }, 'off')).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    expect(reasoningWireFragment('gemini', { model: 'gemini-3.6-flash' }, 'model-default')).toEqual({});
    /* F2 — a 2.5 id has no row, so it offers model-default only and its fragment is always {}. */
    expect(reasoningWireFragment('gemini', { model: 'gemini-2.5-flash' }, 'model-default')).toEqual({});
  });

  it('every Gemini level that thinks carries includeThoughts; off never does (P19)', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemma-4-31b-it']) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = reasoningWireFragment('gemini', { model }, level).thinkingConfig as Record<string, unknown> | undefined;
        if (level === 'model-default') expect(cfg, `${model} ${level}`).toBeUndefined();
        else if (level === 'off') expect(cfg !== undefined && 'includeThoughts' in cfg, `${model} ${level}`).toBe(false);
        else expect(cfg?.includeThoughts, `${model} ${level}`).toBe(true);
      }
    }
  });

  it('refuses a level the model does not offer instead of downgrading it', () => {
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-3.8-flash' }, 'minimal')).toThrow(AnalyzerReasoningUnavailableError);
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-9-ultra' }, 'low')).toThrow(AnalyzerReasoningUnavailableError);
    /* F2 — a 2.5 id has no row, so any non-default level is refused the same way an unknown id's would be. */
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'high')).toThrow(AnalyzerReasoningUnavailableError);
  });
});

describe('geminiRequestThinks — per request (P27)', () => {
  it('the id rule decides the default; a level that turns thinking on or off decides the request', () => {
    expect(geminiRequestThinks('gemini-3.6-flash', undefined)).toBe(true);
    expect(geminiRequestThinks('gemini-3.6-flash', 'model-default')).toBe(true);
    expect(geminiRequestThinks('gemma-4-31b-it', undefined)).toBe(false);
    expect(geminiRequestThinks('gemma-4-31b-it', 'on')).toBe(true);
    expect(geminiRequestThinks('gemma-4-31b-it', 'off')).toBe(false);
    /* F2 — a 2.5 id has no row, so any level falls back to the static id rule, same as an unknown id. */
    expect(geminiRequestThinks('gemini-2.5-flash', 'off')).toBe(geminiModelThinks('gemini-2.5-flash'));
  });

  it('agrees with the wire for every offered level: a level thinks exactly when its fragment carries includeThoughts', () => {
    for (const model of ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemma-4-31b-it', 'gemini-9-ultra']) {
      for (const level of offeredReasoningLevels({ engine: 'gemini', model })) {
        const cfg = reasoningWireFragment('gemini', { model }, level).thinkingConfig as Record<string, unknown> | undefined;
        const expected = level === 'model-default' ? geminiModelThinks(model) : cfg?.includeThoughts === true;
        expect(geminiRequestThinks(model, level), `${model} ${level}`).toBe(expected);
      }
    }
  });
});


describe('Ollama', () => {
  it('offers model-default/off/on, plus named levels only when the Test record accepted them', () => {
    expect(offeredReasoningLevels({ engine: 'local', model: 'qwen3.5:4b' })).toEqual(['model-default', 'off', 'on']);
    expect(
      offeredReasoningLevels({ engine: 'local', model: 'qwen3.5:4b', record: { reasoning: { low: 'accepted', medium: 'rejected', high: 'accepted' } } }),
    ).toEqual(['model-default', 'off', 'on', 'low', 'high']);
  });

  it('probes every Ollama level in a Test (named levels are not yet offered)', () => {
    expect(testableReasoningLevels({ engine: 'local', model: 'qwen3.5:4b' })).toEqual(['model-default', 'off', 'on', 'low', 'medium', 'high']);
    expect(testableReasoningLevels({ engine: 'gemini', model: 'gemma-4-31b-it' })).toEqual(['model-default', 'off', 'on']);
  });

  it('wire fragments', () => {
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'model-default')).toEqual({});
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'off')).toEqual({ think: false });
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'on')).toEqual({ think: true });
    expect(reasoningWireFragment('ollama', { model: 'q:4b' }, 'medium')).toEqual({ think: 'medium' });
    expect(() => reasoningWireFragment('ollama', { model: 'q:4b' }, 'none')).toThrow(AnalyzerReasoningUnavailableError);
  });
});

describe('endpoint wire fragments', () => {
  it('reasoning_effort sends the level verbatim, model-default sends nothing', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('reasoning_effort') }, 'none')).toEqual({ reasoning_effort: 'none' });
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('reasoning_effort') }, 'model-default')).toEqual({});
  });
  it('enable_thinking sends chat_template_kwargs with a boolean', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('enable_thinking') }, 'off')).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('enable_thinking') }, 'on')).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });
  it('not_controllable refuses anything but model-default', () => {
    expect(reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('not_controllable') }, 'model-default')).toEqual({});
    expect(() => reasoningWireFragment('openai', { model: 'm', endpoint: endpoint('not_controllable') }, 'on')).toThrow(AnalyzerReasoningUnavailableError);
  });
});

describe('defaults preserve today', () => {
  it('Ollama off; Gemini and endpoints model-default', () => {
    expect(REASONING_LEVELS).toEqual(['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(defaultReasoningLevel('local')).toBe('off');
    expect(defaultReasoningLevel('gemini')).toBe('model-default');
    expect(defaultReasoningLevel('openai')).toBe('model-default');
    expect(resolveReasoningSetting({}, { engine: 'local', model: 'q:4b' })).toBe('off');
    expect(resolveReasoningSetting({}, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('model-default');
    expect(resolveReasoningSetting({}, { engine: 'openai', model: 'm', endpoint: { reasoning: 'model-default' } })).toBe('model-default');
  });
  it('reads the saved setting per Ollama model, per Gemini model, and per endpoint (P18)', () => {
    const s = { analyzerReasoningByEngine: { ollama: { 'q:4b': 'on' as const }, gemini: { 'gemini-3.6-flash': 'low' as const } } };
    expect(resolveReasoningSetting(s, { engine: 'local', model: 'q:4b' })).toBe('on');
    expect(resolveReasoningSetting(s, { engine: 'local', model: 'q:9b' })).toBe('off'); // model A's level is never model B's
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('low');
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.5-flash' })).toBe('model-default');
    expect(resolveReasoningSetting(s, { engine: 'openai', model: 'm', endpoint: { reasoning: 'none' } })).toBe('none');
  });
});

describe('stored values (N7, N10)', () => {
  it('reads an Ollama entry through normalizeModelTag, so a bare tag and its :latest form share one level (N7)', () => {
    const bare = { analyzerReasoningByEngine: { ollama: { qwen3: 'on' } } };
    expect(resolveReasoningSetting(bare, { engine: 'local', model: 'qwen3:latest' })).toBe('on');
    expect(resolveReasoningSetting(bare, { engine: 'local', model: 'qwen3' })).toBe('on');
    const latest = { analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'high' } } };
    expect(resolveReasoningSetting(latest, { engine: 'local', model: 'qwen3' })).toBe('high');
  });

  it('returns an unknown stored value as saved, so the pre-run check can refuse it (N10, P17)', () => {
    const s = { analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'xhigh' } } };
    expect(resolveReasoningSetting(s, { engine: 'gemini', model: 'gemini-3.6-flash' })).toBe('xhigh');
    expect(offeredReasoningLevels({ engine: 'gemini', model: 'gemini-3.6-flash' })).not.toContain('xhigh');
  });
});

describe('reasoningControlDescription', () => {
  it('names the actual control per engine and style', () => {
    expect(reasoningControlDescription('ollama', { model: 'q:4b' })).toMatch(/Ollama reasoning setting.*"think"/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-3.6-flash' })).toMatch(/thinkingLevel.*cannot turn thinking off/);
    expect(reasoningControlDescription('gemini', { model: 'gemma-4-31b-it' })).toMatch(/thinkingLevel.*"off" sends MINIMAL/);
    expect(reasoningControlDescription('gemini', { model: 'gemini-9-ultra' })).toMatch(/cannot be controlled/);
    /* F2 — a 2.5 id has no row, so it reads the same as an unknown id. */
    expect(reasoningControlDescription('gemini', { model: 'gemini-2.5-flash' })).toMatch(/cannot be controlled/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('reasoning_effort') })).toMatch(/"Lab box".*reasoning_effort/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('enable_thinking') })).toMatch(/chat_template_kwargs\.enable_thinking/);
    expect(reasoningControlDescription('openai', { model: 'm', endpoint: endpoint('not_controllable') })).toMatch(/"not controllable"/);
    expect(reasoningControlDescription('openai', { model: 'm' })).toMatch(/this endpoint's Reasoning setting/);
  });
});

describe('a level that reaches a call anyway is coded, not a bare Error (N10)', () => {
  it('reasoningWireFragment throws AnalyzerReasoningUnavailableError marked mid-run, with the engine of its transport', () => {
    const err = (() => {
      try {
        reasoningWireFragment('ollama', { model: 'q:4b' }, 'xhigh' as ReasoningLevel);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'q:4b', level: 'xhigh', engine: 'local', when: 'mid-run' });
    expect(() => reasoningWireFragment('gemini', { model: 'gemini-2.5-pro' }, 'off')).toThrow(
      expect.objectContaining({ engine: 'gemini', when: 'mid-run' }),
    );
  });
});
