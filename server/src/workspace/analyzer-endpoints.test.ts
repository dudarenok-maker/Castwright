import { describe, it, expect } from 'vitest';
import {
  AnalyzerEndpointRefusal,
  MODEL_ID_CONFIG_KNOBS,
  MODEL_ID_SETTING_FIELDS,
  analyzerEndpointSchema,
  applyCreate,
  applyDelete,
  applyKey,
  applyUpdate,
  defaultGpuForBaseUrl,
  ENDPOINT_KEY_CONTROL_CHARACTER_RULE,
  endpointKeyStatus,
  findEndpointReferences,
  friendlyEndpointIssueMessage,
  keyOriginMatches,
  resolveEndpointApiKey,
  resolveUnloadUrl,
  type EndpointState,
} from './analyzer-endpoints.js';
import { userSettingsSchema, DEFAULT_USER_SETTINGS } from './user-settings.js';
import { KNOBS } from '../config/registry.js';
import { AnalyzerKeyOriginError } from '../analyzer/errors.js';

const base = { id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768 };
const empty: EndpointState = { analyzerEndpoints: [], analyzerEndpointKeys: {} };

function refusal(fn: () => unknown): AnalyzerEndpointRefusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof AnalyzerEndpointRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('analyzerEndpointSchema defaults (#3084 contract)', () => {
  it('fills the contract defaults', () => {
    expect(analyzerEndpointSchema.parse({ ...base, gpu: 'any' })).toEqual({
      ...base,
      gpu: 'any',
      concurrency: 1,
      requestCeilingMs: 1_800_000,
      structuredOutput: 'schema',
      reasoningStyle: 'not_controllable',
      reasoning: 'model-default',
      maxOutputTokens: 0,
    });
  });
});

describe('defaultGpuForBaseUrl', () => {
  it.each([
    ['http://localhost:8080/v1', 'any'],
    ['http://127.0.0.1:8080/v1', 'any'],
    ['http://[::1]:8080/v1', 'any'],
    ['http://192.168.1.20:8080/v1', 'none'],
    ['https://openrouter.ai/api/v1', 'none'],
    ['not a url', 'none'],
  ])('%s → %s', (url, gpu) => {
    expect(defaultGpuForBaseUrl(url)).toBe(gpu);
  });
});

