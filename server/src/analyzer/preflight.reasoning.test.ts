import { describe, it, expect } from 'vitest';
import { preflightTargets, runAnalyzerPreflight } from './preflight.js';
import { AnalyzerReasoningUnavailableError } from './errors.js';
import { DEFAULT_USER_SETTINGS, userSettingsSchema, type UserSettings } from '../workspace/user-settings.js';
// Re-pinned to 80be2f1d (#3192, A1): getResolvedOllamaUrl moved to config/ollama-resolved.js.
import { getResolvedOllamaUrl } from '../config/ollama-resolved.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';

const settings = (over: Partial<UserSettings>): UserSettings => ({ ...DEFAULT_USER_SETTINGS, ...over });
const thrown = (fn: () => void): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('runAnalyzerPreflight — stored reasoning level no longer offered (#3084 wave 5, P17)', () => {
  it('a Gemini level the table does not offer refuses the run, naming the model, the level and the engine', () => {
    const s = settings({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } });
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'gemini-3.8-flash', s), s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'gemini-3.8-flash', level: 'minimal', engine: 'gemini' });
  });

  it('classifies by the target engine: a bare Ollama default tag with a stale named level is refused (N5)', () => {
    /* A bare tag (no ':') infers as Gemini from its id, but selection builds it as local (e.g. OLLAMA_MODEL=llama2). */
    const s = settings({ analyzerReasoningByEngine: { ollama: { llama2: 'low' } } });
    const err = thrown(() => runAnalyzerPreflight([{ modelId: 'llama2', source: 'env', engine: 'local' }], s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'llama2', level: 'low', engine: 'local' });
  });

  it('an unknown stored value (xhigh) loads without resetting settings and refuses the run before its first call (N10)', () => {
    const s = settings({ analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'xhigh' } } });
    expect(userSettingsSchema.safeParse(s).success).toBe(true);
    const err = thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'gemini-3.6-flash', s), s));
    expect(err).toBeInstanceOf(AnalyzerReasoningUnavailableError);
    expect(err).toMatchObject({ modelId: 'gemini-3.6-flash', level: 'xhigh', engine: 'gemini' });
  });

  it('one Ollama model id (N7): a named level saved under qwen3 passes for runs on qwen3 and qwen3:latest, with the Test record saved under qwen3:latest', () => {
    const s = settings({
      analyzerReasoningByEngine: { ollama: { qwen3: 'low' } },
      analyzerCapabilitiesByModel: {
        'qwen3:latest': { serverUrl: getResolvedOllamaUrl(), testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: { low: 'accepted' } },
      },
    });
    expect(() => runAnalyzerPreflight([{ modelId: 'qwen3:latest', source: 'settings', engine: 'local' }], s)).not.toThrow();
    expect(() => runAnalyzerPreflight([{ modelId: 'qwen3', source: 'env', engine: 'local' }], s)).not.toThrow();
  });

  it('an Ollama named level with no accepted Test record refuses; a base level passes', () => {
    const stale = settings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } } });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', stale), stale))).toBeInstanceOf(
      AnalyzerReasoningUnavailableError,
    );
    const ok = settings({ analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'on' } } });
    expect(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'qwen3.5:4b', ok), ok)).not.toThrow();
  });

  it('an installed digest that differs from the stored record discards it here too, agreeing with the structured-output check (A3)', () => {
    const stale = settings({
      analyzerReasoningByEngine: { ollama: { 'qwen3.5:4b': 'low' } },
      analyzerCapabilitiesByModel: {
        'qwen3.5:4b': {
          serverUrl: getResolvedOllamaUrl(),
          digest: 'sha256:old',
          testedAt: '2026-09-11T10:00:00.000Z',
          control: { ok: true },
          structuredOutput: {},
          reasoning: { low: 'accepted' },
        },
      },
    });
    const targets = preflightTargets(['phase0'], 'qwen3.5:4b', stale);
    /* The installed model was re-pulled: the record's digest no longer matches. Discarded, so `low` is
       no longer offered — the same discard W3c's structured-output check already applies for this
       reason, so the two checks agree on one run rather than one trusting a record the other drops. */
    expect(thrown(() => runAnalyzerPreflight(targets, stale, new Map([['qwen3.5:4b', 'sha256:new']])))).toBeInstanceOf(
      AnalyzerReasoningUnavailableError,
    );
    /* Same digest: the record is kept. */
    expect(() => runAnalyzerPreflight(targets, stale, new Map([['qwen3.5:4b', 'sha256:old']]))).not.toThrow();
    /* No digest resolved (resolvePreflightDigests came back empty, or wasn't called): fail-open (A3), matching capabilityRecordFor's own rule. */
    expect(() => runAnalyzerPreflight(targets, stale)).not.toThrow();
  });

  it('an endpoint level saved under another control style refuses', () => {
    const endpoint = {
      ...analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768 }),
      reasoning: 'high' as const,
    };
    const s = settings({ analyzerEndpoints: [endpoint] });
    expect(thrown(() => runAnalyzerPreflight(preflightTargets(['phase0'], 'openai:lab::m', s), s))).toMatchObject({
      level: 'high',
      engine: 'openai',
    });
  });
});
