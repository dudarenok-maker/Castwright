/* Integration tests for POST + DELETE
   /:bookId/cast/:characterId/reject-orphan-match (#2040 Task 17 shipped
   id-wide; #2092/#2089 made it pair-scoped and added the DELETE undo).

   Seeds one book on disk with a live "mairin" cast row. Tests assert:

   POST:
   - 400 on missing fields / self-pair.
   - 404 on unknown book / unknown character.
   - 409 when the book has no cast on disk yet.
   - Happy path: writes a one-sided notLinkedTo edge onto the live character
     (this book's own bookId, the orphaned id as `characterId`), AND records
     the rejection in cast-id-history.json's `rejectedPairs` AND forgets any
     stale `supersededBy` entry naming the orphaned id (stashing what it
     removed on the pair as `forgotSupersededTo`).
   - Idempotency: a second identical call doesn't duplicate the notLinkedTo
     entry or the `rejectedPairs` entry.
   - D1 pair scope: rejecting orphanedId against ONE character does not block
     it against a DIFFERENT one.

   DELETE (the undo):
   - Same guards as POST.
   - Removes the notLinkedTo edge, removes the rejectedPairs entry, and
     restores any `forgotSupersededTo`.
   - Idempotent.
   - #2089's stated acceptance bar: after POST-then-DELETE,
     `buildCastResolver(...).resolve(orphanedId)` returns the SAME result it
     returned before the POST — asserted against the resolver directly, not
     by checking cast-id-history.json no longer contains a string.

   Same lazy-import-after-WORKSPACE_DIR pattern as cast-not-linked-to.test.ts
   so paths.ts binds BOOKS_ROOT against the temp workspace. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';

const AUTHOR = 'Della Renwick';
const SERIES = 'Standalones';
const TITLE = 'The Hollow Tide';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

const initialCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'mairin', name: 'Mairin', role: 'character', color: 'unset' },
];

function writeBookOnDisk(characters: object[]) {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
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
}

function readCast(): { characters: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}

function readHistory(): Record<string, unknown> | null {
  const path = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** #2089 acceptance bar helper — resolves `characterId` against the LIVE
    cast.json + the CURRENT cast-id-history.json on disk, through the same
    `buildCastResolver` the render/QA/splice paths use. Returns the `via`
    tier (or `undefined` on a miss) so a test can compare "before POST" vs
    "after POST-then-DELETE" without inspecting file contents directly. */
