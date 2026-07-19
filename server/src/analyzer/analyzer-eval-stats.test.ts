import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aes-'));
vi.mock('../workspace/paths.js', () => ({ telemetryDir: () => dir }));

/* Count readFile calls so the srv-61 test can prove appendAndTrim no longer
   re-reads the whole JSONL on every append. Hoisted (vi.mock is hoisted above
   imports; a plain top-level const would be in the TDZ inside the factory). The
   mock passes every fs/promises export through untouched — only readFile is
   wrapped with a counter — so every other test keeps its real IO behaviour. */
const io = vi.hoisted(() => ({ readFileCalls: 0, failAppendOnce: false }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    readFile: (...args: Parameters<typeof real.readFile>) => {
      io.readFileCalls++;
      return (real.readFile as (...a: unknown[]) => unknown)(...args);
    },
    appendFile: (...args: Parameters<typeof real.appendFile>) => {
      if (io.failAppendOnce) {
        io.failAppendOnce = false;
        return Promise.reject(new Error('disk full'));
      }
      return (real.appendFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import {
  foldPassTiming, canonicalModel, recordPassEval, withPassEval,
  readAnalyzerEvalRecords, appendAnalyzerEval, analyzerEvalStatsFilePath,
  ANALYZER_EVAL_MAX_LINES, __resetAnalyzerEvalQueueForTest,
  type RawEvalTiming, type AnalyzerEvalRecord,
} from './analyzer-eval-stats.js';
import { readFileSync, writeFileSync } from 'node:fs';

const t = (o: Partial<RawEvalTiming>): RawEvalTiming => ({
  model: 'qwen36-castwright', evalCount: 0, evalDuration: 0,
  promptEvalCount: 0, promptEvalDuration: 0, loadDuration: 0, ...o,
});

beforeEach(() => { __resetAnalyzerEvalQueueForTest(); try { writeFileSync(analyzerEvalStatsFilePath(), ''); } catch {} });

describe('foldPassTiming', () => {
  it('token-weights tok/s across sub-calls (not a mean of rates)', () => {
    // 100 tok @ 100 t/s (1e9 ns) + 100 tok @ 25 t/s (4e9 ns).
    // Token-weighted: 200 tok / 5s = 40 t/s. A mean of per-call rates would give 62.5.
    const f = foldPassTiming([t({ evalCount: 100, evalDuration: 1e9 }), t({ evalCount: 100, evalDuration: 4e9 })]);
    expect(f?.evalTokS).toBeCloseTo(40, 5);
    expect(f?.evalCount).toBe(200);
    expect(f?.subCalls).toBe(2);
  });
  it('loadMs is the MAX over sub-calls, in ms', () => {
    const f = foldPassTiming([t({ loadDuration: 0 }), t({ loadDuration: 610_000_000 })]);
    expect(f?.loadMs).toBeCloseTo(610, 5);
  });
  it('null tok/s when summed duration is 0', () => {
    expect(foldPassTiming([t({ evalCount: 5, evalDuration: 0 })])?.evalTokS).toBeNull();
  });
  it('returns null for an empty accumulator', () => {
    expect(foldPassTiming([])).toBeNull();
  });
  it('canonicalises the model tag', () => {
    expect(canonicalModel('qwen36-castwright')).toBe('qwen36-castwright:latest');
    expect(foldPassTiming([t({ model: 'gemma4-e4b-8gb' })])?.model).toBe('gemma4-e4b-8gb:latest');
  });
});

describe('recordPassEval', () => {
  it('appends one folded record; empty acc is a no-op', async () => {
    await recordPassEval([], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1, chunkCount: 1, outcome: 'ok' });
    await recordPassEval([t({ evalCount: 50, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: 'Book', stage: 'stage2-ch', chapterId: 3, chunkCount: 2, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ manuscriptId: 'm', stage: 'stage2-ch', chapterId: 3, chunkCount: 2, evalTokS: 50, subCalls: 1, outcome: 'ok' });
  });
});

describe('withPassEval', () => {
  it('accumulates sub-calls fired on the call and emits one record', async () => {
    const call: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    const r = await withPassEval(call, { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
      async () => { call.onEvalTiming!(t({ evalCount: 10, evalDuration: 1e9 })); call.onEvalTiming!(t({ evalCount: 30, evalDuration: 1e9 })); return { chunkCount: 4 }; },
      (res) => res.chunkCount);
    expect(r.chunkCount).toBe(4);
    const recs = await readAnalyzerEvalRecords();
    expect(recs[0]).toMatchObject({ subCalls: 2, evalCount: 40, chunkCount: 4, outcome: 'ok' });
  });
  it('records outcome:failed and rethrows when the pass throws', async () => {
    const call: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    await expect(withPassEval(call, { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
      async () => { call.onEvalTiming!(t({ evalCount: 5, evalDuration: 1e9 })); throw new Error('boom'); })
    ).rejects.toThrow('boom');
    const recs = await readAnalyzerEvalRecords();
    expect(recs[0]).toMatchObject({ outcome: 'failed', chunkCount: null, subCalls: 1 });
  });
  it('two concurrent passes on DISTINCT calls do not cross-contaminate', async () => {
    const a: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    const b: { onEvalTiming?: (t: RawEvalTiming) => void } = {};
    await Promise.all([
      withPassEval(a, { manuscriptId: 'A', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
        async () => { a.onEvalTiming!(t({ evalCount: 100, evalDuration: 1e9 })); await new Promise((r) => setTimeout(r, 5)); a.onEvalTiming!(t({ evalCount: 100, evalDuration: 1e9 })); }),
      withPassEval(b, { manuscriptId: 'B', bookTitle: null, stage: 'stage2-ch', chapterId: 1 },
        async () => { b.onEvalTiming!(t({ evalCount: 300, evalDuration: 1e9 })); }),
    ]);
    const recs = await readAnalyzerEvalRecords();
    const byBook = Object.fromEntries(recs.map((r) => [r.manuscriptId, r]));
    expect(byBook.A.evalCount).toBe(200);
    expect(byBook.B.evalCount).toBe(300);
  });
});

describe('store IO', () => {
  it('reads newest-first and honours limit', async () => {
    for (let i = 1; i <= 3; i++) await recordPassEval([t({ evalCount: i, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: i, chunkCount: 1, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords(2);
    expect(recs.map((r) => r.chapterId)).toEqual([3, 2]);
  });
  it('skips a corrupt trailing line', async () => {
    await recordPassEval([t({ evalCount: 1, evalDuration: 1e9 })], { manuscriptId: 'm', bookTitle: null, stage: 'stage2-ch', chapterId: 1, chunkCount: 1, outcome: 'ok' });
    writeFileSync(analyzerEvalStatsFilePath(), readFileSync(analyzerEvalStatsFilePath(), 'utf8') + '{ not json\n');
    expect(await readAnalyzerEvalRecords()).toHaveLength(1);
  });
  it('trims to the cap, keeping newest', async () => {
    const lines = Array.from({ length: ANALYZER_EVAL_MAX_LINES + 5 }, (_, i) =>
      JSON.stringify({ at: new Date(0).toISOString(), manuscriptId: 'm', bookTitle: null, model: 'x:latest', stage: 'stage2-ch', chapterId: i, evalTokS: 1, promptTokS: null, evalCount: 1, loadMs: 0, subCalls: 1, chunkCount: 1, outcome: 'ok' } as AnalyzerEvalRecord)).join('\n') + '\n';
    writeFileSync(analyzerEvalStatsFilePath(), lines);
    await appendAnalyzerEval({ at: new Date().toISOString(), manuscriptId: 'm', bookTitle: null, model: 'x:latest', stage: 'stage2-ch', chapterId: 9999, evalTokS: 1, promptTokS: null, evalCount: 1, loadMs: 0, subCalls: 1, chunkCount: 1, outcome: 'ok' });
    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(ANALYZER_EVAL_MAX_LINES);
    expect(recs[0].chapterId).toBe(9999); // newest kept
  });
});

describe('appendAndTrim — in-memory line-count tracking (srv-61)', () => {
  const rec = (chapterId: number): AnalyzerEvalRecord => ({
    at: new Date().toISOString(), manuscriptId: 'm', bookTitle: null, model: 'x:latest',
    stage: 'stage2-ch', chapterId, evalTokS: 1, promptTokS: null, evalCount: 1, loadMs: 0,
    subCalls: 1, chunkCount: 1, outcome: 'ok',
  });

  it('does not re-read the whole file on every append (tracks the count in memory)', async () => {
    // First append establishes the count from disk — exactly ONE read. Asserting
    // this proves the counter mock is actually intercepting the module's readFile,
    // so the no-further-reads assertion below can't be a placebo pass.
    io.readFileCalls = 0;
    await appendAnalyzerEval(rec(1));
    const afterFirst = io.readFileCalls;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    // Subsequent below-cap appends must NOT re-read the whole file.
    await appendAnalyzerEval(rec(2));
    await appendAnalyzerEval(rec(3));
    expect(io.readFileCalls).toBe(afterFirst);
  });

  it('resets the in-memory count on an IO error so the next append re-establishes from disk', async () => {
    await appendAnalyzerEval(rec(1)); // establishes the count from disk
    await appendAnalyzerEval(rec(2)); // steady increment — no read
    io.readFileCalls = 0;
    io.failAppendOnce = true;
    await appendAnalyzerEval(rec(3)); // appendFile throws → catch resets count to null
    expect(io.readFileCalls).toBe(0); // the failed append never reached the read
    await appendAnalyzerEval(rec(4)); // count was null → MUST re-establish from disk
    expect(io.readFileCalls).toBe(1);
    // Store stays consistent: 3 failed to append, 1/2/4 landed.
    const recs = await readAnalyzerEvalRecords();
    expect(recs.map((r) => r.chapterId).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 4]);
  });

  it('trims via the in-memory counter as appends cross the cap, keeping newest', async () => {
    // Pre-fill just under the cap so a handful of real appends cross it and
    // exercise the establish → increment → trim → post-trim-increment path.
    const base = Array.from({ length: ANALYZER_EVAL_MAX_LINES - 2 }, (_, i) => JSON.stringify(rec(i))).join('\n') + '\n';
    writeFileSync(analyzerEvalStatsFilePath(), base);
    for (let i = 0; i < 5; i++) await appendAnalyzerEval(rec(1000 + i)); // MAX-2+5 = MAX+3
    const recs = await readAnalyzerEvalRecords();
    expect(recs).toHaveLength(ANALYZER_EVAL_MAX_LINES);
    expect(recs[0].chapterId).toBe(1004); // newest kept after repeated trims
  });
});
