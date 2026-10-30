import { describe, it, expect, vi } from 'vitest';
import cases from '../__fixtures__/extra-params-cases.json' with { type: 'json' };
import {
  GEMINI_CONFIG_ALLOWLIST,
  OWNED_CONTAINERS,
  PROTECTED_KEYS,
  REDACTED,
  filterStoredPayload,
  mergeExtraParams,
  payloadControlsOutputCap,
  payloadOutputCap,
  payloadOutputCapKey,
  payloadSecretValues,
  redactPayloadValues,
  requestControlsLabelParts,
  requestMaxOutputTokens,
  resolveExtraParamsSetting,
  stripPayloadTemperature,
  validateExtraParams,
} from './extra-params.js';
import type { TransportKind } from '../errors.js';

const NEW_OPENAI_KEYS = ['structured_outputs', 'guided_json', 'guided_regex', 'guided_choice', 'guided_grammar', 'guided_decoding_backend', 'guided_whitespace_pattern'];

const geminiRefusal = (paths: string) =>
  `Gemini "config" accepts only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed, safetySettings. Refused: ${paths}.`;

describe('protected keys are exactly spec §9; Gemini config is an allowlist (P16)', () => {
  it('per transport', () => {
    expect(PROTECTED_KEYS.openai).toEqual([
      'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
      'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'include_reasoning',
      'structured_outputs', 'guided_json', 'guided_regex', 'guided_choice', 'guided_grammar', 'guided_decoding_backend', 'guided_whitespace_pattern',
    ]);
    expect(PROTECTED_KEYS.ollama).toEqual(['model', 'messages', 'stream', 'format', 'think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu', 'options.stop']);
    expect(PROTECTED_KEYS.gemini).toEqual(['model', 'contents']);
    expect(GEMINI_CONFIG_ALLOWLIST).toEqual(['temperature', 'topP', 'topK', 'maxOutputTokens', 'presencePenalty', 'frequencyPenalty', 'seed', 'safetySettings']);
    expect(OWNED_CONTAINERS).toEqual({ ollama: ['options'], gemini: ['config'], openai: ['chat_template_kwargs'] });
  });
});

