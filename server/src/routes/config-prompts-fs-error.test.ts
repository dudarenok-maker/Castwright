/* #4236 -- the /prompts/:id endpoints answered `(err as Error).message`. They read and write
   ~/.castwright/prompts/<id>.md, so a node fs error's message names the account's home directory.
   Each answers the curated sentence instead; an ordinary error keeps its own message. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const HOME_PATH = 'C:\\Users\\someone\\.castwright\\prompts\\prompt.castDetection.md';
const seam = vi.hoisted(() => ({ err: null as unknown }));

vi.mock('../config/prompts.js', async (orig) => ({
  ...(await orig<typeof import('../config/prompts.js')>()),
  readPrompt: vi.fn(async () => {
    throw seam.err;
  }),
  writeForkedPrompt: vi.fn(async () => {
    throw seam.err;
  }),
  resetPrompt: vi.fn(async () => {
    throw seam.err;
  }),
}));

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-config-prompts-fs-test-'));
  process.env.USER_SETTINGS_FILE = join(workspaceRoot, 'user-settings.json');
  const { configRouter } = await import('./config.js');
  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.USER_SETTINGS_FILE;
});

const fsErr = () =>
  Object.assign(new Error(`EACCES: permission denied, open '${HOME_PATH}'`), {
    code: 'EACCES',
    syscall: 'open',
    path: HOME_PATH,
  });

const CALLS: Array<[string, (a: Express) => request.Test]> = [
  ['GET', (a) => request(a).get('/api/config/prompts/prompt.castDetection')],
  ['PUT', (a) => request(a).put('/api/config/prompts/prompt.castDetection').send({ text: 'x' })],
  ['POST reset', (a) => request(a).post('/api/config/prompts/prompt.castDetection/reset')],
];

describe('/api/config/prompts/:id error bodies are path-free (#4236)', () => {
  for (const [name, call] of CALLS) {
    it(`${name}: an fs error answers the curated sentence, never the home path`, async () => {
      seam.err = fsErr();
      const res = await call(app);
      expect(res.status).toBe(500);
      expect(res.body.error).not.toContain('someone');
      expect(res.body.error).toBe('Files could not be read or written. Check free disk space and folder permissions.');
    });

    it(`${name}: an ordinary error keeps its own message`, async () => {
      seam.err = new Error('ordinary prompt failure');
      const res = await call(app);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('ordinary prompt failure');
    });
  }
});
