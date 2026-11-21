/**
 * srv-36 — unit tests for afterChapterFinalized (render-integrity score pass).
 *
 * Covers:
 *   1. Calls scoreBook(bookDir, chapters, [justFinalized.slug]) when
 *      qa.speaker.enabled is true.
 *   2. GH #1436 — writes the justFinalized chapter's own "attempted" sentinel
 *      unconditionally, even when its scoreBook run is coalesced away.
 *   3. Two concurrent same-book invocations coalesce into ONE scoreBook run
 *      (single-flight per bookId).
 *   4. Does nothing (including no attempted-sentinel write) when
 *      qa.speaker.enabled is false.
 *   5. Fire-and-forget: chapter completion must NOT block on the score pass —
 *      a slow/hung scoreBook (the audition-centroid path) used to stall
 *      assembly until the 720s no-progress watchdog killed the chapter (#1029).
 *   6. Finding 2: the post-audition VRAM reconcile fires against the run's
 *      FULL-cast keep-flags (`ctx.keep`) — NOT scoreBook's return — and is
 *      skipped when the run uses no Qwen tier.
 *   7. #3711 — the score pass is a registered `scoring` job and scores the
 *      LEASE's folder (resolved under book-op), not `ctx.bookDir`; a book that is
 *      gone is never scored.
 *
 * `runBookJob` is replaced by a stand-in that hands `fn` a lease for the books
 * in `leaseDirs` (and BOOK_GONE for any other), since the fake `/b1`-style ids
 * here have no folder on disk. The real registry is covered in
 * workspace/book-jobs.test.ts and routes/book-op.long-jobs.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/* #4560 — S1-S4 use a REAL `.queue.json`: point the workspace at a temp dir BEFORE any module
   (paths.ts reads WORKSPACE_DIR at import) loads. */
vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spk-4560-'));
});

const leaseDirs = vi.hoisted(
  () =>
    new Map<string, string>([
      ['b1', '/b1'],
      ['b1b', '/b1b'],
      ['b2', '/b2'],
      ['hang-1029', '/h'],
      ['b3', '/b3'],
      ['b4', '/b4'],
      ['b5', '/b5'],
      ['b-key', '/b-key'],
      ['b-resume', '/b-resume'],
      ['other-book', '/o'],
      ['skip-a', '/skip-a'],
      ['skip-b1', '/skip-b1'],
      ['skip-b2', '/skip-b2'],
      ['skip-c', '/skip-c'],
      ['skip-d', '/skip-d'],
      ['skip-e', '/skip-e'],
      ['skip-f', '/skip-f'],
      ['stale-keep', '/stale-keep'],
      ['stale-keep-ctl', '/stale-keep-ctl'],
      ['recon-s1', '/recon-s1'],
      ['recon-s2', '/recon-s2'],
      ['recon-s3', '/recon-s3'],
      ['recon-s4', '/recon-s4'],
      ['recon-s5', '/recon-s5'],
      ['recon-s6', '/recon-s6'],
      ['recon-s7', '/recon-s7'],
      ['recon-s8', '/recon-s8'],
      ['recon-s9', '/recon-s9'],
      ['recon-s10', '/recon-s10'],
    ]),
);
vi.mock('../workspace/book-jobs.js', async () => {
  const { BOOK_GONE } = await import('../workspace/book-op-lock.js');
  return {
    runBookJob: vi.fn(async (bookId: string, _kind: string, fn: (lease: unknown) => Promise<unknown>) => {
      const bookDir = leaseDirs.get(bookId);
      if (!bookDir) return BOOK_GONE;
      return { done: fn({ bookId, bookDir, state: {} }) };
    }),
  };
});
vi.mock('../audio/render-integrity/aggregate.js', () => ({
  scoreBook: vi.fn(async () => ({ usedQwenTiers: { keep06: false, keep17: false }, mismatchCount: 0 })),
}));
/* GH #1436 fix — afterChapterFinalized now writes the "attempted" sentinel
   for its own justFinalized chapter directly, before the single-flight gate.
   Mocked here (rather than hitting the real filesystem at bogus paths like
   '/b1') so these tests stay focused on the scoreBook orchestration/single-
   flight/reconcile behaviour they were written to cover; the sentinel-write
   behaviour itself is covered in aggregate.test.ts / qa-report.test.ts. */
