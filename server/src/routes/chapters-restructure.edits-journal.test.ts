/* #4227 -- the restructure route journals the edits rewrite before writing
 * state.json and clears the journal once manuscript-edits.json has landed.
 * Harness mirrors chapters-restructure.manuscript-hints.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const spy = vi.hoisted(() => ({ log: [] as string[], editsFail: false, journalFail: false }));
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...real,
    writeJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeJsonAtomic>) => {
      const path = String(args[0]);
      spy.log.push(path);
      if (spy.editsFail && path.endsWith('manuscript-edits.json')) throw new Error('edits write boom');
      if (spy.journalFail && path.endsWith('restructure-edits-journal.json')) {
        throw new Error('journal write boom');
      }
      return real.writeJsonAtomic(...args);
    }),
  };
});
vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...real,
    writeStateJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeStateJsonAtomic>) => {
      spy.log.push('STATE');
      return real.writeStateJsonAtomic(...args);
    }),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Edits Journal Test';
const SERIES = 'Standalones';
const TITLE = 'Edits Journal Test Book';
const MANUSCRIPT_ID = 'm_edits_journal_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

const editsPath = (): string => join(bookDir, '.audiobook', 'manuscript-edits.json');
const statePath = (): string => join(bookDir, '.audiobook', 'state.json');
const journalPath = (): string => join(bookDir, '.audiobook', 'restructure-edits-journal.json');

function seedState(): void {
  writeFileSync(
    statePath(),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
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
}

function seedManuscriptEdits(): void {
  writeFileSync(
    editsPath(),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha first.' },
        { id: 2, chapterId: 1, characterId: 'narr', text: 'Alpha second.' },
        { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' },
        { id: 2, chapterId: 2, characterId: 'sam', text: 'Beta second.' },
        { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma first.' },
        { id: 2, chapterId: 3, characterId: 'narr', text: 'Gamma second.' },
      ],
    }),
  );
}

type Sentence = { id: number; chapterId: number; characterId: string; text: string };
const readEdits = (): { sentences: Sentence[] } =>
  JSON.parse(readFileSync(editsPath(), 'utf8')) as { sentences: Sentence[] };
const readState = (): { chapters: Array<{ id: number; uuid: string }> } =>
  JSON.parse(readFileSync(statePath(), 'utf8')) as { chapters: Array<{ id: number; uuid: string }> };

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-edits-journal-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  spy.log.length = 0;
  spy.editsFail = false;
  spy.journalFail = false;
  seedState();
  seedManuscriptEdits();
  rmSync(journalPath(), { force: true });
  rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

afterEach(() => {
  spy.editsFail = false;
  spy.journalFail = false;
});

const merge12 = () =>
  request(app).post(`/api/books/${bookId}/chapters/merge`).send({ chapterIds: [1, 2] });

describe('restructure journals the edits rewrite (#4227)', () => {
  /* Red when: the clearRestructureEditsJournal call is deleted from the route. */
  it('W1 a clean restructure leaves no journal', async () => {
    const res = await merge12();
    expect(res.status).toBe(200);
    expect(existsSync(journalPath())).toBe(false);
    expect(readEdits().sentences.some((s) => s.chapterId === 3)).toBe(false);
  });

  /* Red when: the journal write moves to after writeStateJsonAtomic, or the
     edits write moves before the state write. */
  it('W2 the journal is written before state.json, and state.json before the edits', async () => {
    const res = await merge12();
    expect(res.status).toBe(200);
    const j = spy.log.findIndex((p) => p.endsWith('restructure-edits-journal.json'));
    const s = spy.log.indexOf('STATE');
    const e = spy.log.findIndex((p) => p.endsWith('manuscript-edits.json'));
    expect(j).toBeGreaterThanOrEqual(0);
    expect(s).toBeGreaterThan(j);
    expect(e).toBeGreaterThan(s);
  });

  /* Red when: the journal is not written, is written from the OLD chapter list,
     or carries a remap/sha that does not match the edits on disk. */
  it('W3 a failing edits write leaves a journal that re-keys the old edits', async () => {
    const editsBefore = readFileSync(editsPath());
    spy.editsFail = true;
    const res = await merge12();
    expect(res.status).toBe(500);

    const state = readState();
    expect(state.chapters).toHaveLength(2);
    expect(readFileSync(editsPath()).equals(editsBefore)).toBe(true);
    expect(readEdits().sentences.some((s) => s.chapterId === 3)).toBe(true);

    expect(existsSync(journalPath())).toBe(true);
    const journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as {
      editsSha256: string;
      chapters: Array<{ id: number; uuid: string }>;
      remap: import('../workspace/restructure.js').SentenceRemap[];
    };
    expect(journal.chapters).toEqual(state.chapters.map((c) => ({ id: c.id, uuid: c.uuid })));
    expect(journal.editsSha256).toBe(createHash('sha256').update(editsBefore).digest('hex'));

    const { applySentenceRemap } = await import('../workspace/restructure.js');
    const rebuilt = applySentenceRemap(readEdits().sentences, journal.remap);
    expect(rebuilt.some((s) => s.chapterId === 3)).toBe(false);
    const gamma = rebuilt.filter((s) => s.text.startsWith('Gamma'));
    expect(gamma.map((s) => [s.chapterId, s.id])).toEqual([
      [2, 1],
      [2, 2],
    ]);
  });

  /* Red when: the journal is written without the editsRead.kind === 'ok' guard. */
  it('W4 no edits file means no journal', async () => {
    rmSync(editsPath(), { force: true });
    const res = await merge12();
    expect(res.status).toBe(200);
    expect(spy.log.some((p) => p.endsWith('restructure-edits-journal.json'))).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });

  /* Red when: the state.json write is allowed to run before the journal write
     settles, so a journal failure no longer leaves state.json untouched. */
  it('W5 a failing journal write changes nothing', async () => {
    const editsBefore = readFileSync(editsPath());
    spy.journalFail = true;
    const res = await merge12();
    expect(res.status).toBe(500);
    expect(readState().chapters).toHaveLength(3);
    expect(readFileSync(editsPath()).equals(editsBefore)).toBe(true);
  });
});

