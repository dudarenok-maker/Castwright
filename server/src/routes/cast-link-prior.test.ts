/* Integration tests for the cast/link-prior router.

   Seeds two the Hollow Tide books on disk — the current ("source") book contains
   the analyzer-named full-form character ("Hartwell Brennan Vale"); the
   prior ("target") book contains the canonical short form ("Hart"). The
   tests assert:

   - Success path appends source's name to target's aliases (case-insensitive
     dedup), writes target's cast.json atomically, and returns matchedFrom
     + voiceId for the frontend's applyManualMatch dispatch.
   - Idempotency: re-calling with the same body is a no-op on disk.
   - Series guard: a book in a different series, a standalone, or an
     unknown bookId all return 404.
   - Missing source/target character ids return 404.

   Same lazy-import pattern as the sibling route tests so WORKSPACE_DIR
   is set before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const KEEPER_BOOK = 'The Hollow Tide';
const NEW_BOOK = 'New the Hollow Tide Book';
const OTHER_BOOK = 'Other Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let newBookId: string;
let otherBookId: string;
let standaloneBookId: string;

const initialKeeperCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'hart',
    name: 'Hart',
    role: 'character',
    color: 'unset',
    voiceId: 'v_hart',
    aliases: ['Hartwell'],
  },
  { id: 'wren', name: 'Wren', role: 'character', color: 'unset', voiceId: 'v_wren' },
];

const initialNewBookCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'hartwell-brennan-vale',
    name: 'Hartwell Brennan Vale',
    role: 'character',
    color: 'unset',
    aliases: ['Bren'],
  },
];

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean } = {},
) {
  const dir = join(workspace, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return dir;
}

function readCast(
  workspace: string,
  author: string,
  series: string,
  title: string,
): { characters: Array<Record<string, unknown>> } {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-link-prior-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castLinkPriorRouter }, { makeBookId }] = await Promise.all([
    import('./cast-link-prior.js'),
    import('../workspace/paths.js'),
  ]);
  keeperBookId = makeBookId(AUTHOR, SERIES, KEEPER_BOOK);
  newBookId = makeBookId(AUTHOR, SERIES, NEW_BOOK);
  otherBookId = makeBookId(AUTHOR, 'Different Series', OTHER_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castLinkPriorRouter);
});

/* Re-seed the books before every test so the alias-mutation cases don't
   bleed into each other. Cheap (4 books × 2 small files each). */
beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, initialKeeperCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, initialNewBookCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, 'Different Series', OTHER_BOOK, otherBookId, [
    { id: 'unrelated', name: 'Unrelated', role: 'character', color: 'unset' },
  ]);
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    STANDALONE,
    standaloneBookId,
    [{ id: 'lonely', name: 'Lonely', role: 'character', color: 'unset' }],
    { isStandalone: true },
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callLink(bookId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/link-prior`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/link-prior', () => {
  it('rejects when any of the three body ids are missing', async () => {
    const res = await callLink(newBookId, { sourceCharacterId: 'hartwell-brennan-vale' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when targetBookId equals the path bookId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: newBookId,
      targetCharacterId: 'hartwell-brennan-vale',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book is unknown', async () => {
    const res = await callLink('nope', {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the target book is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: 'nope',
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target book/i);
  });

  it('returns 404 when target book is in a different series', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: otherBookId,
      targetCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when target book is a standalone', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: standaloneBookId,
      targetCharacterId: 'lonely',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when the source character is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'missing',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source character/i);
  });

  it('returns 404 when the target character is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it('appends source.name to target.aliases on disk and returns matchedFrom + voiceId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matchedFrom: {
        bookId: keeperBookId,
        characterId: 'hart',
        bookTitle: KEEPER_BOOK,
        confidence: 1,
      },
      voiceId: 'v_hart',
    });

    const hartOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    );
    expect(hartOnDisk).toBeDefined();
    expect(hartOnDisk?.aliases).toEqual(['Hartwell', 'Hartwell Brennan Vale', 'Bren']);
  });

  it('does not duplicate aliases on a repeat call (case-insensitive dedup)', async () => {
    /* First call adds Hartwell Brennan Vale + Bren. Second call should be
       a no-op on disk. The route still returns 200 with matchedFrom so
       the frontend can re-dispatch applyManualMatch idempotently. */
    await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    const beforeSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    const res2 = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    const afterSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    expect(res2.status).toBe(200);
    expect(afterSecond).toEqual(beforeSecond);
  });

  it("unifies the source character's voiceId to the target's key (plan 122)", async () => {
    const before = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    );
    expect(before?.voiceId).toBeUndefined();
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    /* The source now shares the target's series-override write key — aliases
       alone never did that, so a later "Propose voices" approve would skip
       this book. Other source fields are untouched. */
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    );
    expect(after?.voiceId).toBe('v_hart');
    expect(after?.name).toBe('Hartwell Brennan Vale');
    expect(after?.aliases).toEqual(['Bren']);
  });

  it("denormalises the target's designed qwen voice onto the source (reused-voice consistency)", async () => {
    /* Regression for the reused-Qwen-voice bug: linking a source character to a
       target that carries a designed qwen voice must copy the target's
       ttsEngine + overrideTtsVoices onto the source so it no longer resolves to
       '' (Kokoro fallback) at generation. Re-seed the keeper target (hart) with a
       designed qwen voice, then link the new book's full-form character to it. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart' } },
        voiceStyle: 'a quirky, earnest boy genius',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as
      | { ttsEngine?: string; overrideTtsVoices?: { qwen?: { name: string } }; voiceStyle?: string }
      | undefined;
    expect(after?.ttsEngine).toBe('qwen');
    expect(after?.overrideTtsVoices?.qwen?.name).toBe('qwen-hart');
    /* The persona rides along the voice denormalise (srv-18). */
    expect(after?.voiceStyle).toBe('a quirky, earnest boy genius');
  });

  it("does not clobber the source's own persona when denormalising (srv-18)", async () => {
    /* The source already carries a hand-edited persona — the link must keep it,
       even while it adopts the target's designed voice. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hartwell-brennan-vale',
        name: 'Hartwell Brennan Vale',
        role: 'character',
        color: 'unset',
        aliases: ['Bren'],
        voiceStyle: 'my own edited persona',
      },
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart' } },
        voiceStyle: 'the target persona',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as { voiceStyle?: string; overrideTtsVoices?: { qwen?: { name: string } } } | undefined;
    expect(after?.voiceStyle).toBe('my own edited persona');
    expect(after?.overrideTtsVoices?.qwen?.name).toBe('qwen-hart');
  });

  it("falls back to the target's id when the target has no voiceId", async () => {
    /* Re-seed keeper with a target carrying NO voiceId — the canonical key is
       then the target's id, and the source should adopt it. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      { id: 'maerin', name: 'Maerin', role: 'character', color: 'unset' },
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      { id: 'maerin-vell', name: 'Maerin Vell', role: 'character', color: 'unset' },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'maerin-vell',
      targetBookId: keeperBookId,
      targetCharacterId: 'maerin',
    });
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('maerin');
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'maerin-vell',
    );
    expect(after?.voiceId).toBe('maerin');
  });

  it('merges the target profile (quotes, attributes, description, tone, gender, age) onto an empty source', async () => {
    /* The carry-over fix: a roster-linked row with NO profile of its own
       (The Floodmark's "Dame Linnet") must inherit the canonical character's
       representative quotes + descriptors at link time, not just its voice. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        evidence: [{ quote: 'Technopath stuff!', note: 'gadget talk' }],
        attributes: ['inventive', 'loyal'],
        description: 'A boy-genius technopath.',
        tone: { default: 'earnest' },
        gender: 'male',
        ageRange: 'teen',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    /* Response echoes the merged profile so the open drawer updates without
       a reload. */
    expect(res.body.profile).toBeDefined();
    expect(res.body.profile.evidence).toHaveLength(1);
    expect(res.body.profile.attributes).toEqual(['inventive', 'loyal']);
    expect(res.body.profile.description).toBe('A boy-genius technopath.');
    /* Source on disk inherited the profile. */
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as Record<string, unknown> | undefined;
    expect((after?.evidence as unknown[])?.length).toBe(1);
    expect(after?.attributes).toEqual(['inventive', 'loyal']);
    expect(after?.description).toBe('A boy-genius technopath.');
    expect(after?.tone).toEqual({ default: 'earnest' });
    expect(after?.gender).toBe('male');
    expect(after?.ageRange).toBe('teen');
  });

  it("unions quotes/attributes source-first and never clobbers the source's own description", async () => {
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'hartwell-brennan-vale',
        name: 'Hartwell Brennan Vale',
        role: 'character',
        color: 'unset',
        aliases: ['Bren'],
        evidence: [{ quote: 'Source line.', note: 'own' }],
        attributes: ['witty'],
        description: "The source's own description.",
      },
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        evidence: [{ quote: 'Target line.', note: 'canon' }],
        attributes: ['witty', 'brave'],
        description: 'A different, longer canonical description.',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as Record<string, unknown> | undefined;
    const quotes = (after?.evidence as Array<{ quote: string }>).map((e) => e.quote);
    expect(quotes).toEqual(['Source line.', 'Target line.']); // source-first union
    expect(after?.attributes).toEqual(['witty', 'brave']); // dedup, source-first
    expect(after?.description).toBe("The source's own description."); // never clobbered
  });

  it('Task 6a: does not plant the target qwen slot onto a coqui-cloned source', async () => {
    /* Headline regression: the source has a real cloned voice on coqui (no
       qwen slot of its own — `sourceHasQwen` would read false). Linking it
       to a qwen-designed target must NOT denormalise the target's qwen
       slot onto it (that would plant another character's designed voice on
       a real person's cloned record) and must NOT retarget `ttsEngine` to
       qwen either — the source has no ttsEngine of its own, so the old
       `source.ttsEngine ?? target.ttsEngine ?? 'qwen'` fallback chain would
       have force-moved it. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'hartwell-brennan-vale',
        name: 'Hartwell Brennan Vale',
        role: 'character',
        color: 'unset',
        aliases: ['Bren'],
        overrideTtsVoices: {
          coqui: { name: 'xtts-real-person', libraryUuid: 'lib-123', provenance: 'cloned' },
        },
      },
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart', provenance: 'designed' } },
        voiceStyle: 'a quirky, earnest boy genius',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as
      | {
          ttsEngine?: string;
          overrideTtsVoices?: {
            qwen?: { name: string };
            coqui?: { name: string; libraryUuid?: string; provenance?: string };
          };
        }
      | undefined;
    /* The target's qwen slot must never land on the persisted source record. */
    expect(after?.overrideTtsVoices?.qwen).toBeUndefined();
    /* The source's own cloned coqui slot must survive untouched. */
    expect(after?.overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-real-person',
      libraryUuid: 'lib-123',
      provenance: 'cloned',
    });
    /* ttsEngine must not be retargeted to qwen either. */
    expect(after?.ttsEngine).toBeUndefined();
  });

  it('Task 6a: a cloned slot with a missing/non-string libraryUuid still counts as cloned and is protected', async () => {
    /* Fail-safe case: a malformed cloned slot (no usable libraryUuid) must
       still be read as "cloned" by the guard — characterHasClonedSlot does
       not validate libraryUuid, deliberately, so a malformed record isn't
       clobbered. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'hartwell-brennan-vale',
        name: 'Hartwell Brennan Vale',
        role: 'character',
        color: 'unset',
        aliases: ['Bren'],
        overrideTtsVoices: {
          coqui: { name: 'xtts-real-person', provenance: 'cloned' },
        },
      },
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart', provenance: 'designed' } },
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as
      | { ttsEngine?: string; overrideTtsVoices?: { qwen?: { name: string } } }
      | undefined;
    expect(after?.overrideTtsVoices?.qwen).toBeUndefined();
    expect(after?.ttsEngine).toBeUndefined();
  });

  it('[#1885] does not denormalise a CLONED target voice onto the source (consent-scan bypass)', async () => {
    /* Distinct from Task 6a (which protects a source that's ALREADY cloned
       from being overwritten). This is the other half: this route is a
       MANUAL link — the client supplies targetCharacterId directly, so
       nothing upstream (unlike the auto-matcher's candidate list, which
       library-cast-scan.ts already filters to exclude any character
       carrying a cloned slot) stops the target itself from being a real
       person's consented clone. Discriminating fixture: the SOURCE has no
       voice at all (so `sourceHasQwen` is false and denormalisation would
       otherwise fire); only the TARGET carries the cloned slot. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Hartwell'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart', libraryUuid: 'lib-hart', provenance: 'cloned' } },
        voiceStyle: 'a quirky, earnest boy genius',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    ) as { ttsEngine?: string; overrideTtsVoices?: { qwen?: { name: string } }; voiceStyle?: string } | undefined;
    /* The target's cloned qwen slot must never land on the source. */
    expect(after?.overrideTtsVoices?.qwen).toBeUndefined();
    expect(after?.ttsEngine).toBeUndefined();
    expect(after?.voiceStyle).toBeUndefined();
    /* The target's OWN cloned voice on disk is untouched (this route only
       ever writes voiceId/aliases/profile onto the target, never voice
       fields). */
    const hartOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    ) as { overrideTtsVoices?: { qwen?: { provenance?: string } } } | undefined;
    expect(hartOnDisk?.overrideTtsVoices?.qwen?.provenance).toBe('cloned');
  });

  it('drops target.name from the alias pool (no self-alias)', async () => {
    /* Edge case: source.aliases already contains the target's name.
       After the merge, target.aliases should NOT list its own name. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'hartwell-brennan-vale',
        name: 'Hartwell Brennan Vale',
        role: 'character',
        color: 'unset',
        aliases: ['Hart'],
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'hartwell-brennan-vale',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const hartOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    );
    /* "Hart" was in source's aliases, but it equals target.name → filtered. */
    expect(hartOnDisk?.aliases).not.toContain('Hart');
    expect(hartOnDisk?.aliases).toContain('Hartwell Brennan Vale');
  });

  /* #1981 fix-round Finding 2 — this route now holds withCastLocks([source,
     target]) across its read-through-write span, same as cast-not-linked-to
     and library-cast-override. Only cast-not-linked-to had a route-level
     AB/BA regression test; this closes the gap for cast-link-prior.

     Two concurrent calls with the path bookId and body.targetBookId in
     opposite roles: call 1 links keeperBookId/hart -> newBookId's
     hartwell-brennan-vale (raw lock order [keeperDir, newDir]); call 2 links
     newBookId/narrator -> keeperBookId's wren (raw lock order [newDir,
     keeperDir]) — the reverse. Without withCastLocks's `.sort()` this is a
     classic AB/BA. The two calls touch four DISJOINT character records (call
     1 writes newBookId's hartwell-brennan-vale + keeperBookId's hart; call 2
     writes keeperBookId's wren + newBookId's narrator), so the outcome is
     assertable regardless of which call's critical section the lock lets run
     first.

     Same deterministic-barrier shape as cast-not-linked-to.test.ts's `#1981`
     test: intercept BOTH requests' SECOND `findBookByBookId` call (each
     request's target-book lookup, immediately preceding withCastLocks) and
     hold each open until both have arrived. Because the fixture books are
     the same two ids in swapped roles, the second-ever lookup of keeperBookId
     is deterministically call 2's target lookup, and the second-ever lookup
     of newBookId is deterministically call 1's target lookup — true
     regardless of which physical request reaches that point first. */
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
      const isSecondLookup = seen[id] === 2 && (id === keeperBookId || id === newBookId);
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
          callLink(keeperBookId, {
            sourceCharacterId: 'hart',
            targetBookId: newBookId,
            targetCharacterId: 'hartwell-brennan-vale',
          }),
          callLink(newBookId, {
            sourceCharacterId: 'narrator',
            targetBookId: keeperBookId,
            targetCharacterId: 'wren',
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

    /* Both mutations survived on disk — call 1's target write (newBookId's
       hartwell-brennan-vale gained hart's name + alias) and source write
       (keeperBookId's hart adopted the target's canonical voiceId key). */
    const hartwellOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'hartwell-brennan-vale',
    );
    expect(hartwellOnDisk?.aliases).toEqual(
      expect.arrayContaining(['Bren', 'Hart', 'Hartwell']),
    );
    const hartOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    );
    expect(hartOnDisk?.voiceId).toBe('hartwell-brennan-vale');

    /* Call 2's target write (keeperBookId's wren gained narrator's name as
       an alias) and source write (newBookId's narrator adopted wren's
       voiceId). */
    const wrenOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenOnDisk?.aliases).toContain('Narrator');
    const narratorOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'narrator',
    );
    expect(narratorOnDisk?.voiceId).toBe('v_wren');
  });
});
