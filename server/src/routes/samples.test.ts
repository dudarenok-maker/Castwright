import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, cpSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
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

  it('the registered record carries the sha of the manuscript bytes on disk (#3703)', async () => {
    if (!bundleReady()) return;
    const res = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(res.status).toBe(200);
    const dir = join(workspaceRoot, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
    const state = JSON.parse(readFileSync(join(dir, '.audiobook', 'state.json'), 'utf8'));
    const { getManuscript } = await import('../store/manuscripts.js');
    const record = getManuscript(state.manuscriptId);
    expect(record).toBeDefined();
    const onDisk = readFileSync(join(dir, state.manuscriptFile));
    expect(record?.sourceSha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
  });

  it('is idempotent — a second load is a no-op 200', async () => {
    if (!bundleReady()) return;
    const a = await request(app).post(`/api/samples/${SLUG}/load`);
    const b = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.alreadyLoaded).toBe(true);
  });

  it('a STRANDED copy (main missing, good .bak.1) is already loaded: edits and manuscriptId survive a re-load (#3625)', async () => {
    if (!bundleReady()) return;
    const dir = join(workspaceRoot, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
    const first = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(first.status).toBe(200);
    const statePath = join(dir, '.audiobook', 'state.json');
    const castPath = join(dir, '.audiobook', 'cast.json');
    const manuscriptId = JSON.parse(readFileSync(statePath, 'utf8')).manuscriptId;
    const cast = JSON.parse(readFileSync(castPath, 'utf8'));
    cast.userEdited = 'keep me';
    writeFileSync(castPath, JSON.stringify(cast));
    renameSync(statePath, `${statePath}.bak.1`); // the crash-gap shape
    const res = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(res.status).toBe(200);
    expect(res.body.alreadyLoaded).toBe(true);
    expect(JSON.parse(readFileSync(castPath, 'utf8')).userEdited).toBe('keep me');
    expect(JSON.parse(readFileSync(`${statePath}.bak.1`, 'utf8')).manuscriptId).toBe(manuscriptId);
    expect(existsSync(statePath)).toBe(false);
  });

  /* #3625 review 2: a torn copy with nothing to recover is NOT ours to clobber, but an
     error that says nothing about the file (EACCES / EISDIR) must surface instead
     of claiming "loaded" with nothing there. */
  describe('a copy whose state cannot be read', () => {
    const paths = () => {
      const d = join(workspaceRoot, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
      return { statePath: join(d, '.audiobook', 'state.json'), castPath: join(d, '.audiobook', 'cast.json') };
    };
    const seed = async () => {
      const { statePath, castPath } = paths();
      rmSync(statePath, { recursive: true, force: true });
      for (const n of [1, 2, 3]) rmSync(`${statePath}.bak.${n}`, { force: true });
      const first = await request(app).post(`/api/samples/${SLUG}/load`);
      expect(first.status).toBe(200);
      const cast = JSON.parse(readFileSync(castPath, 'utf8'));
      cast.userEdited = 'keep me';
      writeFileSync(castPath, JSON.stringify(cast));
      return { statePath, castPath };
    };

    it('torn state with no backup: reports alreadyLoaded and overwrites nothing', async () => {
      if (!bundleReady()) return;
      const { statePath, castPath } = await seed();
      writeFileSync(statePath, '{ torn');
      const res = await request(app).post(`/api/samples/${SLUG}/load`);
      expect(res.status).toBe(200);
      expect(res.body.alreadyLoaded).toBe(true);
      expect(readFileSync(statePath, 'utf8')).toBe('{ torn');
      expect(JSON.parse(readFileSync(castPath, 'utf8')).userEdited).toBe('keep me');
    });

    it('a non-parse read error (EISDIR) fails the load with a 500 instead of claiming loaded', async () => {
      if (!bundleReady()) return;
      const { statePath, castPath } = await seed();
      rmSync(statePath, { force: true });
      mkdirSync(statePath);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await request(app).post(`/api/samples/${SLUG}/load`);
        expect(res.status).toBe(500);
        expect(res.body.alreadyLoaded).toBeUndefined();
        expect(JSON.parse(readFileSync(castPath, 'utf8')).userEdited).toBe('keep me');
      } finally {
        errSpy.mockRestore();
        rmSync(statePath, { recursive: true, force: true });
      }
    });
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

describe('samples router — load waits on the state lock (#3625)', () => {
  let ws: string;
  let app3: Express;
  let resetSamples: () => void;

  beforeAll(async () => {
    ws = mkdtempSync(join(tmpdir(), 'audiobook-samples-lock-'));
    process.env.WORKSPACE_DIR = ws;
    vi.resetModules();
    const { samplesRouter, setSamplesRoot, _resetSamplesRoot } = await import('./samples.js');
    setSamplesRoot(SAMPLES_ROOT);
    resetSamples = _resetSamplesRoot;
    app3 = express();
    app3.use(express.json());
    app3.use('/api/samples', samplesRouter);
  });

  afterAll(() => {
    if (ws) rmSync(ws, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
    if (resetSamples) resetSamples();
  });

  it('does not write state.json while the lock is held, then lands', async () => {
    if (!bundleReady()) return;
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const { stateJsonPath: stateJsonPathForLock } = await import('../workspace/paths.js');
    const bookDir = join(ws, 'books', 'Castwright', 'Standalones', 'The Coalfall Commission');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateJsonLock(stateJsonPathForLock(bookDir), async () => {
      acquired();
      await gate;
    });
    await got;

    const pending = request(app3)
      .post(`/api/samples/${SLUG}/load`)
      .then((r) => r);
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(statePath)).toBe(false);
    release();
    const [res] = await Promise.all([pending, held]);
    expect(res.status).toBe(200);
    expect(res.body.alreadyLoaded).toBe(false);
    expect(existsSync(statePath)).toBe(true);
  });
});
