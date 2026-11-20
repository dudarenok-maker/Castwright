/* `GET /:bookId/state` derives `completedSlugs` from the live-take finder
   (`chapterAudioExists`): a chapter is done only when its LIVE take exists,
   in any format the book can write. Pins #4166: `.ogg` (Opus) counts, a lone
   `<slug>.previous.mp3` does not, and a short slug never matches a longer
   slug's file. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Completed Slugs Test';
const SERIES = 'Standalones';
const TITLE = 'Completed Slugs Book';
const MANUSCRIPT_ID = 'm_completed_slugs_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

function writeState(slugs: string[]): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
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
      chapters: slugs.map((slug, i) => ({ id: i + 1, title: `Chapter ${i + 1}`, slug })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function touchAudio(...names: string[]): void {
  const dir = join(bookDir, 'audio');
  mkdirSync(dir, { recursive: true });
  for (const n of names) writeFileSync(join(dir, n), 'x');
}

async function getCompleted(): Promise<string[]> {
  const res = await request(app).get(`/api/books/${bookId}/state`);
  expect(res.status).toBe(200);
  return res.body.completedSlugs;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-completed-slugs-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# Chapter One\n\nFirst sentence.\n');

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  const audio = join(bookDir, 'audio');
  if (existsSync(audio)) rmSync(audio, { recursive: true, force: true });
});

describe('GET /:bookId/state completedSlugs', () => {
  it('D1: counts a live .mp3 take', async () => {
    writeState(['01-a']);
    touchAudio('01-a.mp3');
    expect(await getCompleted()).toEqual(['01-a']);
  });

  it('D2: counts a live .m4a take', async () => {
    writeState(['01-a']);
    touchAudio('01-a.m4a');
    expect(await getCompleted()).toEqual(['01-a']);
  });

  it('D3: counts a live .ogg (Opus) take', async () => {
    writeState(['01-a']);
    touchAudio('01-a.ogg');
    expect(await getCompleted()).toEqual(['01-a']);
  });

  it('D4: a lone preserved .previous.mp3 is not done', async () => {
    writeState(['01-a']);
    touchAudio('01-a.previous.mp3', '01-a.previous.segments.json');
    expect(await getCompleted()).toEqual([]);
  });

  it('D5: live take plus preserved take is done', async () => {
    writeState(['01-a']);
    touchAudio('01-a.mp3', '01-a.previous.mp3');
    expect(await getCompleted()).toEqual(['01-a']);
  });

  it('R2: a lone .next-x.mp3 does not count (#4331)', async () => {
    writeState(['01-a']);
    touchAudio('01-a.next-x.mp3');
    expect(await getCompleted()).toEqual([]);
  });

  it('D6: a short slug does not match a longer slug file', async () => {
    writeState(['ch-1', 'ch-10']);
    touchAudio('ch-10.mp3');
    expect(await getCompleted()).toEqual(['ch-10']);
  });

  it('D7: no audio folder yields an empty list', async () => {
    writeState(['01-a']);
    expect(await getCompleted()).toEqual([]);
  });

  it('D8: mixed formats keep state.chapters order', async () => {
    writeState(['01-a', '02-b', '03-c']);
    touchAudio('01-a.mp3', '02-b.previous.mp3', '03-c.ogg');
    expect(await getCompleted()).toEqual(['01-a', '03-c']);
  });
});
