/* Route test for GET /api/generation/stats — the dev RTF pill's data source.
   The rolling-window maths are pinned in ../tts/generation-stats.test.ts; this
   just confirms the route is mounted and serialises the accumulator. */

import { afterEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { generationStatsRouter } from './generation-stats.js';
import {
  __resetGenerationStatsForTest,
  recordChapterThroughput,
} from '../tts/generation-stats.js';

const app: Express = express();
app.use('/api/generation', generationStatsRouter);

afterEach(() => __resetGenerationStatsForTest());

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
});
