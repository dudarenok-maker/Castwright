/* #2166 — analysis.ts's caller-side half of the reconciliation: its own
   withCastLock, its own best-effort try/catch, operator-visible reporting,
   and NO write at all when the book is already consistent. The rules
   themselves are unit-tested in store/reject-edge-reconcile.test.ts. */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcileRejectEdgesOnDisk,
  DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE,
  logIfDegradedCastIdHistory,
} from './analysis.js';
import {
  loadCastIdHistoryWithStatus,
  dropSupersededIdsReclaimedByLiveCast,
  CastIdHistoryUnreadableError,
} from '../store/cast-id-history.js';

const BOOK_ID = 'book-hollow-tide';
let root: string;
let bookDir: string;

function seed(cast: object, history: object | null) {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
  if (history) {
    writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify(history));
  } else {
    rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
  }
}

/* Seed a cast.json plus a cast-id-history.json whose RAW BYTES are given —
   the two degraded shapes `seed()` cannot express, because it stringifies. */
function seedRawHistory(cast: object, historyText: string) {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify(cast));
  writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), historyText);
}

function readCast() {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

function collectLog() {
  const lines: string[] = [];
  return { lines, log: (_phase: number, message: string) => void lines.push(message) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-reject-reconcile-'));
  bookDir = join(root, 'book');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('reconcileRejectEdgesOnDisk', () => {
  it('[C1] removes an unbacked edge and reports it', async () => {
    seed({ characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] }, null);
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([]);
    expect(lines.join('\n')).toMatch(/mairin/);
    expect(lines.join('\n')).toMatch(/m2/);
  });

  it('[C2] writes back an edge whose pair survived, and reports it', async () => {
    seed(
      { characters: [{ id: 'mairin' }] },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
    expect(lines.join('\n')).toMatch(/m2/);
  });

  it('[C3] performs NO write when the book is already consistent', async () => {
    seed(
      { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const before = statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs;
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs).toBe(before);
    expect(lines).toEqual([]);
  });

  it('[C4] touches nothing when bookId is undefined', async () => {
    seed({ characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] }, null);
    const { log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, undefined, log);

    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
  });

  it('[C5] is best-effort — an unreadable cast.json does not throw', async () => {
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), 'not json at all');
    const { log } = collectLog();

    await expect(reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log)).resolves.toBeUndefined();
  });

  it('[C6] does not undo clearNotLinkedEdgesForDroppedRejections', async () => {
    /* #2133's helper is per-RETIREMENT: retireCharacterId drops a self-loop
       pair from history and the helper clears the matching edge. This
       reconciliation is per-PERSIST and derived from state — so it must see
       that as consistent, not as "a pair whose edge is missing".

       DOCUMENTARY, not evidential — stated plainly rather than counted. The
       fixture is a consistent book: `mairin` has a backed edge and `mara` has
       neither pair nor edge (the post-#2133 state, where retireCharacterId
       dropped the pair and its helper cleared the edge). Nothing here can
       redden against any implementation that derives adds solely from
       `rejectedPairs`, which is the only thing this one does. Its value is
       that it writes the interaction down. See Step 7. */
    seed(
      {
        characters: [
          { id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] },
          { id: 'mara' },
        ],
      },
      { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'm2', to: 'mairin' }] },
    );
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(readCast().characters[1].notLinkedTo).toBeUndefined();
    expect(readCast().characters[0].notLinkedTo).toEqual([{ bookId: BOOK_ID, characterId: 'm2' }]);
    expect(lines).toEqual([]);
  });

  /* Final-review Critical (#2166). `loadCastIdHistory` collapses absent,
     unreadable and malformed onto the same empty history. Pass 1 reads an
     empty history as PROOF that every same-book edge is stranded, so a
     degraded read used to delete every reject in the book and log that it had
     cleared stranded links — and only a `rejectedPairs`-backed edge could ever
     come back. Both fixtures below carry a same-book edge and NO
     `rejectedPairs`: the exact shape [C1] deletes when the history is
     genuinely absent, so nothing but the degraded check can keep them green. */
  describe('a degraded cast-id-history.json removes NOTHING', () => {
    for (const [id, label, historyText] of [
      ['C8', 'unparseable', '{invalid json'],
      ['C9', 'wrong shape', JSON.stringify({ schema: 2, supersededBy: {} })],
    ] as const) {
      it(`[${id}] keeps every edge when the history file is present but ${label}`, async () => {
        seedRawHistory(
          { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
          historyText,
        );
        const before = statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs;
        const { lines, log } = collectLog();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        try {
          await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

          // The edge survives — the whole point.
          expect(readCast().characters[0].notLinkedTo).toEqual([
            { bookId: BOOK_ID, characterId: 'm2' },
          ]);
          // No write at all.
          expect(statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs).toBe(before);
          // #2201 — the run log gets ONE line naming the skip, distinguishable
          // from the `Cleared N …` / `Restored N …` lines that fire only when
          // a write actually happened.
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/could not be read/);
          expect(lines[0]).not.toMatch(/Cleared|Restored/);

          // Operator-visible: one warning naming the book and the skip.
          const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
          const skip = warnings.filter((m) => m.includes('reject-edge reconciliation skipped'));
          expect(skip).toHaveLength(1);
          expect(skip[0]).toContain(BOOK_ID);
          expect(skip[0]).not.toMatch(/Cleared/);
        } finally {
          warnSpy.mockRestore();
        }
      });
    }
  });

  /* #2201 — the sibling half of [C8]/[C9]: a healthy run (this is [C1]'s own
     fixture, replayed here to pin the log-line side specifically) must NOT
     emit the degraded-skip line — it would be a false "this book needs
     attention" report on a book that needed nothing of the sort. */
  it('[C12] a healthy run does not emit the degraded-skip log line', async () => {
    seed({ characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] }, null);
    const { lines, log } = collectLog();

    await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log);

    expect(lines.some((l) => l.includes('could not be read'))).toBe(false);
  });

  /* #2214 — the ROOT fix. PR #2202's `degraded` guard above only protected
     THIS function's own consequence; the always-writing history step run
     earlier in the same persist block (`recordRetirements`, both
     `dropSuperseded*` helpers) read through the collapsing `loadCastIdHistory`
     and wrote back UNCONDITIONALLY — so by the time the reconciliation used
     to read, the damaged file had already been replaced by a valid, empty one.
     #2214 hardens the step itself: it now reads through
     `loadCastIdHistoryWithStatus` and THROWS `CastIdHistoryUnreadableError`
     on a degraded verdict, before inspecting or mutating anything — so the
     laundering this test used to have to defend against (via
     `statusBeforePersist`) can no longer happen in the first place. The
     `statusBeforePersist` plumbing stays wired (exercised below) as defence
     in depth, not because it is still the only thing standing between a
     degraded read and a deletion.

     Driven here as the two real functions in the real order against one book
     dir, rather than through the persist block itself — no unit test stands
     that block up (which is exactly why [C7] below is a source scan), and this
     interleaving is what a regression here would defeat. [C7] pins that
     analysis.ts orders it this way; this pins that the ordering, plus the
     root fix, actually saves the edge. */
  it('[C10] a degraded read refuses to write — the damaged file is never laundered into a valid empty one', async () => {
    /* A genuine reject: the edge on cast.json, its `rejectedPairs` backing in
       a history file that has been truncated mid-write. No `rejectedPairs`
       survives the damage — the exact shape [C1] deletes. */
    const rawHistory = '{"schema":1,"supersededBy":{},"rejectedPairs":[{"from":"m2","to":"mai';
    seedRawHistory(
      { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
      rawHistory,
    );
    const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
    const { lines, log } = collectLog();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // 1. The persist block's FIRST act: take the verdict, before any rewrite.
      const { status } = await loadCastIdHistoryWithStatus(bookDir);
      expect(status).toBe('degraded');

      /* 2. An always-writing step runs, exactly as the persist block runs it —
            it now REFUSES, throwing instead of silently laundering the file.
            This is the root fix under test: production wraps this call in a
            try/catch (analysis.ts's persist blocks), so the throw itself is
            non-fatal to the run — what matters here is that it happens at
            all, before any write. */
      await expect(dropSupersededIdsReclaimedByLiveCast(bookDir, ['mairin'])).rejects.toThrow(
        CastIdHistoryUnreadableError,
      );

      /* 3. The damage is still fully OBSERVABLE from disk — byte-identical to
            what was seeded. Before #2214 this step replaced it with a valid,
            empty file; now it never touches it. */
      expect(readFileSync(historyPath, 'utf8')).toBe(rawHistory);
      expect((await loadCastIdHistoryWithStatus(bookDir)).status).toBe('degraded');

      // 4. The reconciliation, handed the pre-rewrite verdict — #2202's
      //    downstream defence, still exercised as belt-and-braces.
      await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log, status);

      // The user's decision survives — the whole point.
      expect(readCast().characters[0].notLinkedTo).toEqual([
        { bookId: BOOK_ID, characterId: 'm2' },
      ]);
      // And nothing claims to have cleared a stranded link — #2201's log
      // line reports the skip, never a clear/restore. Pin the line COUNT too
      // (finding 4, PR #2233 review) — [C8]/[C9] pin it this way already;
      // the `.some()` pair above only checked content, not that exactly one
      // line was emitted.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/could not be read/);
      expect(lines[0]).not.toMatch(/Cleared|Restored/);

      const skip = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('reject-edge reconciliation skipped'));
      expect(skip).toHaveLength(1);
      expect(skip[0]).toContain(BOOK_ID);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /* PR #2233 review, finding 1. [C10] cannot tell "the ternary is honoured"
     from "the ternary is inert", because its own local read ALSO comes back
     `degraded` — `statusNow` already equals `statusBeforePersist` there, so
     `statusBeforePersist === 'degraded' ? 'degraded' : statusNow` and a bare
     `statusNow` produce the same answer. This case forces them apart: the
     history on disk is HEALTHY (a genuine `ok` local read, no
     `rejectedPairs`) so pass 1 would delete the edge on its own — only the
     ternary honouring the pre-persist `degraded` verdict can save it. */
  it('[C14] a degraded statusBeforePersist overrides a HEALTHY local read', async () => {
    seed(
      { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
      { schema: 1, supersededBy: {}, rejectedPairs: [] },
    );
    const before = statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs;
    const { lines, log } = collectLog();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log, 'degraded');

      // The edge survives even though the local read is healthy.
      expect(readCast().characters[0].notLinkedTo).toEqual([
        { bookId: BOOK_ID, characterId: 'm2' },
      ]);
      // No write at all.
      expect(statSync(join(bookDir, '.audiobook', 'cast.json')).mtimeMs).toBe(before);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/could not be read/);
      expect(lines[0]).not.toMatch(/Cleared|Restored/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /* #2228 disposition (kept, not retired): analysis.persist-block-degraded-
     history.test.ts now drives runMainAnalyzerJob's persist block end to end
     — a degraded cast-id-history.json produces the shared log line and the
     file is left byte-identical — which is real behavioural coverage for
     ONE of the two authoritative persists. [C7]/[C11] stay as cheap
     backstops for the other: they are the only coverage on
     runSubsetAnalyzerJob's mirror block (standing that one up too would cost
     a second ~60s stub-analyzer run for the same wiring fact this source
     scan already pins for free), and they also continue to catch the
     ~zero-cost regression the behavioural test doesn't aim at — the helper
     being exported but silently uncalled from one of the two call sites. */
  it('[C7] is wired into BOTH authoritative persists', () => {
    /* A source scan, not a behavioural test — deliberately. The two call sites
       live inside the analysis persist path, which no unit test stands up, so
       without this the helper could be exported and never called and the whole
       branch would stay green. Mirrors cast-lock.guard.test.ts's approach. */
    const src = readFileSync(fileURLToPath(new URL('./analysis.ts', import.meta.url)), 'utf8');
    const calls = src.match(/await reconcileRejectEdgesOnDisk\(writeDir,/g) ?? [];

    expect(
      calls,
      'analysis.ts no longer calls reconcileRejectEdgesOnDisk at both authoritative persists — see plan 281 Task 3',
    ).toHaveLength(2);
    expect(src).toContain(
      'await reconcileRejectEdgesOnDisk(writeDir, retirementBookId, log, historyStatusBeforePersist, castBase)',
    );
    expect(src).toContain(
      'await reconcileRejectEdgesOnDisk(writeDir, subsetBookId, log, historyStatusBeforePersist, castBase)',
    );
  });

  /* PR #2202 gate review (Critical) — [C10] proves that taking the verdict
     BEFORE the rewriting steps saves the edge. This pins that analysis.ts
     actually takes it there. Source scan for the same reason as [C7]: the
     persist blocks are not standable-up in a unit test, and the ordering is
     the whole fix — a capture that drifted below the first `recordRetirements`
     would leave every behavioural test green while the file was laundered
     again in production. Kept, not retired, for the same #2228 disposition
     recorded on [C7] above (same cheap-backstop reasoning, unrepeated here). */
  it('[C11] captures the id-history verdict BEFORE the persist rewrites it, on both paths', () => {
    const src = readFileSync(fileURLToPath(new URL('./analysis.ts', import.meta.url)), 'utf8');

    for (const bookIdBinding of ['retirementBookId', 'subsetBookId'] as const) {
      /* `retirementBookId` appears only in the main persist block and
         `subsetBookId` only in the subset one, so each anchor scopes the
         search to its own block without needing to parse. */
      const blockStart = src.indexOf(`const ${bookIdBinding} = bookIdForRetirementCleanup(record)`);
      expect(blockStart, `${bookIdBinding} block not found`).toBeGreaterThan(-1);

      const captureIdx = src.indexOf(
        'const { status: historyStatusBeforePersist } = await loadCastIdHistoryWithStatus(',
        blockStart,
      );
      const firstRewriteIdx = src.indexOf(
        `await recordRetirements(writeDir, ${bookIdBinding},`,
        blockStart,
      );
      const reconcileIdx = src.indexOf(
        `await reconcileRejectEdgesOnDisk(writeDir, ${bookIdBinding}, log, historyStatusBeforePersist, castBase)`,
        blockStart,
      );

      expect(captureIdx, `no pre-persist id-history read in the ${bookIdBinding} block`).toBeGreaterThan(-1);
      expect(firstRewriteIdx, `no recordRetirements in the ${bookIdBinding} block`).toBeGreaterThan(-1);
      expect(reconcileIdx, `no reconcile call in the ${bookIdBinding} block`).toBeGreaterThan(-1);
      expect(
        captureIdx,
        `the ${bookIdBinding} block reads cast-id-history.json AFTER a step that rewrites it — the degraded guard is defeated (PR #2202 gate review, Critical)`,
      ).toBeLessThan(firstRewriteIdx);
      expect(captureIdx).toBeLessThan(reconcileIdx);
    }
  });

  /* #2214/#2201 — the #2214 hardening (every id-history mutating helper now
     THROWS CastIdHistoryUnreadableError on a degraded read instead of
     laundering the file) made #2201's user-facing log line unreachable on
     the real path: the unconditional `dropSupersededIdsReclaimedByLiveCast`
     call inside each persist block's try now throws BEFORE
     `reconcileRejectEdgesOnDisk` — the only place that line used to live —
     is ever reached, jumping straight to `catch (historyErr)`. Neither
     persist block is standable-up in a unit test (see [C7]/[C11]'s own
     comments for why — no test in this file, or `book-state-preserve-
     voices.test.ts`'s only other reference to `reconcileRejectEdgesOnDisk`,
     exercises `runMainAnalyzerJob`/`runSubsetAnalyzerJob` end to end), so
     this pins the wiring at the same source-scan seam [C7]/[C11] already
     use — but PR #2233 review, finding 5 pulled the actual behaviour
     (`instanceof` check + log call) out into an exported
     `logIfDegradedCastIdHistory` helper, so it no longer has to be a source
     scan ALONE: the helper below is driven directly, including the negative
     case (a plain `Error` emits nothing) a source scan can't check at all. */
  describe('logIfDegradedCastIdHistory', () => {
    it('[C13a] emits the shared degraded-history log line for CastIdHistoryUnreadableError', () => {
      const { lines, log } = collectLog();

      logIfDegradedCastIdHistory(new CastIdHistoryUnreadableError('boom'), log);

      expect(lines).toEqual([DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE]);
    });

    it('[C13b] emits nothing for a plain Error', () => {
      const { lines, log } = collectLog();

      logIfDegradedCastIdHistory(new Error('boom'), log);

      expect(lines).toEqual([]);
    });
  });

  it('[C13] both persist-block catch handlers call the shared helper', () => {
    const src = readFileSync(fileURLToPath(new URL('./analysis.ts', import.meta.url)), 'utf8');

    const catchHandlerWarnLines = [
      "console.warn('[analysis] failed to record character-id retirement(s)', historyErr);",
      "console.warn('[analysis-subset] failed to record character-id retirement(s)', historyErr);",
    ];

    for (const warnLine of catchHandlerWarnLines) {
      const warnIdx = src.indexOf(warnLine);
      expect(warnIdx, `catch handler not found: ${warnLine}`).toBeGreaterThan(-1);

      // Scope the search to THIS catch block only — bounded by the start of
      // the next `catch (historyErr) {` (or EOF for the last one) — so a fix
      // present in one handler but missing from the other cannot pass by
      // matching the sibling's copy further down the file.
      const nextCatchStart = src.indexOf('} catch (historyErr) {', warnIdx + 1);
      const block = src.slice(warnIdx, nextCatchStart === -1 ? src.length : nextCatchStart);

      expect(
        block,
        `catch handler after "${warnLine}" does not call logIfDegradedCastIdHistory`,
      ).toContain('logIfDegradedCastIdHistory(historyErr, log);');
    }

    // Reused, not copy-pasted: the instanceof check + log call live in the
    // helper ONCE; each catch handler is one call site, plus
    // reconcileRejectEdgesOnDisk's own degraded branch still emits directly
    // (it already has the verdict in hand, not a caught error).
    expect(src.match(/logIfDegradedCastIdHistory\(historyErr, log\);/g) ?? []).toHaveLength(2);
    expect(src.match(/log\(1, DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE\);/g) ?? []).toHaveLength(2);

    // The shared constant itself carries the user-facing wording a reader of
    // reconcileRejectEdgesOnDisk's own degraded branch already recognises.
    expect(DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE).toMatch(/could not be read/);
    expect(DEGRADED_CAST_ID_HISTORY_LOG_MESSAGE).toMatch(/No links were changed/);
  });
});
