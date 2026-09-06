/* #3004 — a rejoin poll couldn't tell "I joined the still-running job" from
   "no job was found, so a brand-new one silently started." This file covers
   the fix's three pieces:

   1. `endJob` persists the job's terminal outcome (result/error) to
      analysis-last-outcome.json. Driven through the REAL exported `endJob`
      (production's own terminal transition) against a real workspace-backed
      book fixture — but WITHOUT running the analyzer pipeline itself. A
      genuine pipeline success/failure needs a much larger fixture (full
      roster, structure-engine settings, coverage retries) and is already
      exercised by analysis.test.ts / analysis.rename-midrun.test.ts; this
      file only needs to prove endJob's NEW persistence branch, which is
      agnostic to *why* the job ended.
   2. `shouldCheckForRejoinMiss` — the pure predicate for "no live job AND
      not an explicit fresh restart" — asserted directly against the
      boundary cases (spec points 1, 2, 4).
   3. `buildRejoinMissEvent` — the event shape, with and without a prior
      outcome attached (spec point 2's "no file present" carve-out).

   The sticky-resume join branch itself (point 3: existing && !aborted &&
   !requestedFresh) is unchanged production code already covered by
   analysis.test.ts's sticky-analysis describe block; this file does not
   re-test it. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisJob } from './analysis.js';
import type { AnalysisLastOutcome } from '../store/analysis-state.js';

const AUTHOR = 'Rejoin Miss Author';
const SERIES = 'Standalones';
const CHAPTER_BODY = 'Nova said the plan out loud.';

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-rejoin-miss-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function setUpBook(title: string): Promise<{ bookDir: string; manuscriptId: string }> {
  const manuscriptId = `test-rejoin-miss-${title}-${Date.now()}-${Math.random()}`;
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  const { makeBookId } = await import('../workspace/paths.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  const { putManuscript } = await import('../store/manuscripts.js');
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 10,
    byteSize: 100,
    uploadedAt: new Date().toISOString(),
    sourceText: CHAPTER_BODY,
    chapterHints: [{ id: 1, title: 'Chapter One', body: CHAPTER_BODY }],
    bookDir,
  });

  return { bookDir, manuscriptId };
}

async function buildJob(manuscriptId: string, bookDir: string): Promise<AnalysisJob> {
  const job = {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind: 'main',
    bookDir,
    engine: 'gemini',
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;

  /* Register the job into the in-flight map, matching how the real route
     code registers jobs at line ~3400. The staleness guard in endJob
     (line ~3070) checks if the job is still the current entry in the map;
     without registration, every job fails the check and skips the write. */
  const { __testRegisterJobForTest } = await import('./analysis.js');
  __testRegisterJobForTest(job);

  return job;
}

/** `writeAnalysisLastOutcome` inside `endJob` is fire-and-forget (`void`,
    same pattern as the pre-existing `persistTerminalSnapshot` calls) —
    `endJob` itself is synchronous and returns before the write settles. Poll
    briefly rather than asserting immediately after the call. */