describe('keyOriginMatches', () => {
  it('matches scheme + host + port exactly', () => {
    const stored = { origin: 'http://127.0.0.1:8080' };
    expect(keyOriginMatches(stored, 'http://127.0.0.1:8080/v1/chat/completions')).toBe(true);
    expect(keyOriginMatches(stored, 'http://127.0.0.1:8081/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'https://127.0.0.1:8080/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'http://localhost:8080/v1')).toBe(false);
    expect(keyOriginMatches(undefined, 'http://127.0.0.1:8080/v1')).toBe(false);
    expect(keyOriginMatches(stored, 'not a url')).toBe(false);
  });
});

describe('resolveUnloadUrl', () => {
  const ep = (unloadUrl?: string) =>
    analyzerEndpointSchema.parse({ ...base, gpu: 'any', ...(unloadUrl ? { unloadUrl } : {}) });
  it('returns null without an unload URL, the URL as-is without {model}', () => {
    expect(resolveUnloadUrl(ep(), 'm')).toBeNull();
    expect(resolveUnloadUrl(ep('http://127.0.0.1:8080/api/models/unload'), undefined)).toBe(
      'http://127.0.0.1:8080/api/models/unload',
    );
  });
  it('substitutes one encoded served model (P3: the caller POSTs once per servedModels() entry), and skips when there is none', () => {
    const e = ep('http://127.0.0.1:8080/api/models/unload/{model}');
    expect(resolveUnloadUrl(e, 'org/qwen3:30b')).toBe('http://127.0.0.1:8080/api/models/unload/org%2Fqwen3%3A30b');
    expect(resolveUnloadUrl(e, undefined)).toBeNull();
  });
});

describe('create / update / delete / key decisions', () => {
  it('create fills gpu from the base URL host when omitted', () => {
    expect(applyCreate(empty, base).analyzerEndpoints[0].gpu).toBe('any');
    expect(applyCreate(empty, { ...base, baseUrl: 'http://10.0.0.5:8080/v1' }).analyzerEndpoints[0].gpu).toBe('none');
  });
  it('refuses a missing context size, naming the field', () => {
    const r = refusal(() => applyCreate(empty, { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1' }));
    expect(r).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(r.issues.some((i) => i.path.join('.') === 'contextTokens')).toBe(true);
  });
  it('pins field-aware messages for a bad URL, a missing context size and a too-big request ceiling — never raw zod text (#3084 F5 review, item 4)', () => {
    const badUrl = refusal(() => applyCreate(empty, { ...base, baseUrl: 'not a url' }));
    expect(badUrl.issues).toEqual([{ path: ['baseUrl'], message: 'Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.' }]);
    const noContext = refusal(() => applyCreate(empty, { id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1' }));
    expect(noContext.issues.find((i) => i.path.join('.') === 'contextTokens')?.message).toBe('Context size is required.');
    const bigCeiling = refusal(() => applyCreate(empty, { ...base, requestCeilingMs: 99_000_000 }));
    expect(bigCeiling.issues).toEqual([{ path: ['requestCeilingMs'], message: 'Request ceiling must be at most 240 minutes.' }]);
    /* No-echo, still: the submitted values never appear anywhere in the refusal. */
    expect(JSON.stringify([badUrl, bigCeiling])).not.toMatch(/not a url|99000000|99_000_000/);
  });
  it.each(['ftp://lab/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'ws://lab/v1', 'mailto:a@b.c'])(
    'refuses a %s base URL and unload URL at save, naming the field and never the value (#3525 review)',
    (url) => {
      const badBase = refusal(() => applyCreate(empty, { ...base, baseUrl: url }));
      expect(badBase).toMatchObject({ status: 400, refusal: 'invalid' });
      expect(badBase.issues).toEqual([{ path: ['baseUrl'], message: 'Base URL must start with http:// or https://.' }]);
      const badUnload = refusal(() => applyCreate(empty, { ...base, unloadUrl: url }));
      expect(badUnload).toMatchObject({ status: 400, refusal: 'invalid' });
      expect(badUnload.issues.some((i) => i.path.join('.') === 'unloadUrl')).toBe(true);
      expect(JSON.stringify([badBase, badUnload])).not.toContain(url);
    },
  );
  it("refuses `http:lab/v1` (no //), the shape the server's own message rules out (#3525 review pass 2)", () => {
    const r = refusal(() => applyCreate(empty, { ...base, baseUrl: 'http:lab/v1' }));
    expect(r).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(r.issues).toEqual([{ path: ['baseUrl'], message: 'Base URL must start with http:// or https://.' }]);
  });
  it.each(['HTTP://LAB:8080/v1', 'Https://lab/v1'])('accepts the mixed-case scheme %s and stores it as typed', (url) => {
    const next = applyCreate(empty, { ...base, baseUrl: url });
    expect(next.analyzerEndpoints[0].baseUrl).toBe(url);
  });
  it('friendlyEndpointIssueMessage falls back to the raw zod message for a path/code this map does not cover', () => {
    const issue = { code: 'custom', path: ['extraParams'], message: 'made up for this test' } as unknown as Parameters<typeof friendlyEndpointIssueMessage>[1];
    expect(friendlyEndpointIssueMessage('extraParams', issue)).toBe('made up for this test');
  });
  it.each(['Lab', 'lab_1', '', 'a'.repeat(41)])('refuses the endpoint id %j', (id) => {
    expect(refusal(() => applyCreate(empty, { ...base, id }))).toMatchObject({ status: 400, refusal: 'invalid' });
  });
  it('refuses a duplicate id', () => {
    const once = applyCreate(empty, base);
    expect(refusal(() => applyCreate(once, base))).toMatchObject({ status: 409, refusal: 'duplicate-id' });
  });
  it('refuses an unload URL on another origin, accepts one on the same origin, and never echoes either URL (F5)', () => {
    const r = refusal(() => applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' }));
    expect(r).toMatchObject({ status: 400, refusal: 'unload-off-origin' });
    expect(r.issues).toEqual([{ path: ['unloadUrl'], message: 'must be on the same scheme, host and port as baseUrl' }]);
    expect(JSON.stringify({ message: r.message, issues: r.issues })).not.toContain('9999');
    expect(
      applyCreate(empty, { ...base, unloadUrl: 'http://127.0.0.1:8080/api/models/unload/{model}' }).analyzerEndpoints,
    ).toHaveLength(1);
  });
  it('accepts a custom payload and refuses a protected key, validated by validateExtraParams', () => {
    expect(
      applyUpdate(applyCreate(empty, base), 'lab', { ...base, extraParams: { top_k: 20, min_p: 0.05, presence_penalty: 1.5 } }).analyzerEndpoints[0]
        .extraParams,
    ).toEqual({ top_k: 20, min_p: 0.05, presence_penalty: 1.5 });
    expect(applyCreate(empty, { ...base, extraParams: {} }).analyzerEndpoints).toHaveLength(1);
    const refused = refusal(() =>
      applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'off', extraParams: { chat_template_kwargs: { enable_thinking: true } } }),
    );
    expect(refused).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(refused.issues).toEqual([
      { path: ['extraParams'], message: 'These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.' },
    ]);
    /* The key is protected only under the enable_thinking style, so the reasoning style reaches the check. */
    expect(applyCreate(empty, { ...base, extraParams: { chat_template_kwargs: { enable_thinking: true } } }).analyzerEndpoints).toHaveLength(1);
  });
  it('an update judges the payload only when it changes: an unchanged stale payload saves, a changed one is refused (A7)', () => {
    /* A payload stored before a rule existed (or written straight into user-settings.json). */
    const created = applyCreate(empty, { ...base, extraParams: { top_k: 20 } });
    const stale = {
      ...created,
      analyzerEndpoints: [{ ...created.analyzerEndpoints[0], extraParams: { response_format: { type: 'text' } } }],
    };
    expect(
      applyUpdate(stale, 'lab', { ...base, name: 'Lab renamed', extraParams: { response_format: { type: 'text' } } }).analyzerEndpoints[0],
    ).toMatchObject({ name: 'Lab renamed' });
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, extraParams: { response_format: { type: 'json_object' } } })).issues).toEqual([
      { path: ['extraParams'], message: 'These keys are controlled by Castwright and cannot be set here: response_format.' },
    ]);
  });
  it('an update that only switches the reasoning style re-judges an unchanged payload under the new style (A7)', () => {
    const stored = applyCreate(empty, { ...base, extraParams: { chat_template_kwargs: { enable_thinking: true } } });
    const switched = refusal(() =>
      applyUpdate(stored, 'lab', { ...base, reasoningStyle: 'enable_thinking', reasoning: 'off', extraParams: { chat_template_kwargs: { enable_thinking: true } } }),
    );
    expect(switched.issues).toEqual([
      { path: ['extraParams'], message: 'These keys are controlled by Castwright and cannot be set here: chat_template_kwargs.enable_thinking.' },
    ]);
  });
  it('the same stale payload re-sent with its keys in another order is not re-judged (5b-D10)', () => {
    const created = applyCreate(empty, { ...base, extraParams: { top_k: 20 } });
    const stale = {
      ...created,
      analyzerEndpoints: [{ ...created.analyzerEndpoints[0], extraParams: { response_format: { type: 'text' }, top_k: 20 } }],
    };
    expect(
      applyUpdate(stale, 'lab', { ...base, name: 'Lab renamed', extraParams: { top_k: 20, response_format: { type: 'text' } } }).analyzerEndpoints[0],
    ).toMatchObject({ name: 'Lab renamed' });
  });
  it('accepts a reasoning level its control style offers, and refuses one it does not, naming the style (5a rules)', () => {
    expect(applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'off' }).analyzerEndpoints[0].reasoning).toBe('off');
    expect(applyCreate(empty, { ...base, reasoningStyle: 'reasoning_effort', reasoning: 'none' }).analyzerEndpoints[0].reasoning).toBe('none');
    expect(applyCreate(empty, { ...base, reasoning: 'model-default' }).analyzerEndpoints[0].reasoning).toBe('model-default');
    const wrongStyle = refusal(() => applyCreate(empty, { ...base, reasoningStyle: 'enable_thinking', reasoning: 'none' }));
    expect(wrongStyle).toMatchObject({ status: 400, refusal: 'invalid' });
    expect(wrongStyle.issues).toEqual([
      { path: ['reasoning'], message: 'Reasoning "none" is not offered by the enable_thinking control style (offered: model-default, off, on).' },
    ]);
    const notControllable = refusal(() => applyUpdate(applyCreate(empty, base), 'lab', { ...base, reasoning: 'high' }));
    expect(notControllable.issues).toEqual([
      { path: ['reasoning'], message: 'Reasoning "high" is not offered by the not_controllable control style (offered: model-default).' },
    ]);
  });
  it('an update judges the level only when it changes: an unchanged stale level saves, a changed one is refused (A7)', () => {
    /* A level whose style changed under it (or a table change): stored, and no longer offered. */
    const created = applyCreate(empty, { ...base, reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    const stale = { ...created, analyzerEndpoints: [{ ...created.analyzerEndpoints[0], reasoningStyle: 'not_controllable' as const }] };
    /* The same level sent back with a new name: not judged, so the edit saves. */
    expect(applyUpdate(stale, 'lab', { ...base, name: 'Lab renamed', reasoningStyle: 'not_controllable', reasoning: 'high' }).analyzerEndpoints[0]).toMatchObject({
      name: 'Lab renamed',
      reasoning: 'high',
    });
    /* Changing the level is judged. */
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, reasoningStyle: 'not_controllable', reasoning: 'low' })).issues).toEqual([
      { path: ['reasoning'], message: 'Reasoning "low" is not offered by the not_controllable control style (offered: model-default).' },
    ]);
    /* So is changing the style that decides which levels are offered. */
    expect(refusal(() => applyUpdate(stale, 'lab', { ...base, reasoningStyle: 'enable_thinking', reasoning: 'high' })).issues).toEqual([
      { path: ['reasoning'], message: 'Reasoning "high" is not offered by the enable_thinking control style (offered: model-default, off, on).' },
    ]);
  });
  it('update keeps the id immutable and 404s an unknown endpoint', () => {
    const s = applyCreate(empty, base);
    expect(refusal(() => applyUpdate(s, 'lab', { ...base, id: 'other' }))).toMatchObject({ status: 400 });
    expect(refusal(() => applyUpdate(s, 'nope', base))).toMatchObject({ status: 404, refusal: 'not-found' });
    expect(applyUpdate(s, 'lab', { ...base, name: 'Renamed' }).analyzerEndpoints[0].name).toBe('Renamed');
  });
  it('a key is bound to the base URL origin; moving the base URL marks it origin-mismatch', () => {
    const withKey = applyKey(applyCreate(empty, base), 'lab', '  sk-secret-123  ');
    expect(withKey.analyzerEndpointKeys.lab).toEqual({ origin: 'http://127.0.0.1:8080', key: 'sk-secret-123' });
    expect(endpointKeyStatus(withKey)).toEqual({ lab: 'set' });
    const moved = applyUpdate(withKey, 'lab', { ...base, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(endpointKeyStatus(moved)).toEqual({ lab: 'origin-mismatch' });
    expect(endpointKeyStatus(applyKey(moved, 'lab', null))).toEqual({ lab: 'unset' });
  });
  it('refuses a key containing any control character (C0 or C1, CR, LF, NUL), naming the rule and never echoing the key (P22)', () => {
    const s = applyCreate(empty, base);
    const ctl = (code: number) => String.fromCharCode(code);
    for (const key of ['sk-crlf-secret-1\r\nX-Injected: 1', `sk-nul-secret-1${ctl(0x00)}`, 'sk-tab-secret-1\tx', `sk-c1-secret-1${ctl(0x85)}x`, `sk-del-secret-1${ctl(0x7f)}x`, '\nsk-lead-secret-1']) {
      const r = refusal(() => applyKey(s, 'lab', key));
      expect(r).toMatchObject({ status: 400, refusal: 'invalid' });
      expect(r.message).toBe(ENDPOINT_KEY_CONTROL_CHARACTER_RULE);
      expect(JSON.stringify({ message: r.message, issues: r.issues })).not.toContain('secret-1');
    }
    expect(applyKey(s, 'lab', 'sk-printable-1234').analyzerEndpointKeys.lab.key).toBe('sk-printable-1234');
  });
  it('resolveEndpointApiKey refuses a key bound to another origin than the target URL', () => {
    const withKey = applyKey(applyCreate(empty, base), 'lab', 'sk-secret-123');
    const moved = applyUpdate(withKey, 'lab', { ...base, baseUrl: 'http://127.0.0.1:9090/v1' });
    expect(resolveEndpointApiKey(withKey, withKey.analyzerEndpoints[0], 'http://127.0.0.1:8080/v1/chat/completions')).toBe('sk-secret-123');
    expect(() => resolveEndpointApiKey(moved, moved.analyzerEndpoints[0], moved.analyzerEndpoints[0].baseUrl)).toThrow(AnalyzerKeyOriginError);
    expect(() => resolveEndpointApiKey(withKey, withKey.analyzerEndpoints[0], 'http://10.0.0.5:8080/api/models/unload/m')).toThrow(AnalyzerKeyOriginError);
    expect(resolveEndpointApiKey(applyCreate(empty, base), applyCreate(empty, base).analyzerEndpoints[0], base.baseUrl)).toBeNull();
  });
  it('delete is refused while a saved setting references the endpoint, and removes the key when allowed', () => {
    /* #3084 A5 (re-pin to 80be2f1d) — analyzerPhase0Model/analyzerPhase1Model
       no longer exist as settings fields (#3192's migration moves any saved
       phase model into configOverrides). Both references below are
       configOverrides entries now, not the retired settings fields. */
    const s = applyKey(applyCreate(empty, base), 'lab', 'sk-secret-123');
    const refs = {
      ...DEFAULT_USER_SETTINGS,
      configOverrides: { 'analyzer.phase0.model': 'openai:lab::qwen3:30b', 'analyzer.phase1.model': 'openai:lab::m' },
    };
    const r = refusal(() => applyDelete(s, refs, 'lab'));
    expect(r).toMatchObject({ status: 409, refusal: 'referenced' });
    expect(r.issues).toEqual([
      { path: [], message: 'Advanced setting "analyzer.phase0.model"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
    const after = applyDelete(s, DEFAULT_USER_SETTINGS, 'lab');
    expect(after).toEqual(empty);
  });
});

describe('findEndpointReferences', () => {
  it('matches only ids naming this endpoint', () => {
    /* #3084 A5 — same fix: both phase knobs are configOverrides entries. */
    const settings = {
      ...DEFAULT_USER_SETTINGS,
      defaultAnalysisModel: 'openai:lab::m',
      configOverrides: {
        'analyzer.phase0.model': 'openai:lab2::m',
        'analyzer.phase1.model': 'openai:latest',
        'analyzer.personaGeneration.engine': 'openai:lab::m',
      },
    };
    expect(findEndpointReferences(settings, 'lab')).toEqual([
      'Account setting "defaultAnalysisModel"',
      'Advanced setting "analyzer.personaGeneration.engine"',
    ]);
  });

  it('counts the analyzer fallback target (#3084 P30)', () => {
    const settings = { ...DEFAULT_USER_SETTINGS, configOverrides: { 'analyzer.fallback.target': 'openai:lab::m' } };
    expect(findEndpointReferences(settings, 'lab')).toEqual(['Advanced setting "analyzer.fallback.target"']);
    expect(findEndpointReferences({ ...settings, configOverrides: { 'analyzer.fallback.target': 'gemini' } }, 'lab')).toEqual([]);
  });

  /* Guard: a model-id setting added later (e.g. by the #3141 chain) must be
     classified here, or deleting an endpoint could orphan it silently. */
  it('every user-settings field and analyzer-models knob that can hold a model id is classified', () => {
    const FIELD_EXCLUDED = new Set([
      'analyzerKeepAliveByModel', // map keyed by Ollama tag, not a selection
      'analyzerRateLimitsByModel', // map keyed by model id, not a selection (#3084 PR 3c)
      'analyzerCapabilitiesByModel', // Test records keyed by model id, not a selection (#3084 PR 3c)
      'defaultTtsModelKey', // TTS
      'defaultTtsModelKeyExplicit', // TTS
      'dualModelEnabled', // boolean toggle for the two-model pipeline (user-settings.ts:268), not an id
    ]);
    const fields = Object.keys(userSettingsSchema.shape).filter((k) => /model/i.test(k));
    for (const f of fields) {
      expect(
        (MODEL_ID_SETTING_FIELDS as readonly string[]).includes(f) || FIELD_EXCLUDED.has(f),
        `classify user-settings field "${f}" in MODEL_ID_SETTING_FIELDS or the exclusion list`,
      ).toBe(true);
    }
    const KNOB_EXCLUDED = new Set([
      'analyzer.ollama.model', // Ollama tag
      'analyzer.gemini.model', // Gemini id
      'analyzer.gemini.voiceStyleModel', // Gemini id
      'analyzer.personaGeneration.localModel', // Ollama tag
    ]);
    const knobs = KNOBS.filter(
      (k) => k.group === 'analyzer-models' && (/(\.model|Model|\.engine)$/.test(k.key) || k.type === 'analyzer-engine'),
    );
    for (const k of knobs) {
      expect(
        (MODEL_ID_CONFIG_KNOBS as readonly string[]).includes(k.key) || KNOB_EXCLUDED.has(k.key),
        `classify knob "${k.key}" in MODEL_ID_CONFIG_KNOBS or the exclusion list`,
      ).toBe(true);
    }
  });
});