vi.mock('../audio/render-integrity/verdicts-io.js', () => ({
  writeAttempted: vi.fn(async () => {}),
  attemptedPath: (root: string, slug: string) => `${root}/${slug}.render-integrity-attempted.json`,
}));
/* Mock the reconcile so the post-audition branch is observable and never
   reaches for the sidecar over the network. The other two exports are the ones
   generation.ts imports from this module (mirrors the sibling route tests). */
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: vi.fn(async () => undefined),
  reconcileResidentQwenTiers: vi.fn(async () => undefined),
  SIDECAR_ENGINES: new Set(),
}));

import { scoreBook } from '../audio/render-integrity/aggregate.js';
import { writeAttempted } from '../audio/render-integrity/verdicts-io.js';
import { reconcileResidentQwenTiers } from '../tts/ensure-sidecar-loaded.js';
import {
  afterChapterFinalized,
  triggerScoring,
  __awaitScoringSettled,
  __registerFakeJobForTest,
  makePostScoreKeepRecompute,
} from './generation.js';
import { writeQueueFile } from '../workspace/queue-migrate.js';
import { queueJsonPath } from '../workspace/paths.js';
import type { QueueEntry } from '../workspace/queue-io.js';
import { chr, sent, T06, T17 } from '../tts/qwen-tier-needs.fixtures.js';
import * as cfg from '../config/resolver.js';
import { registerSplice } from './chapter-job-coordination.js';
import { setInFlightDesignCounter, setInFlightMintCounter } from '../gpu/active-generation-gate.js';

const NO_QWEN = { keep06: false, keep17: false };
const CH1 = { id: 1, slug: 'ch1' };

