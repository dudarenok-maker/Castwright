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
  readPick,
  type RunnerDeps,
  type ManifestEntry,
  type SavedCapture,
  type PickFile,
  type MeasurementReport,
  isTurnSentence,
} from '../../server/scripts/paragraph-degradation-ab.mts';
import { conventionsFor } from '../../server/src/analyzer/dialogue-structure/lang/index.ts';
import { runStructureEngine } from '../../server/src/routes/analysis.ts';
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
  assert.equal(readdirSync(scratch).filter((f) => f.startsWith('capture-')).length, 1);
  assert.equal(existsSync(join(scratch, 'pick.json')), true, 'only the first run settled a pick');
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
  assert.deepEqual(readdirSync(scratch).sort(), [...[1, 2, 3].map(captureFileName), 'pick.json']);
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

/* ---- Phase 7b step 3: the runner settles the chapter pick (spec §4.4 step 2) ---- */

interface ChSpec { id: number; hidden: number; dashParas?: number }

/** Chapter text with exactly `hidden` mid-paragraph turn openers and `dashParas` extra dash lines. */
function pickFixture(specs: ChSpec[]): { dir: string; manifest: ManifestEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pda-pick-'));
  const rosterPath = join(dir, 'roster.json');
  writeFileSync(rosterPath, JSON.stringify(ROSTER));
  const manifest: ManifestEntry[] = specs.map((s) => {
    const chapterTextPath = join(dir, `ch${s.id}.txt`);
    const merged = `— Да.${' — Да.'.repeat(s.hidden)}`;
    const extra = Array.from({ length: s.dashParas ?? 0 }, () => '— Хорошо.');
    writeFileSync(chapterTextPath, [merged, ...extra].join('\n'));
    return { chapterId: s.id, chapterTextPath, rosterPath };
  });
  return { dir, manifest };
}

/** A fake capture whose alignment is below the floor for the ids in `below` (read live, so a test can change it). */
function pickDeps(below: Set<number>) {
  const calls: number[] = [];
  const logs: string[] = [];
  const deps: RunnerDeps = {
    makeAnalyzer: () => mockAnalyzer,
    capture: (async (o: Parameters<typeof captureChapterStages>[0]) => {
      calls.push(o.chapterId);
      o.structureBudget!.remainingWindows -= 1;
      const low = below.has(o.chapterId);
      return {
        raw: [], deterministic: [], final: [], reasons: [], flags: [],
        stage1: { characters: [] }, paras: [], alignment: undefined,
        structureReport: { alignedPct: low ? 40 : 90, flagOnly: low },
        chunks: { chunkCount: 1, coverageRetries: 0, coverageExhausted: 0, deterministicSplits: 0 },
      };
    }) as unknown as RunnerDeps['capture'],
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs };
}

const pickOf = (dir: string) => readPick(scratchOf(dir))!;

test('pick: candidates walk in hidden-turn order, not dash density, and a swap takes the next by hidden turns', async () => {
  // ch1 is the densest (30 dash lines) but has 2 hidden turns; ch2 has 6, ch3 has 4, ch4 has 1.
  const { dir, manifest } = pickFixture([
    { id: 1, hidden: 2, dashParas: 30 }, { id: 2, hidden: 6 }, { id: 3, hidden: 4 }, { id: 4, hidden: 1 },
  ]);
  const { deps, calls } = pickDeps(new Set([2]));
  assert.equal(await runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps), 0);
  assert.deepEqual(calls, [2, 3, 1, 4], 'hidden-turn order 2,3,1,4; ch2 below the floor, so ch4 is the third clear');
  const p = pickOf(dir);
  assert.deepEqual(p.order, [2, 3, 1, 4]);
  assert.deepEqual(p.picked, [3, 1, 4]);
  assert.equal(p.chapters['2']!.status, 'swapped-out');
  assert.equal(p.chapters['2']!.hiddenTurns, 6);
  assert.ok(p.chapters['1']!.dashParagraphs >= 30);
  assert.equal(p.outcome, 'three');
});