async function waitForOutcome(bookDir: string): Promise<AnalysisLastOutcome | null> {
  const { readAnalysisLastOutcome } = await import('../store/analysis-state.js');
  const deadline = Date.now() + 2_000;
  for (;;) {
    const outcome = await readAnalysisLastOutcome(bookDir);
    if (outcome) return outcome;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('#3004 endJob persists the terminal outcome (analysis-last-outcome.json)', () => {
  it('a clean success (kind: "result") is recorded, not miscategorised as an error', async () => {
    const { bookDir, manuscriptId } = await setUpBook('Success Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      endJob(await buildJob(manuscriptId, bookDir), { kind: 'result' });
      const outcome = await waitForOutcome(bookDir);
      expect(outcome).not.toBeNull();
      expect(outcome!.kind).toBe('result');
      expect(outcome!.manuscriptId).toBe(manuscriptId);
      expect(outcome!.code).toBeUndefined();
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);

  it('a real failure records kind: "error" with its code and message, not silently as a success', async () => {
    const { bookDir, manuscriptId } = await setUpBook('Failure Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      endJob(await buildJob(manuscriptId, bookDir), {
        kind: 'error',
        code: 'cast_incomplete',
        message: 'synthetic phase-0 failure',
      });
      const outcome = await waitForOutcome(bookDir);
      expect(outcome).not.toBeNull();
      expect(outcome!.kind).toBe('error');
      expect(outcome!.code).toBe('cast_incomplete');
      expect(outcome!.message).toBe('synthetic phase-0 failure');
      expect(outcome!.manuscriptId).toBe(manuscriptId);
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);

  it('a paused/displaced run (error code "aborted") is recorded like any other error outcome', async () => {
    const { bookDir, manuscriptId } = await setUpBook('Paused Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      endJob(await buildJob(manuscriptId, bookDir), { kind: 'error', code: 'aborted' });
      const outcome = await waitForOutcome(bookDir);
      expect(outcome).not.toBeNull();
      expect(outcome!.kind).toBe('error');
      expect(outcome!.code).toBe('aborted');
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);

  it('a later run overwrites the earlier recorded outcome on the same book', async () => {
    const { bookDir, manuscriptId } = await setUpBook('Overwrite Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      endJob(await buildJob(manuscriptId, bookDir), { kind: 'error', code: 'cast_incomplete' });
      const first = await waitForOutcome(bookDir);
      expect(first!.kind).toBe('error');

      endJob(await buildJob(manuscriptId, bookDir), { kind: 'result' });
      const deadline = Date.now() + 2_000;
      let finalOutcome = first;
      while (finalOutcome?.kind !== 'result' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
        finalOutcome = await waitForOutcome(bookDir);
      }
      expect(finalOutcome!.kind).toBe('result');
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);

  it('a clean teardown with no final event (subscriber-driven cleanup) does not overwrite a prior recorded outcome', async () => {
    /* endJob is also called with NO finalEv at all — e.g. when the last
       subscriber disconnects from an already-quiescent job. That path must
       not clobber whatever the job's own terminal event already recorded. */
    const { bookDir, manuscriptId } = await setUpBook('No-Overwrite Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      endJob(await buildJob(manuscriptId, bookDir), { kind: 'result' });
      const first = await waitForOutcome(bookDir);
      expect(first!.kind).toBe('result');

      endJob(await buildJob(manuscriptId, bookDir), undefined);
      await new Promise((r) => setTimeout(r, 100));
      const { readAnalysisLastOutcome } = await import('../store/analysis-state.js');
      const after = await readAnalysisLastOutcome(bookDir);
      expect(after!.kind).toBe('result');
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);

  it('a "subset" kind job does NOT write the main outcome file (scope is main-job rejoin only)', async () => {
    const { bookDir, manuscriptId } = await setUpBook('Subset Book');
    const { endJob } = await import('./analysis.js');
    const { removeManuscript } = await import('../store/manuscripts.js');

    try {
      const job = await buildJob(manuscriptId, bookDir);
      (job as unknown as { kind: string }).kind = 'subset';
      endJob(job, { kind: 'error', code: 'cast_incomplete' });
      await new Promise((r) => setTimeout(r, 200));
      const { readAnalysisLastOutcome } = await import('../store/analysis-state.js');
      expect(await readAnalysisLastOutcome(bookDir)).toBeNull();
    } finally {
      removeManuscript(manuscriptId);
    }
  }, 30_000);
});

describe('#3004 shouldCheckForRejoinMiss — the "no live job" boundary', () => {
  it('true when no job is tracked at all (spec point 1: novel-looking gap)', async () => {
    const { shouldCheckForRejoinMiss } = await import('./analysis.js');
    expect(shouldCheckForRejoinMiss(undefined, false)).toBe(true);
  });

  it('true when a tracked job exists but its controller is already aborted', async () => {
    const { shouldCheckForRejoinMiss } = await import('./analysis.js');
    const controller = new AbortController();
    controller.abort();
    expect(shouldCheckForRejoinMiss({ controller }, false)).toBe(true);
  });

  it('false when a live (non-aborted) job exists — the unchanged sticky-resume path (spec point 3)', async () => {
    const { shouldCheckForRejoinMiss } = await import('./analysis.js');
    const controller = new AbortController();
    expect(shouldCheckForRejoinMiss({ controller }, false)).toBe(false);
  });

  it('false whenever requestedFresh is true, regardless of whether a job exists (spec point 4)', async () => {
    const { shouldCheckForRejoinMiss } = await import('./analysis.js');
    expect(shouldCheckForRejoinMiss(undefined, true)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(shouldCheckForRejoinMiss({ controller }, true)).toBe(false);
  });
});

describe('#3004 buildRejoinMissEvent', () => {
  it('attaches the prior outcome when one is on disk', async () => {
    const { buildRejoinMissEvent } = await import('./analysis.js');
    const ev = buildRejoinMissEvent({
      manuscriptId: 'm1',
      kind: 'error',
      code: 'cast_incomplete',
      message: 'boom',
      endedAt: 12345,
    });
    expect(ev.kind).toBe('rejoin-miss');
    expect(ev.priorOutcome).toEqual({
      kind: 'error',
      code: 'cast_incomplete',
      message: 'boom',
      endedAt: 12345,
    });
  });

  it('omits priorOutcome entirely for a truly novel manuscript (spec point 2 carve-out) — no fabricated outcome', async () => {
    const { buildRejoinMissEvent } = await import('./analysis.js');
    const ev = buildRejoinMissEvent(null);
    expect(ev.kind).toBe('rejoin-miss');
    expect(ev).not.toHaveProperty('priorOutcome');
  });

  it('reports a clean success distinctly from an error, so a caller does not conflate the two', async () => {
    const { buildRejoinMissEvent } = await import('./analysis.js');
    const ev = buildRejoinMissEvent({
      manuscriptId: 'm1',
      kind: 'result',
      endedAt: 99,
    });
    expect(ev.priorOutcome?.kind).toBe('result');
    expect(ev.priorOutcome?.code).toBeUndefined();
  });
});