describe('validateExtraParams', () => {
  it('requires a JSON object', () => {
    for (const bad of [null, [], 'x', 3]) {
      expect(validateExtraParams('openai', bad, {})).toEqual({ ok: false, errors: ['Custom parameters must be a JSON object, for example {"top_k": 40}.'] });
    }
  });
  it('names every protected key it refuses', () => {
    expect(validateExtraParams('openai', { model: 'x', top_k: 40, stream: false }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: model, stream.'],
    });
    expect(validateExtraParams('ollama', { think: true, options: { num_ctx: 8192, min_p: 0.05 } }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: think, options.num_ctx.'],
    });
    expect(validateExtraParams('gemini', { config: { thinkingConfig: {}, topK: 40 } }, {})).toEqual({
      ok: false, errors: [geminiRefusal('config.thinkingConfig')],
    });
  });
  it('Gemini config is an allowlist: httpOptions (and everything nested in it) and stopSequences are refused by name (P16)', () => {
    expect(
      validateExtraParams(
        'gemini',
        { config: { httpOptions: { baseUrl: 'http://evil', headers: { 'x-goog-api-key': 'k' }, extraBody: { contents: [] }, retryOptions: { attempts: 5 }, timeout: 1 } } },
        {},
      ),
    ).toEqual({ ok: false, errors: [geminiRefusal('config.httpOptions')] });
    expect(validateExtraParams('gemini', { config: { stopSequences: ['}'] } }, {})).toEqual({ ok: false, errors: [geminiRefusal('config.stopSequences')] });
    const allowed = {
      config: {
        temperature: 0.4, topP: 0.9, topK: 40, maxOutputTokens: 2048, presencePenalty: 0.1, frequencyPenalty: 0.1, seed: 7,
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      },
    };
    expect(validateExtraParams('gemini', allowed, {})).toEqual({ ok: true, value: allowed });
  });
  it('refuses every endpoint reasoning key and the added Ollama keys (A8)', () => {
    expect(
      validateExtraParams('openai', { reasoning: { effort: 'high' }, reasoning_format: 'none', reasoning_budget_tokens: 0, thinking_budget_tokens: 0, include_reasoning: false, top_k: 40 }, {}),
    ).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: reasoning, reasoning_format, reasoning_budget_tokens, thinking_budget_tokens, include_reasoning.'],
    });
    expect(validateExtraParams('ollama', { tools: [], options: { main_gpu: 1, min_p: 0.05 } }, {})).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: tools, options.main_gpu.'],
    });
  });
  it('protects chat_template_kwargs.enable_thinking unless the style is not_controllable (#3904)', () => {
    const p = { chat_template_kwargs: { enable_thinking: true } };
    const refusal = { ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.'] };
    expect(validateExtraParams('openai', p, { reasoningStyle: 'not_controllable' }).ok).toBe(true);
    expect(validateExtraParams('openai', p, { reasoningStyle: 'reasoning_effort' })).toEqual(refusal);
    expect(validateExtraParams('openai', p, { reasoningStyle: 'enable_thinking' })).toEqual(refusal);
    /* fail closed: no style is not "not controllable" */
    expect(validateExtraParams('openai', p, {})).toEqual(refusal);
  });
  it.each(NEW_OPENAI_KEYS)('refuses the vLLM structured-output key %s (#3904)', (key) => {
    expect(validateExtraParams('openai', { [key]: {}, top_k: 40 }, {})).toEqual({
      ok: false, errors: [`These keys are controlled by Castwright and cannot be set here: ${key}.`],
    });
  });
  it.each(NEW_OPENAI_KEYS)('refuses a case variant of %s (#3904)', (key) => {
    const variant = key.replace(/^./, (c) => c.toUpperCase());
    const r = validateExtraParams('openai', { [variant]: {} }, {});
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.errors.join(' ')).toContain(variant);
    expect(filterStoredPayload('openai', { [variant]: {}, top_k: 40 })).toEqual({ value: { top_k: 40 }, dropped: [variant] });
  });
  it('refuses null on an owned container, allows null on keys inside it', () => {
    expect(validateExtraParams('ollama', { options: null }, {})).toEqual({ ok: false, errors: ['"options" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('gemini', { config: null }, {})).toEqual({ ok: false, errors: ['"config" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('openai', { chat_template_kwargs: null }, {})).toEqual({ ok: false, errors: ['"chat_template_kwargs" cannot be null — it holds settings Castwright sends. Set or null individual keys inside it instead.'] });
    expect(validateExtraParams('ollama', { options: { temperature: null, num_predict: 512 } }, {}).ok).toBe(true);
  });
  it('refuses a Gemini top-level key other than config', () => {
    expect(validateExtraParams('gemini', { topK: 40 }, {})).toEqual({ ok: false, errors: ['"topK" is not a Gemini request field — put generation options inside "config".'] });
  });
  it('accepts the reporter payloads unchanged', () => {
    const p = { top_k: 20, min_p: 0.05, presence_penalty: 1.5 };
    expect(validateExtraParams('openai', p, {})).toEqual({ ok: true, value: p });
  });
});

