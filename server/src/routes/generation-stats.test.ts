/* Route test for GET /api/generation/stats — the dev RTF pill's data source —
   plus GET /api/generation/telemetry (fs-20). The rolling-window maths are
   pinned in ../tts/generation-stats.test.ts and the telemetry store in
   ../tts/resource-telemetry.test.ts; this confirms both routes are mounted and
   serialise their accumulators.

   A temp WORKSPACE_DIR is set BEFORE the dynamic imports so the telemetry file
   resolves under it (paths.ts resolves WORKSPACE_ROOT at module load) and the
   test never touches the real workspace. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
let recordPassEval: typeof import('../analyzer/analyzer-eval-stats.js').recordPassEval;
let resetAnalyzerQueue: typeof import('../analyzer/analyzer-eval-stats.js').__resetAnalyzerEvalQueueForTest;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-genstats-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ generationStatsRouter }, statsMod, telemetryMod, analyzerMod] = await Promise.all([
    import('./generation-stats.js'),
    import('../tts/generation-stats.js'),
    import('../tts/resource-telemetry.js'),
    import('../analyzer/analyzer-eval-stats.js'),
  ]);
  resetStats = statsMod.__resetGenerationStatsForTest;
  recordChapterThroughput = statsMod.recordChapterThroughput;
  appendTelemetry = telemetryMod.appendTelemetry;
  telemetryFilePath = telemetryMod.telemetryFilePath;
  recordPassEval = analyzerMod.recordPassEval;
  resetAnalyzerQueue = analyzerMod.__resetAnalyzerEvalQueueForTest;

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

afterEach(() => {
  resetStats();
  resetAnalyzerQueue();
});

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
      rerecordRtf: null,
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
      rerecordRtf: null,
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
        rerecordRtf: null,
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

describe('GET /api/generation/analyzer-stats (analyzer eval-rate telemetry)', () => {
  it('returns an empty list when nothing is recorded', async () => {
    const res = await request(app).get('/api/generation/analyzer-stats');
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
  });

  it('returns recorded eval records newest-first', async () => {
    await recordPassEval(
      [
        {
          model: 'gemma2',
          evalCount: 100,
          evalDuration: 1e9,
          promptEvalCount: 50,
          promptEvalDuration: 0.5e9,
          loadDuration: 0.1e9,
        },
      ],
      {
        manuscriptId: 'ms-1',
        bookTitle: 'Book 1',
        stage: 'stage-1',
        chapterId: 1,
        chunkCount: 5,
        outcome: 'ok',
      },
    );
    await recordPassEval(
      [
        {
          model: 'gemma2',
          evalCount: 120,
          evalDuration: 1.2e9,
          promptEvalCount: 60,
          promptEvalDuration: 0.6e9,
          loadDuration: 0.1e9,
        },
      ],
      {
        manuscriptId: 'ms-1',
        bookTitle: 'Book 1',
        stage: 'stage-1',
        chapterId: 2,
        chunkCount: 6,
        outcome: 'ok',
      },
    );
    const res = await request(app).get('/api/generation/analyzer-stats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records).toHaveLength(2);
    expect(res.body.records[0].chapterId).toBe(2);
    expect(res.body.records[1].chapterId).toBe(1);
  });

  it('honours the limit query param', async () => {
    for (let i = 1; i <= 4; i++) {
      await recordPassEval(
        [
          {
            model: 'gemma2',
            evalCount: 100 * i,
            evalDuration: 1e9,
            promptEvalCount: 50 * i,
            promptEvalDuration: 0.5e9,
            loadDuration: 0.1e9,
          },
        ],
        {
          manuscriptId: 'ms-1',
          bookTitle: 'Book 1',
          stage: 'stage-1',
          chapterId: i,
          chunkCount: 5 + i,
          outcome: 'ok',
        },
      );
    }
    const res = await request(app).get('/api/generation/analyzer-stats?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.records.map((r: { chapterId: number }) => r.chapterId)).toEqual([4, 3]);
  });

  it('returns { records: [] } on a read error', async () => {
    // Spy on readAnalyzerEvalRecords and make it reject
    const analyzerMod = await import('../analyzer/analyzer-eval-stats.js');
    const spy = vi.spyOn(analyzerMod, 'readAnalyzerEvalRecords').mockRejectedValueOnce(
      new Error('Intentional read error'),
    );
    const res = await request(app).get('/api/generation/analyzer-stats');
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
    spy.mockRestore();
  });
});