test('pick: the swap cap stops the walk at five captures with two chapters clear', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, hidden: 8 - id })));
  const { deps, calls } = pickDeps(new Set([1, 3, 5]));
  assert.equal(await runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps), 0);
  assert.deepEqual(calls, [1, 2, 3, 4, 5], 'at most five chapters are taken');
  const p = pickOf(dir);
  assert.equal(p.outcome, 'fewer-than-three: 2');
  assert.match(p.outcomeReason ?? '', /two-swap cap/);
  assert.equal(p.chapters['6']!.status, 'not-captured');
});

test('pick: the cap reached with one chapter clear records fewer-than-three: 1', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3, 4, 5].map((id) => ({ id, hidden: 6 - id })));
  const { deps, calls } = pickDeps(new Set([1, 2, 4, 5]));
  await runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps);
  assert.deepEqual(calls, [1, 2, 3, 4]);
  const p = pickOf(dir);
  assert.equal(p.outcome, 'fewer-than-three: 1');
  assert.deepEqual(p.picked, [3]);
});

test('pick: no chapter clear records not-computed', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3, 4, 5].map((id) => ({ id, hidden: 6 - id })));
  const { deps, calls } = pickDeps(new Set([1, 2, 3, 4, 5]));
  assert.equal(await runCapture({ manifest, model: 'A', scratch: scratchOf(dir) }, deps), 0);
  assert.deepEqual(calls, [1, 2, 3]);
  const p = pickOf(dir);
  assert.equal(p.outcome, 'not-computed');
  assert.deepEqual(p.picked, []);
  assert.equal(p.rerolls, 0);
});

/** The §4.4 worked example: candidates ch5, ch8, ch6, ch7, ch1 by hidden turns. */
function workedExample() {
  return pickFixture([{ id: 5, hidden: 5 }, { id: 8, hidden: 4 }, { id: 6, hidden: 3 }, { id: 7, hidden: 2 }, { id: 1, hidden: 1 }]);
}

test('worked example: round 1 picks ch5, ch7, ch1; --recapture 8 captures only ch8 and re-walks with the cap reset', async () => {
  const { dir, manifest } = workedExample();
  const scratch = scratchOf(dir);
  const below = new Set([8, 6]);
  const r1 = pickDeps(below);
  assert.equal(await runCapture({ manifest, model: 'A', scratch }, r1.deps), 0);
  assert.deepEqual(r1.calls, [5, 8, 6, 7, 1]);
  assert.deepEqual(pickOf(dir).picked, [5, 7, 1]);

  const ch7Before = readFileSync(join(scratch, captureFileName(7)));
  below.delete(8); // the defect in ch8 is fixed: it now clears
  const r2 = pickDeps(below);
  assert.equal(await runCapture({ manifest, model: 'A', scratch, recapture: [8], reason: 'ch8 capture defective' }, r2.deps), 0);
  assert.deepEqual(r2.calls, [8], 'only ch8 is captured again');
  assert.deepEqual(readFileSync(join(scratch, captureFileName(7))), ch7Before, "ch7's kept capture is not rewritten");

  const p = pickOf(dir);
  assert.deepEqual(p.picked, [5, 8, 7], 'the walk takes ch5, ch8, ch6 (a swap) and ch7, and settles');
  assert.equal(p.chapters['6']!.status, 'swapped-out');
  assert.equal(p.chapters['1']!.status, 'captured-not-used');
  assert.equal(p.outcome, 'three');
  assert.deepEqual(p.superseded.map((s) => [s.chapterId, s.round]), [[8, 1]]);
  assert.ok(existsSync(join(scratch, p.superseded[0]!.file)));
  assert.equal(p.rounds.at(-1)!.kind, 'recapture');
  assert.equal(p.rounds.at(-1)!.cause, 'ch8 capture defective');
  assert.equal(p.rounds.at(-1)!.model, 'A');
  assert.equal(readSavedCaptures(scratch).find((e) => e.saved.chapterId === 8)!.saved.round, 2);
});

test('--recapture needs --reason and a current capture, and refuses with nothing written', async () => {
  const { dir, manifest } = workedExample();
  const scratch = scratchOf(dir);
  await runCapture({ manifest, model: 'A', scratch }, pickDeps(new Set()).deps);
  const before = snapshot(scratch);
  for (const opts of [
    { manifest, model: 'A', scratch, recapture: [8] },
    { manifest, model: 'A', scratch, recapture: [99], reason: 'x' },
  ]) {
    const { deps, calls } = pickDeps(new Set());
    assert.notEqual(await runCapture(opts, deps), 0);
    assert.equal(calls.length, 0);
    assert.equal(snapshot(scratch), before);
  }
});