describe('Gemini safetySettings shape (N11)', () => {
  const REFUSAL = '"config.safetySettings" must be an array of objects with only a string "category" and a string "threshold".';
  it('refuses an entry with any other field, such as method, naming the key', () => {
    expect(
      validateExtraParams('gemini', { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE', method: 'SEVERITY' }] } }, {}),
    ).toEqual({ ok: false, errors: [REFUSAL] });
  });
  it('refuses a non-array and a non-string threshold, naming the key', () => {
    expect(validateExtraParams('gemini', { config: { safetySettings: { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' } } }, {})).toEqual({
      ok: false,
      errors: [REFUSAL],
    });
    expect(validateExtraParams('gemini', { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 4 }] } }, {})).toEqual({
      ok: false,
      errors: [REFUSAL],
    });
  });
  it('accepts an empty list, and null (which removes the key)', () => {
    expect(validateExtraParams('gemini', { config: { safetySettings: [] } }, {}).ok).toBe(true);
    expect(validateExtraParams('gemini', { config: { safetySettings: null } }, {}).ok).toBe(true);
  });
  it('drops a stored invalid safetySettings at merge and reports its path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeExtraParams(
      'gemini',
      { model: 'g', config: { temperature: 0.2 } },
      { config: { safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE', method: 'SEVERITY' }], topK: 40 } },
    );
    expect(out).toEqual({ model: 'g', config: { temperature: 0.2, topK: 40 } });
    expect(String(warn.mock.calls[0][0])).toContain('config.safetySettings');
    warn.mockRestore();
  });
});

describe('prototype keys (N12)', () => {
  const poisoned = () =>
    JSON.parse('{"__proto__":{"polluted":true},"top_k":1,"nested":{"constructor":{"x":1},"ok":2},"list":[{"prototype":3,"k":4}]}') as Record<string, unknown>;
  it('filterStoredPayload drops them at any depth, reports each path, and never sets a prototype', () => {
    const { value, dropped } = filterStoredPayload('openai', poisoned());
    expect(dropped).toEqual(['__proto__', 'nested.constructor', 'list[0].prototype']);
    expect(JSON.stringify(value)).toBe('{"top_k":1,"nested":{"ok":2},"list":[{"k":4}]}');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
  it('validateExtraParams refuses them, naming each path', () => {
    expect(validateExtraParams('openai', poisoned(), {})).toEqual({
      ok: false,
      errors: ['Keys named __proto__, constructor or prototype are not allowed: __proto__, nested.constructor, list[0].prototype.'],
    });
  });
  it('filterStoredPayload of no payload is no payload', () => {
    expect(filterStoredPayload('openai', undefined)).toEqual({ value: undefined, dropped: [] });
  });
});

describe('mergeExtraParams', () => {
  it('replaces top-level keys, removes on null, and never mutates the native request', () => {
    const native = { model: 'm', temperature: 0.2, top_p: 1 };
    const out = mergeExtraParams('openai', native, { temperature: 0.9, top_p: null, top_k: 40 });
    expect(out).toEqual({ model: 'm', temperature: 0.9, top_k: 40 });
    expect(native).toEqual({ model: 'm', temperature: 0.2, top_p: 1 });
  });
  it('merges the owned container key by key', () => {
    const native = { model: 'q', options: { temperature: 0.2, num_ctx: 32768, num_gpu: 999, num_predict: -1 } };
    expect(mergeExtraParams('ollama', native, { options: { min_p: 0.05, num_predict: null } })).toEqual({
      model: 'q', options: { temperature: 0.2, num_ctx: 32768, num_gpu: 999, min_p: 0.05 },
    });
    expect(mergeExtraParams('gemini', { model: 'g', config: { temperature: 0.2, maxOutputTokens: 8192 } }, { config: { topK: 40 } })).toEqual({
      model: 'g', config: { temperature: 0.2, maxOutputTokens: 8192, topK: 40 },
    });
  });
  it('keeps the reasoning-owned enable_thinking when a payload adds another template kwarg', () => {
    expect(mergeExtraParams('openai', { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: { add_generation_prompt: true } })).toEqual({
      chat_template_kwargs: { enable_thinking: false, add_generation_prompt: true },
    });
  });
  it('drops the native max_tokens when the payload controls the endpoint output cap', () => {
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { max_completion_tokens: 4096 })).toEqual({ max_completion_tokens: 4096 });
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { max_tokens: null })).toEqual({});
    /* N9 — llama.cpp's n_predict is an output cap too, so the transport's max_tokens gives way to it. */
    expect(mergeExtraParams('openai', { max_tokens: 8192 }, { n_predict: 1024 })).toEqual({ n_predict: 1024 });
  });
  it('returns the native request unchanged with no payload', () => {
    const native = { model: 'm' };
    expect(mergeExtraParams('openai', native, undefined)).toBe(native);
  });
});

