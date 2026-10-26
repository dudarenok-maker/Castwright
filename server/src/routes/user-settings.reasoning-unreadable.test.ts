/* #3084 wave 5 / #3625 — the offered-level judgement is skipped while the settings
   file is unreadable (the read returns cached or default settings, so judging against
   them would be wrong); writeUserSettings alone decides the outcome. Only the flag the
   route reads is mocked: the real write still succeeds here. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let unreadable = false;

vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  isUserSettingsFileUnreadable: () => unreadable,
}));

let workspaceRoot: string;
let app: Express;
let userSettingsPath: string;
let resetCache: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-user-settings-unreadable-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.GEMINI_API_KEY;

  const [{ userSettingsRouter }, settings] = await Promise.all([
    import('./user-settings.js'),
    import('../workspace/user-settings.js'),
  ]);
  userSettingsPath = settings.USER_SETTINGS_PATH;
  resetCache = settings._resetUserSettingsCache;

  app = express();
  app.use(express.json());
  app.use('/api/user/settings', userSettingsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  unreadable = false;
  if (userSettingsPath && existsSync(userSettingsPath)) rmSync(userSettingsPath, { force: true });
  resetCache();
});

describe('PUT /api/user/settings — reasoning judgement and an unreadable settings file (#3625)', () => {
  /* gemini-3.8-flash does not offer `minimal`. */
  const body = { analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } };

  it('judges the level when the file is readable (control)', async () => {
    unreadable = false;
    const res = await request(app).put('/api/user/settings').send(body);
    expect(res.status).toBe(400);
  });

  it('skips the judgement when the file is unreadable and lets the write decide', async () => {
    unreadable = true;
    const res = await request(app).put('/api/user/settings').send(body);
    expect(res.status).toBe(200);
  });
});
