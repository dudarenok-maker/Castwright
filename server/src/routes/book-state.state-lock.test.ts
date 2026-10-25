/* #3625 child 8 — the book-state.ts state.json read-modify-writes wait on the
   per-book state lock (the REAL lock, never a mock) and derive their write from
   a read taken INSIDE it:

   - GET /:bookId/state's chapter-uuid lazy migration;
   - POST /:bookId/chapters/:chapterId/exclude;
   - POST /:bookId/chapters/:chapterId/held.

   (The chapter-title refresh is in book-state.refresh-lock.test.ts: it parses
   a manuscript, and parsing in this file's worker crashed it on Windows.)

   Each site gets a "waits on the lock" case (state.json unchanged while the
   test holds the lock, written after release) and a stale-snapshot case (a
   change made to state.json while the request waits survives the write). */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'State Lock';
const SERIES = 'Standalones';
const TITLE = 'State Lock Book';

const MANUSCRIPT_BODY = [
  'Chapter 1',
  'The Beginning',
  '',
  'First body line.',
  '',
  'Chapter 2',
  'A Manifest',
  '',
  'Second body line.',
  '',
].join('\n');

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-state-lock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  statePath = join(bookDir, '.audiobook', 'state.json');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
});

type Ch = { id: number; title: string; slug: string; uuid?: string; [k: string]: unknown };