describe('mergeExtraParams re-applies the rules to a stored payload (P16, P17)', () => {
  it('drops protected keys and logs their names, never their values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const native = { model: 'q', think: false, keep_alive: -1, options: { num_ctx: 32768, num_gpu: 0, temperature: 0.2 } };
    const out = mergeExtraParams('ollama', native, {
      think: true,
      keep_alive: 'stored-secret-keepalive',
      tools: [{ type: 'function' }],
      options: { num_ctx: 2048, num_gpu: 99, main_gpu: 1, min_p: 0.05 },
    });
    expect(out).toEqual({ model: 'q', think: false, keep_alive: -1, options: { num_ctx: 32768, num_gpu: 0, temperature: 0.2, min_p: 0.05 } });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    for (const name of ['think', 'keep_alive', 'tools', 'options.num_ctx', 'options.num_gpu', 'options.main_gpu']) expect(line).toContain(name);
    expect(line).not.toContain('stored-secret-keepalive');
    warn.mockRestore();
  });
  it('a stored null on an owned container is ignored: options keeps num_ctx and num_gpu 0', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeExtraParams('ollama', { options: { num_ctx: 32768, num_gpu: 0 } }, { options: null })).toEqual({ options: { num_ctx: 32768, num_gpu: 0 } });
    expect(mergeExtraParams('gemini', { model: 'g', config: { temperature: 0.2 } }, { config: null })).toEqual({ model: 'g', config: { temperature: 0.2 } });
    expect(mergeExtraParams('openai', { chat_template_kwargs: { enable_thinking: false } }, { chat_template_kwargs: null })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    vi.restoreAllMocks();
  });
  it('Gemini: only allowlisted config keys survive; httpOptions, stopSequences and other top-level keys never do', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeExtraParams(
      'gemini',
      { model: 'g', contents: [], config: { temperature: 0.2 } },
      { model: 'evil', labels: { a: 'b' }, config: { httpOptions: { baseUrl: 'http://evil' }, stopSequences: ['}'], topK: 40 } },
    );
    expect(out).toEqual({ model: 'g', contents: [], config: { temperature: 0.2, topK: 40 } });
    expect(JSON.stringify(out)).not.toContain('evil');
    vi.restoreAllMocks();
  });
  it('drops endpoint reasoning keys, and enable_thinking unless the style is not_controllable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mergeExtraParams('openai', { reasoning_effort: 'none' }, { reasoning_effort: 'high', reasoning_budget_tokens: 9000, include_reasoning: true, top_k: 40 })).toEqual({
      reasoning_effort: 'none',
      top_k: 40,
    });
    const native = { chat_template_kwargs: { enable_thinking: false } };
    const stored = { chat_template_kwargs: { enable_thinking: true } };
    expect(mergeExtraParams('openai', native, stored, { reasoningStyle: 'enable_thinking' })).toEqual(native);
    expect(mergeExtraParams('openai', native, stored, { reasoningStyle: 'reasoning_effort' })).toEqual(native);
    expect(mergeExtraParams('openai', native, stored)).toEqual(native);
    expect(mergeExtraParams('openai', native, stored, { reasoningStyle: 'not_controllable' })).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
    vi.restoreAllMocks();
  });
  it.each(NEW_OPENAI_KEYS)('drops a stored %s with a names-only warning (#3904)', (key) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secret = 'sk-secret-value-123456';
    expect(mergeExtraParams('openai', { model: 'm' }, { [key]: secret, top_k: 40 })).toEqual({ model: 'm', top_k: 40 });
    expect(filterStoredPayload('openai', { [key]: secret }).dropped).toEqual([key]);
    const logged = warn.mock.calls.map((c) => c.join(' ')).join(' | ');
    expect(logged).toContain(key);
    expect(logged).not.toContain(secret);
    vi.restoreAllMocks();
  });
});

