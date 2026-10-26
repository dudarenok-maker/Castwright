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
import { reasoningOverflowFixes, targetInputTooLargeFixes, classifyAnalysisFailure, type AnalysisFailureFix } from './failure-taxonomy.js';
import { allKnobs, getKnob } from '../config/registry.js';
import { AnalyzerReasoningOverflowError, type TransportKind } from '../analyzer/errors.js';
import { GEMINI_REASONING_TABLE, geminiReasoningRow } from '../analyzer/reasoning.js';
import type { ReasoningLevel } from '../analyzer/reasoning-level.js';
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
  { transport: 'ollama' as const, model: 'qwen3.5:9b', reasoningLevel: 'on' as const },
  { transport: 'gemini' as const, model: 'gemma-4-31b-it', reasoningLevel: 'on' as const },
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

  it('offers the endpoint\'s own maxOutputTokens/contextTokens and the stage fractions, naming the endpoint, never payload, and no reasoning row for a not_controllable endpoint (5.5-D2), and only the trailing Read: entry links a page', () => {
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
    expect(actionable.every((f) => f.wikiPage === undefined)).toBe(true);
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

  it('targetInputTooLargeFixes names only registry keys (#3084 P30)', () => {
    for (const [family, transport] of [['context', 'ollama'], ['context', 'openai'], ['requestCap', 'gemini']] as const) {
      const fixes = targetInputTooLargeFixes(family, transport);
      expect(fixes.length).toBeGreaterThan(0);
      for (const fix of fixes) {
        expect(fix.settingKey, fix.label).toBeDefined();
        expect(getKnob(fix.settingKey!), fix.settingKey).toBeDefined();
      }
    }
  });

  it('targetInputTooLargeFixes offers no input-fraction fix for a context target (#3710 M3)', () => {
    for (const transport of ['ollama', 'openai', 'gemini'] as const) {
      expect(targetInputTooLargeFixes('context', transport).map((f) => f.settingKey)).not.toContain('analyzer.stage1.localInputFraction');
      expect(targetInputTooLargeFixes('context', transport).map((f) => f.settingKey)).not.toContain('analyzer.stage2.localInputFraction');
    }
  });

  it('every fix wikiPage names a wiki page that exists, with no anchor (#3084 P33)', () => {
    const fixes = [
      ...reasoningOverflowFixes({ transport: 'openai', model: 'qwen3-30b', endpointId: 'lab' }),
      ...reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.5-flash' }),
      ...reasoningOverflowFixes({ transport: 'ollama', model: 'qwen3.5:4b' }),
    ];
    const openai = reasoningOverflowFixes({ transport: 'openai', model: 'qwen3-30b', endpointId: 'lab' });
    /* The settled fixes/reads rule, asserted by structure rather than position: actionable fixes first, then
       every `Read:` entry, and only a `Read:` entry links a page. A later wave can add a fix or a read and
       this stays green. */
    const firstRead = openai.findIndex((f) => f.label.startsWith('Read:'));
    expect(firstRead).toBeGreaterThan(0);
    expect(openai.slice(0, firstRead).every((f) => !f.label.startsWith('Read:') && f.wikiPage === undefined)).toBe(true);
    expect(openai.slice(firstRead).every((f) => f.label.startsWith('Read:') && typeof f.wikiPage === 'string')).toBe(true);
    expect(openai).toContainEqual({ label: 'Read: When a model thinks past its output limit', wikiPage: 'OpenAI-Compatible-Analyzer-Endpoints' });
    for (const fix of fixes.filter((f) => f.wikiPage)) {
      expect(fix.wikiPage, fix.label).toMatch(/^[A-Za-z0-9-]+$/);
      expect(existsSync(fileURLToPath(new URL(`../../../docs/wiki/${fix.wikiPage}.md`, import.meta.url))), fix.wikiPage).toBe(true);
    }
  });
});

