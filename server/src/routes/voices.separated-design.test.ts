/* #4067, pass 5 — a designed-voice override (`qwen-<U'>`) of a voice "Don't reuse"
   separated belongs to the rows that moved onto U' and to no other. applyOverrideToCastFiles
   used to exempt a library-assigned slot from that skip, so the DECLINED book's
   `{ qwen: { name: 'qwen-L1', libraryUuid, provenance } }` row lost its library marker and
   rendered `qwen-v_wren` with no file; and its up-front clone scan counted the declined
   book's consented Coqui clone, refusing the other book's propagation.
   The bulk and single design paths reach the same function and are pinned in
   cast-design.declined-first-design.test.ts / qwen-voice.declined-no-uuid.test.ts. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const U = 'u_designed';

let workspaceRoot: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let applyOverrideToCastFiles: typeof import('./voices.js').applyOverrideToCastFiles;
let recordSeparatedVoice: typeof import('../workspace/separated-voices.js').recordSeparatedVoice;

const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const readRow = (t: string): Record<string, any> =>
  JSON.parse(readFileSync(join(bookDir(t), '.audiobook', 'cast.json'), 'utf8')).characters[0];

function writeBook(t: string, position: number, id: string, row: Record<string, unknown>) {
  mkdirSync(join(bookDir(t), '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir(t), '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: position,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir(t), 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir(t), '.audiobook', 'cast.json'), JSON.stringify({ characters: [row] }));
}

const wren = (extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  ...extra,
});
const librarySlot = {
  qwen: { name: 'qwen-L1', libraryUuid: 'L1', provenance: 'designed' },
};
const coquiClone = {
  coqui: { name: 'wren-clone', libraryUuid: 'C1', provenance: 'cloned' },
};
/* Book Two is the decliner: it moved onto U (a separated voice when `separated`). */
const bookTwoRow = () => wren({ voiceUuid: U, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } });

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voices-separated-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { voicesRouter, applyOverrideToCastFiles: apply } = await import('./voices.js');
  ({ recordSeparatedVoice } = await import('../workspace/separated-voices.js'));
  const { makeBookId } = await import('../workspace/paths.js');
  applyOverrideToCastFiles = apply;
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/voices', voicesRouter);
});

beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const putSeries = () =>
  request(app)
    .put('/api/voices/v_wren/override')
    .send({ override: { engine: 'qwen', name: `qwen-${U}` }, scope: 'series', bookId: bookTwoId });

describe("a separated voice's designed override leaves the declined book's library slot alone (#4067, pass 5)", () => {
  it('PUT (series scope): Book One keeps libraryUuid/provenance, no-uuid row declined', async () => {
    await recordSeparatedVoice(U);
    writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'qwen', overrideTtsVoices: librarySlot }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    const before = readRow('Book One');
    const res = await putSeries();
    expect(res.status).toBe(204);
    expect(readRow('Book One')).toEqual(before);
    expect(readRow('Book One').overrideTtsVoices.qwen).toEqual(librarySlot.qwen);
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${U}`);
  });

  it('a library slot on a row with ANOTHER uuid is declined too', async () => {
    await recordSeparatedVoice(U);
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_other', overrideTtsVoices: librarySlot }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    const before = readRow('Book One');
    expect((await putSeries()).status).toBe(204);
    expect(readRow('Book One')).toEqual(before);
  });

  it('a row that moved onto U still takes the write', async () => {
    await recordSeparatedVoice(U);
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: U, overrideTtsVoices: { qwen: { name: 'qwen-old' } } }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    expect((await putSeries()).status).toBe(204);
    expect(readRow('Book One').overrideTtsVoices.qwen.name).toBe(`qwen-${U}`);
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${U}`);
  });

  it('NOT separated: a library slot is written as before (marker cleared, no-uuid or other-uuid row)', async () => {
    writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'qwen', overrideTtsVoices: librarySlot }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    expect((await putSeries()).status).toBe(204);
    expect(readRow('Book One').overrideTtsVoices.qwen).toEqual({ name: `qwen-${U}` });

    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_other', overrideTtsVoices: librarySlot }));
    expect((await putSeries()).status).toBe(204);
    expect(readRow('Book One').overrideTtsVoices.qwen).toEqual({ name: `qwen-${U}` });
  });

  it('NOT separated: a row with another uuid and no library slot is still declined (#3992)', async () => {
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_other', overrideTtsVoices: { qwen: { name: 'qwen-u_other' } } }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    const before = readRow('Book One');
    expect((await putSeries()).status).toBe(204);
    expect(readRow('Book One')).toEqual(before);
  });
});

describe("a separated voice's designed override ignores the declined book's clone (#4067, pass 5)", () => {
  const seedDeclinedClone = async () => {
    await recordSeparatedVoice(U);
    writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
  };

  it('PUT (series scope): the route-level scan does not refuse; Book One keeps its clone', async () => {
    await seedDeclinedClone();
    const before = readRow('Book One');
    const res = await putSeries();
    expect(res.status).toBe(204);
    expect(readRow('Book One')).toEqual(before);
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${U}`);
  });

  it("applyOverrideToCastFiles: the function's own up-front scan does not refuse either", async () => {
    await seedDeclinedClone();
    const before = readRow('Book One');
    const r = await applyOverrideToCastFiles('v_wren', { engine: 'qwen', name: `qwen-${U}` }, { author: AUTHOR, series: SERIES });
    expect(r).toEqual({ updated: 1, skipped: [] });
    expect(readRow('Book One')).toEqual(before);
  });

  it('a clone on a row that IS on U still refuses (route and function)', async () => {
    await recordSeparatedVoice(U);
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: U, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    const before = readRow('Book One');
    expect((await putSeries()).status).toBe(409);
    const r = await applyOverrideToCastFiles('v_wren', { engine: 'qwen', name: `qwen-${U}` }, { author: AUTHOR, series: SERIES });
    expect(r.updated).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(readRow('Book One')).toEqual(before);
  });

  it('NOT separated: the declined-looking book still blocks on its clone (scan unchanged)', async () => {
    writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    writeBook('Book Two', 2, bookTwoId, bookTwoRow());
    expect((await putSeries()).status).toBe(409);
  });
});
