/* #3084 P23 — PUT /api/config refuses an endpoint model id for the phase-model
   knobs until PR 3d. Real express + supertest over a temp workspace, the same
   harness shape as routes/user-settings.test.ts. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let settings: typeof import('../workspace/user-settings.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-config-endpoint-ids-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  delete process.env.ANALYZER_PHASE0_MODEL;
  delete process.env.ANALYZER_PHASE1_MODEL;
  const [{ configRouter }, s] = await Promise.all([import('./config.js'), import('../workspace/user-settings.js')]);
  settings = s;
  settings._resetUserSettingsCache();
  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  settings._resetUserSettingsCache();
});

describe('PUT /api/config — phase-model and ollama-model overrides (#3084 P23)', () => {
  it.each(['analyzer.phase0.model', 'analyzer.phase1.model', 'analyzer.ollama.model'])(
    /* #3084 A3/A4 (re-pin to 80be2f1d) — analyzer.ollama.model is a THIRD
       refused knob now: A3 makes it Advanced-editable and read at runtime
       (getResolvedOllamaModel), so a saved endpoint id there would reach an
       Ollama probe exactly like a phase knob would. */
    'refuses an endpoint model id for %s and writes nothing',
    async (key) => {
      const res = await request(app).put('/api/config').send({ [key]: 'openai:lab::qwen3:30b' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`${key}: OpenAI-compatible endpoint models cannot be selected in this build.`);
      expect((await settings.readUserSettings()).configOverrides[key]).toBeUndefined();
    },
  );

  it('still saves an Ollama tag that starts with openai:', async () => {
    const res = await request(app).put('/api/config').send({ 'analyzer.phase0.model': 'openai:latest' });
    expect(res.status).toBe(200);
    expect(res.body.applied).toEqual(['analyzer.phase0.model']);
  });
});