describe('reasoningOverflowFixes — reasoning-level fixes (#3084 wave 5a, F7, extension accepted 2026-09-13)', () => {
  afterEach(() => _resetUserSettingsCache());

  /* err.reasoningLevel is set by Task 5.1 at the actual throw site (mapFinish / runFreeText); this
     test drives reasoningOverflowFixes the same way classifyAnalysisFailure's real call site does —
     through the error instance, never a hand-built ctx — so the opts-object shape cannot drift
     (review pass 2, item 1). The endpoint case is 5.5b-ii's. */
  const overflow = (transport: TransportKind, model: string, reasoningLevel?: ReasoningLevel, endpointId?: string) =>
    classifyAnalysisFailure(new AnalyzerReasoningOverflowError(transport, model, 812, { endpointId, reasoningLevel }), model).fixes ?? [];

  it('an endpoint gets a fix pointing at its own reasoning field only on a controllable style above its floor (5.5-D2)', () => {
    const lab = (reasoningStyle: 'not_controllable' | 'enable_thinking' | 'reasoning_effort') =>
      analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab box', baseUrl: 'http://127.0.0.1:8081/v1', gpu: 'none', contextTokens: 32768, reasoningStyle });
    const reasoningFix = (fixes: ReturnType<typeof overflow>) => fixes.find((f) => f.endpointField?.field === 'reasoning');
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab('enable_thinking')] });
    expect(reasoningFix(overflow('openai', 'm', 'on', 'lab'))).toEqual({ label: "Lower Lab box's reasoning level", endpointField: { endpointId: 'lab', field: 'reasoning' } });
    expect(reasoningFix(overflow('openai', 'm', 'model-default', 'lab'))).toBeDefined();
    expect(reasoningFix(overflow('openai', 'm', 'off', 'lab'))).toBeUndefined();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab('reasoning_effort')] });
    expect(reasoningFix(overflow('openai', 'm', 'low', 'lab'))).toBeDefined();
    expect(reasoningFix(overflow('openai', 'm', 'none', 'lab'))).toBeUndefined();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab('not_controllable')] });
    expect(reasoningFix(overflow('openai', 'm', 'model-default', 'lab'))).toBeUndefined();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    expect(reasoningFix(overflow('openai', 'm', 'on', 'gone'))).toBeUndefined();
  });

  /* Corrected, review pass 2, item 10a: 'model-default' also gets the fix (Ollama can still think
     with no `think` field sent), only an explicit 'off' or no level at all does not. */
  it('Ollama at on, a named level, or model-default gets a fix; at off or unset it does not', () => {
    expect(overflow('ollama', 'q:4b', 'on').find((f) => f.reasoningSetting)?.reasoningSetting).toEqual({ engine: 'ollama', model: 'q:4b' });
    expect(overflow('ollama', 'q:4b', 'medium').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('ollama', 'q:4b', 'model-default').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('ollama', 'q:4b', 'off').some((f) => f.reasoningSetting)).toBe(false);
    expect(overflow('ollama', 'q:4b', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('Gemini at an explicit level with a lower rung gets a fix naming it; at the lowest rung it does not', () => {
    const medium = overflow('gemini', 'gemini-3.6-flash', 'medium');
    const fix = medium.find((f) => f.reasoningSetting);
    expect(fix?.reasoningSetting).toEqual({ engine: 'gemini', model: 'gemini-3.6-flash' });
    expect(fix?.label).toContain('"low"');
    expect(fix?.wikiPage).toBeUndefined(); // review pass 2, item 10b
    expect(overflow('gemini', 'gemini-3.8-flash', 'low').some((f) => f.reasoningSetting)).toBe(false);
  });

  it('Gemma 4 at explicit on gets the fix (lower to off); at off or model-default it does not', () => {
    expect(overflow('gemini', 'gemma-4-31b-it', 'on').some((f) => f.reasoningSetting)).toBe(true);
    expect(overflow('gemini', 'gemma-4-31b-it', 'off').some((f) => f.reasoningSetting)).toBe(false);
    expect(overflow('gemini', 'gemma-4-31b-it', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('a 2.5 id (no row, F2) never gets a reasoning-level fix, at any level', () => {
    expect(overflow('gemini', 'gemini-2.5-flash', 'high').some((f) => f.reasoningSetting)).toBe(false);
  });

  /* Review pass 1 (2026-09-13) — the level actually run, via defaultLevel, decides model-default cases. */
  it('Flash-Lite at model-default (defaultLevel minimal) gets no level fix — already at the lowest rung', () => {
    expect(overflow('gemini', 'gemini-3.5-flash-lite', undefined).some((f) => f.reasoningSetting)).toBe(false);
  });

  it('3.8 Flash at model-default (defaultLevel medium) suggests trying low', () => {
    const fix = overflow('gemini', 'gemini-3.8-flash', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"low"');
  });

  it('3.1 Pro at model-default (defaultLevel high) suggests trying medium', () => {
    const fix = overflow('gemini', 'gemini-3.1-pro-preview', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"medium"');
  });

  /* review pass 2, item 7: 3 Flash (bare, no dot-version) has its own defaultLevel (high), distinct
     from 3.5/3.6 Flash's medium. */
  it('3 Flash (gemini-3-flash-preview) at model-default (defaultLevel high) suggests trying medium', () => {
    const fix = overflow('gemini', 'gemini-3-flash-preview', undefined).find((f) => f.reasoningSetting);
    expect(fix?.label).toContain('"medium"');
  });
});

describe('reasoningOverflowFixes — reasoningSetting guards (#3084 wave 5a, F7)', () => {
  it('every reasoningSetting.engine is gemini or ollama', () => {
    for (const ctx of CONTEXTS) {
      for (const fix of reasoningOverflowFixes(ctx)) {
        if (fix.reasoningSetting) expect(['gemini', 'ollama']).toContain(fix.reasoningSetting.engine);
      }
    }
  });

  /* Corrected, review pass 2, item 3: one real, verified model id per table row, in the SAME order
     as GEMINI_REASONING_TABLE (a regex-source-derived id matched no row and checked nothing). */
  const ROW_FIXTURE_IDS = [
    'gemini-3.5-flash-lite', // Flash-Lite (minimal/low/medium/high, defaultLevel minimal)
    'gemini-3-flash-preview', // 3 Flash, bare (minimal/low/medium/high, defaultLevel high)
    'gemini-3.6-flash', // 3.5/3.6 Flash (minimal/low/medium/high, defaultLevel medium)
    'gemini-3.8-flash', // 3.7/3.8 Flash (low/medium/high, defaultLevel medium)
    'gemini-3.1-pro', // 3.1 Pro (low/medium/high, defaultLevel high)
    'gemma-4-31b-it', // Gemma 4 (off/on, gemmaOnOff)
  ] as const;

  describe('ROW_FIXTURE_IDS — one real id per GEMINI_REASONING_TABLE row', () => {
    it('the fixture has exactly one id per table row', () => {
      expect(ROW_FIXTURE_IDS.length).toBe(GEMINI_REASONING_TABLE.length);
    });
    it('every fixture id resolves back to its own row, by identity, in table order', () => {
      ROW_FIXTURE_IDS.forEach((id, i) => {
        expect(geminiReasoningRow(id), id).toBe(GEMINI_REASONING_TABLE[i]);
      });
    });
  });

  /* Review pass 1 (2026-09-13) — the guard checks the RULE: exhaustively, for every (row, level) the
     table can produce, a Gemini fix exists iff there is a strictly lower real rung to name, and never
     for gemmaOnOff at model-default. */
  it('a Gemini reasoning fix exists iff a strictly lower rung is available for the level actually run', () => {
    GEMINI_REASONING_TABLE.forEach((row, i) => {
      const model = ROW_FIXTURE_IDS[i];
      const levelsToCheck: (ReasoningLevel | undefined)[] =
        row.control === 'gemmaOnOff' ? ['on', 'off', undefined] : [...row.levels.filter((l) => l !== 'model-default'), undefined];
      for (const level of levelsToCheck) {
        const fixes = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('gemini', model, 812, { reasoningLevel: level }), model).fixes ?? [];
        const hasFix = fixes.some((f) => f.reasoningSetting);
        if (row.control === 'gemmaOnOff') {
          expect(hasFix, `${model} at ${level}`).toBe(level === 'on');
        } else {
          const effective = level && level !== 'model-default' ? level : row.defaultLevel;
          const expectFix = effective !== undefined && row.levels.indexOf(effective) > 1;
          expect(hasFix, `${model} at ${level ?? 'model-default'}`).toBe(expectFix);
        }
      }
    });
  });
});
