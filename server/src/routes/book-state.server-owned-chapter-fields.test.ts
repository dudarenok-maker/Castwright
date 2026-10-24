/* #3683 — `PUT /:bookId/state` (`slice: 'state'`) must not let a stale or
   hostile client `chapters` copy revert a chapter's server-stamped fields. The
   on-disk copy wins for the server-owned render/failure fields and `uuid`; the
   only client-side exception is an explicit `null` on one of the four
   `generation*` failure fields, which clears it (an absent key keeps disk). */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'Owned Fields Test';
const SERIES = 'Standalones';
const TITLE = 'Owned Fields Book';

type Ch = Record<string, unknown> & { id: number };

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;

const seedChapters = (): Ch[] => [
  { id: 1, title: 'One', slug: '01-one', duration: '0:00', uuid: 'u-1' },
  { id: 2, title: 'Two', slug: '02-two', duration: '0:00', uuid: 'u-2' },
];

const statePathOf = (dir: string) => join(dir, '.audiobook', 'state.json');

function writeState(chapters: Ch[]): void {
  writeFileSync(
    statePathOf(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

const readChapters = (dir = bookDir): Ch[] =>
  (JSON.parse(readFileSync(statePathOf(dir), 'utf8')) as { chapters: Ch[] }).chapters;

const putChapters = (chapters: unknown, extra: Record<string, unknown> = {}) =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .send({ slice: 'state', patch: { ...extra, chapters } });

const STAMP = {
  duration: '00:12:34',
  audioModelKey: 'qwen',
  audioEngines: { qwen: 2 },
  audioRenderedAt: '2026-10-23T10:00:00.000Z',
  audioQa: { score: 0.97, flags: [] },
};

const FAILURE = {
  generationState: 'failed',
  generationError: 'server reason',
  generationErrorCode: 'E_X',
  generationRemediation: 'do y',
};

const withOverlay = (chapters: Ch[], id: number, overlay: Record<string, unknown>): Ch[] =>
  chapters.map((c) => (c.id === id ? { ...c, ...overlay } : c));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-owned-fields-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

/* Re-created per case: the folder-moving case relocates the book. */
beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeState(seedChapters());
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('PUT /:bookId/state slice:state — server-owned chapter fields (#3683)', () => {
  it('A. a finalize stamp survives a stale client copy', async () => {
    const staleChapters = structuredClone(seedChapters());
    writeState(withOverlay(seedChapters(), 1, STAMP));

    const res = await putChapters(staleChapters);
    expect(res.status).toBe(204);

    const ch = readChapters();
    const c1 = ch.find((c) => c.id === 1)!;
    expect(c1.duration).toBe(STAMP.duration);
    expect(c1.audioModelKey).toBe(STAMP.audioModelKey);
    expect(c1.audioEngines).toEqual(STAMP.audioEngines);
    expect(c1.audioRenderedAt).toBe(STAMP.audioRenderedAt);
    expect(c1.audioQa).toEqual(STAMP.audioQa);
    expect(ch.map((c) => c.uuid)).toEqual(['u-1', 'u-2']);
  });

  it('B. a client set of a failure field does not overwrite the failure stamp', async () => {
    writeState(withOverlay(seedChapters(), 1, FAILURE));

    const res = await putChapters(
      withOverlay(seedChapters(), 1, { ...FAILURE, generationError: 'client reason' }),
    );
    expect(res.status).toBe(204);

    const c1 = readChapters().find((c) => c.id === 1)!;
    expect(c1.generationState).toBe('failed');
    expect(c1.generationError).toBe('server reason');
  });

  it('C. a stale copy without the failure keys keeps the failure stamp', async () => {
    const staleChapters = structuredClone(seedChapters());
    writeState(withOverlay(seedChapters(), 1, FAILURE));

    const res = await putChapters(staleChapters);
    expect(res.status).toBe(204);

    const c1 = readChapters().find((c) => c.id === 1)!;
    expect(c1.generationState).toBe('failed');
    expect(c1.generationError).toBe('server reason');
    expect(c1.generationErrorCode).toBe('E_X');
    expect(c1.generationRemediation).toBe('do y');
  });

  it('C2. an explicit null clears the failure fields; absent keys keep disk', async () => {
    writeState(withOverlay(seedChapters(), 1, FAILURE));
    const cleared = await putChapters(
      withOverlay(seedChapters(), 1, {
        generationState: null,
        generationError: null,
        generationErrorCode: null,
        generationRemediation: null,
      }),
    );
    expect(cleared.status).toBe(204);
    const c1 = readChapters().find((c) => c.id === 1)!;
    for (const key of Object.keys(FAILURE)) {
      expect(key in c1, `${key} should be dropped, not written`).toBe(false);
    }

    writeState(withOverlay(seedChapters(), 1, FAILURE));
    const mixed = await putChapters(withOverlay(seedChapters(), 1, { generationState: null }));
    expect(mixed.status).toBe(204);
    const m1 = readChapters().find((c) => c.id === 1)!;
    expect('generationState' in m1).toBe(false);
    expect(m1.generationError).toBe('server reason');
    expect(m1.generationErrorCode).toBe('E_X');
    expect(m1.generationRemediation).toBe('do y');
  });

  it('D. a client set of a server-owned field is ignored', async () => {
    const res = await putChapters(
      withOverlay(seedChapters(), 1, {
        audioModelKey: 'kokoro',
        audioQa: { score: 0.1 },
        duration: '09:99:99',
      }),
    );
    expect(res.status).toBe(204);

    const c1 = readChapters().find((c) => c.id === 1)!;
    expect('audioModelKey' in c1).toBe(false);
    expect('audioQa' in c1).toBe(false);
    expect(c1.uuid).toBe('u-1');
    expect(c1.duration).toBe('0:00');
  });

  it('E. client-owned edits still land alongside the carried stamp', async () => {
    const stale = structuredClone(seedChapters());
    writeState(withOverlay(seedChapters(), 1, STAMP));
    const incoming = stale.map((c) =>
      c.id === 2 ? { ...c, title: 'Two (edited)', excluded: true } : c,
    );

    const res = await putChapters(incoming);
    expect(res.status).toBe(204);

    const ch = readChapters();
    const c2 = ch.find((c) => c.id === 2)!;
    expect(c2.title).toBe('Two (edited)');
    expect(c2.excluded).toBe(true);
    expect(ch.find((c) => c.id === 1)!.duration).toBe(STAMP.duration);
  });

  it('F. the folder-moving path applies the same rule', async () => {
    const staleChapters = structuredClone(seedChapters());
    writeState(withOverlay(seedChapters(), 1, STAMP));
    const newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, 'Moved Owned Book');

    const res = await putChapters(staleChapters, { title: 'Moved Owned Book' });
    expect(res.status).toBe(204);

    const c1 = readChapters(newDir).find((c) => c.id === 1)!;
    expect(c1.duration).toBe(STAMP.duration);
    expect(c1.audioModelKey).toBe(STAMP.audioModelKey);
    expect(c1.audioEngines).toEqual(STAMP.audioEngines);
    expect(c1.audioRenderedAt).toBe(STAMP.audioRenderedAt);
    expect(c1.audioQa).toEqual(STAMP.audioQa);
  });

  it("G. a stale pre-reorder copy gets no other chapter's uuid or stamps", async () => {
    writeState([
      { id: 1, title: 'Two', slug: '01-two', uuid: 'u-2', duration: '00:20:00' },
      { id: 2, title: 'One', slug: '02-one', uuid: 'u-1', duration: '00:10:00' },
    ]);

    const res = await putChapters([
      { id: 1, title: 'One', slug: '01-one', uuid: 'u-1' },
      { id: 2, title: 'Two', slug: '02-two', uuid: 'u-2' },
    ]);
    expect(res.status).toBe(204);

    const ch = readChapters();
    const one = ch.find((c) => c.title === 'One')!;
    const two = ch.find((c) => c.title === 'Two')!;
    expect(one.duration).toBeUndefined();
    expect(two.duration).toBeUndefined();
    expect(one.uuid).not.toBe('u-2');
    expect(two.uuid).not.toBe('u-1');
    expect(new Set(ch.map((c) => c.uuid)).size).toBe(ch.length);
  });

  it('H. a stale pre-merge copy never duplicates a uuid or borrows a stamp', async () => {
    writeState([
      { id: 1, title: 'One', slug: '01-one', uuid: 'u-1' },
      { id: 2, title: 'Two', slug: '02-two', uuid: 'u-2' },
      { id: 3, title: 'Four', slug: '03-four', uuid: 'u-4', duration: '00:40:00' },
    ]);

    const res = await putChapters([
      { id: 1, title: 'One', slug: '01-one', uuid: 'u-1' },
      { id: 2, title: 'Two', slug: '02-two', uuid: 'u-2' },
      { id: 3, title: 'Three', slug: '03-three', uuid: 'u-3' },
      { id: 4, title: 'Four', slug: '04-four', uuid: 'u-4' },
    ]);
    expect(res.status).toBe(204);

    const ch = readChapters();
    expect(new Set(ch.map((c) => c.uuid)).size).toBe(ch.length);
    expect(ch.find((c) => c.title === 'Three')!.duration).toBeUndefined();
    expect(ch.find((c) => c.title === 'Four')!.duration).toBeUndefined();
    expect(ch.find((c) => c.title === 'Four')!.uuid).not.toBe('u-4');
    expect(ch.find((c) => c.title === 'Three')!.uuid).not.toBe('u-4');
  });
});