describe('afterChapterFinalized', () => {
  beforeEach(() => {
    vi.mocked(scoreBook).mockClear();
    vi.mocked(writeAttempted).mockClear();
    vi.mocked(reconcileResidentQwenTiers).mockClear();
  });

  it('calls scoreBook with the bookDir, full chapter list, and the justFinalized chapter when enabled', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({
      bookId: 'b1',
      bookDir: '/b1',
      chapters: [CH1],
      justFinalized: CH1,
      keep: NO_QWEN,
    });
    expect(scoreBook).toHaveBeenCalledOnce();
    expect(scoreBook).toHaveBeenCalledWith('/b1', [CH1], ['ch1'], expect.any(Object));
  });

  it('writes the attempted sentinel for justFinalized unconditionally, even when a scoreBook run is already coalesced away (GH #1436)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Two concurrent completions for the SAME book, DIFFERENT chapters. The
    // second call's scoreBook invocation is coalesced away by the single-flight
    // gate (see the next test) — but its OWN attempted-sentinel write must
    // still happen, since it's written before that gate is even checked.
    await Promise.all([
      afterChapterFinalized({
        bookId: 'b1b', bookDir: '/b1b', chapters: [CH1, { id: 2, slug: 'ch2' }],
        justFinalized: CH1, keep: NO_QWEN,
      }),
      afterChapterFinalized({
        bookId: 'b1b', bookDir: '/b1b', chapters: [CH1, { id: 2, slug: 'ch2' }],
        justFinalized: { id: 2, slug: 'ch2' }, keep: NO_QWEN,
      }),
    ]);
    expect(writeAttempted).toHaveBeenCalledWith(expect.stringContaining('ch1.render-integrity-attempted.json'));
    expect(writeAttempted).toHaveBeenCalledWith(expect.stringContaining('ch2.render-integrity-attempted.json'));
  });

  it('coalesces two concurrent same-book invocations into ONE scoreBook run', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Both calls run concurrently with the same bookId — single-flight should
    // ensure scoreBook is only invoked once.
    await Promise.all([
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [CH1], justFinalized: CH1, keep: NO_QWEN }),
      afterChapterFinalized({ bookId: 'b2', bookDir: '/b2', chapters: [CH1], justFinalized: CH1, keep: NO_QWEN }),
    ]);
    expect(scoreBook).toHaveBeenCalledTimes(1);
  });

  it('does not block the caller when scoreBook hangs (no-progress watchdog regression — bug #1029)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // Simulate the slow/hung audition-centroid score path that stalled chapter
    // assembly for 720s on the 8GB box: scoreBook never resolves.
    let releaseHung!: (v: { usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }) => void;
    vi.mocked(scoreBook).mockImplementationOnce(
      () => new Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }>((r) => { releaseHung = r; }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.resolve(
        afterChapterFinalized({ bookId: 'hang-1029', bookDir: '/h', chapters: [CH1], justFinalized: CH1, keep: NO_QWEN }),
      ).then(() => 'resolved' as const),
      new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 250);
      }),
    ]);
    if (timer) clearTimeout(timer);

    // Fire-and-forget: chapter completion must NOT await the score pass…
    expect(outcome).toBe('resolved');
    // …but the pass WAS still kicked off (just not awaited).
    expect(scoreBook).toHaveBeenCalledTimes(1);
    // Release the hung pass so its scoringInFlight entry does not leak into later tests (#4445:
    // another book's in-flight score pass now gates the generation-path reconcile).
    releaseHung({ usedQwenTiers: NO_QWEN, mismatchCount: 0 });
    await __awaitScoringSettled('hang-1029');
  });

  it('does nothing when qa.speaker.enabled is false', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(false);
    await afterChapterFinalized({
      bookId: 'b3',
      bookDir: '/b3',
      chapters: [CH1],
      justFinalized: CH1,
      keep: NO_QWEN,
    });
    expect(writeAttempted).not.toHaveBeenCalled();
    expect(scoreBook).not.toHaveBeenCalled();
    expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
  });

  it('reconciles Qwen tiers against the run FULL-cast keep-flags after the score pass (Finding 2)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    const keep = { keep06: true, keep17: false };
    await afterChapterFinalized({ bookId: 'b4', bookDir: '/b4', chapters: [CH1], justFinalized: CH1, keep });
    // The reconcile fires in the fire-and-forget tail after scoreBook resolves.
    await vi.waitFor(() => expect(reconcileResidentQwenTiers).toHaveBeenCalledTimes(1));
    // It reconciles against ctx.keep (the run's full-cast set), NOT anything
    // derived from scoreBook's finalized-chapters view (scoreBook returns void).
    expect(reconcileResidentQwenTiers).toHaveBeenCalledWith(keep);
  });

  it('still reconciles on the generation path while the run own render is registered (#4235 skip is resume-only)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    // In production afterChapterFinalized runs while the run's own render is
    // registered, so isAnyGenerationActive() is true. The resume-only skip must
    // not apply to a pass that carries ctx.keep.
    const cleanup = __registerFakeJobForTest('b4', []);
    try {
      const keep = { keep06: true, keep17: false };
      await afterChapterFinalized({ bookId: 'b4', bookDir: '/b4', chapters: [CH1], justFinalized: CH1, keep });
      await __awaitScoringSettled('b4');
      expect(reconcileResidentQwenTiers).toHaveBeenCalledWith(keep);
    } finally {
      cleanup();
    }
  });

  /* #4445 - the generation path now skips the tier eviction while OTHER work is active. */
  describe('skips the generation-path reconcile while other work is active (#4445)', () => {
    const keep = { keep06: true, keep17: false };

    it("(a) another book's render is registered", async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      const cleanup = __registerFakeJobForTest('other-book', []);
      try {
        await afterChapterFinalized({ bookId: 'skip-a', bookDir: '/skip-a', chapters: [CH1], justFinalized: CH1, keep });
        await __awaitScoringSettled('skip-a');
        expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('(b) a splice or QA repair is registered (another book, or the same book)', async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      for (const [bookId, spliceBook] of [['skip-b1', 'other-book'], ['skip-b2', 'skip-b2']]) {
        const release = registerSplice(spliceBook, 1, new AbortController());
        try {
          await afterChapterFinalized({ bookId, bookDir: `/${bookId}`, chapters: [CH1], justFinalized: CH1, keep });
          await __awaitScoringSettled(bookId);
          expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
        } finally {
          release();
        }
      }
    });

    it("(c) another book's score pass is in flight", async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      let releaseOther!: (v: { usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }) => void;
      vi.mocked(scoreBook).mockImplementationOnce(
        () => new Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }>((r) => { releaseOther = r; }),
      );
      await afterChapterFinalized({ bookId: 'other-book', bookDir: '/o', chapters: [CH1], justFinalized: CH1, keep: NO_QWEN });
      await afterChapterFinalized({ bookId: 'skip-c', bookDir: '/skip-c', chapters: [CH1], justFinalized: CH1, keep });
      await __awaitScoringSettled('skip-c');
      expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(releaseOther).toBeTypeOf('function'));
      releaseOther({ usedQwenTiers: NO_QWEN, mismatchCount: 0 });
      await __awaitScoringSettled('other-book');
    });

    /* A live voice design / variant mint on ANY book holds the VoiceDesign model and the
       1.7B Base, and the reconcile's /unload would null them mid-forward. Neither enters
       `inFlightByBook`, so they read from the leaf gate's registered counters. */
    it.each([
      ['(d) a voice design is in flight', 'skip-d', setInFlightDesignCounter],
      ['(e) a variant mint is in flight', 'skip-e', setInFlightMintCounter],
    ] as const)('%s', async (_name, bookId, setCounter) => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      setCounter(() => 1);
      try {
        await afterChapterFinalized({ bookId, bookDir: `/${bookId}`, chapters: [CH1], justFinalized: CH1, keep });
        await __awaitScoringSettled(bookId);
        expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
      } finally {
        setCounter(() => 0);
      }
    });

    it('(f) the resume route (no ctx.keep) skips while a design or mint is in flight', async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      vi.mocked(scoreBook).mockResolvedValue({ usedQwenTiers: keep, mismatchCount: 0 });
      for (const setCounter of [setInFlightDesignCounter, setInFlightMintCounter]) {
        setCounter(() => 1);
        try {
          await triggerScoring({ bookId: 'skip-f', bookDir: '/skip-f', chapters: [CH1], justFinalizedSlugs: [] });
          await __awaitScoringSettled('skip-f');
          expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
        } finally {
          setCounter(() => 0);
        }
      }
    });
  });

  /* #4445 review pass 1 - `ctx.keep` is per chapter POST, so after a mid-run tier change a
     same-book sibling may be rendering on the 1.7B while this stale keep says keep17:false. */
  describe('never evicts the 1.7B while a Quality render is known active (#4445)', () => {
    it('keeps the 1.7B (forces keep17:true) when a same-book sibling renders at Quality; the 0.6B half follows ctx.keep', async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      const cleanup = __registerFakeJobForTest('stale-keep', [], true);
      try {
        const keep = { keep06: true, keep17: false };
        await afterChapterFinalized({ bookId: 'stale-keep', bookDir: '/stale-keep', chapters: [CH1], justFinalized: CH1, keep });
        await __awaitScoringSettled('stale-keep');
        expect(reconcileResidentQwenTiers).toHaveBeenCalledTimes(1);
        expect(reconcileResidentQwenTiers).toHaveBeenCalledWith({ keep06: true, keep17: true });
      } finally {
        cleanup();
      }
    });

    it('control: no Quality render active, the 1.7B evicts as before', async () => {
      vi.spyOn(cfg, 'configValue').mockReturnValue(true);
      const cleanup = __registerFakeJobForTest('stale-keep-ctl', [], false);
      try {
        const keep = { keep06: true, keep17: false };
        await afterChapterFinalized({ bookId: 'stale-keep-ctl', bookDir: '/stale-keep-ctl', chapters: [CH1], justFinalized: CH1, keep });
        await __awaitScoringSettled('stale-keep-ctl');
        expect(reconcileResidentQwenTiers).toHaveBeenCalledWith(keep);
      } finally {
        cleanup();
      }
    });
  });

  it('skips the reconcile when the run uses no Qwen tier', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({ bookId: 'b5', bookDir: '/b5', chapters: [CH1], justFinalized: CH1, keep: NO_QWEN });
    // Let the score-pass tail run; the reconcile must NOT fire for a no-Qwen run.
    await vi.waitFor(() => expect(scoreBook).toHaveBeenCalledTimes(1));
    expect(reconcileResidentQwenTiers).not.toHaveBeenCalled();
  });
});

