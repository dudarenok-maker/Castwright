/* Integration tests for the library-cast override router.

   Sets up a tempdir workspace with two books that both contain a
   character named "Oduvan". The source book (richer profile — full
   description, attributes, gender, ageRange) is the "current" book the
   user is on; the target book (leaner profile — only name + voiceId) is
   the library record whose profile we want to overwrite. Asserts the
   merge preserves the target's audio identity (id, voiceId, name) while
   pulling source's richer profile into it. Same lazy-import pattern as
   cast-merge.test.ts / voice-match.test.ts so WORKSPACE_DIR is set before
   paths.js binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { readJson } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

/* #1981 fix-round Finding 2 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so
   the AB/BA deadlock test at the bottom of this file can deterministically
   intercept this route's OWN `findBookByBookId` calls (bound at scan.js's
   own module-load time). Defaults to a plain passthrough — every other test
   in this file behaves exactly as if this mock weren't here. Same shape as
   cast-not-linked-to.test.ts's own `#1981` deadlock test — see that test's
   header comment for why a bare `Promise.all` of two live requests can't
   reliably exercise this path. */
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return { ...actual, findBookByBookId: vi.fn(actual.findBookByBookId) };
});

/* `readJson` has no workspace-path dependency at all, so it's safe as an
   ordinary top-level import. `castJsonPath` is a pure function of its
   bookDir argument too, but merely IMPORTING '../workspace/paths.js'
   executes that module's top-level WORKSPACE_ROOT/BOOKS_ROOT binding
   against whatever WORKSPACE_DIR happens to be at that instant — so it
   still needs the same lazy-import treatment as `makeBookId` below (see
   this file's header comment); imported once, inside the same-book
   describe's beforeAll. */
interface CastFile {
  characters: CharacterOutput[];
}

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const NOVELLA = 'Novella';
const FULL_NOVEL = 'Full Novel';

let workspaceRoot: string;
let app: Express;
let novellaBookId: string;
let novelBookId: string;

/* The lean library record: a novella met Oduvan only briefly, so the
   analyzer only nailed down his name + gender. The voiceId is the
   crucial bit — the novella's chapter audio is bound to it and must
   survive the override. */
const leanOduvan = {
  id: 'oduvan',
  name: 'Oduvan',
  role: 'minor character',
  color: 'eliza',
  voiceId: 'v_oduvan_novella',
  gender: 'male',
  lines: 4,
  scenes: 1,
  /* Evidence is per-book — these quotes are from the novella's
     manuscript and must NOT be overwritten by the richer book's quotes,
     which wouldn't resolve against this manuscript. */
  evidence: [{ quote: 'Easy now.', note: 'novella moment' }],
};

/* The rich source: a full novel saw Oduvan across many chapters and
   built a fuller portrait. Slightly different canonical name ("Oduvan
   Heks") — the override should fold the lean target's "Oduvan" form
   into target.aliases so future matches across the series recognise
   either form. */