test('--reroll with no defect captures afresh every chapter it takes and supersedes the earlier captures', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3, 4].map((id) => ({ id, hidden: 5 - id })));
  const scratch = scratchOf(dir);
  const below = new Set([1, 2, 3, 4]);
  await runCapture({ manifest, model: 'A', scratch }, pickDeps(below).deps);
  assert.equal(pickOf(dir).outcome, 'not-computed');

  below.clear(); // the re-roll aligns differently
  const r = pickDeps(below);
  assert.equal(await runCapture({ manifest, model: 'A', scratch, reroll: true, reason: 'no defect found; re-roll' }, r.deps), 0);
  assert.deepEqual(r.calls, [1, 2, 3], 'every chapter the re-walk takes is captured afresh');
  const p = pickOf(dir);
  assert.equal(p.outcome, 'three');
  assert.equal(p.rerolls, 1);
  assert.deepEqual(p.superseded.map((s) => [s.chapterId, s.round]).sort(), [[1, 1], [2, 1], [3, 1]]);
  for (const s of p.superseded) assert.ok(existsSync(join(scratch, s.file)));
  assert.ok(readSavedCaptures(scratch).every((e) => e.saved.round === 2));
  assert.equal(p.rounds.at(-1)!.kind, 'reroll');
});

test('a second not-computed after the re-roll stops for the owner, and a second --reroll is refused', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3, 4].map((id) => ({ id, hidden: 5 - id })));
  const scratch = scratchOf(dir);
  const below = new Set([1, 2, 3, 4]);
  await runCapture({ manifest, model: 'A', scratch }, pickDeps(below).deps);
  const rr = pickDeps(below);
  assert.equal(await runCapture({ manifest, model: 'A', scratch, reroll: true, reason: 'one re-roll' }, rr.deps), 0);
  assert.deepEqual(rr.calls, [1, 2, 3]);
  const p = pickOf(dir);
  assert.equal(p.outcome, 'stopped-for-owner');
  assert.match(p.outcomeReason ?? '', /no chapter cleared/);
  assert.equal(p.chapters['4']!.status, 'not-captured', 'nothing more is captured');

  const before = snapshot(scratch);
  const again = pickDeps(new Set());
  assert.notEqual(await runCapture({ manifest, model: 'A', scratch, reroll: true, reason: 'two re-rolls' }, again.deps), 0);
  assert.equal(again.calls.length, 0);
  assert.equal(snapshot(scratch), before, 'a second --reroll writes nothing');
});

test('a --reroll after a computed outcome is refused and writes nothing', async () => {
  const { dir, manifest } = pickFixture([1, 2, 3].map((id) => ({ id, hidden: 4 - id })));
  const scratch = scratchOf(dir);
  await runCapture({ manifest, model: 'A', scratch }, pickDeps(new Set()).deps);
  assert.equal(pickOf(dir).outcome, 'three');
  const before = snapshot(scratch);
  const { deps, calls } = pickDeps(new Set());
  assert.notEqual(await runCapture({ manifest, model: 'A', scratch, reroll: true, reason: 'x' }, deps), 0);
  assert.equal(calls.length, 0);
  assert.equal(snapshot(scratch), before);
});

/* ---- Phase 7c step 2: the 1A replays from saved captures (spec §4.3, §4.4 step 2, R4-1, R7-7, R9-3, R10-2) ---- */

const MERGED_BODY = [
  '— Ты уверен, что это сработает? — спросил Антон.',
  '— Да, вполне, — ответила Ольга.',
  'Борис промолчал. — Тогда идём, — сказал Борис. — Хорошо.',
  '— После тебя.',
].join('\n');
const MERGED_SENTENCES: Array<[string, string]> = [
  ['anton', '— Ты уверен, что это сработает?'],
  ['olga', '— Да, вполне,'],
  ['narrator', 'Борис промолчал.'],
  ['boris', '— Тогда идём,'],
  ['olga', '— Хорошо.'],
  ['narrator', '— После тебя.'],
];

