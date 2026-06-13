import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { tourRouter } from './tour.js';
import * as settings from '../workspace/user-settings.js';

function app() {
  const a = express();
  a.use('/api/tour', tourRouter);
  return a;
}

describe('/api/tour', () => {
  beforeEach(async () => {
    rmSync(settings.USER_SETTINGS_PATH, { force: true });
    settings._resetUserSettingsCache();
    await settings.readUserSettings();
  });

  it('GET /status returns { completedAt: null } before completion', async () => {
    const res = await request(app()).get('/api/tour/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completedAt: null });
  });

  it('POST /complete stamps an ISO timestamp and GET reflects it', async () => {
    const post = await request(app()).post('/api/tour/complete');
    expect(post.status).toBe(200);
    expect(typeof post.body.completedAt).toBe('string');
    expect(new Date(post.body.completedAt).toISOString()).toBe(post.body.completedAt);

    const get = await request(app()).get('/api/tour/status');
    expect(get.body.completedAt).toBe(post.body.completedAt);
  });
});