describe('payloadOutputCap (P19)', () => {
  it.each<[TransportKind, Record<string, unknown> | undefined, number | null | undefined]>([
    ['ollama', { options: { num_predict: 512 } }, 512],
    ['ollama', { options: { num_predict: -1 } }, null],
    ['ollama', { options: { min_p: 0.05 } }, undefined],
    ['openai', { max_completion_tokens: 4096 }, 4096],
    ['openai', { max_tokens: 8192, max_completion_tokens: 4096 }, 4096],
    ['openai', { max_tokens: null }, null],
    ['openai', { n_predict: 1024 }, 1024],
    ['openai', { n_predict: -1 }, null],
    ['gemini', { config: { maxOutputTokens: 2048 } }, 2048],
    ['gemini', undefined, undefined],
  ])('%s %j → %s', (kind, params, cap) => {
    expect(payloadOutputCap(kind, params)).toBe(cap);
  });
});

describe('payloadOutputCapKey (N13)', () => {
  it.each<[TransportKind, Record<string, unknown> | undefined, string | undefined]>([
    ['ollama', { options: { num_predict: 512 } }, 'options.num_predict'],
    ['gemini', { config: { maxOutputTokens: 2048 } }, 'config.maxOutputTokens'],
    ['openai', { max_tokens: 8192, max_completion_tokens: 4096 }, 'max_completion_tokens'],
    ['openai', { n_predict: 1024 }, 'n_predict'],
    ['openai', { max_tokens: null }, 'max_tokens'],
    ['openai', { top_k: 40 }, undefined],
    ['openai', undefined, undefined],
  ])('%s %j → %s', (kind, params, key) => {
    expect(payloadOutputCapKey(kind, params)).toBe(key);
  });
});

describe('stripPayloadTemperature', () => {
  it.each<[TransportKind, Record<string, unknown>, Record<string, unknown>]>([
    ['openai', { temperature: 0.9, top_k: 40 }, { top_k: 40 }],
    ['ollama', { options: { temperature: 0.9, min_p: 0.05 }, top_k: 1 }, { options: { min_p: 0.05 }, top_k: 1 }],
    ['gemini', { config: { temperature: 0.9, topK: 40 } }, { config: { topK: 40 } }],
    ['ollama', { options: { min_p: 0.05 } }, { options: { min_p: 0.05 } }],
  ])('%s removes only the temperature key', (kind, params, expected) => {
    const copy = structuredClone(params);
    expect(stripPayloadTemperature(kind, params)).toEqual(expected);
    expect(params).toEqual(copy);
  });
});

describe('output cap and label parts (shared case table)', () => {
  it.each(cases as Array<{ kind: TransportKind; params: Record<string, unknown>; controlsOutputCap: boolean; labelParts: string[] }>)(
    '$kind $params',
    ({ kind, params, controlsOutputCap, labelParts }) => {
      expect(payloadControlsOutputCap(kind, params)).toBe(controlsOutputCap);
      expect(requestControlsLabelParts(kind, params)).toEqual(labelParts);
    },
  );
  it('no payload → no cap, no label', () => {
    expect(payloadControlsOutputCap('openai', undefined)).toBe(false);
    expect(requestControlsLabelParts('openai', undefined)).toEqual([]);
  });
});

