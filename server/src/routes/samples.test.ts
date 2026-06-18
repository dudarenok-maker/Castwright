import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = resolve(__dirname, '..', '..', '..', 'samples');
const SLUG = 'the-coalfall-commission';
const bundleReady = () => existsSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'cast.json'));

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-samples-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { samplesRouter } = await import('./samples.js');
  app = express();
  app.use(express.json());
  app.use('/api/samples', samplesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('samples router', () => {
  it('404s for an unknown sample slug', async () => {
    const res = await request(app).post(`/api/samples/not-a-real-sample/load`);
    expect(res.status).toBe(404);
  });

  it('rejects a traversal slug with 400 before the existsSync precheck', async () => {
    const res = await request(app).post('/api/samples/..%2f..%2fevil/load');
    expect(res.status).toBe(400);
  });

  it('loads the bundled sample into the workspace with voices merged', async () => {
    if (!bundleReady()) {
      console.warn(`[samples.test] bundle ${SLUG} not captured yet — skipping load assertion.`);
      return;
    }
    const res = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(res.status).toBe(200);
    expect(res.body.bookId).toBeTruthy();

    const dir = join(workspaceRoot, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
    expect(existsSync(join(dir, '.audiobook', 'cast.json'))).toBe(true);

    const cast = JSON.parse(readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8'));
    const firstQwen = cast.characters.find(
      (c: { overrideTtsVoices?: { qwen?: { name?: string } } }) => c.overrideTtsVoices?.qwen?.name,
    );
    if (firstQwen) {
      expect(
        existsSync(
          join(workspaceRoot, 'voices', 'qwen', `${firstQwen.overrideTtsVoices.qwen.name}.pt`),
        ),
      ).toBe(true);
    }

    const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.manuscriptId).toMatch(/^mns_/);
  });

  it('is idempotent — a second load is a no-op 200', async () => {
    if (!bundleReady()) return;
    const a = await request(app).post(`/api/samples/${SLUG}/load`);
    const b = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.alreadyLoaded).toBe(true);
  });
});
