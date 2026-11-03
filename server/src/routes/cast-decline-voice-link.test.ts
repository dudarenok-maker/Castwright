/* #3992 — POST /api/books/:bookId/cast/:characterId/decline-voice-link, the
   only writer of the `declinedVoiceFrom` ("Don't reuse") marker, and the manual
   re-link (cast/link-prior) that clears it again. Same lazy-import pattern as
   cast-not-linked-to.test.ts so WORKSPACE_DIR is set before paths.ts binds. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

let root: string;
let app: Express;
let oneId: string;
let twoId: string;

const dirOf = (title: string) => join(root, 'books', AUTHOR, SERIES, title);
const castFile = (title: string) => join(dirOf(title), '.audiobook', 'cast.json');
const readRows = (title: string): Array<Record<string, any>> =>
  JSON.parse(readFileSync(castFile(title), 'utf8')).characters;

function writeBook(title: string, id: string, characters: object[]) {
  const dir = dirOf(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
      author: AUTHOR,
      series: SERIES,
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
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

const wren = (extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  ...extra,
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-decline-voice-link-'));
  process.env.WORKSPACE_DIR = root;
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { castLinkPriorRouter } = await import('./cast-link-prior.js');
  const { makeBookId } = await import('../workspace/paths.js');
  oneId = makeBookId(AUTHOR, SERIES, 'Book One');
  twoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/books', castLinkPriorRouter);
});

beforeEach(() => {
  rmSync(join(root, 'books'), { recursive: true, force: true });
  writeBook('Book One', oneId, [wren()]);
  writeBook('Book Two', twoId, [wren(), { id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const decline = (bookId: string, characterId: string, body: object) =>
  request(app).post(`/api/books/${bookId}/cast/${characterId}/decline-voice-link`).send(body);

describe('POST decline-voice-link', () => {
  it('records the declined book on the row, and only that row', async () => {
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ declinedVoiceFrom: [oneId], declinedVoiceUuids: [] });
    const rows = readRows('Book Two');
    expect(rows[0].declinedVoiceFrom).toEqual([oneId]);
    expect(rows[1].declinedVoiceFrom).toBeUndefined();
    expect(readRows('Book One')[0].declinedVoiceFrom).toBeUndefined();
  });

  it('records the voice uuid the row holds, so the decline covers every book holding that voice (pass-2 V)', async () => {
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_shared' })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.body).toEqual({ declinedVoiceFrom: [oneId], declinedVoiceUuids: ['u_shared'] });
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_shared']);
    // a repeat is a no-op, and a row that has since forked adds its new uuid
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_shared']);
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_new', declinedVoiceFrom: [oneId], declinedVoiceUuids: ['u_shared'] })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_shared', 'u_new']);
  });

  it('clears matchedFrom on disk in the same write, mirroring the reducer (pass-2 D)', async () => {
    const mf = { bookId: oneId, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_shared', voiceState: 'reused', matchedFrom: mf })]);
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(200);
    const row = readRows('Book Two')[0];
    expect('matchedFrom' in row).toBe(false);
    expect(row.voiceState).toBe('generated');
    expect(row.declinedVoiceFrom).toEqual([oneId]);
    expect(row.voiceUuid).toBe('u_shared');
  });

  it('keeps a locked or tuned voiceState when it clears the link', async () => {
    const mf = { bookId: oneId, characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceState: 'tuned', matchedFrom: mf })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    const row = readRows('Book Two')[0];
    expect('matchedFrom' in row).toBe(false);
    expect(row.voiceState).toBe('tuned');
  });

  it('leaves a link to a DIFFERENT book alone (the disk moved on since the client read it)', async () => {
    const mf = { bookId: 'another-book', characterId: 'wren', bookTitle: 'Other', confidence: 0.9 };
    writeBook('Book Two', twoId, [wren({ voiceState: 'reused', matchedFrom: mf })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    const row = readRows('Book Two')[0];
    expect(row.matchedFrom).toEqual(mf);
    expect(row.declinedVoiceFrom).toEqual([oneId]);
  });

  it('a cast.json that cannot be read answers a path-free 500 (an fs error embeds the absolute path)', async () => {
    rmSync(castFile('Book Two'));
    mkdirSync(castFile('Book Two')); // reading a directory throws EISDIR with the path in its message
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(typeof res.body.error).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain(root);
  });

  it('a torn cast.json answers 500 and is left exactly as it was', async () => {
    writeFileSync(castFile('Book Two'), '{"characters":[{"id":');
    const res = await decline(twoId, 'wren', { fromBookId: oneId });
    expect(res.status).toBe(500);
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe('{"characters":[{"id":');
  });

  it('records no uuid for a row that has none', async () => {
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect('declinedVoiceUuids' in readRows('Book Two')[0]).toBe(false);
  });

  it('is idempotent and accumulates distinct books', async () => {
    await decline(twoId, 'wren', { fromBookId: oneId });
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readRows('Book Two')[0].declinedVoiceFrom).toEqual([oneId]);
    const res = await decline(twoId, 'wren', { fromBookId: 'a-deleted-book' });
    expect(res.body.declinedVoiceFrom).toEqual([oneId, 'a-deleted-book']);
  });

  it('does not write when the book is already recorded (no needless rewrite)', async () => {
    await decline(twoId, 'wren', { fromBookId: oneId });
    const before = readFileSync(castFile('Book Two'), 'utf8');
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe(before);
  });

  it('400 on a missing or self fromBookId, writing nothing', async () => {
    const before = readFileSync(castFile('Book Two'), 'utf8');
    expect((await decline(twoId, 'wren', {})).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: '  ' })).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: 7 })).status).toBe(400);
    expect((await decline(twoId, 'wren', { fromBookId: twoId })).status).toBe(400);
    expect(readFileSync(castFile('Book Two'), 'utf8')).toBe(before);
  });

  it('404 on an unknown character or book, 409 on an empty cast', async () => {
    expect((await decline(twoId, 'nobody', { fromBookId: oneId })).status).toBe(404);
    expect((await decline('no-such-book', 'wren', { fromBookId: oneId })).status).toBe(404);
    writeBook('Book Two', twoId, []);
    expect((await decline(twoId, 'wren', { fromBookId: oneId })).status).toBe(409);
  });

  it('keeps every other field of the cast file', async () => {
    writeBook('Book Two', twoId, [wren({ voiceUuid: 'u_x', voiceState: 'generated', aliases: ['W'] })]);
    await decline(twoId, 'wren', { fromBookId: oneId });
    expect(readRows('Book Two')[0]).toMatchObject({ voiceUuid: 'u_x', voiceState: 'generated', aliases: ['W'] });
  });
});

describe('cast/link-prior clears the marker for the book it links to', () => {
  const link = () =>
    request(app)
      .post(`/api/books/${twoId}/cast/link-prior`)
      .send({ sourceCharacterId: 'wren', targetBookId: oneId, targetCharacterId: 'wren' });

  it('drops only the re-linked book from the marker, forcing the write even when nothing else changed', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: [oneId, 'another-book'] })]);
    const res = await link();
    expect(res.status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceFrom).toEqual(['another-book']);
  });

  it('removes the field entirely when it was the last entry', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: [oneId] })]);
    expect((await link()).status).toBe(200);
    expect('declinedVoiceFrom' in readRows('Book Two')[0]).toBe(false);
  });

  it('drops the re-linked voice uuid from declinedVoiceUuids too (pass-2 V)', async () => {
    writeBook('Book One', oneId, [wren({ voiceUuid: 'u_shared' })]);
    writeBook('Book Two', twoId, [
      wren({ voiceUuid: 'u_shared', declinedVoiceFrom: [oneId], declinedVoiceUuids: ['u_shared', 'u_keep'] }),
    ]);
    expect((await link()).status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceUuids).toEqual(['u_keep']);
    expect('declinedVoiceFrom' in readRows('Book Two')[0]).toBe(false);
  });

  it('leaves a marker that names a different book alone', async () => {
    writeBook('Book Two', twoId, [wren({ declinedVoiceFrom: ['another-book'] })]);
    expect((await link()).status).toBe(200);
    expect(readRows('Book Two')[0].declinedVoiceFrom).toEqual(['another-book']);
  });
});