function writeState(chapters: Ch[], parserVersion?: number): void {
  const state: Record<string, unknown> = {
    bookId,
    manuscriptId: 'm_state_lock',
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.md',
    castConfirmed: true,
    chapters,
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (parserVersion !== undefined) state.chapterTitleParserVersion = parserVersion;
  writeFileSync(statePath, JSON.stringify(state));
}

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/* Locks a failing assertion left held; released in afterEach so one red case
   cannot starve the next one's holdLock into a lock timeout. */
const openHolds: Array<() => void> = [];
afterEach(() => {
  while (openHolds.length) openHolds.pop()!();
});

async function holdLock(): Promise<{ release: () => void; held: Promise<void> }> {
  const { withStateJsonLock } = await import('../workspace/file-lock.js');
  const { stateJsonPath: stateJsonPathForLock } = await import('../workspace/paths.js');
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const got = new Promise<void>((r) => (acquired = r));
  const held = withStateJsonLock(stateJsonPathForLock(bookDir), async () => {
    acquired();
    await gate;
  });
  await got;
  openHolds.push(release);
  return { release, held };
}

/* Mutate state.json on disk while a request is parked behind the lock. */
function mutateOnDisk(fn: (s: { chapters: Ch[] }) => void): void {
  const cur = readState();
  fn(cur);
  writeFileSync(statePath, JSON.stringify(cur));
}

const sendGet = () => request(app).get(`/api/books/${bookId}/state`).then((r) => r);
const sendToggle = (kind: 'exclude' | 'held', chapterId: number) =>
  request(app)
    .post(`/api/books/${bookId}/chapters/${chapterId}/${kind}`)
    .send(kind === 'exclude' ? { excluded: true } : { held: true })
    .then((r) => r);

const plain = (withUuids: boolean): Ch[] => [
  { id: 1, title: 'Dedication', slug: '01-dedication', ...(withUuids ? { uuid: 'u-1' } : {}) },
  { id: 2, title: 'Chapter One', slug: '02-chapter-one', ...(withUuids ? { uuid: 'u-2' } : {}) },
];

describe('GET /:bookId/state — chapter-uuid migration waits on the state lock', () => {
  it('does not write while the lock is held, then the migration lands', async () => {
    writeState(plain(false), CHAPTER_TITLE_PARSER_VERSION);
    const before = readFileSync(statePath, 'utf8');
    const { release, held } = await holdLock();
    const p = sendGet();
    await settle();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    release();
    const [res] = await Promise.all([p, held]);
    expect(res.status).toBe(200);
    const onDisk = readState();
    expect(onDisk.chapters.every((c: Ch) => !!c.uuid)).toBe(true);
    expect(res.body.state.chapters.map((c: Ch) => c.uuid)).toEqual(
      onDisk.chapters.map((c: Ch) => c.uuid),
    );
  });

  it('derives the write from the fresh read, not the snapshot', async () => {
    writeState(plain(false), CHAPTER_TITLE_PARSER_VERSION);
    const { release, held } = await holdLock();
    const p = sendGet();
    await settle();
    mutateOnDisk((s) => {
      s.chapters[0].title = 'Renamed While Locked';
    });
    release();
    await Promise.all([p, held]);
    const onDisk = readState();
    expect(onDisk.chapters[0].title).toBe('Renamed While Locked');
    expect(onDisk.chapters.every((c: Ch) => !!c.uuid)).toBe(true);
  });
});

for (const kind of ['exclude', 'held'] as const) {
  const flag = kind === 'exclude' ? 'excluded' : 'held';
  describe(`POST /chapters/:chapterId/${kind} waits on the state lock`, () => {
    it('does not write while the lock is held, then lands', async () => {
      writeState(plain(true), CHAPTER_TITLE_PARSER_VERSION);
      const before = readFileSync(statePath, 'utf8');
      const { release, held } = await holdLock();
      const p = sendToggle(kind, 1);
      await settle();
      expect(readFileSync(statePath, 'utf8')).toBe(before);
      release();
      const [res] = await Promise.all([p, held]);
      expect(res.status).toBe(200);
      expect(readState().chapters[0][flag]).toBe(true);
    });

    it('toggles against the fresh read, not the snapshot', async () => {
      writeState(plain(true), CHAPTER_TITLE_PARSER_VERSION);
      const { release, held } = await holdLock();
      const p = sendToggle(kind, 1);
      await settle();
      mutateOnDisk((s) => {
        s.chapters[1].title = 'Renamed While Locked';
      });
      release();
      await Promise.all([p, held]);
      const onDisk = readState();
      expect(onDisk.chapters[1].title).toBe('Renamed While Locked');
      expect(onDisk.chapters[0][flag]).toBe(true);
    });

    it('404s when the chapter vanished while the request waited on the lock', async () => {
      writeState(plain(true), CHAPTER_TITLE_PARSER_VERSION);
      const { release, held } = await holdLock();
      const p = sendToggle(kind, 2);
      await settle();
      mutateOnDisk((s) => {
        s.chapters = s.chapters.filter((c) => c.id !== 2);
      });
      release();
      const [res] = await Promise.all([p, held]);
      expect(res.status).toBe(404);
    });
  });
}

const sendPutState = (patch: Record<string, unknown>) =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch })
    .then((r) => r);

describe('PUT /:bookId/state (slice state) waits on the state lock', () => {
  it('does not write while the lock is held, then the patch lands', async () => {
    writeState(plain(true), CHAPTER_TITLE_PARSER_VERSION);
    const before = readFileSync(statePath, 'utf8');
    const { release, held } = await holdLock();
    const p = sendPutState({ notes: 'locked note' });
    await settle();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    release();
    const [res] = await Promise.all([p, held]);
    expect(res.status).toBe(200);
    expect(readState().notes).toBe('locked note');
  });

  it('builds the next document from the fresh read, not the snapshot', async () => {
    writeState(plain(true), CHAPTER_TITLE_PARSER_VERSION);
    const { release, held } = await holdLock();
    const p = sendPutState({ notes: 'stale-safe' });
    await settle();
    /* A concurrent finalize stamps chapter 1 while the PUT waits. */
    mutateOnDisk((s) => {
      s.chapters[0].audioRenderedAt = '2026-10-16T00:00:00.000Z';
    });
    release();
    await Promise.all([p, held]);
    const onDisk = readState();
    expect(onDisk.notes).toBe('stale-safe');
    expect(onDisk.chapters[0].audioRenderedAt).toBe('2026-10-16T00:00:00.000Z');
  });
});