const richOduvan = {
  id: 'oduvan',
  name: 'Oduvan Heks',
  role: 'Physician',
  color: 'damien',
  voiceId: 'v_oduvan_novel',
  gender: 'male',
  ageRange: 'adult',
  attributes: ['eccentric', 'reassuring', 'humorous'],
  aliases: ['Doc'],
  description: 'The elvin physician at Saltmoor — eccentric, kind, calm under pressure.',
  tone: { warmth: 75, pace: 55, authority: 60 },
  evidence: [{ quote: "I'll have you patched up in no time.", note: 'novel moment' }],
  lines: 208,
  scenes: 7,
};

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-library-override-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ libraryCastOverrideRouter }, { makeBookId }] = await Promise.all([
    import('./library-cast-override.js'),
    import('../workspace/paths.js'),
  ]);
  novellaBookId = makeBookId(AUTHOR, SERIES, NOVELLA);
  novelBookId = makeBookId(AUTHOR, SERIES, FULL_NOVEL);

  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NOVELLA, novellaBookId, [leanOduvan]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, FULL_NOVEL, novelBookId, [richOduvan]);

  app = express();
  app.use(express.json());
  app.use('/api', libraryCastOverrideRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function readCast(title: string) {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

function callOverride(body: object) {
  return request(app)
    .post('/api/library-cast/override')
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('library-cast override router', () => {
  it('rejects when any of the four ids are missing', async () => {
    const res = await callOverride({ sourceBookId: novelBookId, sourceCharacterId: 'oduvan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when source === target', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novelBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: 'nope',
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the source character id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'missing',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source character/i);
  });

  it('returns 404 when the target character id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it("writes the merged profile to BOTH books while preserving each side's audio identity", async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(200);

    const targetOnDisk = readCast(NOVELLA).characters[0];
    const sourceOnDisk = readCast(FULL_NOVEL).characters[0];

    /* Audio identity preserved per-side — id, voiceId, name, color stay
       with their own book. The novella keeps v_oduvan_novella so its
       chapter audio still plays; the full novel keeps v_oduvan_novel. */
    expect(targetOnDisk.id).toBe('oduvan');
    expect(targetOnDisk.voiceId).toBe('v_oduvan_novella');
    expect(targetOnDisk.name).toBe('Oduvan');
    expect(sourceOnDisk.id).toBe('oduvan');
    expect(sourceOnDisk.voiceId).toBe('v_oduvan_novel');
    expect(sourceOnDisk.name).toBe('Oduvan Heks');

    /* Per-book metrics + per-book evidence don't cross over. */
    expect(targetOnDisk.lines).toBe(4);
    expect(targetOnDisk.scenes).toBe(1);
    expect(targetOnDisk.evidence).toEqual([{ quote: 'Easy now.', note: 'novella moment' }]);
    expect(sourceOnDisk.lines).toBe(208);
    expect(sourceOnDisk.scenes).toBe(7);
    expect(sourceOnDisk.evidence).toEqual([
      { quote: "I'll have you patched up in no time.", note: 'novel moment' },
    ]);

    /* Profile fields — both sides end up identical on the merged
       fields. Longest description wins (source's); attributes unioned;
       tone fields merged; role/gender/ageRange from whichever side has
       a value (source wins on conflict). */
    for (const merged of [targetOnDisk, sourceOnDisk]) {
      expect(merged.description).toBe(richOduvan.description);
      expect(merged.role).toBe('Physician');
      expect(merged.ageRange).toBe('adult');
      expect(merged.gender).toBe('male');
      expect(merged.attributes).toEqual(['eccentric', 'reassuring', 'humorous']);
      expect(merged.tone).toEqual({ warmth: 75, pace: 55, authority: 60 });
    }

    /* Aliases — each side drops its OWN name. The novella's aliases
       include "Oduvan Heks" (source's name) and "Doc" (source's alias).
       The full novel's aliases include "Oduvan" (target's name).
       Neither side self-aliases. */
    const targetAliases = (targetOnDisk.aliases as string[] | undefined) ?? [];
    expect(targetAliases).toContain('Oduvan Heks');
    expect(targetAliases).toContain('Doc');
    expect(targetAliases).not.toContain('Oduvan');

    const sourceAliases = (sourceOnDisk.aliases as string[] | undefined) ?? [];
    expect(sourceAliases).toContain('Oduvan');
    expect(sourceAliases).toContain('Doc');
    expect(sourceAliases).not.toContain('Oduvan Heks');
  });

  it('returns both merged records in the response body', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({
      id: 'oduvan',
      voiceId: 'v_oduvan_novel',
      name: 'Oduvan Heks',
      description: richOduvan.description,
      role: 'Physician',
    });
    expect(res.body.target).toMatchObject({
      id: 'oduvan',
      voiceId: 'v_oduvan_novella',
      name: 'Oduvan',
      description: richOduvan.description,
      role: 'Physician',
    });
  });

  it('keeps the longer description on the source when target has a longer one', async () => {
    /* Edge case: the LIBRARY record's description is longer than the
       current book's. "Longest wins" must keep the longer one on both
       sides — we don't blindly favour the source. Build a fresh book
       pair to exercise this without polluting prior tests. */
    const RICHER_TARGET_TITLE = 'Richer-Target Novella';
    const LEANER_SOURCE_TITLE = 'Leaner-Source Novel';
    const { makeBookId } = await import('../workspace/paths.js');
    const richerTargetId = makeBookId(AUTHOR, SERIES, RICHER_TARGET_TITLE);
    const leanerSourceId = makeBookId(AUTHOR, SERIES, LEANER_SOURCE_TITLE);

    const richerTarget = {
      id: 'aldous',
      name: 'Aldous',
      role: 'councillor',
      color: 'eliza',
      voiceId: 'v_aldous_target',
      gender: 'male',
      ageRange: 'adult',
      description:
        'A red-haired councillor with a warm laugh, known for treating Wren like a daughter and for breaking ranks with the Council when conscience demanded it.',
      attributes: ['warm', 'principled'],
      lines: 90,
      scenes: 3,
    };
    const leanerSource = {
      id: 'aldous',
      name: 'Aldous',
      role: '',
      color: 'eliza',
      voiceId: 'v_aldous_source',
      gender: 'male',
      description: 'A councillor.',
      lines: 12,
      scenes: 1,
    };
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, RICHER_TARGET_TITLE, richerTargetId, [
      richerTarget,
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, LEANER_SOURCE_TITLE, leanerSourceId, [
      leanerSource,
    ]);

    const res = await callOverride({
      sourceBookId: leanerSourceId,
      sourceCharacterId: 'aldous',
      targetBookId: richerTargetId,
      targetCharacterId: 'aldous',
    });
    expect(res.status).toBe(200);
    /* Target's longer description survived on BOTH sides — the source's
       leaner record now carries the richer description too. */
    expect(res.body.source.description).toBe(richerTarget.description);
    expect(res.body.target.description).toBe(richerTarget.description);
    /* Target's role survived because source didn't have one. */
    expect(res.body.source.role).toBe('councillor');
    /* Identity-only fields source lacked are filled from target. */
    expect(res.body.source.ageRange).toBe('adult');
    /* Attributes unioned (source had none) so both sides get target's. */
    expect(res.body.source.attributes).toEqual(['warm', 'principled']);
  });
});

/* #1981 (Task 8) — the same-book data-loss bug. library-cast-override's
   guard rejects same-book AND same-character only, so same-book with two
   DIFFERENT characters is reachable — and broken with NO concurrency at
   all: two independent reads of one file, two arrays derived from
   separate snapshots, two writes to the same path. Its own book pair so
   this can't interact with the shared Oduvan fixtures above. */
describe('library-cast override router — same-book merge (#1981 Task 8)', () => {
  const SAME_BOOK_TITLE = 'Same-Book Override Book';
  const aliceName = 'Alice Merrow';
  const bobName = 'Bob Wexler';
  let bookId: string;
  let bookDir: string;
  let castJsonPath: (bookDir: string) => string;

  beforeAll(async () => {
    const paths = await import('../workspace/paths.js');
    castJsonPath = paths.castJsonPath;
    const { makeBookId } = paths;
    bookId = makeBookId(AUTHOR, SERIES, SAME_BOOK_TITLE);
    bookDir = writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, SAME_BOOK_TITLE, bookId, [
      {
        id: 'alice',
        name: aliceName,
        role: 'protagonist',
        color: 'eliza',
        voiceId: 'v_alice',
        gender: 'female',
        ageRange: 'adult',
        description: 'A sharp-tongued cartographer with a soft spot for lost causes.',
        attributes: ['sharp-tongued', 'loyal'],
        aliases: ['Al'],
        lines: 40,
        scenes: 3,
      },
      {
        id: 'bob',
        name: bobName,
        role: 'sidekick',
        color: 'damien',
        voiceId: 'v_bob',
        gender: 'male',
        ageRange: 'adult',
        description: 'A nervous quartermaster who counts everything twice.',
        attributes: ['nervous', 'meticulous'],
        lines: 25,
        scenes: 2,
      },
    ]);
  });

  it('does not lose the source merge when source and target are the same book', async () => {
    /* Its guard rejects same-book AND same-character only, so same-book with two
       different characters is reachable — and broken with no concurrency at
       all: two independent reads of one file, two arrays derived from separate
       snapshots, two writes to the same path. nextTargetCharacters is derived
       from the PRE-merge targetCast read, so the second write puts alice back
       unmodified and her merge is gone.

       Assert on `aliases`. This route never touches overrideTtsVoices — it merges
       description, role, gender, ageRange, tone, attributes and aliases — so an
       overrideTtsVoices assertion would pass before and after and prove nothing. */
    await request(app).post('/api/library-cast/override')
      .send({ sourceBookId: bookId, sourceCharacterId: 'alice',
              targetBookId: bookId, targetCharacterId: 'bob' })
      .expect(200);

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const byId = Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c]));
    /* alice's merge takes bob's name into her alias pool. Red today: alice is
       written back from the pre-merge snapshot. */
    expect(byId.alice.aliases).toContain(bobName);
    expect(byId.bob.aliases).toContain(aliceName);
  });
});

