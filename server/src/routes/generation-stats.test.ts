/* Route test for GET /api/generation/stats — the dev RTF pill's data source —
   plus GET /api/generation/telemetry (fs-20). The rolling-window maths are
   pinned in ../tts/generation-stats.test.ts and the telemetry store in
   ../tts/resource-telemetry.test.ts; this confirms both routes are mounted and
   serialise their accumulators.

   A temp WORKSPACE_DIR is set BEFORE the dynamic imports so the telemetry file
   resolves under it (paths.ts resolves WORKSPACE_ROOT at module load) and the
   test never touches the real workspace. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let app: Express;
let workspaceRoot: string;
let resetStats: () => void;
let appendTelemetry: typeof import('../tts/resource-telemetry.js').appendTelemetry;
let telemetryFilePath: typeof import('../tts/resource-telemetry.js').telemetryFilePath;
let recordChapterThroughput: typeof import('../tts/generation-stats.js').recordChapterThroughput;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-genstats-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ generationStatsRouter }, statsMod, telemetryMod] = await Promise.all([
    import('./generation-stats.js'),
    import('../tts/generation-stats.js'),
    import('../tts/resource-telemetry.js'),
  ]);
  resetStats = statsMod.__resetGenerationStatsForTest;
  recordChapterThroughput = statsMod.recordChapterThroughput;
  appendTelemetry = telemetryMod.appendTelemetry;
  telemetryFilePath = telemetryMod.telemetryFilePath;

  app = express();
  app.use('/api/generation', generationStatsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  const p = telemetryFilePath();
  if (existsSync(p)) rmSync(p, { force: true });
});

afterEach(() => resetStats());

describe('GET /api/generation/stats', () => {
  it('returns the idle shape when nothing has generated', async () => {
    const res = await request(app).get('/api/generation/stats');
    expect(res.status).toBe(200);
    expect(res.body.chapters).toBe(0);
    expect(res.body.rtf).toBeNull();
    expect(res.body.updatedAt).toBeNull();
  });

  it('reflects a recorded chapter', async () => {
    // 120 s audio in 60 s wall → rtf 0.5.
    recordChapterThroughput({ chapterId: 3, audioSec: 120, synthMs: 60_000 });
    const res = await request(app).get('/api/generation/stats');
    expect(res.status).toBe(200);
    expect(res.body.chapters).toBe(1);
    expect(res.body.rtf).toBeCloseTo(0.5, 5);
    expect(res.body.last.chapterId).toBe(3);
  });

  it('serialises the per-chapter history with title/book/engine', async () => {
    recordChapterThroughput({
      chapterId: 5,
      audioSec: 120,
      synthMs: 60_000,
      title: 'Chapter 5',
      bookId: 'book-a',
      modelKey: 'qwen3-tts',
    });
    const res = await request(app).get('/api/generation/stats');
    expect(res.status).toBe(200);
    expect(res.body.recentChapters).toHaveLength(1);
    expect(res.body.recentChapters[0]).toMatchObject({
      chapterId: 5,
      title: 'Chapter 5',
      bookId: 'book-a',
      modelKey: 'qwen3-tts',
      rtf: 0.5,
    });
  });
});

describe('GET /api/generation/telemetry (fs-20)', () => {
  it('returns an empty list when nothing is recorded', async () => {
    const res = await request(app).get('/api/generation/telemetry');
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });

  it('returns appended records newest-first', async () => {
    await appendTelemetry({
      at: new Date().toISOString(),
      bookId: 'book-a',
      bookTitle: 'Book A',
      chapterId: 1,
      title: 'Chapter 1',
      modelKey: 'qwen3-tts-0.6b',
      rtf: 1.2,
      audioSec: 600,
      wallSec: 720,
      vramReservedMb: 3200,
      vramTotalMb: 8192,
      committedHostMb: 4096,
    });
    await appendTelemetry({
      at: new Date().toISOString(),
      bookId: 'book-a',
      bookTitle: 'Book A',
      chapterId: 2,
      title: 'Chapter 2',
      modelKey: 'qwen3-tts-0.6b',
      rtf: 1.4,
      audioSec: 600,
      wallSec: 840,
      vramReservedMb: 3400,
      vramTotalMb: 8192,
      committedHostMb: 4300,
    });
    const res = await request(app).get('/api/generation/telemetry');
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { chapterId: number }) => r.chapterId)).toEqual([2, 1]);
    expect(res.body.records[0].vramReservedMb).toBe(3400);
  });

  it('honours the limit query param', async () => {
    for (let i = 1; i <= 4; i++) {
      await appendTelemetry({
        at: new Date().toISOString(),
        bookId: 'book-a',
        bookTitle: 'Book A',
        chapterId: i,
        title: `Chapter ${i}`,
        modelKey: 'qwen3-tts-0.6b',
        rtf: 1,
        audioSec: 600,
        wallSec: 600,
        vramReservedMb: 3000,
        vramTotalMb: 8192,
        committedHostMb: 4000,
      });
    }
    const res = await request(app).get('/api/generation/telemetry?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { chapterId: number }) => r.chapterId)).toEqual([4, 3]);
  });
});
