/* Integration tests for the cast/link-prior router.

   Seeds two the Hollow Tide books on disk — the current ("source") book contains
   the analyzer-named full-form character ("Dexter Alvin Diznee"); the
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

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Shannon Messenger';
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
    aliases: ['Dexter'],
  },
  { id: 'wren', name: 'Wren', role: 'character', color: 'unset', voiceId: 'v_wren' },
];

const initialNewBookCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'dexter-alvin-diznee',
    name: 'Dexter Alvin Diznee',
    role: 'character',
    color: 'unset',
    aliases: ['Dizz'],
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
    const res = await callLink(newBookId, { sourceCharacterId: 'dexter-alvin-diznee' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when targetBookId equals the path bookId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: newBookId,
      targetCharacterId: 'dexter-alvin-diznee',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book is unknown', async () => {
    const res = await callLink('nope', {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the target book is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: 'nope',
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target book/i);
  });

  it('returns 404 when target book is in a different series', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: otherBookId,
      targetCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when target book is a standalone', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
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
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it('appends source.name to target.aliases on disk and returns matchedFrom + voiceId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
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

    const dexOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    );
    expect(dexOnDisk).toBeDefined();
    expect(dexOnDisk?.aliases).toEqual(['Dexter', 'Dexter Alvin Diznee', 'Dizz']);
  });

  it('does not duplicate aliases on a repeat call (case-insensitive dedup)', async () => {
    /* First call adds Dexter Alvin Diznee + Dizz. Second call should be
       a no-op on disk. The route still returns 200 with matchedFrom so
       the frontend can re-dispatch applyManualMatch idempotently. */
    await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    const beforeSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    const res2 = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    const afterSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    expect(res2.status).toBe(200);
    expect(afterSecond).toEqual(beforeSecond);
  });

  it("unifies the source character's voiceId to the target's key (plan 122)", async () => {
    const before = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'dexter-alvin-diznee',
    );
    expect(before?.voiceId).toBeUndefined();
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    /* The source now shares the target's series-override write key — aliases
       alone never did that, so a later "Propose voices" approve would skip
       this book. Other source fields are untouched. */
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'dexter-alvin-diznee',
    );
    expect(after?.voiceId).toBe('v_hart');
    expect(after?.name).toBe('Dexter Alvin Diznee');
    expect(after?.aliases).toEqual(['Dizz']);
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
        aliases: ['Dexter'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart' } },
        voiceStyle: 'a quirky, earnest boy genius',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'dexter-alvin-diznee',
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
        id: 'dexter-alvin-diznee',
        name: 'Dexter Alvin Diznee',
        role: 'character',
        color: 'unset',
        aliases: ['Dizz'],
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
        aliases: ['Dexter'],
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-hart' } },
        voiceStyle: 'the target persona',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'dexter-alvin-diznee',
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
      { id: 'maerin-vacker', name: 'Maerin Vacker', role: 'character', color: 'unset' },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'maerin-vacker',
      targetBookId: keeperBookId,
      targetCharacterId: 'maerin',
    });
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('maerin');
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'maerin-vacker',
    );
    expect(after?.voiceId).toBe('maerin');
  });

  it('merges the target profile (quotes, attributes, description, tone, gender, age) onto an empty source', async () => {
    /* The carry-over fix: a roster-linked row with NO profile of its own
       (Unlocked's "Dame Linnet") must inherit the canonical character's
       representative quotes + descriptors at link time, not just its voice. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
      {
        id: 'hart',
        name: 'Hart',
        role: 'character',
        color: 'unset',
        voiceId: 'v_hart',
        aliases: ['Dexter'],
        evidence: [{ quote: 'Technopath stuff!', note: 'gadget talk' }],
        attributes: ['inventive', 'loyal'],
        description: 'A boy-genius technopath.',
        tone: { default: 'earnest' },
        gender: 'male',
        ageRange: 'teen',
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
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
      (c) => c.id === 'dexter-alvin-diznee',
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
        id: 'dexter-alvin-diznee',
        name: 'Dexter Alvin Diznee',
        role: 'character',
        color: 'unset',
        aliases: ['Dizz'],
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
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK).characters.find(
      (c) => c.id === 'dexter-alvin-diznee',
    ) as Record<string, unknown> | undefined;
    const quotes = (after?.evidence as Array<{ quote: string }>).map((e) => e.quote);
    expect(quotes).toEqual(['Source line.', 'Target line.']); // source-first union
    expect(after?.attributes).toEqual(['witty', 'brave']); // dedup, source-first
    expect(after?.description).toBe("The source's own description."); // never clobbered
  });

  it('drops target.name from the alias pool (no self-alias)', async () => {
    /* Edge case: source.aliases already contains the target's name.
       After the merge, target.aliases should NOT list its own name. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'dexter-alvin-diznee',
        name: 'Dexter Alvin Diznee',
        role: 'character',
        color: 'unset',
        aliases: ['Hart'],
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'hart',
    });
    expect(res.status).toBe(200);
    const dexOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'hart',
    );
    /* "Hart" was in source's aliases, but it equals target.name → filtered. */
    expect(dexOnDisk?.aliases).not.toContain('Hart');
    expect(dexOnDisk?.aliases).toContain('Dexter Alvin Diznee');
  });
});
