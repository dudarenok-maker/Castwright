import { describe, it, expect } from 'vitest';
import { GEMINI_CONFIG_ALLOWLIST, OWNED_CONTAINERS, PROTECTED_KEYS, filterStoredPayload, validateExtraParams } from './extra-params.js';

const geminiRefusal = (paths: string) =>
  `Gemini "config" accepts only temperature, topP, topK, maxOutputTokens, presencePenalty, frequencyPenalty, seed, safetySettings. Refused: ${paths}.`;

describe('protected keys are exactly spec §9; Gemini config is an allowlist (P16)', () => {
  it('per transport', () => {
    expect(PROTECTED_KEYS.openai).toEqual([
      'model', 'messages', 'stream', 'stream_options', 'n', 'stop', 'tools', 'tool_choice', 'response_format', 'grammar', 'json_schema',
      'reasoning_effort', 'reasoning', 'reasoning_format', 'reasoning_budget_tokens', 'thinking_budget_tokens', 'include_reasoning',
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
  it('protects chat_template_kwargs.enable_thinking only for the enable_thinking style', () => {
    const p = { chat_template_kwargs: { enable_thinking: true } };
    expect(validateExtraParams('openai', p, { reasoningStyle: 'reasoning_effort' }).ok).toBe(true);
    expect(validateExtraParams('openai', p, { reasoningStyle: 'enable_thinking' })).toEqual({
      ok: false, errors: ['These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.'],
    });
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
