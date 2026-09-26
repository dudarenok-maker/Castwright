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
import { reasoningOverflowFixes, type AnalysisFailureFix } from './failure-taxonomy.js';
import { allKnobs } from '../config/registry.js';
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

  it('openai returns no fixes yet (3b adds them)', () => {
    expect(reasoningOverflowFixes(CONTEXTS[2])).toEqual([]);
  });
});

describe('reasoningOverflowFixes — the RIGHT key, not just a valid one (#3084 wave 2b, F7)', () => {
  it('Ollama names numCtx, the binding limit — not numPredict', () => {
    const keys = reasoningOverflowFixes({ transport: 'ollama', model: 'qwen3.5:9b' }).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.ollama.numCtx');
    expect(keys).not.toContain('analyzer.ollama.numPredict');
  });

  it('Gemini names maxInputTokensPerRequest and outputHeavyChunkChars', () => {
    const keys = reasoningOverflowFixes({ transport: 'gemini', model: 'gemini-3.6-flash' }).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.gemini.maxInputTokensPerRequest');
    expect(keys).toContain('analyzer.gemini.outputHeavyChunkChars');
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