describe('redactPayloadValues', () => {
  it('redacts string values of 8+ characters anywhere in the payload, not shorter ones', () => {
    const params = { api_extra: 'sk-lab-0123456789', mode: 'json', nested: { list: ['tenant-alpha-7', 'auto'] } };
    const text = 'upstream said: key sk-lab-0123456789 for tenant-alpha-7 in json auto mode';
    expect(redactPayloadValues(text, params)).toBe(`upstream said: key ${REDACTED} for ${REDACTED} in json auto mode`);
  });
  it('redacts the JSON-escaped form of a value', () => {
    const params = { prompt_prefix: 'say "hello" now' };
    expect(redactPayloadValues('{"error":"bad value say \\"hello\\" now"}', params)).toBe(`{"error":"bad value ${REDACTED}"}`);
  });
  it('replaces the longest value first so a shorter overlapping value leaves no fragment', () => {
    expect(redactPayloadValues('abcdefghij', { a: 'abcdefgh', b: 'abcdefghij' })).toBe(REDACTED);
  });
  it('is a no-op without a payload', () => {
    expect(redactPayloadValues('text', undefined)).toBe('text');
  });
  it("payloadSecretValues lists every string value (the 8-character floor and the JSON-escaped spelling are W3b's)", () => {
    expect(payloadSecretValues({ a: 'json', b: { c: ['say "hi" there'] } })).toEqual(['json', 'say "hi" there']);
  });
  it('a value under 8 characters is never redacted, even when its JSON-escaped spelling is 8 or more (5b-D11)', () => {
    const text = 'upstream echoed x \\"\\"\\"\\"';
    expect(redactPayloadValues(text, { a: '""""' })).toBe(text);
  });
});

describe('settings helpers', () => {
  it('resolves the payload per engine and per endpoint', () => {
    const s = { analyzerExtraParamsByEngine: { ollama: { top_k: 1 }, gemini: { config: { topK: 2 } } } };
    expect(resolveExtraParamsSetting(s, { engine: 'local' })).toEqual({ top_k: 1 });
    expect(resolveExtraParamsSetting(s, { engine: 'gemini' })).toEqual({ config: { topK: 2 } });
    expect(resolveExtraParamsSetting(s, { engine: 'openai', endpoint: { extraParams: { top_k: 3 } } })).toEqual({ top_k: 3 });
    expect(resolveExtraParamsSetting({}, { engine: 'local' })).toBeUndefined();
  });
});

describe('requestMaxOutputTokens (P19)', () => {
  it("uses the payload's cap, maps a removed cap to undefined, and otherwise asks the engine", () => {
    expect(requestMaxOutputTokens('ollama', { options: { num_predict: 512 } }, () => 4096)).toBe(512);
    expect(requestMaxOutputTokens('openai', { max_tokens: null }, () => 4096)).toBeUndefined();
    expect(requestMaxOutputTokens('gemini', { config: { topK: 40 } }, () => 4096)).toBe(4096);
    expect(requestMaxOutputTokens('gemini', undefined, () => 4096)).toBe(4096);
  });
});

