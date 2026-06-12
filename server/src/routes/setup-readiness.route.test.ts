import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import express from 'express';

/* vi.mock is hoisted above imports, so these stubs are active even though
   setup-readiness.ts is statically imported below via setupReadinessRouter. */
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: vi.fn(() => ({
      synthesize: vi.fn().mockResolvedValue({
        pcm: Buffer.alloc(24_000 * 2 * 0.3, 0),
        sampleRate: 24_000,
        mimeType: 'audio/L16',
      }),
    })),
  };
});

vi.mock('../tts/mp3.js', () => ({
  encodePcmToAudio: vi.fn().mockResolvedValue(Buffer.from([0xff])),
}));

import { setupReadinessRouter } from './setup-readiness.js';

let audioDir: string;

beforeAll(() => {
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-smoke-test-'));
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
});

afterAll(() => {
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

describe('GET /api/setup/readiness route (integration — live probe)', () => {
  it('returns 200 with the readiness shape even when the sidecar is down', async () => {
    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).get('/api/setup/readiness');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ready');
    expect(res.body).toHaveProperty('blockers.sidecar');
    expect(res.body).toHaveProperty('info.gpu');
  });
});

describe('POST /api/setup/complete route', () => {
  it('POST /complete stamps setupCompletedAt and returns it', async () => {
    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).post('/api/setup/complete');
    expect(res.status).toBe(200);
    expect(typeof res.body.completedAt).toBe('string');
    expect(new Date(res.body.completedAt).toISOString()).toBe(res.body.completedAt);
  });
});

describe('POST /api/setup/smoke', () => {
  it('returns 200 { ok: true, url: string, analyzerOk: boolean } when synth succeeds', async () => {
    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).post('/api/setup/smoke');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.url).toBe('string');
    expect(typeof res.body.analyzerOk).toBe('boolean');
  });

  it('returns 200 { ok: false, stage: "synth", error: string } when synth rejects — never 500', async () => {
    const { selectTtsProvider } = await import('../tts/index.js');
    const mockProvider = {
      synthesize: vi.fn().mockRejectedValue(new Error('sidecar down')),
    };
    vi.mocked(selectTtsProvider).mockReturnValueOnce(mockProvider as never);

    const app = express();
    app.use('/api/setup', setupReadinessRouter);
    const res = await request(app).post('/api/setup/smoke');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.stage).toBe('synth');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toContain('sidecar down');
  });
});
