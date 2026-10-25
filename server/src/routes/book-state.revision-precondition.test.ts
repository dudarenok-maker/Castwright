/* Plan 289 Task 2 (#3784) — PUT /:bookId/state honours an optional
   `baseRevision`: a conditional write that carries a stale field is refused
   with 409 `stale_revision` and writes nothing; success answers
   `200 { revision }` instead of 204.

   Real temp workspace + the real routers (supertest), the pattern of
   book-state.slice-revisions.test.ts. Each test seeds its own uniquely-titled
   book, so a folder rename in one cannot leak into the next. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';
import { sliceRevision } from '../workspace/slice-revision.js';

const AUTHOR = 'Precondition Test';
const SERIES = 'Standalones';
const STALE_ERROR = 'This book was changed elsewhere since your edit was made, so the edit was not saved.';

let workspaceRoot: string;
let app: Express;
let seq = 0;
let runBookJobFn: typeof import('../workspace/book-jobs.js').runBookJob;
let importPortableBundleFn: typeof import('../import/scan-import-folder.js').importPortableBundle;
let makeBookIdFn: typeof import('../workspace/paths.js').makeBookId;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-precondition-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { voiceOverrideLinkedRouter }, { importRouter }, { chaptersRestructureRouter }] =
    await Promise.all([
      import('./book-state.js'),
      import('./voice-override-linked.js'),
      import('./import.js'),
      import('./chapters-restructure.js'),
    ]);
  runBookJobFn = (await import('../workspace/book-jobs.js')).runBookJob;
  importPortableBundleFn = (await import('../import/scan-import-folder.js')).importPortableBundle;
  makeBookIdFn = (await import('../workspace/paths.js')).makeBookId;
  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', voiceOverrideLinkedRouter);
  app.use('/api/books', chaptersRestructureRouter);
  app.use('/api', importRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

interface Seeded {
  bookId: string;
  title: string;
  dir: string;
  ab: (f: string) => string;
}

function seed(prefix: string, opts: { cast?: object[]; title?: string; series?: string } = {}): Seeded {
  const title = opts.title ?? `${prefix} ${++seq}`;
  const series = opts.series ?? SERIES;
  const bookId = makeBookIdFn(AUTHOR, series, title);
  const dir = join(workspaceRoot, 'books', AUTHOR, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nAlpha.\n\n# Chapter Two\n\nBeta.\n\n# Chapter Three\n\nGamma.\n');
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: AUTHOR,
      series,
      seriesPosition: null,
      isStandalone: series === SERIES,
      manuscriptFile: 'manuscript.md',
      castConfirmed: opts.series !== undefined,
      editEpoch: 'ep_seed',
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  if (opts.cast) writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: opts.cast }));
  return { bookId, title, dir, ab: (f) => join(dir, '.audiobook', f) };
}

const dirFor = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const readJsonFile = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

type Revs = Record<string, Record<string, string>>;

async function getRevs(bookId: string): Promise<Revs> {
  const res = await request(app).get(`/api/books/${bookId}/state`);
  expect(res.status).toBe(200);
  return res.body.sliceRevisions;
}

const put = (bookId: string, slice: string, patch: unknown, baseRevision?: unknown) =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .send(baseRevision === undefined ? { slice, patch } : { slice, patch, baseRevision });

describe('PUT /:bookId/state — baseRevision precondition', () => {
  it('N5: a stale conditional rename is refused; title and folder stay at the newer value', async () => {
    const b = seed('N5');
    const base = await getRevs(b.bookId);
    const t2 = `${b.title} T2`;
    const lib = await put(b.bookId, 'state', { title: t2 });
    expect(lib.status).toBe(200);
    expect(existsSync(dirFor(t2))).toBe(true);

    const stale = await put(b.bookId, 'state', { title: `${b.title} T1` }, base.state);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_revision');
    expect(stale.body.error).toBe(STALE_ERROR);
    expect(readJsonFile(join(dirFor(t2), '.audiobook', 'state.json')).title).toBe(t2);
    expect(existsSync(dirFor(`${b.title} T1`))).toBe(false);
  });

  it('a stale conditional rename on the MOVING branch writes nothing and leaves the old folder intact', async () => {
    const b = seed('Move');
    const base = await getRevs(b.bookId);
    expect((await put(b.bookId, 'state', { description: 'D2' })).status).toBe(200);

    const renamed = `${b.title} Renamed`;
    const stale = await put(b.bookId, 'state', { title: renamed, description: 'D1' }, base.state);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale_revision');
    expect(existsSync(b.dir)).toBe(true);
    expect(existsSync(dirFor(renamed))).toBe(false);
    const st = readJsonFile(b.ab('state.json'));
    expect(st.title).toBe(b.title);
    expect(st.description).toBe('D2');
  });

  it('book_busy wins over stale_revision when the folder would move', async () => {
    const b = seed('Busy');
    const base = await getRevs(b.bookId);
    expect((await put(b.bookId, 'state', { description: 'D2' })).status).toBe(200);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = await runBookJobFn(b.bookId, 'render', () => gate);
    try {
      const res = await put(b.bookId, 'state', { title: `${b.title} X`, description: 'D1' }, base.state);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
    } finally {
      release();
      if (typeof job === 'object' && job && 'done' in job) await job.done;
    }
  });

  it('disjoint fields do not refuse each other', async () => {
    const b = seed('Disjoint');
    const base = await getRevs(b.bookId);
    expect((await put(b.bookId, 'state', { notes: 'changed elsewhere' })).status).toBe(200);
    const res = await put(b.bookId, 'state', { castConfirmed: true }, base.state);
    expect(res.status).toBe(200);
    const st = readJsonFile(b.ab('state.json'));
    expect(st.castConfirmed).toBe(true);
    expect(st.notes).toBe('changed elsewhere');
  });

  it('a body with no baseRevision is unconditional, as today', async () => {
    const b = seed('Unconditional');
    expect((await put(b.bookId, 'state', { notes: 'a' })).status).toBe(200);
    expect((await put(b.bookId, 'state', { notes: 'b' })).status).toBe(200);
    expect(readJsonFile(b.ab('state.json')).notes).toBe('b');
  });

  it('a malformed baseRevision is a 400, not a silent unconditional write', async () => {
    const b = seed('Malformed');
    const res = await put(b.bookId, 'state', { notes: 'x' }, ['not', 'a', 'map']);
    expect(res.status).toBe(400);
    expect(readJsonFile(b.ab('state.json')).notes).toBeUndefined();
  });

  it('lost response: a conditional retry of an already-landed state patch with untrimmed tags is 200', async () => {
    const b = seed('LostState');
    const base = await getRevs(b.bookId);
    const patch = { tags: ['  alpha ', 'beta', 'alpha'], title: b.title };
    expect((await put(b.bookId, 'state', patch)).status).toBe(200);
    const retry = await put(b.bookId, 'state', patch, base.state);
    expect(retry.status).toBe(200);
    expect(readJsonFile(b.ab('state.json')).tags).toEqual(['alpha', 'beta']);
  });

  it('lost response: a conditional retry of an already-landed cast patch carrying GET decorations is 200', async () => {
    const b = seed('LostCast', {
      cast: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset' }],
    });
    const first = await request(app).get(`/api/books/${b.bookId}/state`);
    const base = first.body.sliceRevisions;
    const decorated = first.body.cast.characters as Array<Record<string, unknown>>;
    expect(decorated[0]).toHaveProperty('clonedElsewhereInSeries');
    const patch = { characters: decorated.map((c) => ({ ...c, name: 'Wren Renamed' })) };

    expect((await put(b.bookId, 'cast', patch)).status).toBe(200);
    const retry = await put(b.bookId, 'cast', patch, base.cast);
    expect(retry.status).toBe(200);
    expect(readJsonFile(b.ab('cast.json')).characters[0].name).toBe('Wren Renamed');
  });

  it('a genuinely stale cast / manuscript / changeLog write is refused and writes nothing', async () => {
    const b = seed('StaleSlices', { cast: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset' }] });
    writeFileSync(b.ab('manuscript-edits.json'), JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'A.' }] }));
    writeFileSync(b.ab('change-log.json'), JSON.stringify({ events: [{ type: 'a' }] }));
    const base = await getRevs(b.bookId);

    writeFileSync(b.ab('cast.json'), JSON.stringify({ characters: [{ id: 'wren', name: 'Elsewhere', role: 'character', color: 'unset' }] }));
    writeFileSync(b.ab('manuscript-edits.json'), JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Elsewhere.' }] }));
    writeFileSync(b.ab('change-log.json'), JSON.stringify({ events: [{ type: 'elsewhere' }] }));

    const cast = await put(b.bookId, 'cast', { characters: [{ id: 'wren', name: 'Mine', role: 'character', color: 'unset' }] }, base.cast);
    const ms = await put(b.bookId, 'manuscript', { sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Mine.' }] }, base.manuscript);
    const cl = await put(b.bookId, 'changeLog', { events: [{ type: 'mine' }] }, base.changeLog);
    for (const r of [cast, ms, cl]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('stale_revision');
    }
    expect(readJsonFile(b.ab('cast.json')).characters[0].name).toBe('Elsewhere');
    expect(readJsonFile(b.ab('manuscript-edits.json')).sentences[0].text).toBe('Elsewhere.');
    expect(readJsonFile(b.ab('change-log.json')).events[0].type).toBe('elsewhere');
  });

  it('voice override: a kept roster for B is refused after a linked override landed in B', async () => {
    const A = seed('VoiceA', { title: 'Voice A', series: 'Hollow Saga', cast: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 3 }] });
    const B = seed('VoiceB', { title: 'Voice B', series: 'Hollow Saga', cast: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset', lines: 2 }] });
    const base = await getRevs(B.bookId);

    const linked = await request(app)
      .post(`/api/books/${A.bookId}/cast/wren/voice-override-linked`)
      .send({ override: { engine: 'qwen', name: 'wren-designed' } });
    expect(linked.status).toBe(200);
    const afterLinked = readJsonFile(B.ab('cast.json'));
    expect(afterLinked.characters[0].overrideTtsVoices?.qwen?.name).toBe('wren-designed');

    const res = await put(
      B.bookId,
      'cast',
      { characters: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset', overrideTtsVoices: { qwen: { name: 'something-else' } } }] },
      base.cast,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_revision');
    expect(readJsonFile(B.ab('cast.json'))).toEqual(afterLinked);
  });

  it('wipe: a re-parse rotates the epoch, so a kept castConfirmed:true is refused', async () => {
    const b = seed('Wipe');
    const base = await getRevs(b.bookId);
    expect((await request(app).post(`/api/books/${b.bookId}/reparse`)).status).toBe(200);
    expect(readJsonFile(b.ab('state.json')).castConfirmed).toBe(false);

    const res = await put(b.bookId, 'state', { castConfirmed: true }, base.state);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_revision');
    expect(readJsonFile(b.ab('state.json')).castConfirmed).toBe(false);
  });

  it('N8 (POST /api/import): delete then re-import refuses a pre-delete base on every slice, including an absent-file base', async () => {
    const title = 'N8 Import Book';
    const importOnce = async () => {
      const imp = await request(app)
        .post('/api/import')
        .send({ text: `# ${title}\n\n## Chapter One\n\nText.\n`, fileName: 'n8.md' });
      const res = await request(app).post('/api/books').send({
        tempId: imp.body.tempId,
        author: AUTHOR,
        title,
        seriesPosition: null,
        isStandalone: true,
      });
      expect(res.status).toBe(201);
      return res.body.bookId as string;
    };
    const bookId = await importOnce();
    const base = await getRevs(bookId);
    expect((await request(app).delete(`/api/books/${bookId}`)).status).toBe(204);
    expect(await importOnce()).toBe(bookId);

    const state = await put(bookId, 'state', { castConfirmed: true }, base.state);
    const cast = await put(bookId, 'cast', { characters: [{ id: 'a', name: 'A', role: 'character', color: 'unset' }] }, base.cast);
    const ms = await put(bookId, 'manuscript', { sentences: [{ id: 1, chapterId: 1, characterId: 'a', text: 'x' }] }, base.manuscript);
    for (const r of [state, cast, ms]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('stale_revision');
    }
  });

  it('N8 (portable bundle): delete then re-import with the same bookId and manuscriptId refuses a pre-delete base', async () => {
    const bundleState = {
      bookId: makeBookIdFn(AUTHOR, SERIES, 'N8 Bundle Book'),
      manuscriptId: 'mns_n8_bundle',
      title: 'N8 Bundle Book',
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      editEpoch: 'ep_in_bundle',
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
      coverGradient: ['#abc', '#def'],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
    const bundle = await new Promise<Buffer>((resolve, reject) => {
      const zip = new ZipFile();
      const chunks: Buffer[] = [];
      zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
      zip.outputStream.on('error', reject);
      zip.addBuffer(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            exportedFrom: { appVersion: '0.0.0' },
            book: { bookId: bundleState.bookId, title: bundleState.title, author: AUTHOR, series: SERIES },
            contents: { stateJsonHash: 'stub', manuscriptHash: 'stub', audioCount: 0, totalSizeBytes: 0 },
          }),
        ),
        'MANIFEST.json',
      );
      zip.addBuffer(Buffer.from(JSON.stringify(bundleState)), 'state.json');
      zip.addBuffer(Buffer.from('# Title\nbody\n'), 'manuscript.txt');
      zip.addBuffer(Buffer.from(JSON.stringify({ events: [] })), 'change-log.json');
      zip.end();
    });

    await importPortableBundleFn(bundle, { onConflict: 'fail' });
    const base = await getRevs(bundleState.bookId);
    expect((await request(app).delete(`/api/books/${bundleState.bookId}`)).status).toBe(204);
    await importPortableBundleFn(bundle, { onConflict: 'fail' });

    const state = await put(bundleState.bookId, 'state', { castConfirmed: true }, base.state);
    const cast = await put(bundleState.bookId, 'cast', { characters: [{ id: 'a', name: 'A', role: 'character', color: 'unset' }] }, base.cast);
    const ms = await put(bundleState.bookId, 'manuscript', { sentences: [{ id: 1, chapterId: 1, characterId: 'a', text: 'x' }] }, base.manuscript);
    for (const r of [state, cast, ms]) {
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('stale_revision');
    }
  });

  it('a chapter restructure moves the manuscript sentences token but no state token', async () => {
    const b = seed('Restructure');
    writeFileSync(
      b.ab('manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha.' },
          { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta.' },
          { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma.' },
        ],
      }),
    );
    const before = await getRevs(b.bookId);
    const res = await request(app).post(`/api/books/${b.bookId}/chapters/merge`).send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    const after = await getRevs(b.bookId);
    expect(after.manuscript.sentences).not.toBe(before.manuscript.sentences);
    expect(after.state).toEqual(before.state);
  });

  it('PUT 200 answers { revision } equal to the next GET, for every slice (moving and non-moving state)', async () => {
    const b = seed('Revision', { cast: [{ id: 'wren', name: 'Wren', role: 'character', color: 'unset' }] });
    const castRes = await put(b.bookId, 'cast', { characters: [{ id: 'wren', name: 'Wren Two', role: 'character', color: 'unset' }] });
    expect(castRes.status).toBe(200);
    expect(castRes.body.revision).toEqual((await getRevs(b.bookId)).cast);

    const msRes = await put(b.bookId, 'manuscript', { sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Hi.' }], mergedAwayKeys: ['k'] });
    expect(msRes.status).toBe(200);
    expect(msRes.body.revision).toEqual((await getRevs(b.bookId)).manuscript);

    const clRes = await put(b.bookId, 'changeLog', { events: [{ type: 'e' }] });
    expect(clRes.status).toBe(200);
    expect(clRes.body.revision).toEqual((await getRevs(b.bookId)).changeLog);

    const stRes = await put(b.bookId, 'state', { notes: 'n', tags: [' t '] });
    expect(stRes.status).toBe(200);
    expect(stRes.body.revision).toEqual((await getRevs(b.bookId)).state);

    const moved = await put(b.bookId, 'state', { title: `${b.title} Moved` });
    expect(moved.status).toBe(200);
    expect(moved.body.revision).toEqual((await getRevs(b.bookId)).state);
    const salt = { manuscriptId: `m_${b.bookId}`, editEpoch: 'ep_seed' };
    expect(moved.body.revision).toEqual(
      sliceRevision('state', readJsonFile(join(dirFor(`${b.title} Moved`), '.audiobook', 'state.json')), salt),
    );
  });
});