describe('case-variant keys (Go encoding/json matches keys case-insensitively, last duplicate wins)', () => {
  const repro = { Options: { num_ctx: 131072, num_gpu: 0 }, Model: 'llama3.3:70b', Think: true, Stream: false };

  it('validateExtraParams refuses the Ollama repro payload, naming every case-variant key', () => {
    const r = validateExtraParams('ollama', repro, {});
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join(' ');
    for (const k of ['Options', 'Model', 'Think', 'Stream']) expect(text).toContain(k);
  });
  it('refuses a case-variant Model/Messages for openai', () => {
    const r = validateExtraParams('openai', { Model: 'x', MESSAGES: [] }, {});
    expect(r.ok).toBe(false);
    const text = r.ok ? '' : r.errors.join(' ');
    expect(text).toContain('Model');
    expect(text).toContain('MESSAGES');
  });
  it('refuses a case-variant nested key under the exact owned container, and a case-variant output cap or temperature', () => {
    for (const [kind, params, name] of [
      ['ollama', { options: { Num_Ctx: 1 } }, 'options.Num_Ctx'],
      ['ollama', { options: { Num_Predict: 128 } }, 'options.Num_Predict'],
      ['ollama', { options: { Temperature: 1 } }, 'options.Temperature'],
      ['openai', { Max_Tokens: 5 }, 'Max_Tokens'],
      ['openai', { chat_template_kwargs: { Enable_Thinking: true } }, 'chat_template_kwargs.Enable_Thinking'],
    ] as const) {
      const r = validateExtraParams(kind, params, { reasoningStyle: 'enable_thinking' });
      expect(r.ok, name).toBe(false);
      expect(r.ok ? '' : r.errors.join(' ')).toContain(name);
    }
  });
  it('still accepts exact-case canonical keys', () => {
    expect(validateExtraParams('ollama', { options: { min_p: 0.05, num_predict: 100 }, top_k: 40 }, {}).ok).toBe(true);
  });
  it('filterStoredPayload drops case variants (top level and nested) and keeps the rest', () => {
    const { value, dropped } = filterStoredPayload('ollama', { ...repro, options: { Num_Ctx: 1, min_p: 0.05 }, top_k: 40 });
    expect(value).toEqual({ options: { min_p: 0.05 }, top_k: 40 });
    expect(dropped).toEqual(expect.arrayContaining(['Options', 'Model', 'Think', 'Stream', 'options.Num_Ctx']));
    expect(filterStoredPayload('openai', { Model: 'x', Messages: [], top_k: 40 }).value).toEqual({ top_k: 40 });
  });
  it('mergeExtraParams never lets a case variant reach the wire', () => {
    const native = { model: 'm', options: { num_ctx: 4096 }, stream: true };
    const out = mergeExtraParams('ollama', native, repro);
    expect(out).toEqual(native);
  });
  it('{"Options":{"num_predict":128}} never yields an undetected cap', () => {
    const payload = { Options: { num_predict: 128 } };
    expect(validateExtraParams('ollama', payload, {}).ok).toBe(false);
    const { value } = filterStoredPayload('ollama', payload);
    expect(JSON.stringify(mergeExtraParams('ollama', { options: {} }, payload))).not.toMatch(/num_predict/i);
    expect(payloadControlsOutputCap('ollama', value)).toBe(false);
  });

  describe('Unicode simple case folding (U+017F long s folds to s, U+212A Kelvin sign folds to k)', () => {
    const folded = [
      ['ollama', { 'optionſ': { num_ctx: 131072, num_predict: 128 } }],
      ['ollama', { 'ſtream': false }],
      ['ollama', { 'meſſages': [] }],
      ['openai', { 'max_tokenſ': 5 }],
    ] as const;

    it('validateExtraParams refuses long-s variants of owned keys', () => {
      for (const [kind, params] of folded) {
        const r = validateExtraParams(kind, params, {});
        expect(r.ok, Object.keys(params)[0]).toBe(false);
      }
    });
    it('filterStoredPayload drops them and mergeExtraParams never lets them reach the wire', () => {
      for (const [kind, params] of folded) {
        const { value, dropped } = filterStoredPayload(kind, { ...params, top_k: 40 });
        expect(value, Object.keys(params)[0]).toEqual({ top_k: 40 });
        expect(dropped).toContain(Object.keys(params)[0]);
        const native = { model: 'm', options: { num_ctx: 4096 }, stream: true };
        expect(mergeExtraParams(kind, native, params)).toEqual(native);
      }
    });
    it('{"option\\u017f":{"num_predict":128}} never yields an undetected cap', () => {
      const payload = { 'optionſ': { num_predict: 128 } };
      expect(validateExtraParams('ollama', payload, {}).ok).toBe(false);
      const { value } = filterStoredPayload('ollama', payload);
      expect(JSON.stringify(mergeExtraParams('ollama', { options: {} }, payload))).not.toMatch(/num_predict/i);
      expect(payloadControlsOutputCap('ollama', value)).toBe(false);
    });
    it('pins the Kelvin sign', () => {
      expect(validateExtraParams('ollama', { 'Keep_alive': '5m' }, {}).ok).toBe(false);
      expect(validateExtraParams('ollama', { 'thinK': true }, {}).ok).toBe(false);
    });
    it('still accepts exact options.num_predict, top_k and min_p', () => {
      expect(validateExtraParams('ollama', { options: { num_predict: 100, min_p: 0.05 }, top_k: 40 }, {}).ok).toBe(true);
    });
  });
});