const rename1 = () =>
  request(app).post(`/api/books/${bookId}/chapters/1/rename`).send({ title: 'Opening' });

/* Parks the edits write: the merge answers 500 with state.json on the new chapter
   list, the journal on disk and the edits still keyed to the OLD chapters. Then
   clears the failure flag and drops the in-memory record, as a restart would. */
async function parkThenRestart(): Promise<void> {
  spy.editsFail = true;
  const res = await merge12();
  expect(res.status).toBe(500);
  expect(existsSync(journalPath())).toBe(true);
  expect(readEdits().sentences.some((s) => s.chapterId === 3)).toBe(true);
  spy.editsFail = false;
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
}

describe('the next restructure replays an interrupted edits journal (#4227)', () => {
  /* Red when: the replayRestructureEditsJournal call is deleted from
     applyRestructureClaimed (chapterId === 3 survives), or moved after
     judgeParsePairing (the sha backstop answers 409 / edits stay old-keyed). */
  it('P1 a parked edits write, then replay -> edits keyed to the new chapters', async () => {
    await parkThenRestart();

    const res = await rename1();
    expect(res.status).toBe(200);

    const sentences = readEdits().sentences;
    expect([...new Set(sentences.map((s) => s.chapterId))].sort()).toEqual([1, 2]);
    expect(sentences.some((s) => s.chapterId === 3)).toBe(false);
    const ch1 = sentences.filter((s) => s.chapterId === 1);
    expect(ch1.map((s) => [s.id, s.text])).toEqual([
      [1, 'Alpha first.'],
      [2, 'Alpha second.'],
      [3, 'Beta first.'],
      [4, 'Beta second.'],
    ]);
    expect(ch1[3].characterId).toBe('sam');
    expect(ch1.slice(0, 3).every((s) => s.characterId === 'narr')).toBe(true);
    const ch2 = sentences.filter((s) => s.chapterId === 2);
    expect(ch2.map((s) => [s.id, s.text])).toEqual([
      [1, 'Gamma first.'],
      [2, 'Gamma second.'],
    ]);
    expect(existsSync(journalPath())).toBe(false);
  });

  /* Red when: the sha guard (editsSha256 compare) is deleted from the replay, so a
     journal is applied to edits it was not computed from. */
  it('P2 a stale journal is discarded, not applied', async () => {
    await parkThenRestart();
    const edited = readEdits();
    edited.sentences[0].text = 'Alpha first, edited by a client save.';
    writeFileSync(editsPath(), JSON.stringify(edited));
    const { removeManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);

    await rename1();

    expect(existsSync(journalPath())).toBe(false);
    /* The rename's own restructure rewrites the file pretty-printed, so compare the
       parsed content: the client's edit survives and nothing was re-keyed. */
    expect(readEdits()).toEqual(edited);
    expect(readEdits().sentences.some((s) => s.chapterId === 3)).toBe(true);
  });

  /* Red when: the replay call breaks the no-journal path (throws, or rewrites
     edits it has no journal for). */
  it('P3 a clean book is unaffected', async () => {
    const editsBefore = readEdits();
    const res = await rename1();
    expect(res.status).toBe(200);
    expect(existsSync(journalPath())).toBe(false);
    expect(readEdits()).toEqual(editsBefore);
  });
});

