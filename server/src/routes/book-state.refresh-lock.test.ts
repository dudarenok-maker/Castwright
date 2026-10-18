/* #3625 child 8 — GET /:bookId/state's chapter-title refresh waits on the
   per-book state lock (the REAL lock) and derives its write from a read taken
   INSIDE it. Separate from book-state.state-lock.test.ts: see the note there. */

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

describe('GET /:bookId/state — title refresh waits on the state lock', () => {
  const stale = (): Ch[] => [
    { id: 1, title: 'Chapter 1', slug: '01-chapter-1', uuid: 'u-1' },
    { id: 2, title: 'Chapter 2', slug: '02-chapter-2', uuid: 'u-2' },
  ];

  it('does not write while the lock is held, then the refresh lands', async () => {
    writeState(stale(), 1);
    const before = readFileSync(statePath, 'utf8');
    const { release, held } = await holdLock();
    const p = sendGet();
    await settle();
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    release();
    const [res] = await Promise.all([p, held]);
    expect(res.status).toBe(200);
    expect(readState().chapters.map((c: Ch) => c.title)).toEqual([
      'Chapter 1 — The Beginning',
      'Chapter 2 — A Manifest',
    ]);
  });

  it('derives the write from the fresh read: a change made while waiting is not reverted', async () => {
    writeState(stale(), 1);
    const { release, held } = await holdLock();
    const p = sendGet();
    await settle();
    mutateOnDisk((s) => {
      s.chapters[0].duration = 123;
    });
    release();
    const [res] = await Promise.all([p, held]);
    const onDisk = readState();
    expect(onDisk.chapters[0].duration).toBe(123);
    expect(onDisk.chapters[0].title).toBe('Chapter 1 — The Beginning');
    expect(res.body.state.chapters[0].duration).toBe(123);
  });

  it('returns the fresh state without writing when another writer already refreshed it', async () => {
    writeState(stale(), 1);
    const { release, held } = await holdLock();
    const p = sendGet();
    await settle();
    writeState(
      [
        { id: 1, title: 'Winner 1', slug: '01-chapter-1', uuid: 'u-1' },
        { id: 2, title: 'Winner 2', slug: '02-chapter-2', uuid: 'u-2' },
      ],
      CHAPTER_TITLE_PARSER_VERSION,
    );
    const snapshot = readFileSync(statePath, 'utf8');
    release();
    const [res] = await Promise.all([p, held]);
    expect(readFileSync(statePath, 'utf8')).toBe(snapshot);
    expect(res.body.state.chapters.map((c: Ch) => c.title)).toEqual(['Winner 1', 'Winner 2']);
  });
});
