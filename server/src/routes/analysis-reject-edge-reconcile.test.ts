/* #2166 — analysis.ts's caller-side half of the reconciliation: its own
   withCastLock, its own best-effort try/catch, operator-visible reporting,
   and NO write at all when the book is already consistent. The rules
   themselves are unit-tested in store/reject-edge-reconcile.test.ts. */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileRejectEdgesOnDisk } from './analysis.js';
import {
  loadCastIdHistoryWithStatus,
  dropSupersededIdsReclaimedByLiveCast,
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
          // And nothing claims otherwise in the run log.
          expect(lines).toEqual([]);

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

  /* PR #2202 gate review (Critical). The `degraded` guard above is defeated by
     the production ORDERING: `recordRetirements` and both `dropSuperseded*`
     helpers run earlier in the same persist block, read through the collapsing
     `loadCastIdHistory`, and write back UNCONDITIONALLY — so by the time the
     reconciliation reads, the damaged file has been replaced by a valid, empty
     one and its own read says `ok`. Both records of a real user decision then
     go: the `rejectedPairs` half was already unreadable, and the removal pass
     deletes the `notLinkedTo` half that was still enforcing it.

     Driven here as the two real functions in the real order against one book
     dir, rather than through the persist block itself — no unit test stands
     that block up (which is exactly why [C7] below is a source scan), and this
     interleaving IS the defeat. [C7] pins that analysis.ts orders it this way;
     this pins that ordering it this way actually saves the edge. */
  it('[C10] an always-writing history step cannot launder a degraded read into a deletion', async () => {
    /* A genuine reject: the edge on cast.json, its `rejectedPairs` backing in
       a history file that has been truncated mid-write. No `rejectedPairs`
       survives the damage — the exact shape [C1] deletes. */
    seedRawHistory(
      { characters: [{ id: 'mairin', notLinkedTo: [{ bookId: BOOK_ID, characterId: 'm2' }] }] },
      '{"schema":1,"supersededBy":{},"rejectedPairs":[{"from":"m2","to":"mai',
    );
    const { lines, log } = collectLog();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // 1. The persist block's FIRST act: take the verdict, before any rewrite.
      const { status } = await loadCastIdHistoryWithStatus(bookDir);
      expect(status).toBe('degraded');

      // 2. An always-writing step runs, exactly as the persist block runs it.
      await dropSupersededIdsReclaimedByLiveCast(bookDir, ['mairin']);

      /* 3. The damage is now UNOBSERVABLE from disk — the file is valid and
            empty. This is the assertion that makes the rest meaningful: the
            reconciliation's own read can no longer defend the edge, so only
            the verdict carried from step 1 can. */
      expect((await loadCastIdHistoryWithStatus(bookDir)).status).toBe('ok');

      // 4. The reconciliation, handed the pre-rewrite verdict.
      await reconcileRejectEdgesOnDisk(bookDir, BOOK_ID, log, status);

      // The user's decision survives — the whole point.
      expect(readCast().characters[0].notLinkedTo).toEqual([
        { bookId: BOOK_ID, characterId: 'm2' },
      ]);
      // And nothing claims to have cleared a stranded link.
      expect(lines).toEqual([]);

      const skip = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('reject-edge reconciliation skipped'));
      expect(skip).toHaveLength(1);
      expect(skip[0]).toContain(BOOK_ID);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('[C7] is wired into BOTH authoritative persists', () => {
    /* A source scan, not a behavioural test — deliberately. The two call sites
       live inside the analysis persist path, which no unit test stands up, so
       without this the helper could be exported and never called and the whole
       branch would stay green. Mirrors cast-lock.guard.test.ts's approach. */
    const src = readFileSync(fileURLToPath(new URL('./analysis.ts', import.meta.url)), 'utf8');
    const calls = src.match(/await reconcileRejectEdgesOnDisk\(record\.bookDir,/g) ?? [];

    expect(
      calls,
      'analysis.ts no longer calls reconcileRejectEdgesOnDisk at both authoritative persists — see plan 281 Task 3',
    ).toHaveLength(2);
    expect(src).toContain(
      'await reconcileRejectEdgesOnDisk(record.bookDir, retirementBookId, log, historyStatusBeforePersist)',
    );
    expect(src).toContain(
      'await reconcileRejectEdgesOnDisk(record.bookDir, subsetBookId, log, historyStatusBeforePersist)',
    );
  });

  /* PR #2202 gate review (Critical) — [C10] proves that taking the verdict
     BEFORE the rewriting steps saves the edge. This pins that analysis.ts
     actually takes it there. Source scan for the same reason as [C7]: the
     persist blocks are not standable-up in a unit test, and the ordering is
     the whole fix — a capture that drifted below the first `recordRetirements`
     would leave every behavioural test green while the file was laundered
     again in production. */
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
        `await recordRetirements(record.bookDir, ${bookIdBinding},`,
        blockStart,
      );
      const reconcileIdx = src.indexOf(
        `await reconcileRejectEdgesOnDisk(record.bookDir, ${bookIdBinding}, log, historyStatusBeforePersist)`,
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
});
