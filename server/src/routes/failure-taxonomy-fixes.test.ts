/* #3084 wave 2b, F7 — the cross-cutting guard for `reasoningOverflowFixes` (and
   for every fix a later wave appends to it: 3b endpoints, 5a reasoning level,
   5b payload all extend THIS file rather than writing a new one).

   It checks a property of the data, not of one function: every `settingKey` is a
   real registry knob and every `wikiPage` names a real file under `docs/wiki/`.
   That is also why the file is named `-fixes` while the SOURCE lives in
   failure-taxonomy.ts — there is no `failure-taxonomy-fixes.ts`.

   The Gemini catalog seed below is load-bearing, not decorative: the
   conditional `analyzer.gemini.maxOutputTokens` fix only appears when the
   model's `outputTokenLimit` is KNOWN and the configured cap sits below it, so
   without the seed that branch never runs and its `settingKey` would never be
   checked by anything here. */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { reasoningOverflowFixes, classifyAnalysisFailure, type AnalysisFailureFix } from './failure-taxonomy.js';
import { allKnobs } from '../config/registry.js';
import { AnalyzerReasoningOverflowError } from '../analyzer/errors.js';
import { analyzerEndpointSchema, type AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { _seedGeminiCatalogForTest, _resetGeminiCatalogForTest } from '../analyzer/catalog/gemini-catalog.js';

/* #3084 F7 — resolved from this FILE's own location, never cwd-relative: the
   server test suite runs with cwd `server/`, so a bare 'docs/wiki/...' would
   resolve to `server/docs/wiki/...`, which does not exist. Mirrors
   `src/lib/wiki-links.test.ts:20-21`'s `fileURLToPath(import.meta.url)`
   pattern and W3cd's later append to this same file. */
const wikiDir = fileURLToPath(new URL('../../../docs/wiki/', import.meta.url));

const CONTEXTS = [
  { transport: 'gemini' as const, model: 'gemini-3.6-flash' },
  { transport: 'ollama' as const, model: 'qwen3.5:9b' },
  { transport: 'openai' as const, model: 'm', endpointId: 'lab' },
];

describe('reasoningOverflowFixes — every settingKey/wikiPage is real (#3084 wave 2b, F7)', () => {
  afterEach(() => {
    _resetGeminiCatalogForTest();
    delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
  });

  it('every settingKey allKnobs() actually has, across every branch including the conditional one', () => {
    const keys = new Set(allKnobs().map((k) => k.key));
    /* Seed the catalog with a KNOWN outputTokenLimit, then configure a value
       below it — only this combination makes the conditional Gemini
       maxOutputTokens fix actually appear. Without the seed,
       getCachedGeminiModelInfo(model) is undefined and that branch never
       runs at all, so its settingKey would never be checked by anything
       below — proving the seed is load-bearing, not decorative. */
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    process.env.ANALYZER_MAX_OUTPUT_TOKENS = '4096'; // below the seeded 65536
    const gemini = reasoningOverflowFixes(CONTEXTS[0]);
    expect(gemini.some((f) => f.settingKey === 'analyzer.gemini.maxOutputTokens')).toBe(true);
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.settingKey) expect(keys.has(fix.settingKey), fix.settingKey).toBe(true);
      }
    }
  });

  it('every endpointField names a real analyzerEndpointSchema field (#3084 F7, 3b)', () => {
    const fields = new Set(Object.keys(analyzerEndpointSchema.shape));
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.endpointField) expect(fields.has(fix.endpointField.field), fix.endpointField.field).toBe(true);
      }
    }
  });

  it('every wikiPage names a file that exists under docs/wiki/ (resolved from this file, not cwd)', () => {
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.wikiPage) expect(existsSync(`${wikiDir}${fix.wikiPage}.md`), fix.wikiPage).toBe(true);
      }
    }
  });

  it('never offers the thinking window as a fix (it bounds time, not output room)', () => {
    for (const ctx of CONTEXTS) {
      expect(reasoningOverflowFixes(ctx).map((f) => f.settingKey)).not.toContain(
        'analyzer.gemini.thinkingIdleTimeoutMs',
      );
    }
  });

});

describe('reasoningOverflowFixes — openai transport (#3084 F7)', () => {
  afterEach(() => _resetUserSettingsCache());

  const LAB_ENDPOINT: AnalyzerEndpoint = {
    id: 'lab',
    name: 'Lab box',
    baseUrl: 'http://127.0.0.1:8080/v1',
    gpu: 'any',
    concurrency: 1,
    requestCeilingMs: 10_000,
    structuredOutput: 'schema',
    reasoningStyle: 'not_controllable',
    reasoning: 'model-default',
    maxOutputTokens: 0,
    contextTokens: 32_768,
  };

  it('offers the endpoint\'s own maxOutputTokens/contextTokens and the stage fractions, naming the endpoint, never reasoning or payload, and no wikiPage yet', () => {
    /* Structural, not an exact-count toEqual on the whole array: a later wave may
       append a `Read:` entry to any reasoningOverflowFixes result. This asserts the
       ACTIONABLE rows this branch contributes, exactly, and that every `Read:` entry
       sits after every actionable one. */
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [LAB_ENDPOINT],
    });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'lab' });
    const isRead = (f: { label: string }) => f.label.startsWith('Read:');
    const actionable = fixes.filter((f) => !isRead(f));
    const reads = fixes.filter(isRead);
    expect(actionable).toEqual([
      expect.objectContaining({ label: expect.stringContaining('Lab box'), endpointField: { endpointId: 'lab', field: 'maxOutputTokens' } }),
      expect.objectContaining({ label: expect.stringContaining('Lab box'), endpointField: { endpointId: 'lab', field: 'contextTokens' } }),
      expect.objectContaining({ settingKey: 'analyzer.stage1.localInputFraction' }),
      expect.objectContaining({ settingKey: 'analyzer.stage2.localInputFraction' }),
    ]);
    const lastActionableIndex = fixes.length - 1 - [...fixes].reverse().findIndex((f) => !isRead(f));
    const firstReadIndex = fixes.findIndex(isRead);
    if (reads.length > 0) expect(firstReadIndex).toBeGreaterThan(lastActionableIndex);
    expect(fixes.every((f) => f.wikiPage === undefined)).toBe(true);
    expect(fixes.some((f) => f.settingKey?.includes('reasoning') || ('endpointField' in f && f.endpointField?.field === 'reasoning'))).toBe(false);
  });

  it('falls back to the endpoint id when the endpoint has been deleted since the failure', () => {
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const fixes = reasoningOverflowFixes({ transport: 'openai', model: 'm', endpointId: 'gone' });
    expect(fixes[0].label).toContain('gone');
  });

  it('classifyAnalysisFailure passes the real error\'s endpointId through to the fixes (review finding)', () => {
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [LAB_ENDPOINT],
    });
    const err = new AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512, { endpointId: 'lab' });
    const failure = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(failure.fixes?.some((f) => 'endpointField' in f && f.endpointField?.endpointId === 'lab')).toBe(true);
  });
});

