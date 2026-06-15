import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../workspace/user-settings.js', () => ({
  writeConfigOverride: vi.fn(async () => {}),
  clearConfigOverride: vi.fn(async () => {}),
}));
vi.mock('./generation.js', () => ({ activeGenerationBooks: vi.fn(() => []) }));
vi.mock('../tts/design-lock.js', () => ({
  isAnyDesignBusy: vi.fn(() => false),
  isAnyAnalysisBusy: vi.fn(() => false),
}));

import { acceleratorProfileRouter } from './accelerator-profile.js';
import * as us from '../workspace/user-settings.js';
import * as gen from './generation.js';
import * as lock from '../tts/design-lock.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accelerator', acceleratorProfileRouter);
  return app;
}

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('POST /api/accelerator/profile (AMD phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock(gen.activeGenerationBooks).mockReturnValue([]);
    mock(lock.isAnyDesignBusy).mockReturnValue(false);
    mock(lock.isAnyAnalysisBusy).mockReturnValue(false);
  });

  it('rejects an unknown profile (400)', async () => {
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'banana' });
    expect(res.status).toBe(400);
    expect(us.writeConfigOverride).not.toHaveBeenCalled();
  });

  it('persists an explicit profile + reports rebuildRequired when idle', async () => {
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'amd' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, profile: 'amd', rebuildRequired: true });
    expect(us.writeConfigOverride).toHaveBeenCalledWith('tts.accelerator', 'amd');
  });

  it("'auto' clears the override (hardware detection drives the next build)", async () => {
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'auto' });
    expect(res.status).toBe(200);
    expect(us.clearConfigOverride).toHaveBeenCalledWith('tts.accelerator');
    expect(us.writeConfigOverride).not.toHaveBeenCalled();
  });

  it('refuses (409) while a generation job is in flight + names the busy books', async () => {
    mock(gen.activeGenerationBooks).mockReturnValue(['book-1']);
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'amd' });
    expect(res.status).toBe(409);
    expect(res.body.busyBooks).toEqual(['book-1']);
    expect(us.writeConfigOverride).not.toHaveBeenCalled();
  });

  it('refuses (409) while a voice-design job is busy', async () => {
    mock(lock.isAnyDesignBusy).mockReturnValue(true);
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'cpu' });
    expect(res.status).toBe(409);
    expect(us.writeConfigOverride).not.toHaveBeenCalled();
  });

  it('refuses (409) while an analysis job is busy', async () => {
    mock(lock.isAnyAnalysisBusy).mockReturnValue(true);
    const res = await request(makeApp()).post('/api/accelerator/profile').send({ profile: 'nvidia' });
    expect(res.status).toBe(409);
  });
});