describe('triggerScoring — registered scoring job (#3711)', () => {
  beforeEach(() => {
    vi.mocked(scoreBook).mockClear();
  });

  it("scores the lease's folder, not ctx.bookDir (the book may have moved since the ctx was built)", async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    leaseDirs.set('b-moved', '/moved-here');
    await triggerScoring({ bookId: 'b-moved', bookDir: '/stale', chapters: [CH1], justFinalizedSlugs: [] });
    await vi.waitFor(() => expect(scoreBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(scoreBook).mock.calls[0][0]).toBe('/moved-here');
  });

  it('never scores a book that is gone (registration answered BOOK_GONE)', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await triggerScoring({ bookId: 'b-deleted', bookDir: '/x', chapters: [CH1], justFinalizedSlugs: [] });
    await __awaitScoringSettled('b-deleted');
    expect(scoreBook).not.toHaveBeenCalled();
  });
});

describe('afterChapterFinalized — forwards the run model key to scoring (#3524 pass 2 A(ii))', () => {
  beforeEach(() => {
    vi.mocked(scoreBook).mockClear();
  });

  it("passes the run's model key through to scoreBook as runModelKey", async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await afterChapterFinalized({
      bookId: 'b-key',
      bookDir: '/b-key',
      chapters: [CH1],
      justFinalized: CH1,
      keep: NO_QWEN,
      runModelKey: 'coqui-xtts-v2',
    });
    await vi.waitFor(() => expect(scoreBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(scoreBook).mock.calls[0][3]).toMatchObject({ runModelKey: 'coqui-xtts-v2' });
  });

  it('Resume scoring (triggerScoring with no run key) passes none', async () => {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    await triggerScoring({ bookId: 'b-resume', bookDir: '/b-resume', chapters: [CH1], justFinalizedSlugs: [] });
    await vi.waitFor(() => expect(scoreBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(scoreBook).mock.calls[0][3]?.runModelKey).toBeUndefined();
  });
});

/* #1393 / #4560 (plan 293 §2.7, S1-S5) — the post-score reconcile re-reads the book's needs when
   it runs: a fresh `.queue.json` read (the finished chapter excluded) unioned, at the moment the
   keep function is called, with this book's live non-aborted jobs' `tierNeeds`. The reconcile is
   mocked, so the keep function it was handed is called here to read the resolved keep. */
describe('post-score reconcile recomputes its keep when it runs (#4560)', () => {
  type Keep = { keep06: boolean; keep17: boolean };
  const BOTH: Keep = { keep06: true, keep17: true };
  const entry = (
    bookId: string,
    chapterId: number,
    status: QueueEntry['status'],
    modelKey?: QueueEntry['modelKey'],
  ): QueueEntry => ({
    id: `${bookId}-${chapterId}`,
    bookId,
    chapterId,
    scope: 'this',
    addedAt: '2026-11-21T00:00:00.000Z',
    status,
    order: chapterId,
    ...(modelKey ? { modelKey } : {}),
  });
  const writeQueue = (entries: QueueEntry[]) =>
    writeQueueFile(queueJsonPath(), { entries, paused: false });
  /* Request key 0.6B; the narrator (title beat, always spoken) is raised to the 1.7B, `wren` too;
     `pip` rides the 0.6B; `ghost` is a 0.6B cast member who speaks nowhere. */
  const cast = [
    chr('narrator', { ttsModelKey: T17 }),
    chr('wren', { ttsModelKey: T17 }),
    chr('pip'),
    chr('ghost'),
  ];

  async function postScoreKeep(
    bookId: string,
    o: {
      queue: QueueEntry[];
      analysis: Record<number, ReturnType<typeof sent>[]>;
      fullCastKeep?: Keep;
      captured?: Keep;
      /** Runs while `scoreBook` is held open (a chapter queued, a sibling registered). */
      during?: () => Promise<void> | void;
      /** Runs inside the reconcile call, after the busy check and before the keep function is read. */
      beforeResolve?: () => void;
    },
  ): Promise<Keep | null> {
    vi.spyOn(cfg, 'configValue').mockReturnValue(true);
    vi.mocked(reconcileResidentQwenTiers).mockClear();
    await writeQueue(o.queue);
    let release!: (v: { usedQwenTiers: Keep; mismatchCount: number }) => void;
    vi.mocked(scoreBook).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    const captured = o.captured ?? { keep06: false, keep17: true };
    /* Resolve the keep INSIDE the reconcile call, as production does (right after /health, while
       this book's own score pass is still registered), not after the pass has settled. */
    let resolved: Keep | null | undefined;
    vi.mocked(reconcileResidentQwenTiers).mockImplementationOnce(async (arg) => {
      o.beforeResolve?.();
      resolved = typeof arg === 'function' ? arg() : arg;
      return true;
    });
    await afterChapterFinalized({
      bookId,
      bookDir: `/${bookId}`,
      chapters: [CH1],
      justFinalized: CH1,
      keep: captured,
      fullCastKeep: o.fullCastKeep ?? BOTH,
      recomputeKeep: makePostScoreKeepRecompute({
        bookId,
        finishedChapterId: CH1.id,
        analysisChapters: o.analysis,
        cast,
        defaultEngine: 'qwen',
        requestQwenModelKey: T06,
        qwenUnavailable: false,
        fullCastKeep: o.fullCastKeep ?? BOTH,
      }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await o.during?.();
    release({ usedQwenTiers: NO_QWEN, mismatchCount: 0 });
    await __awaitScoringSettled(bookId);
    expect(reconcileResidentQwenTiers).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reconcileResidentQwenTiers).mock.calls[0][0]).toBeTypeOf('function');
    return resolved as Keep | null;
  }

  it('S1: a same-book chapter queued while the pass ran is kept (not the POST-time capture)', async () => {
    const bookId = 'recon-s1';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress')],
      analysis: { 1: [sent('wren')], 2: [sent('pip')] },
      during: () => writeQueue([entry(bookId, 1, 'in_progress'), entry(bookId, 2, 'queued')]),
    });
    expect(resolved).toEqual(BOTH);
  });

  it('S2: a same-book job registered with declared tierNeeds is unioned in at call time', async () => {
    const bookId = 'recon-s2';
    let cleanup: (() => void) | undefined;
    try {
      const resolved = await postScoreKeep(bookId, {
        queue: [entry(bookId, 1, 'in_progress')],
        analysis: { 1: [sent('wren')] },
        during: () => {
          cleanup = __registerFakeJobForTest(bookId, [], false, BOTH);
        },
      });
      expect(resolved).toEqual(BOTH);
    } finally {
      cleanup?.();
    }
  });

  it('S3: a strict subset — the silent 0.6B cast member is NOT kept; only the 1.7B speaker remains', async () => {
    const bookId = 'recon-s3';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress'), entry(bookId, 2, 'queued')],
      analysis: { 1: [sent('wren')], 2: [sent('wren')] },
      fullCastKeep: BOTH,
    });
    expect(resolved).toEqual({ keep06: false, keep17: true });
  });

  it('S4: the just-finished chapter (still in_progress in the file) is excluded from the needs', async () => {
    const bookId = 'recon-s4';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress'), entry(bookId, 2, 'queued')],
      analysis: { 1: [sent('pip')], 2: [sent('wren')] },
    });
    expect(resolved).toEqual({ keep06: false, keep17: true });
  });

  /* Owner decision on #1393 (2026-11-22): after the book's LAST chapter the recomputed union is
     empty; the post-score reconcile then falls back to the keep computed at this run's start
     (`ctx.keep`) instead of skipping, so a 0.6B only the audition pulled is still evicted. */
  it('S5: the last chapter (nothing pending) falls back to the run-start keep: the audition-only 0.6B is evicted', async () => {
    const bookId = 'recon-s5';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress')],
      analysis: { 1: [sent('wren')] },
      captured: { keep06: false, keep17: true },
      fullCastKeep: BOTH,
    });
    expect(resolved).toEqual({ keep06: false, keep17: true });
  });

  it('S9: a re-queue of the finished chapter itself (queued) counts at its stamp; only its in_progress entry is excluded', async () => {
    const bookId = 'recon-s9';
    const resolved = await postScoreKeep(bookId, {
      queue: [
        entry(bookId, 1, 'in_progress'),
        { ...entry(bookId, 1, 'queued', T06), id: `${bookId}-1-requeue` },
      ],
      analysis: { 1: [sent('pip')] },
      captured: { keep06: false, keep17: true },
    });
    expect(resolved).toEqual(BOTH);
  });

  it('S10 (D3): an empty run-start keep and an empty union resolve to null, never both tiers evicted', async () => {
    const bookId = 'recon-s10';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress')],
      analysis: { 1: [sent('wren')] },
      captured: NO_QWEN,
    });
    expect(resolved).toBeNull();
  });

  it('S6: the last chapter keeps every tier the run used (run-start keep with both tiers)', async () => {
    const bookId = 'recon-s6';
    const resolved = await postScoreKeep(bookId, {
      queue: [entry(bookId, 1, 'in_progress')],
      analysis: { 1: [sent('wren')] },
      captured: BOTH,
    });
    expect(resolved).toEqual(BOTH);
  });

  /* The post-score keep shares its same-book union and its post-/health re-check with the run-start
     keep; these two pin the post-score call site (twins of F4 and R7). */
  it('S7 (F4 twin): other-book work registering after the busy check resolves to null (skipped)', async () => {
    const bookId = 'recon-s7';
    let cleanup: (() => void) | undefined;
    try {
      const resolved = await postScoreKeep(bookId, {
        queue: [entry(bookId, 1, 'in_progress'), entry(bookId, 2, 'queued')],
        analysis: { 1: [sent('wren')], 2: [sent('wren')] },
        beforeResolve: () => {
          cleanup = __registerFakeJobForTest('other-book', [], false, BOTH);
        },
      });
      expect(resolved).toBeNull();
    } finally {
      cleanup?.();
    }
  });

  it('S8 (R7 twin): an ABORTED same-book sibling contributes nothing', async () => {
    const bookId = 'recon-s8';
    let cleanup: (() => void) | undefined;
    try {
      const resolved = await postScoreKeep(bookId, {
        queue: [entry(bookId, 1, 'in_progress'), entry(bookId, 2, 'queued')],
        analysis: { 1: [sent('wren')], 2: [sent('wren')] },
        beforeResolve: () => {
          const fake = __registerFakeJobForTest(bookId, [], false, { keep06: true, keep17: false });
          cleanup = fake;
          fake.abort();
        },
      });
      expect(resolved).toEqual({ keep06: false, keep17: true });
    } finally {
      cleanup?.();
    }
  });
});
