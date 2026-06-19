/* Integration tests for the voice-override-linked router (plan 122).

   Seeds a small the Hollow Tide series on disk and asserts the keystone behaviour: a
   single approve unifies voiceId + writes the Qwen override across a recurring
   character's whole name/alias group — even when the books never shared a
   voiceId — while respecting notLinkedTo and the old voiceId-key propagation.

   Same lazy-import pattern as the sibling route tests so WORKSPACE_DIR is set
   before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK_A = 'The Hollow Tide';
const BOOK_B = 'The Ebb';
const BOOK_C = 'The Tidewatcher’s Oath';
const OTHER_BOOK = 'A Different Saga';
const STANDALONE = 'A Standalone';

let workspaceRoot: string;
let app: Express;
let bookA: string;
let bookB: string;
let bookC: string;
let otherBookId: string;
let standaloneId: string;

function writeBookOnDisk(
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean } = {},
) {
  const dir = join(workspaceRoot, 'books', author, series, title);
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
}

function readCharacters(title: string): Array<Record<string, unknown>> {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, title, '.audiobook', 'cast.json');
  return (JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> })
    .characters;
}
function findChar(title: string, id: string): Record<string, unknown> | undefined {
  return readCharacters(title).find((c) => c.id === id);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voice-override-linked-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ voiceOverrideLinkedRouter }, { makeBookId }] = await Promise.all([
    import('./voice-override-linked.js'),
    import('../workspace/paths.js'),
  ]);
  bookA = makeBookId(AUTHOR, SERIES, BOOK_A);
  bookB = makeBookId(AUTHOR, SERIES, BOOK_B);
  bookC = makeBookId(AUTHOR, SERIES, BOOK_C);
  otherBookId = makeBookId(AUTHOR, 'A Different Saga', OTHER_BOOK);
  standaloneId = makeBookId(AUTHOR, SERIES, STANDALONE);
  app = express();
  app.use(express.json());
  app.use('/api/books', voiceOverrideLinkedRouter);
});

beforeEach(() => {
  /* Wren under three divergent identities, NO shared voiceId:
       A: id 'wren' (alias "Wren Sparrow")   B: id 'wren-sparrow'
       C: id 'wren' (no alias). */
  writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', aliases: ['Wren Sparrow'], lines: 100 },
    { id: 'marlow', name: 'Marlow', role: 'character', color: 'unset', voiceId: 'v_marlow', lines: 80 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
    { id: 'wren-sparrow', name: 'Wren Sparrow', role: 'character', color: 'unset', lines: 90 },
    { id: 'marlow-halden', name: 'Marlow Halden', role: 'character', color: 'unset', voiceId: 'v_marlow', lines: 60 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_C, bookC, [
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 70 },
  ]);
  writeBookOnDisk(AUTHOR, 'A Different Saga', OTHER_BOOK, otherBookId, [
    { id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 5 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, STANDALONE, standaloneId, [
    { id: 'loner', name: 'Loner', role: 'character', color: 'unset', lines: 9 },
  ], { isStandalone: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callLinked(bookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/${characterId}/voice-override-linked`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/:characterId/voice-override-linked', () => {
  it('unifies voiceId + writes the override across the whole name/alias group', async () => {
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('wren'); // source.voiceId ?? id
    /* All three Wren rows in THIS series are written + unified. */
    const updatedIds = (res.body.updated as Array<{ characterId: string }>).map((u) => u.characterId).sort();
    expect(updatedIds).toEqual(['wren', 'wren', 'wren-sparrow']);

    for (const [title, id] of [
      [BOOK_A, 'wren'],
      [BOOK_B, 'wren-sparrow'],
      [BOOK_C, 'wren'],
    ] as const) {
      const c = findChar(title, id);
      expect(c?.voiceId).toBe('wren');
      expect((c?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('wren-designed');
      expect(c?.ttsEngine).toBe('qwen');
    }
  });

  it('does NOT cross series boundaries (the same-named Wren in another saga is untouched)', async () => {
    await callLinked(bookA, 'wren', { override: { engine: 'qwen', name: 'wren-designed' } });
    const otherPath = join(workspaceRoot, 'books', AUTHOR, 'A Different Saga', OTHER_BOOK, '.audiobook', 'cast.json');
    const other = (JSON.parse(readFileSync(otherPath, 'utf8')) as { characters: Array<Record<string, unknown>> }).characters[0];
    expect(other.overrideTtsVoices).toBeUndefined();
    expect(other.voiceId).toBeUndefined();
  });

  it('respects notLinkedTo — a pair marked intentionally different is skipped', async () => {
    /* Mark A/wren ↮ B/wren-sparrow as different. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        notLinkedTo: [{ bookId: bookB, characterId: 'wren-sparrow' }],
        lines: 100,
      },
    ]);
    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-designed' },
    });
    expect(res.status).toBe(200);
    /* B/wren-sparrow is excluded; C/wren (id-fallback key 'wren' matches
       canonical) still gets it. */
    expect(findChar(BOOK_B, 'wren-sparrow')?.overrideTtsVoices).toBeUndefined();
    expect((findChar(BOOK_C, 'wren')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('wren-designed');
  });

  it('still propagates by shared voiceId across differently-named rows (old behaviour preserved)', async () => {
    const res = await callLinked(bookA, 'marlow', {
      override: { engine: 'qwen', name: 'marlow-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('v_marlow');
    /* B/marlow-halden shares voiceId v_marlow though its name differs. */
    expect((findChar(BOOK_B, 'marlow-halden')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('marlow-designed');
    expect(findChar(BOOK_A, 'marlow')?.voiceId).toBe('v_marlow');
  });

  it('clears the engine map when override is null', async () => {
    await callLinked(bookA, 'wren', { override: { engine: 'qwen', name: 'wren-designed' } });
    const res = await callLinked(bookA, 'wren', { override: null });
    expect(res.status).toBe(200);
    expect(findChar(BOOK_A, 'wren')?.overrideTtsVoices).toBeUndefined();
  });

  it('400s an invalid override body', async () => {
    const res = await callLinked(bookA, 'wren', { override: { engine: 'banjo', name: 'x' } });
    expect(res.status).toBe(400);
  });

  it('404s an unknown book or character', async () => {
    expect((await callLinked('nope', 'wren', { override: null })).status).toBe(404);
    expect((await callLinked(bookA, 'ghost', { override: null })).status).toBe(404);
  });

  it('writes only the source row for a standalone (no series-mates)', async () => {
    const res = await callLinked(standaloneId, 'loner', {
      override: { engine: 'qwen', name: 'loner-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(res.body.updated[0].characterId).toBe('loner');
  });

  it('converges voiceUuid to canonical on manual unify — both rows get U1', async () => {
    /* Seed: two Wren rows with DIFFERENT voiceUuids; canonical (source) has U1. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        aliases: ['Wren Sparrow'],
        lines: 100,
        voiceUuid: 'U1',
      },
    ]);
    writeBookOnDisk(AUTHOR, SERIES, BOOK_C, bookC, [
      {
        id: 'wren',
        name: 'Wren',
        role: 'character',
        color: 'unset',
        lines: 70,
        voiceUuid: 'U2',
      },
    ]);
    /* Also remove BOOK_B's wren-sparrow from the mix so it doesn't confuse the assertion
       (wren-sparrow has no voiceUuid — verify it gets undefined, not U1). */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
      { id: 'wren-sparrow', name: 'Wren Sparrow', role: 'character', color: 'unset', lines: 90 },
    ]);

    const res = await callLinked(bookA, 'wren', {
      override: { engine: 'qwen', name: 'wren-uuid-test' },
    });
    expect(res.status).toBe(200);

    /* Canonical source (A/wren, voiceUuid=U1) retains U1. */
    expect(findChar(BOOK_A, 'wren')?.voiceUuid).toBe('U1');
    /* Non-canonical (C/wren, voiceUuid=U2) must be overwritten to U1. */
    expect(findChar(BOOK_C, 'wren')?.voiceUuid).toBe('U1');
    /* Row with no prior voiceUuid (B/wren-sparrow) also gets U1 — canonical uuid
       propagates to all unified rows so the whole group converges on one identity. */
    expect(findChar(BOOK_B, 'wren-sparrow')?.voiceUuid).toBe('U1');
  });
});
