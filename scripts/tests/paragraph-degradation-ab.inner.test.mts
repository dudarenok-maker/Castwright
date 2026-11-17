/* Assertions for server/scripts/paragraph-degradation-ab.mts, the capture half of
   the #2254 runner (spec §4.3, R6-5, R7-9, R7-10, owner decision 20, R10-6).
   Run under tsx; paragraph-degradation-ab.test.mjs wraps this so
   `npm run test:hooks` sees it. No network: the analyzer is a mock. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCapture,
  main,
  captureFileName,
  readSavedCaptures,
  type RunnerDeps,
  type ManifestEntry,
  type SavedCapture,
} from '../../server/scripts/paragraph-degradation-ab.mts';
import { configValue } from '../../server/src/config/resolver.ts';
import { captureChapterStages } from '../../server/src/analyzer/attribution-eval/run-eval.ts';
import type { Analyzer } from '../../server/src/analyzer/index.ts';

const INITIAL_BUDGET = configValue<number>('analyzer.structure.maxWindowsPerBook');
const BODY = [
  '— Ты уверен, что это сработает? — спросил Антон.',
  '— Да, вполне, — ответила Ольга.',
  '— Тогда идём, — сказал Борис.',
  '— Хорошо.',
  '— После тебя.',
].join('\n');
const ROSTER = {
  characters: [
    { id: 'anton', name: 'Антон', gender: 'male' },
    { id: 'olga', name: 'Ольга', gender: 'female' },
    { id: 'boris', name: 'Борис', gender: 'male' },
  ],
};

function fixtureDir(n: number): { dir: string; manifest: ManifestEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pda-ab-'));
  const rosterPath = join(dir, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify(ROSTER));
  const manifest: ManifestEntry[] = [];
  for (let id = 1; id <= n; id++) {
    const chapterTextPath = join(dir, `ch${id}.txt`);
    writeFileSync(chapterTextPath, `${BODY}\n`.repeat(id));
    manifest.push({ chapterId: id, chapterTextPath, rosterPath });
  }
  return { dir, manifest };
}

const scratchOf = (dir: string): string => join(dir, 'scratch');

/** Listing plus every file's bytes, to prove a refusal left the directory alone. */
function snapshot(scratch: string): string {
  if (!existsSync(scratch)) return '(absent)';
  return readdirSync(scratch)
    .sort()
    .map((f) => `${f}:${createHash('sha256').update(readFileSync(join(scratch, f))).digest('hex')}`)
    .join('\n');
}

const mockAnalyzer = {} as Analyzer;

/** A fake capture that spends one structure window per chapter and records what it was given. */
function fakeDeps(over: Partial<RunnerDeps> = {}, failOn?: number) {
  const calls: Array<{ chapterId: number; budgetAtCall: number }> = [];
  const logs: string[] = [];
  const deps: RunnerDeps = {
    makeAnalyzer: () => mockAnalyzer,
    capture: (async (o: Parameters<typeof captureChapterStages>[0]) => {
      calls.push({ chapterId: o.chapterId, budgetAtCall: o.structureBudget!.remainingWindows });
      if (o.chapterId === failOn) throw new Error(`simulated death in chapter ${o.chapterId}`);
      o.structureBudget!.remainingWindows -= 1;
      return {
        raw: [], deterministic: [], final: [], reasons: [], flags: [],
        stage1: { characters: [] }, paras: [], alignment: undefined,
        structureReport: { alignedPct: 87, flagOnly: false },
        chunks: { chunkCount: 1, coverageRetries: 0, coverageExhausted: 0, deterministicSplits: 0 },
      };
    }) as unknown as RunnerDeps['capture'],
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, calls, logs };
}

test('saved before measured: both chapters are written with model and remainingWindows', async () => {
  const { dir, manifest } = fixtureDir(2);
  const { deps, logs } = fakeDeps();
  const code = await runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps);
  assert.equal(code, 0);
  const saved = readSavedCaptures(scratchOf(dir)).map((e) => e.saved).sort((a, b) => a.chapterId - b.chapterId);
  assert.deepEqual(saved.map((s) => s.chapterId), [1, 2]);
  assert.deepEqual(saved.map((s) => s.model), ['A', 'A']);
  assert.deepEqual(saved.map((s) => s.remainingWindows), [INITIAL_BUDGET - 1, INITIAL_BUDGET - 2]);
  assert.ok(saved.every((s) => s.round === 1 && typeof s.capturedAt === 'string' && s.wallClockMs >= 0));
  assert.ok(logs.some((l) => l.startsWith('ch1:') && l.includes('alignedPct=87') && l.includes('flagOnly=false')));
  assert.ok(logs.some((l) => l.startsWith('estimate')), 'an estimate for the rest follows the first chapter');
});

test('saved before measured: a throwing post-capture hook finds chapter 1 already on disk', async () => {
  const { dir, manifest } = fixtureDir(2);
  const file = join(scratchOf(dir), captureFileName(1));
  let seen = false;
  const { deps } = fakeDeps({
    afterCapture: () => {
      seen = existsSync(file);
      throw new Error('measurement failed');
    },
  });
  await assert.rejects(runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps), /measurement failed/);
  assert.ok(seen, 'the capture file must exist when the hook runs');
  assert.ok(existsSync(file), 'chapter 1 file is still on disk after the hook threw');
});

