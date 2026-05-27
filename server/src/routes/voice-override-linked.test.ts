/* Integration tests for the voice-override-linked router (plan 122).

   Seeds a small KOTLC series on disk and asserts the keystone behaviour: a
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

const AUTHOR = 'Shannon Messenger';
const SERIES = 'Keeper of the Lost Cities';
const BOOK_A = 'Keeper of the Lost Cities';
const BOOK_B = 'Exile';
const BOOK_C = 'Everblaze';
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
  /* Sophie under three divergent identities, NO shared voiceId:
       A: id 'sophie' (alias "Sophie Foster")   B: id 'sophie-foster'
       C: id 'sophie' (no alias). */
  writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    { id: 'sophie', name: 'Sophie', role: 'character', color: 'unset', aliases: ['Sophie Foster'], lines: 100 },
    { id: 'keefe', name: 'Keefe', role: 'character', color: 'unset', voiceId: 'v_keefe', lines: 80 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_B, bookB, [
    { id: 'sophie-foster', name: 'Sophie Foster', role: 'character', color: 'unset', lines: 90 },
    { id: 'keefe-sencen', name: 'Keefe Sencen', role: 'character', color: 'unset', voiceId: 'v_keefe', lines: 60 },
  ]);
  writeBookOnDisk(AUTHOR, SERIES, BOOK_C, bookC, [
    { id: 'sophie', name: 'Sophie', role: 'character', color: 'unset', lines: 70 },
  ]);
  writeBookOnDisk(AUTHOR, 'A Different Saga', OTHER_BOOK, otherBookId, [
    { id: 'sophie', name: 'Sophie', role: 'character', color: 'unset', lines: 5 },
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
    const res = await callLinked(bookA, 'sophie', {
      override: { engine: 'qwen', name: 'sophie-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('sophie'); // source.voiceId ?? id
    /* All three Sophie rows in THIS series are written + unified. */
    const updatedIds = (res.body.updated as Array<{ characterId: string }>).map((u) => u.characterId).sort();
    expect(updatedIds).toEqual(['sophie', 'sophie', 'sophie-foster']);

    for (const [title, id] of [
      [BOOK_A, 'sophie'],
      [BOOK_B, 'sophie-foster'],
      [BOOK_C, 'sophie'],
    ] as const) {
      const c = findChar(title, id);
      expect(c?.voiceId).toBe('sophie');
      expect((c?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('sophie-designed');
      expect(c?.ttsEngine).toBe('qwen');
    }
  });

  it('does NOT cross series boundaries (the same-named Sophie in another saga is untouched)', async () => {
    await callLinked(bookA, 'sophie', { override: { engine: 'qwen', name: 'sophie-designed' } });
    const otherPath = join(workspaceRoot, 'books', AUTHOR, 'A Different Saga', OTHER_BOOK, '.audiobook', 'cast.json');
    const other = (JSON.parse(readFileSync(otherPath, 'utf8')) as { characters: Array<Record<string, unknown>> }).characters[0];
    expect(other.overrideTtsVoices).toBeUndefined();
    expect(other.voiceId).toBeUndefined();
  });

  it('respects notLinkedTo — a pair marked intentionally different is skipped', async () => {
    /* Mark A/sophie ↮ B/sophie-foster as different. */
    writeBookOnDisk(AUTHOR, SERIES, BOOK_A, bookA, [
      {
        id: 'sophie',
        name: 'Sophie',
        role: 'character',
        color: 'unset',
        aliases: ['Sophie Foster'],
        notLinkedTo: [{ bookId: bookB, characterId: 'sophie-foster' }],
        lines: 100,
      },
    ]);
    const res = await callLinked(bookA, 'sophie', {
      override: { engine: 'qwen', name: 'sophie-designed' },
    });
    expect(res.status).toBe(200);
    /* B/sophie-foster is excluded; C/sophie (id-fallback key 'sophie' matches
       canonical) still gets it. */
    expect(findChar(BOOK_B, 'sophie-foster')?.overrideTtsVoices).toBeUndefined();
    expect((findChar(BOOK_C, 'sophie')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('sophie-designed');
  });

  it('still propagates by shared voiceId across differently-named rows (old behaviour preserved)', async () => {
    const res = await callLinked(bookA, 'keefe', {
      override: { engine: 'qwen', name: 'keefe-designed' },
    });
    expect(res.status).toBe(200);
    expect(res.body.canonicalVoiceId).toBe('v_keefe');
    /* B/keefe-sencen shares voiceId v_keefe though its name differs. */
    expect((findChar(BOOK_B, 'keefe-sencen')?.overrideTtsVoices as Record<string, { name: string }>)?.qwen?.name).toBe('keefe-designed');
    expect(findChar(BOOK_A, 'keefe')?.voiceId).toBe('v_keefe');
  });

  it('clears the engine map when override is null', async () => {
    await callLinked(bookA, 'sophie', { override: { engine: 'qwen', name: 'sophie-designed' } });
    const res = await callLinked(bookA, 'sophie', { override: null });
    expect(res.status).toBe(200);
    expect(findChar(BOOK_A, 'sophie')?.overrideTtsVoices).toBeUndefined();
  });

  it('400s an invalid override body', async () => {
    const res = await callLinked(bookA, 'sophie', { override: { engine: 'banjo', name: 'x' } });
    expect(res.status).toBe(400);
  });

  it('404s an unknown book or character', async () => {
    expect((await callLinked('nope', 'sophie', { override: null })).status).toBe(404);
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
});
