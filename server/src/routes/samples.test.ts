import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
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
    /* The bundled sample carries `language: "en"` — it must round-trip
       unchanged, and the key must always be present. */
    const bundleState = JSON.parse(
      readFileSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'state.json'), 'utf8'),
    );
    expect('language' in state).toBe(true);
    expect(state.language).toBe(bundleState.language ?? null);
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

describe('samples router — no-language bundle normalisation', () => {
  let ws: string;
  let app2: Express;
  let resetSamples: () => void;

  beforeAll(async () => {
    ws = mkdtempSync(join(tmpdir(), 'audiobook-samples-nolang-'));

    /* A controlled sample: copy the bundled fixture but strip `language` from
       its state.json so the no-language load path is really exercised. */
    const sampleRoot = join(ws, 'samples');
    const sampleDir = join(sampleRoot, SLUG);
    mkdirSync(join(sampleDir, '.audiobook'), { recursive: true });
    mkdirSync(join(sampleDir, 'voices', 'qwen'), { recursive: true });
    cpSync(join(SAMPLES_ROOT, SLUG, 'manuscript.epub'), join(sampleDir, 'manuscript.epub'));
    if (existsSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'cast.json'))) {
      cpSync(
        join(SAMPLES_ROOT, SLUG, '.audiobook', 'cast.json'),
        join(sampleDir, '.audiobook', 'cast.json'),
      );
    }
    const bundle = JSON.parse(
      readFileSync(join(SAMPLES_ROOT, SLUG, '.audiobook', 'state.json'), 'utf8'),
    );
    delete bundle.language;
    writeFileSync(join(sampleDir, '.audiobook', 'state.json'), JSON.stringify(bundle, null, 2));

    process.env.WORKSPACE_DIR = ws;
    vi.resetModules();
    const { samplesRouter, setSamplesRoot, _resetSamplesRoot } = await import('./samples.js');
    setSamplesRoot(sampleRoot);
    resetSamples = _resetSamplesRoot;
    app2 = express();
    app2.use(express.json());
    app2.use('/api/samples', samplesRouter);
  });

  afterAll(() => {
    if (ws) rmSync(ws, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
    if (resetSamples) resetSamples();
  });

  it('loads a sample whose bundle has no language as language:null (key present)', async () => {
    if (!bundleReady()) return;
    const res = await request(app2).post(`/api/samples/${SLUG}/load`);
    expect(res.status).toBe(200);
    const dir = join(ws, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
    const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8'));
    expect('language' in state).toBe(true);
    expect(state.language).toBeNull();
  });
});