/** A three-chapter ru run captured for real (mock analyzer, real engine); returns the scratch dir. */
async function threeChapterRun() {
  process.env.ATTRIBUTION_ESCALATION = 'local';
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  const { dir, manifest } = fixtureDir(3);
  for (const m of manifest) writeFileSync(m.chapterTextPath, MERGED_BODY);
  const scratch = scratchOf(dir);
  let chapterId = 0;
  const analyzer = {
    runStage2Chapter: () =>
      Promise.resolve({
        sentences: MERGED_SENTENCES.map(([characterId, text], i) => ({ id: i + 1, chapterId, characterId, confidence: 0.9, text })),
      }),
    runAttributionEscalation: () => Promise.resolve(null),
  } as unknown as Analyzer;
  const { deps } = fakeDeps({
    makeAnalyzer: () => analyzer,
    capture: ((o: Parameters<typeof captureChapterStages>[0]) => {
      chapterId = o.chapterId;
      return captureChapterStages(o);
    }) as RunnerDeps['capture'],
  });
  assert.equal(await runCapture({ manifest, model: 'A', scratch, language: 'ru' }, deps), 0);
  assert.deepEqual(readPick(scratch)!.picked, [1, 2, 3]);
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { dir, scratch, manifest, manifestPath };
}

const reportOf = (scratch: string) => JSON.parse(readFileSync(join(scratch, 'report.json'), 'utf8')) as MeasurementReport;
const FROM_CAPTURES = (r: { scratch: string; manifestPath: string }) =>
  ['--from-captures', '--manifest', r.manifestPath, '--scratch', r.scratch, '--language', 'ru'];
const noAnalyzerDeps = (): RunnerDeps => ({
  makeAnalyzer: () => {
    throw new Error('--from-captures must construct no analyzer');
  },
  capture: (() => {
    throw new Error('--from-captures must capture nothing');
  }) as unknown as RunnerDeps['capture'],
  log: () => {},
});

/** Edit one saved capture file in place. */
function editCapture(scratch: string, id: number, edit: (c: SavedCapture) => void): void {
  const f = join(scratch, captureFileName(id));
  const c = JSON.parse(readFileSync(f, 'utf8')) as SavedCapture;
  edit(c);
  writeFileSync(f, JSON.stringify(c, null, 2));
}
function editPick(scratch: string, edit: (p: PickFile) => void): void {
  const f = join(scratch, 'pick.json');
  const p = JSON.parse(readFileSync(f, 'utf8')) as PickFile;
  edit(p);
  writeFileSync(f, JSON.stringify(p, null, 2));
}

test('1A replay: a clean three-chapter capture passes every control and counts equal a direct on/off comparison', async () => {
  const r = await threeChapterRun();
  assert.equal(await main(FROM_CAPTURES(r), noAnalyzerDeps()), 0);
  const rep = reportOf(r.scratch);
  assert.deepEqual(rep.controls.map((c) => c.control.status), ['pass', 'pass', 'pass']);
  assert.equal(rep.verdict.state, 'ready');
  assert.ok(existsSync(join(r.scratch, 'report.md')));
  const conv = conventionsFor('ru')!;
  for (const { saved } of readSavedCaptures(r.scratch)) {
    const args = { sentences: structuredClone(saved.raw), body: MERGED_BODY, stage1: saved.stage1, conventions: conv };
    const on = runStructureEngine(args).examined.sentences;
    const off = runStructureEngine({ ...args, sentences: structuredClone(saved.raw), structureOptions: { recoverMidParagraphTurns: false } }).examined.sentences;
    const direct = on.filter((s, i) => s.characterId !== off[i]!.characterId).length;
    const got = rep.picked.find((p) => p.chapterId === saved.chapterId)!;
    assert.equal(got.changedAll, direct, `ch${saved.chapterId} changed-sentence count`);
    assert.equal(got.sentences, on.length);
    assert.ok(got.turnSentences >= 4, 'dash-opening and merged-turn sentences are turn sentences');
  }
  assert.equal(rep.totals.changedAll, rep.picked.reduce((n, p) => n + p.changedAll, 0));
  assert.equal(rep.totals.chapters, 3);
});