describe('the replay precedes the parse-fallback pairing check (#4227)', () => {
  /* Red when: the replay call moves after judgeParsePairing. That check reads the
     OLD-keyed edits first, so the pairing judges against stale evidence (and the
     closure's sha backstop sees the replay's rewrite) and the rename no longer
     answers 200 with the edits re-keyed. Needs a parse-fallback record (no hints
     file), which P1's persisted-hints record never reaches. */
  it('P4 a parse-fallback record pairs against the replayed edits', async () => {
    await parkThenRestart();
    writeFileSync(
      join(bookDir, 'manuscript.md'),
      '# Chapter One\n\nAlpha first.\nAlpha second.\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n',
    );
    rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });

    const res = await rename1();
    expect(res.status).toBe(200);
    expect(readEdits().sentences.some((s) => s.chapterId === 3)).toBe(false);
    expect(existsSync(journalPath())).toBe(false);
  });
});

/* #4227 pass 1 -- the replay re-keys manuscript-edits.json behind an open client, and
   a client that then applies this response's remap to its OLD-keyed copy drops lines.
   The response therefore names the manuscript slice token of the edits this request
   read (after its own replay, before its own rewrite); a client whose learned token
   differs knows the edits moved under it and adopts the re-read instead of remapping. */
const exclude2 = () =>
  request(app).post(`/api/books/${bookId}/chapters/exclude`).send({ chapterIds: [2], excluded: true });

/* What a client learns at book open: GET /state's `sliceRevisions.manuscript`. */
async function clientToken(): Promise<Record<string, string>> {
  const res = await request(app).get(`/api/books/${bookId}/state`);
  expect(res.status).toBe(200);
  return (res.body as { sliceRevisions: { manuscript: Record<string, string> } }).sliceRevisions.manuscript;
}

describe('the response names the edits revision it read, so a stale client can adopt (#4227)', () => {
  /* Red when: editsRevisionBefore is not returned, or is computed from anything but
     the manuscript slice of the file the request read. */
  it('R1 nothing moved: the response token equals the client token, so the client remaps', async () => {
    const learned = await clientToken();
    const res = await merge12();
    expect(res.status).toBe(200);
    expect(res.body.editsRevisionBefore).toEqual(learned);
  });

  /* Red when: the token is read before the replay instead of after it, or the replay
     is skipped. Trigger 1: the replay runs inside this very request. The expected token
     is what a sweep of the same parked book leaves on disk (same content, same salt):
     the sweep runs first, then the parked files are put back for the request. */
  it('R2 replay inside the request: the token is the re-keyed file, not the one the client holds', async () => {
    const learned = await clientToken();
    await parkThenRestart();
    const parkedEdits = readFileSync(editsPath());
    const parkedJournal = readFileSync(journalPath());
    const { replayAllRestructureEditsJournals } = await import('../workspace/restructure-edits-journal.js');
    expect((await replayAllRestructureEditsJournals()).replayed).toEqual([bookId]);
    const rekeyed = await clientToken();
    writeFileSync(editsPath(), parkedEdits);
    writeFileSync(journalPath(), parkedJournal);

    const res = await exclude2();
    expect(res.status).toBe(200);
    expect(res.body.editsRevisionBefore).toEqual(rekeyed);
    expect(res.body.editsRevisionBefore).not.toEqual(learned);
  });
});

describe('boot-sweep replay, stale client (#4227)', () => {
  /* Red when: the token reflects only "this request replayed". The sweep re-keyed the
     file before the request arrived, so the request itself replays nothing; the token
     still differs from the one the client learned. */
  it('R3 the sweep replayed before the request: the token equals the post-sweep file and differs from the client', async () => {
    const learned = await clientToken();
    await parkThenRestart();
    const { replayAllRestructureEditsJournals } = await import('../workspace/restructure-edits-journal.js');
    const sweep = await replayAllRestructureEditsJournals();
    expect(sweep.replayed).toEqual([bookId]);
    const afterSweep = await clientToken();
    expect(afterSweep).not.toEqual(learned);

    const res = await exclude2();
    expect(res.status).toBe(200);
    expect(res.body.editsRevisionBefore).toEqual(afterSweep);
    expect(res.body.editsRevisionBefore).not.toEqual(learned);
  });
});