async function resolveOrphanedId(orphanedId: string) {
  const cast = readCast();
  const history = await loadCastIdHistory(bookDir);
  return buildCastResolver(cast.characters as Array<{ id: string }>, history).resolve(orphanedId);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-reject-orphan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castRejectOrphanRouter }, { makeBookId }] = await Promise.all([
    import('./cast-reject-orphan.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  writeBookOnDisk(initialCast);
  // #2040 Wave 3 round-2 review, MINOR finding 5: writeBookOnDisk rewrites
  // cast.json but never touched cast-id-history.json, so every case after
  // the first successful reject started with a rejection already on disk —
  // order-coupled state a future "no rejection was recorded" case could pass
  // vacuously against.
  const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
  if (existsSync(historyPath)) rmSync(historyPath, { force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callReject(theBookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${theBookId}/cast/${characterId}/reject-orphan-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

function callUndoReject(theBookId: string, characterId: string, body: object) {
  return request(app)
    .delete(`/api/books/${theBookId}/cast/${characterId}/reject-orphan-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/:characterId/reject-orphan-match', () => {
  it('rejects when orphanedId is missing', async () => {
    const res = await callReject(bookId, 'mairin', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await callReject('nonexistent-book', 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown character', async () => {
    const res = await callReject(bookId, 'nonexistent', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 409 when the book has no cast on disk yet', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(409);
  });

  it('#2040 Task 17 fix round 2 finding 4 — rejects a self-pair (characterId === orphanedId)', async () => {
    // Without this guard, a self notLinkedTo edge would later be honoured by
    // remapFreshToPriorIds' notLinkedToId and refuse a legitimate future
    // by-name remap of this character onto itself — a dead, misleading edge.
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mairin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/self-pair/i);

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toBeUndefined();
  });

  it('writes a one-sided notLinkedTo edge naming the orphaned id, and echoes the pair with its resolution', async () => {
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    // 'mayrin' has no cast entry and no history entry — genuinely unresolved
    // both before and after the reject.
    expect(res.body).toEqual({
      characterId: 'mairin',
      orphanedId: 'mayrin',
      alreadyPresent: false,
      resolution: null,
      resolvedCharacterId: undefined,
    });

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);
    // The other cast row is untouched.
    const narrator = cast.characters.find((c) => c.id === 'narrator');
    expect(narrator?.notLinkedTo).toBeUndefined();
  });

  it('records the rejection in cast-id-history.json as a pair, not the legacy id-wide list', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([{ from: 'mayrin', to: 'mairin' }]);
    expect(history?.rejected).toBeUndefined();
  });

  it('forgets a stale supersededBy entry naming the orphaned id, and stashes it on the pair as forgotSupersededTo (D6)', async () => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
    const res = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    // The alias tier the reject just blocked would otherwise have resolved
    // 'mayrin' — reported here so the response proves the reject took.
    expect(res.body.resolution).toBeNull();
    const history = readHistory();
    expect(history?.supersededBy).toEqual({});
    expect(history?.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' },
    ]);
  });

  it('is idempotent — a second identical call does not duplicate the notLinkedTo entry or the rejectedPairs entry', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const res2 = await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res2.status).toBe(200);
    expect(res2.body.alreadyPresent).toBe(true);

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([{ bookId, characterId: 'mayrin' }]);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([{ from: 'mayrin', to: 'mairin' }]);
  });

  it('rejecting a second, distinct orphaned id against the same character appends rather than replaces', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    await callReject(bookId, 'mairin', { orphanedId: 'the-torment' });
    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([
      { bookId, characterId: 'mayrin' },
      { bookId, characterId: 'the-torment' },
    ]);
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'mairin' },
      { from: 'the-torment', to: 'mairin' },
    ]);
  });

  it('D1 pair scope — rejecting orphanedId against mairin does not block a DIFFERENT target for the same orphanedId', async () => {
    // Seed narrator -> mayrin resolvable via a history entry so there's
    // something concrete to prove stays unaffected.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'narrator' } }),
    );
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    // 'mayrin' still resolves to 'narrator' — only the (mayrin, mairin) pair
    // was rejected, not 'mayrin' against every candidate.
    const r = await resolveOrphanedId('mayrin');
    expect(r?.character.id).toBe('narrator');
    expect(r?.via).toBe('history');
  });
});

describe('DELETE /api/books/:bookId/cast/:characterId/reject-orphan-match (undo, #2092/#2089)', () => {
  it('rejects when orphanedId is missing', async () => {
    const res = await callUndoReject(bookId, 'mairin', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await callUndoReject('nonexistent-book', 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown character', async () => {
    const res = await callUndoReject(bookId, 'nonexistent', { orphanedId: 'mayrin' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the book has no cast on disk yet', async () => {
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(409);
  });

  it('rejects a self-pair', async () => {
    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mairin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/self-pair/i);
  });

  it('is idempotent — DELETE on a pair that was never rejected is a 200 no-op', async () => {
    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(false);
    // removedFrom is always present (never omitted) — empty for a no-op.
    expect(res.body.removedFrom).toEqual([]);
  });

  it('removes the notLinkedTo edge and the rejectedPairs entry', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(true);
    // Round 3 (I-B) — names the raw `from` id(s) actually removed.
    expect(res.body.removedFrom).toEqual(['mayrin']);

    const cast = readCast();
    const mairin = cast.characters.find((c) => c.id === 'mairin');
    expect(mairin?.notLinkedTo).toEqual([]);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('a second DELETE after a successful undo is idempotent', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const res2 = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res2.status).toBe(200);
    expect(res2.body.wasRejected).toBe(false);
  });

  it('leaves a DIFFERENT rejected pair for the same character untouched', async () => {
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    await callReject(bookId, 'mairin', { orphanedId: 'the-torment' });
    await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([{ from: 'the-torment', to: 'mairin' }]);
  });

  it('#2089 acceptance bar — after POST then DELETE, resolve(orphanedId) returns the SAME result it returned before the POST (no forgotSupersededTo case)', async () => {
    // 'mayrin' has no cast entry and no history entry to begin with —
    // genuinely unresolved before the POST.
    const before = await resolveOrphanedId('mayrin');
    expect(before).toBeUndefined();

    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const during = await resolveOrphanedId('mayrin');
    expect(during).toBeUndefined(); // still unresolved, now for a different reason (rejected)

    await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const after = await resolveOrphanedId('mayrin');
    expect(after).toEqual(before);
  });

  it('#2089 acceptance bar — lossless undo of an ALIAS-tier resolution (forgotSupersededTo case)', async () => {
    // 'mayrin' resolves to 'mairin' via the history tier before anything
    // happens — the exact case D6 exists for.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
    const before = await resolveOrphanedId('mayrin');
    expect(before?.character.id).toBe('mairin');
    expect(before?.via).toBe('history');

    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    const during = await resolveOrphanedId('mayrin');
    expect(during).toBeUndefined(); // the pair-scoped reject blocks it

    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe('history');
    expect(res.body.resolvedCharacterId).toBe('mairin');

    const after = await resolveOrphanedId('mayrin');
    // Same RESOLUTION as `before` — same character id, same tier, same
    // viaAlias — not merely "some result": the whole point of stashing
    // forgotSupersededTo (D6). Compared field-by-field rather than via a
    // whole-object toEqual: the `character` object itself legitimately
    // differs (mairin.notLinkedTo goes from undefined to `[]` across the
    // reject/undo round trip — orthogonal bookkeeping, not an identity
    // change) so a whole-object comparison would fail on a difference the
    // #2089 acceptance bar doesn't care about.
    expect(after?.character.id).toBe(before?.character.id);
    expect(after?.via).toBe(before?.via);
    expect(after?.viaAlias).toBe(before?.viaAlias);

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ mayrin: 'mairin' });
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('C1 (review round 1, Critical) — Undo does NOT overwrite a NEWER alias a later re-analysis recorded after the original reject', async () => {
    // 'mayrin' resolves to 'mairin' via history before anything happens —
    // the reject stashes forgotSupersededTo: 'mairin'.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(readHistory()?.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' },
    ]);

    // A LATER, UNRELATED re-analysis records the CORRECT alias (and mints
    // the live 'mr-marrow' row it points to) — simulates retireCharacterId's
    // own production callers (analysis.ts, cast-merge.ts) running
    // independently of this route, between the original reject and the
    // eventual Undo click. The rejectedPairs entry (and its stash) is
    // untouched by that write, since retireCharacterId('mayrin', 'mr-marrow')
    // only repoints entries whose `to` is the id BEING retired ('mairin'
    // here is the TARGET of the new write, not something retiring).
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          ...initialCast,
          { id: 'mr-marrow', name: 'Mr. Marrow', role: 'character', color: 'unset' },
        ],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: { mayrin: 'mr-marrow' },
        rejectedPairs: [{ from: 'mayrin', to: 'mairin', forgotSupersededTo: 'mairin' }],
      }),
    );

    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    // The rejection IS undone (the pair is removed) —
    expect(res.body.wasRejected).toBe(true);
    // — but the alias restore was correctly SKIPPED, and the response says
    // so, naming the newer alias's current target. Round 3 (M-7) — an
    // array, since more than one removed pair can each skip independently.
    expect(res.body.supersededByOther).toEqual(['mr-marrow']);

    const history = readHistory();
    // THE FAILURE MODE C1 EXISTS TO PREVENT: the correct, newer alias must
    // survive untouched. Using retireCharacterId here (the pre-fix code)
    // would have overwritten this back to 'mairin' and repointed anything
    // else that targeted 'mayrin' — reproducing #2040 via the Undo button.
    expect(history?.supersededBy).toEqual({ mayrin: 'mr-marrow' });
    expect(history?.rejectedPairs).toEqual([]);

    // And resolving 'mayrin' now correctly returns the NEWER alias, not the
    // stale rejected one — proving the user-visible outcome is right, not
    // merely the raw JSON.
    const resolved = await resolveOrphanedId('mayrin');
    expect(resolved?.character.id).toBe('mr-marrow');
  });

  it('C1 — a NORMAL Undo (no newer alias since the reject) still restores as before, with supersededByOther absent', async () => {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
    await callReject(bookId, 'mairin', { orphanedId: 'mayrin' });

    const res = await callUndoReject(bookId, 'mairin', { orphanedId: 'mayrin' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(true);
    expect(res.body.supersededByOther).toBeUndefined();

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ mayrin: 'mairin' });
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('Important 2 (review round 2) — a chip shown via a normalised-tier match IS removable by the DELETE the UI sends for that row (round-trip)', async () => {
    // The repo's own real drift shape: 'the_torment'/'The-Torment' both
    // normalise to 'the-torment'. Add the live target to this book's cast.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          ...initialCast,
          { id: 'the-torment', name: 'The Torment', role: 'character', color: 'unset' },
        ],
      }),
    );

    // Reject ONE raw spelling ('The-Torment') against the live 'the-torment'.
    const rejectRes = await callReject(bookId, 'the-torment', { orphanedId: 'The-Torment' });
    expect(rejectRes.status).toBe(200);
    expect(readHistory()?.rejectedPairs).toEqual([{ from: 'The-Torment', to: 'the-torment' }]);

    // A DIFFERENT raw spelling of the same underlying id — 'the_torment' —
    // is genuinely blocked by the resolver via the normalised-id tier
    // (matches segments-io.ts's own Important-1 regression scenario, which
    // is where the banner would show a chip for THIS row).
    const blocked = await resolveOrphanedId('the_torment');
    expect(blocked).toBeUndefined();

    // The UI sends the DELETE using the ROW's own raw id — 'the_torment' —
    // never 'The-Torment', which the row never even carries client-side.
    const undoRes = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(undoRes.status).toBe(200);
    // THE FAILURE MODE THIS TEST EXISTS TO PREVENT: round 1's raw-exact
    // match would have returned wasRejected: false here, left disk
    // unchanged, and reported success anyway (the client dispatches its
    // "undone" state on any 200).
    expect(undoRes.body.wasRejected).toBe(true);
    // Round 3 (I-B) — names the PAIR's own 'The-Torment', not the row's own
    // 'the_torment': the client must key its notLinkedTo redux mirror off
    // THIS value, not `orphanedId`, or the removal would silently target
    // the wrong (non-existent) edge client-side.
    expect(undoRes.body.removedFrom).toEqual(['The-Torment']);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([]);

    // The notLinkedTo edge (written under the PAIR's own 'The-Torment', not
    // the row's 'the_torment') is also actually gone.
    const cast = readCast();
    const theTorment = cast.characters.find((c) => c.id === 'the-torment');
    expect(theTorment?.notLinkedTo).toEqual([]);

    // And 'the_torment' genuinely resolves again — not merely an empty
    // rejectedPairs array.
    const after = await resolveOrphanedId('the_torment');
    expect(after?.character.id).toBe('the-torment');
    expect(after?.via).toBe('normalised-id');
  });

  it('M-6 (review round 3) — a row governing TWO pairs removes both on one Undo click, and names both in the response', async () => {
    // Both 'the_torment' (this row's own raw id — rule 1, raw-always) AND
    // 'The-Torment' (a different spelling that normalises the same — rule
    // 2, since NEITHER has its own supersededBy entry, so 'the_torment'
    // resolves ignoring-pair-rejects via the normalised-id tier) govern
    // this row simultaneously. Seeded directly at the history/cast level
    // (rather than via two POSTs) so the scenario is pinned exactly:
    // rejectedPairs carries both, and notLinkedTo on the live target
    // carries both edges, as if two separate rejects had landed on two
    // differently-spelled rows that both collapse onto the same normalised
    // key.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          ...initialCast,
          {
            id: 'the-torment',
            name: 'The Torment',
            role: 'character',
            color: 'unset',
            notLinkedTo: [
              { bookId, characterId: 'the_torment' },
              { bookId, characterId: 'The-Torment' },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: {},
        rejectedPairs: [
          { from: 'the_torment', to: 'the-torment' },
          { from: 'The-Torment', to: 'the-torment' },
        ],
      }),
    );

    const res = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(true);
    // Both raw spellings named, deduped — order is [raw-self, normalised]
    // per rejectedPairsGoverning's own [...raw, ...normalised] shape.
    expect(res.body.removedFrom).toEqual(['the_torment', 'The-Torment']);

    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([]);

    // BOTH notLinkedTo edges are gone — the resolver treats every one of
    // those spellings as governing the same normalised block, so leaving
    // either behind would silently keep blocking a future by-name remap.
    const cast = readCast();
    const theTorment = cast.characters.find((c) => c.id === 'the-torment');
    expect(theTorment?.notLinkedTo).toEqual([]);
  });

  it('M-7 (review round 4) — a row governing TWO pairs that BOTH skip their restore reports BOTH aliases, not just the last one', async () => {
    // Round 3's M-6 test above proves TWO pairs get removed together;
    // round 3's M-2 test (below) proves ONE pair's skipped restore is
    // attributed to the right key. Neither combines "two pairs" with "both
    // skip" — the shape M-7 actually names, and the shape a last-wins
    // `supersededByOthers.push → splice(0, len, x)` mutation cannot be
    // told apart from `push` on, since a single-element array can't
    // distinguish "all of them" from "the last one" (review round 4).
    //
    // Both governing pairs here are the NORMALISED-rule kind (rule 2):
    // 'The-Torment' and 'THE_TORMENT' both normalise to 'the-torment', and
    // neither is the row's own raw id ('the_torment', which must carry NO
    // supersededBy entry of its own for rule 2 to apply at all — see
    // rejectedPairsGoverning's own doc comment). That leaves each pair's
    // OWN key (`pair.from`) completely free to carry an unrelated "newer
    // alias" in `supersededBy`, so BOTH restores can genuinely skip.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [...initialCast, { id: 'the-torment', name: 'The Torment', role: 'character', color: 'unset' }],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: { 'The-Torment': 'newer-target-1', THE_TORMENT: 'newer-target-2' },
        rejectedPairs: [
          { from: 'The-Torment', to: 'the-torment', forgotSupersededTo: 'alias-one' },
          { from: 'THE_TORMENT', to: 'the-torment', forgotSupersededTo: 'alias-two' },
        ],
      }),
    );

    const res = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(true);
    expect(res.body.removedFrom).toEqual(['The-Torment', 'THE_TORMENT']);
    // THE ASSERTION THIS TEST EXISTS FOR: both skipped aliases, in order —
    // a last-wins mutation would report only `['newer-target-2']` here.
    expect(res.body.supersededByOther).toEqual(['newer-target-1', 'newer-target-2']);

    // Neither newer alias was touched — both restores were correctly
    // skipped, not overwritten.
    const history = readHistory();
    expect(history?.supersededBy).toEqual({ 'The-Torment': 'newer-target-1', THE_TORMENT: 'newer-target-2' });
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('F3 (fix round 5) — two governing pairs whose skipped restores land on the SAME newer alias report ONE entry, not a duplicate', async () => {
    // M-7 above proves the array survives two DISTINCT targets
    // (['newer-target-1', 'newer-target-2']) — it never exercises the dedup
    // clause itself (`[...new Set(supersededByOthers)]`), since two distinct
    // strings can't tell a Set from a plain array apart. This test collapses
    // both skipped restores onto the SAME newer alias, so a mutation that
    // drops the Set/dedup (`supersededByOthers` unwrapped) would report
    // `['newer-target', 'newer-target']` here instead of one entry — the
    // shape the comment above the real code says it exists to prevent
    // ("Narrator" / "Narrator" rendered twice).
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [...initialCast, { id: 'the-torment', name: 'The Torment', role: 'character', color: 'unset' }],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: { 'The-Torment': 'newer-target', THE_TORMENT: 'newer-target' },
        rejectedPairs: [
          { from: 'The-Torment', to: 'the-torment', forgotSupersededTo: 'alias-one' },
          { from: 'THE_TORMENT', to: 'the-torment', forgotSupersededTo: 'alias-two' },
        ],
      }),
    );

    const res = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(true);
    expect(res.body.removedFrom).toEqual(['The-Torment', 'THE_TORMENT']);
    // THE ASSERTION THIS TEST EXISTS FOR: one entry, not a duplicate.
    expect(res.body.supersededByOther).toEqual(['newer-target']);

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ 'The-Torment': 'newer-target', THE_TORMENT: 'newer-target' });
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('M-2 (review round 3) — restoring a cross-spelling pair\'s forgotSupersededTo uses the PAIR\'s own `from`, not the row\'s `orphanedId`', async () => {
    // Round 2's two cross-spelling tests (Important 1/2, below and above)
    // both happen to produce a pair with NO forgotSupersededTo to restore —
    // Important 2 never seeds a supersededBy entry before its POST, and
    // Important 1 writes rejectedPairs directly without ever calling POST
    // at all. Neither exercises restoreSupersededId's `pair.from` argument
    // under the cross-spelling shape, so reverting that argument back to
    // `orphanedId` (the row's own id, which the pair's `from` need NOT
    // match) passed the whole suite. This test seeds a supersededBy entry
    // under the DIFFERENT raw spelling the pair will actually govern
    // through, so the restore has something real to distinguish.
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          ...initialCast,
          { id: 'the-torment', name: 'The Torment', role: 'character', color: 'unset' },
        ],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { 'The-Torment': 'the-torment' } }),
    );

    // Reject 'The-Torment' — POST's guard finds supersededBy['The-Torment']
    // === 'the-torment' (matches characterId), so it stashes
    // forgotSupersededTo: 'the-torment' on the pair and forgets the entry.
    const rejectRes = await callReject(bookId, 'the-torment', { orphanedId: 'The-Torment' });
    expect(rejectRes.status).toBe(200);
    expect(readHistory()).toEqual({
      schema: 1,
      supersededBy: {},
      rejectedPairs: [{ from: 'The-Torment', to: 'the-torment', forgotSupersededTo: 'the-torment' }],
      // #2128 — two writes happened (forgetSupersededId, rejectOrphanedPair),
      // each bumping seq; neither stamps a supersededBy key (the entry was
      // deleted, not established), so the marker maps stay empty.
      seq: 2,
      recordedAtSeq: {},
      recordedAtIso: {},
    });

    // The UI sends the DELETE using the ROW's own raw id — 'the_torment' —
    // a DIFFERENT spelling that normalises the same, never 'The-Torment'.
    const undoRes = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.wasRejected).toBe(true);
    expect(undoRes.body.removedFrom).toEqual(['The-Torment']);
    // The restore succeeded (no newer alias exists) — proven by BOTH the
    // response and, more importantly, by which KEY landed back in
    // supersededBy: 'The-Torment', the pair's own `from`. A restore call
    // that used `orphanedId` ('the_torment') instead would silently write
    // the WRONG key here, leaving 'The-Torment' unrestored while
    // fabricating an entry for 'the_torment' that was never rejected under
    // that spelling in the first place.
    expect(undoRes.body.supersededByOther).toBeUndefined();

    const history = readHistory();
    expect(history?.supersededBy).toEqual({ 'The-Torment': 'the-torment' });
    expect(history?.rejectedPairs).toEqual([]);
  });

  it('Important 1 (review round 2) — DELETE for a row resolving via tier 2 (raw) is a genuine no-op and does NOT collaterally remove an unrelated normalised-only pair', async () => {
    // Same cross-spelling shape as Important 2's round-trip test, but pins
    // the OTHER direction: 'the_torment' has its OWN tier-2 (raw
    // supersededBy) resolution, unrelated to the pair rejected under the
    // DIFFERENT raw spelling 'The-Torment'. A DELETE for the 'the_torment'
    // row must not match — let alone remove — that unrelated pair, the
    // undo-side mirror of segments-io.test.ts's read-side Important-1 test
    // (a row that resolves via tier 2 must never be treated as governed by
    // a normalised-only pair, on either side).
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          ...initialCast,
          { id: 'the-torment', name: 'The Torment', role: 'character', color: 'unset' },
        ],
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({
        schema: 1,
        supersededBy: { the_torment: 'the-torment' },
        rejectedPairs: [{ from: 'The-Torment', to: 'the-torment' }],
      }),
    );

    // Sanity: 'the_torment' really does resolve cleanly via tier 2 first.
    const before = await resolveOrphanedId('the_torment');
    expect(before?.via).toBe('history');

    const res = await callUndoReject(bookId, 'the-torment', { orphanedId: 'the_torment' });
    expect(res.status).toBe(200);
    expect(res.body.wasRejected).toBe(false);

    // THE FAILURE MODE THIS TEST EXISTS TO PREVENT: an over-broad "which
    // pairs apply" computation on the undo side removing 'The-Torment's
    // pair as collateral damage from a DELETE that was never about it.
    const history = readHistory();
    expect(history?.rejectedPairs).toEqual([{ from: 'The-Torment', to: 'the-torment' }]);
  });
});

/* #1981 — this route's cast.json read-modify-write (the notLinkedTo edge) is
   now locked (withCastLock). Mirrors cast-aliases.test.ts's add-alias race
   (the bare-Promise.all shape is adequate here: two DIFFERENT characters in
   the SAME book, no shared state to give either call a head start — per this
   branch's Task 8 finding, a bare Promise.all is a placebo only for a
   SAME-TICK acquisition pair, not for "does a lock exist" in general).
   rejectOrphanedId/forgetSupersededId are NOT part of what this race
   exercises: they already take their own `cast-id-history:<bookDir>` lock
   (cast-id-history.ts), a locked leaf this route's cast lock doesn't wrap. */
describe('#1981 — two reject-orphan-match calls for one book overlap', () => {
  const RACE_TITLE = 'Cast Reject Orphan Race Book';
  let raceBookId: string;
  let raceBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_TITLE);
    raceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RACE_TITLE);
    mkdirSync(join(raceBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(raceBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: raceBookId,
        manuscriptId: 'm_reject_orphan_race_test',
        title: RACE_TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(raceBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(raceBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'race-x', name: 'Race X', role: 'character', color: 'unset' },
          { id: 'race-y', name: 'Race Y', role: 'character', color: 'unset' },
        ],
      }),
    );
  });

  it('keeps both notLinkedTo edges when two reject-orphan-match calls for one book overlap', async () => {
    const [resX, resY] = await Promise.all([
      callReject(raceBookId, 'race-x', { orphanedId: 'race-x-orphan' }),
      callReject(raceBookId, 'race-y', { orphanedId: 'race-y-orphan' }),
    ]);
    expect(resX.status).toBe(200);
    expect(resY.status).toBe(200);

    const cast = JSON.parse(
      readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; notLinkedTo?: Array<{ characterId: string }> }> };
    const x = cast.characters.find((c) => c.id === 'race-x')!;
    const y = cast.characters.find((c) => c.id === 'race-y')!;
    expect(x.notLinkedTo).toEqual([{ bookId: raceBookId, characterId: 'race-x-orphan' }]);
    expect(y.notLinkedTo).toEqual([{ bookId: raceBookId, characterId: 'race-y-orphan' }]);
  });
});
