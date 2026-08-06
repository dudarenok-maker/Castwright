/* #2166 — analysis.ts's caller-side half of the reconciliation: its own
   withCastLock, its own best-effort try/catch, operator-visible reporting,
   and NO write at all when the book is already consistent. The rules
   themselves are unit-tested in store/reject-edge-reconcile.test.ts. */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileRejectEdgesOnDisk } from './analysis.js';

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
    expect(src).toContain('await reconcileRejectEdgesOnDisk(record.bookDir, retirementBookId, log)');
    expect(src).toContain('await reconcileRejectEdgesOnDisk(record.bookDir, subsetBookId, log)');
  });
});
