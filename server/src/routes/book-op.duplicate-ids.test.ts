/* #3711 PR #3714 review pass 1 -- a bookId carried by TWO folders (a legacy
   duplicate; creators can no longer mint one) keeps today's first-match
   behaviour everywhere it is resolved BY ID, and every per-folder walk still
   reaches BOTH twins.

     - 🔴 a sweep (`withBookOpAtDir`) or a walker locks each walked folder with
       that folder as the resolve hint. A hint-accepted resolve used to write the
       in-memory index, so after the startup sweeps the index named the LAST twin:
       a PUT then wrote the twin the GET (first match) does not show.
     - 🟠 the walkers deduped by bookId, so the second twin never got the write
       (a deleted library voice stayed referenced there). They dedupe by the
       RESOLVED folder now. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const BOOK_ID = 'dup__s__twin';

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let fsck: typeof import('../workspace/fsck-orphan-audio.js');
let changelogMigrate: typeof import('../workspace/changelog-migrate.js');
let usage: typeof import('../workspace/voice-library-usage.js');
let scan: typeof import('../workspace/scan.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-dup-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { voicesRouter } = await import('./voices.js');
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  fsck = await import('../workspace/fsck-orphan-audio.js');
  changelogMigrate = await import('../workspace/changelog-migrate.js');
  usage = await import('../workspace/voice-library-usage.js');
  scan = await import('../workspace/scan.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/voices', voicesRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
});

/** Seed `Dup/S/<title>` carrying the shared BOOK_ID. */
function seedTwin(title: string, cast: object[]): string {
  const bookDir = join(paths.BOOKS_ROOT, 'Dup', 'S', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), 'Opening prose here.\n');
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId: BOOK_ID,
      manuscriptId: `m_dup_${title}`,
      title,
      author: 'Dup',
      series: 'S',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: 'en',
    }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: cast }));
  return bookDir;
}

const readState = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')) as Record<string, unknown>;
const readCast = (dir: string): { characters: Array<Record<string, unknown>> } =>
  JSON.parse(readFileSync(paths.castJsonPath(dir), 'utf8')) as { characters: Array<Record<string, unknown>> };

function seedTwins(cast: object[] = [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }]) {
  return { twin1: seedTwin('Twin1', cast), twin2: seedTwin('Twin2', cast) };
}

describe('a duplicated bookId resolves to the first match everywhere it is resolved by id', () => {
  it('after the startup sweeps, a PUT writes the twin the GET shows', async () => {
    const { twin1, twin2 } = seedTwins();
    /* Positive control: the unlocked first-match lookup is Twin1. */
    expect((await scan.findBookByBookId(BOOK_ID))?.bookDir).toBe(twin1);

    await changelogMigrate.migrateLegacyChangeLogs();
    await fsck.fsckAllBooks();

    const put = await request(app)
      .put(`/api/books/${BOOK_ID}/state`)
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(put.status).toBe(200);

    expect(readState(twin1).castConfirmed).toBe(true);
    expect(readState(twin2).castConfirmed).toBe(false);
    const get = await request(app).get(`/api/books/${BOOK_ID}/state`);
    expect(get.status).toBe(200);
    expect(get.body.state.castConfirmed).toBe(true);
  });

  it('peekBook and withBookOp agree with findBookByBookId after a hint-locked step on the second twin', async () => {
    const { twin1, twin2 } = seedTwins();
    /* withBookOpAtDir still runs on the walked folder itself... */
    const ran = await bookOp.withBookOpAtDir(twin2, async (dir) => dir);
    expect(ran).toBe(twin2);
    /* ...but leaves no trace on resolve-by-id. */
    expect((await bookOp.peekBook(BOOK_ID))?.bookDir).toBe(twin1);
    expect(await bookOp.withBookOp(BOOK_ID, async (b) => b.bookDir)).toBe(twin1);
    expect((await scan.findBookByBookId(BOOK_ID))?.bookDir).toBe(twin1);
  });
});

describe('the multi-book walkers write BOTH twins of a duplicated bookId', () => {
  it('clearLibraryVoiceReferences clears the reference in every twin', async () => {
    const { twin1, twin2 } = seedTwins([
      {
        id: 'alice',
        name: 'Alice',
        role: 'lead',
        color: 'narrator',
        overrideTtsVoices: { qwen: { name: 'Lib', libraryUuid: 'lv-1' } },
      },
    ]);
    for (const dir of [twin1, twin2]) {
      writeFileSync(paths.stateJsonPath(dir), JSON.stringify({ ...readState(dir), castConfirmed: true }));
    }

    await usage.clearLibraryVoiceReferences('lv-1');

    expect(readCast(twin1).characters[0].overrideTtsVoices).toEqual({});
    expect(readCast(twin2).characters[0].overrideTtsVoices).toEqual({});
  });

  it('PUT /api/voices/:voiceId/override (workspace scope) writes every twin', async () => {
    const { twin1, twin2 } = seedTwins([{ id: 'alice', name: 'Alice', role: 'lead', color: 'narrator' }]);
    for (const dir of [twin1, twin2]) {
      writeFileSync(paths.stateJsonPath(dir), JSON.stringify({ ...readState(dir), castConfirmed: true }));
    }

    const res = await request(app)
      .put('/api/voices/alice/override')
      .send({ override: { engine: 'kokoro', name: 'af_heart' } });
    expect(res.status).toBe(204);

    expect(readCast(twin1).characters[0].overrideTtsVoices).toEqual({ kokoro: { name: 'af_heart' } });
    expect(readCast(twin2).characters[0].overrideTtsVoices).toEqual({ kokoro: { name: 'af_heart' } });
  });
});