/* #1981 fix-round Finding 2 — this route now holds withCastLocks([source,
   target]) across its read-through-write span, same as cast-link-prior and
   cast-not-linked-to. Only cast-not-linked-to had a route-level AB/BA
   regression test; this closes the gap for library-cast-override. Its own
   book pair (bookX/bookY, each with two characters) so this can't interact
   with the shared Oduvan fixtures or the same-book fixtures above. */
describe('library-cast override router — AB/BA deadlock (#1981 fix-round Finding 2)', () => {
  const BOOK_X_TITLE = 'AB-BA Book X';
  const BOOK_Y_TITLE = 'AB-BA Book Y';
  let bookXId: string;
  let bookYId: string;

  const x1 = {
    id: 'x1',
    name: 'X1',
    role: 'character',
    color: 'unset',
    voiceId: 'v_x1',
    description: 'X1 desc.',
    attributes: ['a1'],
  };
  const x2 = {
    id: 'x2',
    name: 'X2',
    role: 'character',
    color: 'unset',
    voiceId: 'v_x2',
    description: 'X2 description that is definitely longer than Y2s short one.',
    attributes: ['d1'],
  };
  const y1 = {
    id: 'y1',
    name: 'Y1',
    role: 'character',
    color: 'unset',
    voiceId: 'v_y1',
    description: 'Y1 description longer than X1s short one.',
    attributes: ['b1'],
  };
  const y2 = {
    id: 'y2',
    name: 'Y2',
    role: 'character',
    color: 'unset',
    voiceId: 'v_y2',
    description: 'Y2 desc.',
    attributes: ['c1'],
  };

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    bookXId = makeBookId(AUTHOR, SERIES, BOOK_X_TITLE);
    bookYId = makeBookId(AUTHOR, SERIES, BOOK_Y_TITLE);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_X_TITLE, bookXId, [x1, x2]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_Y_TITLE, bookYId, [y1, y2]);
  });

  /* Two concurrent calls with sourceBookId/targetBookId in opposite roles:
     call 1 overrides bookX/x1 <-> bookY/y1 (raw lock order [bookXDir,
     bookYDir]); call 2 overrides bookY/y2 <-> bookX/x2 (raw lock order
     [bookYDir, bookXDir]) — the reverse. Without withCastLocks's `.sort()`
     this is a classic AB/BA. The two calls touch four DISJOINT character
     records (call 1: x1 + y1; call 2: x2 + y2), so the outcome is assertable
     regardless of which call's critical section the lock lets run first —
     each book's cast.json ends up with BOTH of its characters merged,
     because whichever call runs second reads the already-merged state left
     by the first and only overwrites its own targeted id.

     Same deterministic-barrier shape as cast-not-linked-to.test.ts's and
     cast-link-prior.test.ts's `#1981` tests: intercept BOTH requests' SECOND
     `findBookByBookId` call (each request's target-book lookup, immediately
     preceding withCastLocks) and hold each open until both have arrived.
     Because the fixture books are the same two ids in swapped roles, the
     second-ever lookup of bookXId is deterministically call 2's target
     lookup, and the second-ever lookup of bookYId is deterministically call
     1's target lookup — true regardless of which physical request reaches
     that point first. */
  it('#1981 — two concurrent calls with the books in opposite argument order do not deadlock', async () => {
    const scan = await import('../workspace/scan.js');
    const actual = await vi.importActual<typeof import('../workspace/scan.js')>(
      '../workspace/scan.js',
    );
    const seen: Record<string, number> = {};
    let arrived = 0;
    let releaseBoth!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const spy = vi.mocked(scan.findBookByBookId).mockImplementation(async (id: string) => {
      seen[id] = (seen[id] ?? 0) + 1;
      const isSecondLookup = seen[id] === 2 && (id === bookXId || id === bookYId);
      const result = await actual.findBookByBookId(id); // real read, now
      if (isSecondLookup) {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await gate; // hold the RESOLUTION open until both requests arrive
      }
      return result;
    });

    let results: [{ status: number }, { status: number }];
    try {
      results = (await Promise.race([
        Promise.all([
          callOverride({
            sourceBookId: bookXId,
            sourceCharacterId: 'x1',
            targetBookId: bookYId,
            targetCharacterId: 'y1',
          }),
          callOverride({
            sourceBookId: bookYId,
            sourceCharacterId: 'y2',
            targetBookId: bookXId,
            targetCharacterId: 'x2',
          }),
        ]),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('DEADLOCK')), 2000),
        ),
      ])) as [{ status: number }, { status: number }];
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.findBookByBookId);
    }

    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);

    /* Both merges survived on disk, in BOTH books. Call 1's merge (x1<->y1)
       and call 2's merge (x2<->y2) are disjoint characters, so neither call
       could have clobbered the other's write. */
    const bookXChars = readCast(BOOK_X_TITLE).characters;
    const bookYChars = readCast(BOOK_Y_TITLE).characters;
    const byIdX = Object.fromEntries(bookXChars.map((c) => [c.id, c]));
    const byIdY = Object.fromEntries(bookYChars.map((c) => [c.id, c]));

    expect(byIdX.x1.description).toBe(y1.description); // longer of the pair
    expect(byIdY.y1.description).toBe(y1.description);
    expect(byIdX.x1.aliases).toContain('Y1');
    expect(byIdY.y1.aliases).toContain('X1');

    expect(byIdY.y2.description).toBe(x2.description); // longer of the pair
    expect(byIdX.x2.description).toBe(x2.description);
    expect(byIdY.y2.aliases).toContain('X2');
    expect(byIdX.x2.aliases).toContain('Y2');
  });
});