test('1A replay: a control mismatch in one chapter of three is void, naming the chapter and sentence', async () => {
  const r = await threeChapterRun();
  editCapture(r.scratch, 2, (c) => {
    c.deterministic[1]!.characterId = 'boris';
  });
  assert.equal(await main(FROM_CAPTURES(r), noAnalyzerDeps()), 0);
  const rep = reportOf(r.scratch);
  assert.equal(rep.verdict.state, 'void');
  const v = rep.verdict.state === 'void' ? rep.verdict.void : [];
  assert.equal(v.length, 1);
  assert.equal(v[0]?.chapterId, 2);
  assert.equal(v[0]?.index, 1);
  assert.equal(v[0]?.capturedId, 'boris');
  assert.deepEqual(rep.controls.map((c) => c.control.status), ['pass', 'void', 'pass']);
  assert.match(readFileSync(join(r.scratch, 'report.md'), 'utf8'), /ch2 \(picked\): first difference at sentence 1/);
});

test('1A replay: a control mismatch in a captured-not-used chapter still voids the verdict', async () => {
  const r = await threeChapterRun();
  editPick(r.scratch, (p) => {
    p.chapters['3']!.status = 'captured-not-used';
  });
  editCapture(r.scratch, 3, (c) => {
    c.deterministic[0]!.characterId = 'boris';
  });
  await main(FROM_CAPTURES(r), noAnalyzerDeps());
  const rep = reportOf(r.scratch);
  assert.equal(rep.verdict.state, 'void');
  const v = rep.verdict.state === 'void' ? rep.verdict.void : [];
  assert.equal(v[0]?.chapterId, 3);
  assert.equal(v[0]?.status, 'captured-not-used');
});

test('1A replay: swapped-out and captured-not-used chapters sit in their own table and in no total', async () => {
  const r = await threeChapterRun();
  editPick(r.scratch, (p) => {
    p.chapters['2']!.status = 'swapped-out';
    p.chapters['3']!.status = 'captured-not-used';
  });
  await main(FROM_CAPTURES(r), noAnalyzerDeps());
  const rep = reportOf(r.scratch);
  assert.deepEqual(rep.picked.map((p) => p.chapterId), [1]);
  assert.deepEqual(rep.outside.map((p) => [p.chapterId, p.status]), [[2, 'swapped-out'], [3, 'captured-not-used']]);
  assert.ok(rep.outside.every((o) => o.turnSentences > 0), 'the outside chapters have counts of their own');
  assert.equal(rep.totals.chapters, 1);
  assert.equal(rep.totals.turnSentences, rep.picked[0]!.turnSentences, 'totals hold the picked chapter alone');
  assert.equal(rep.totals.sentences, rep.picked[0]!.sentences);
  assert.equal(rep.verdict.state, 'ready', 'their controls ran and passed');
});

test('1A replay: a superseded capture is read by nothing', async () => {
  const r = await threeChapterRun();
  const c = JSON.parse(readFileSync(join(r.scratch, captureFileName(2)), 'utf8')) as SavedCapture;
  c.deterministic[0]!.characterId = 'boris';
  writeFileSync(join(r.scratch, 'capture-ch2.superseded-r1.json'), JSON.stringify(c));
  await main(FROM_CAPTURES(r), noAnalyzerDeps());
  const rep = reportOf(r.scratch);
  assert.equal(rep.verdict.state, 'ready');
  assert.equal(rep.controls.length, 3);
});

test('1A replay: turn sentences come from the text, dash openers and hidden turns both', () => {
  const ru = conventionsFor('ru')!;
  assert.equal(isTurnSentence('— Да, вполне', ru), true, 'dash-opening');
  assert.equal(isTurnSentence('Он промолчал. — Да', ru), true, 'a turn hidden inside a narration sentence');
  assert.equal(isTurnSentence('Он промолчал и ушёл', ru), false, 'plain narration');
});

test('1A replay: --from-captures constructs no analyzer and a failed measurement leaves the captures alone', async () => {
  const r = await threeChapterRun();
  const files = () => readdirSync(r.scratch).filter((f) => f.startsWith('capture-')).map((f) => `${f}:${readFileSync(join(r.scratch, f)).length}`);
  const before = files();
  assert.equal(await main(FROM_CAPTURES(r), noAnalyzerDeps()), 0);
  // a language with no table fails the measurement; the capture files are as they were
  const bad = ['--from-captures', '--manifest', r.manifestPath, '--scratch', r.scratch, '--language', 'xx'];
  assert.equal(await main(bad, noAnalyzerDeps()), 1);
  assert.deepEqual(files(), before);
});
