/* Integration tests for the cast/add-from-roster router.

   Seeds two the Hollow Tide books on disk — the current ("source") book has a
   minimal cast (no Linnet); the prior ("target") book contains a
   "Councillor Linnet" character with a voice. The tests assert:

   - Success path appends a new character row to the source book's
     cast.json with name + gender + ageRange + voiceId copied from the
     target, voiceState = 'reused', matchedFrom set to the target. The
     target's cast.json is untouched.
   - Series guard: target in a different series, a standalone, or
     unknown bookId all return 404.
   - Source book without cast.json yet → 409.
   - Same-book target → 400.
   - Repeat call mints a NEW id each time (no dedupe on the server). */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Shannon Messenger';
const SERIES = 'The Hollow Tide';
const PRIOR_BOOK = 'The Hollow Tide';
const SOURCE_BOOK = 'New the Hollow Tide Book';
const OTHER_BOOK = 'Other Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let priorBookId: string;
let sourceBookId: string;
let otherBookId: string;
let standaloneBookId: string;

const initialPriorCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'councillor-linnet',
    name: 'Councillor Linnet',
    role: 'character',
    color: 'unset',
    voiceId: 'v_linnet',
    gender: 'female',
    ageRange: 'adult',
  },
  { id: 'wren', name: 'Wren', role: 'character', color: 'unset', voiceId: 'v_wren' },
];

const initialSourceCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'lord-vane', name: 'Lord Vane', role: 'character', color: 'unset' },
];

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean; omitCast?: boolean } = {},
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
  if (!opts.omitCast) {
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  }
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-add-from-roster-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castAddFromRosterRouter }, { makeBookId }] = await Promise.all([
    import('./cast-add-from-roster.js'),
    import('../workspace/paths.js'),
  ]);
  priorBookId = makeBookId(AUTHOR, SERIES, PRIOR_BOOK);
  sourceBookId = makeBookId(AUTHOR, SERIES, SOURCE_BOOK);
  otherBookId = makeBookId(AUTHOR, 'Different Series', OTHER_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castAddFromRosterRouter);
});

beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK, priorBookId, initialPriorCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK, sourceBookId, initialSourceCast);
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

function callAdd(bookId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/add-from-roster`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/add-from-roster', () => {
  it('rejects when targetBookId or targetCharacterId is missing', async () => {
    const res = await callAdd(sourceBookId, { targetBookId: priorBookId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when targetBookId equals the path bookId', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: sourceBookId,
      targetCharacterId: 'lord-vane',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book is unknown', async () => {
    const res = await callAdd('nope', {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the target book is unknown', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: 'nope',
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target book/i);
  });

  it('returns 404 when target book is in a different series', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: otherBookId,
      targetCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when target book is a standalone', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: standaloneBookId,
      targetCharacterId: 'lonely',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when the target character is unknown', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it('returns 409 when the source book has no cast.json yet', async () => {
    /* Delete the cast.json that beforeEach wrote; writeBookOnDisk
       with omitCast doesn't unlink existing files. */
    unlinkSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, SOURCE_BOOK, '.audiobook', 'cast.json'),
    );
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/source book has no cast/i);
  });

  it('appends a new character to source.cast.json with matchedFrom + preserved voiceId, returns the full new record', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(200);
    expect(res.body.character).toMatchObject({
      name: 'Councillor Linnet',
      role: 'character',
      gender: 'female',
      ageRange: 'adult',
      voiceId: 'v_linnet',
      voiceState: 'reused',
      matchedFrom: {
        bookId: priorBookId,
        characterId: 'councillor-linnet',
        bookTitle: PRIOR_BOOK,
        confidence: 1,
      },
    });
    expect(typeof res.body.character.id).toBe('string');
    expect(res.body.character.id).not.toBe('councillor-linnet'); // new local id, not the prior id

    const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
    /* New character appended; old characters untouched. */
    expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 1);
    const added = sourceOnDisk.characters.at(-1);
    expect(added).toMatchObject({
      name: 'Councillor Linnet',
      voiceId: 'v_linnet',
      voiceState: 'reused',
    });
  });

  it("does not modify the target book's cast.json", async () => {
    const before = readCast(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK);
    await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    const after = readCast(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK);
    expect(after).toEqual(before);
  });

  it('mints a unique id on repeat calls (no dedupe on the server)', async () => {
    const res1 = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    const res2 = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.character.id).not.toBe(res2.body.character.id);

    const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
    expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 2);
  });
});