describe('reasoningOverflowFixes — the RIGHT key, not just a valid one (#3084 wave 2b, F7)', () => {
  it('Ollama names numCtx, the binding limit — not numPredict', () => {
    const keys = reasoningOverflowFixes({ transport: 'ollama', model: 'qwen3.5:9b' }).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.ollama.numCtx');
    expect(keys).not.toContain('analyzer.ollama.numPredict');
  });

  it('Ollama with a positive num_predict names it FIRST and stops calling num_ctx the binding limit; at the default the list is unchanged', () => {
    const ctx = { transport: 'ollama' as const, model: 'qwen3.5:9b' };
    const defaultFixes = reasoningOverflowFixes(ctx);
    expect(defaultFixes.map((f) => f.settingKey)).toEqual([
      'analyzer.ollama.numCtx',
      'analyzer.stage1.localInputFraction',
      'analyzer.stage2.localInputFraction',
      undefined,
      undefined,
    ]);
    expect(defaultFixes[0].label).toBe('Raise Ollama num_ctx (the binding limit)');
    try {
      process.env.ANALYZER_NUM_PREDICT = '2048';
      const pinned = reasoningOverflowFixes(ctx);
      expect(pinned[0].settingKey).toBe('analyzer.ollama.numPredict');
      expect(pinned[1].settingKey).toBe('analyzer.ollama.numCtx');
      expect(pinned[1].label).not.toContain('binding');
      process.env.ANALYZER_NUM_PREDICT = '-1';
      expect(reasoningOverflowFixes(ctx)).toEqual(defaultFixes);
    } finally {
      delete process.env.ANALYZER_NUM_PREDICT;
    }
  });

  /* Output-only: an overflow is about OUTPUT room, and Gemini's input and output
     limits are separate, so a smaller request body never helps — the copy says
     "splitting never helps", so the fixes must not offer it. */
  it('Gemini offers no lower-input fix (no maxInputTokensPerRequest / outputHeavyChunkChars)', () => {
    const keys = reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.6-flash' }).map((f) => f.settingKey);
    expect(keys).not.toContain('analyzer.gemini.maxInputTokensPerRequest');
    expect(keys).not.toContain('analyzer.gemini.outputHeavyChunkChars');
  });

  it('Gemini at Auto (0) offers no raise-output entry; a pinned cap below the known limit does', () => {
    _seedGeminiCatalogForTest('test-key', [{ id: 'gemini-3.6-flash', outputTokenLimit: 65_536 }]);
    try {
      process.env.ANALYZER_MAX_OUTPUT_TOKENS = '0';
      const auto = reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.6-flash' }).map((f) => f.settingKey);
      expect(auto).not.toContain('analyzer.gemini.maxOutputTokens');
      process.env.ANALYZER_MAX_OUTPUT_TOKENS = '4096';
      const pinned = reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.6-flash' }).map((f) => f.settingKey);
      expect(pinned).toContain('analyzer.gemini.maxOutputTokens');
    } finally {
      _resetGeminiCatalogForTest();
      delete process.env.ANALYZER_MAX_OUTPUT_TOKENS;
    }
  });

  it('every "Read:" entry comes after every actionable fix, at least one exists, and none carries a settingKey (#3084 F7, wave-stable structure)', () => {
    for (const ctx of [{ transport: 'gemini' as const, model: 'gemini-3.6-flash' }, { transport: 'ollama' as const, model: 'qwen3.5:9b' }]) {
      const fixes = reasoningOverflowFixes(ctx);
      const isRead = (f: AnalysisFailureFix) => f.label.startsWith('Read:');
      const lastNonReadIndex = fixes.reduce((acc, f, i) => (isRead(f) ? acc : i), -1);
      const firstReadIndex = fixes.findIndex(isRead);
      // (a) at least one Read: entry exists
      expect(firstReadIndex).toBeGreaterThanOrEqual(0);
      // (b) every Read: entry comes after every non-Read: fix
      expect(firstReadIndex).toBeGreaterThan(lastNonReadIndex);
      // (c) no Read: entry carries a settingKey — the wiki link is its own
      // entry, never a field bolted onto a setting-changing fix.
      for (const f of fixes) if (isRead(f)) expect(f.settingKey, JSON.stringify(f)).toBeUndefined();
      expect(fixes.some((f) => f.label === 'Switch to a different analyzer model' && !f.settingKey && !isRead(f))).toBe(true);
    }
  });
});