test('one model: a run, a --resume and a wider --resume under model B are refused and change nothing', async () => {
  const { dir, manifest } = fixtureDir(3);
  const scratch = scratchOf(dir);
  await runCapture({ manifest: manifest.slice(0, 1), model: 'A', scratch }, fakeDeps().deps);
  const before = snapshot(scratch);

  for (const opts of [
    { manifest, model: 'B', scratch },
    { manifest, model: 'B', scratch, resume: true },
    { manifest: manifest.slice(0, 2), model: 'B', scratch, resume: true },
  ]) {
    const { deps, calls } = fakeDeps();
    const code = await runCapture(opts, deps);
    assert.notEqual(code, 0);
    assert.equal(calls.length, 0, 'no capture may start');
    assert.equal(snapshot(scratch), before, 'listing and bytes unchanged');
  }
});

test('one model: a refused --resume adds no file beside the saved capture', async () => {
  const { dir, manifest } = fixtureDir(1);
  const scratch = scratchOf(dir);
  mkdirSync(scratch);
  await runCapture({ manifest, model: 'A', scratch }, fakeDeps().deps);
  const code = await runCapture({ manifest, model: 'B', scratch, resume: true }, fakeDeps().deps);
  assert.notEqual(code, 0);
  assert.equal(readdirSync(scratch).length, 1);
});

test('--resume: keeps chapter 1, restores the budget from it, captures only chapters 2 and 3', async () => {
  const { dir, manifest } = fixtureDir(3);
  const scratch = scratchOf(dir);
  const first = fakeDeps({}, 2);
  await assert.rejects(runCapture({ manifest, model: 'A', scratch }, first.deps), /simulated death in chapter 2/);
  assert.deepEqual(readdirSync(scratch).sort(), [captureFileName(1)], 'the dead chapter leaves no file');
  const ch1Bytes = readFileSync(join(scratch, captureFileName(1)));
  const ch1 = JSON.parse(ch1Bytes.toString('utf8')) as SavedCapture;
  assert.equal(ch1.remainingWindows, INITIAL_BUDGET - 1);

  const second = fakeDeps();
  const code = await runCapture({ manifest, model: 'A', scratch, resume: true }, second.deps);
  assert.equal(code, 0);
  assert.deepEqual(second.calls.map((c) => c.chapterId), [2, 3]);
  assert.equal(second.calls[0]!.budgetAtCall, INITIAL_BUDGET - 1, "chapter 2's budget is restored, not fresh");
  assert.deepEqual(readFileSync(join(scratch, captureFileName(1))), ch1Bytes, 'chapter 1 is untouched');
  assert.deepEqual(readdirSync(scratch).sort(), [1, 2, 3].map(captureFileName));
});

test('a run into a scratch that already holds captures needs --resume', async () => {
  const { dir, manifest } = fixtureDir(1);
  const scratch = scratchOf(dir);
  await runCapture({ manifest, model: 'A', scratch }, fakeDeps().deps);
  const before = snapshot(scratch);
  const { deps, calls } = fakeDeps();
  assert.notEqual(await runCapture({ manifest, model: 'A', scratch }, deps), 0);
  assert.equal(calls.length, 0);
  assert.equal(snapshot(scratch), before);
});

test('--model missing: exits non-zero with a usage line and writes nothing', async () => {
  const { dir, manifest } = fixtureDir(1);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const err: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: string) => (err.push(String(s)), true);
  let code: number;
  try {
    code = await main(['--manifest', manifestPath, '--scratch', scratchOf(dir)], fakeDeps().deps);
  } finally {
    (process.stderr as { write: unknown }).write = realWrite;
  }
  assert.notEqual(code, 0);
  assert.match(err.join(''), /^usage: paragraph-degradation-ab\.mts .*--model <name>/);
  assert.equal(existsSync(scratchOf(dir)), false);
});

test('the real capture path runs against a mock analyzer and saves its fields', async () => {
  process.env.ATTRIBUTION_ESCALATION = 'local';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  const { dir, manifest } = fixtureDir(1);
  writeFileSync(manifest[0]!.chapterTextPath, BODY);
  const sentences = [
    ['anton', 'Ты уверен, что это сработает'],
    ['olga', 'Да, вполне'],
    ['boris', 'Тогда идём'],
    ['narrator', 'Хорошо'],
    ['narrator', 'После тебя'],
  ].map(([characterId, text], i) => ({ id: i + 1, chapterId: 1, characterId, confidence: 0.9, text }));
  const analyzer = {
    runStage2Chapter: () => Promise.resolve({ sentences }),
    runAttributionEscalation: () => Promise.resolve(null),
  } as unknown as Analyzer;
  const { deps } = fakeDeps({ makeAnalyzer: () => analyzer, capture: captureChapterStages });
  const code = await runCapture({ manifest, model: 'A', scratch: scratchOf(dir), language: 'ru' }, deps);
  assert.equal(code, 0);
  const [{ saved }] = readSavedCaptures(scratchOf(dir)) as [{ saved: SavedCapture }];
  assert.equal(saved.final.length, 5);
  assert.equal(saved.structureReport?.alignedPct, 100);
  assert.deepEqual(saved.stage1.characters.map((c) => c.id), ['anton', 'olga', 'boris']);
  assert.equal(saved.model, 'A');
});
