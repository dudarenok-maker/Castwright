/* #3711 PR #3714 review pass 5 -- the same leak as book-state.fs-error-bodies:
   a node fs error carries the absolute path it failed on in its message, and
   the 500 handlers in cover.ts, voice-library.ts, voices.ts, import.ts and
   samples.ts answered `(e as Error).message` verbatim -- the workspace layout,
   over LAN HTTPS. One case per file: a real-shaped `ErrnoException` is thrown
   from the first dependency the handler awaits, and the body must carry the
   curated sentence, no path and no raw fs vocabulary. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Which route's dependency throws; null = every dependency is real. */
const fault = vi.hoisted(() => ({ which: null as null | string, path: '' }));

const errno = (): NodeJS.ErrnoException =>
  Object.assign(new Error(`EBUSY: resource busy or locked, open '${fault.path}'`), {
    code: 'EBUSY',
    errno: -4082,
    syscall: 'open',
    path: fault.path,
  });

vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return {
    ...actual,
    findBookByBookId: async (...args: Parameters<typeof actual.findBookByBookId>) => {
      if (fault.which === 'cover') throw errno();
      return actual.findBookByBookId(...args);
    },
  };
});
vi.mock('../workspace/voice-library.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/voice-library.js')>();
  return {
    ...actual,
    listEntries: async (...args: Parameters<typeof actual.listEntries>) => {
      if (fault.which === 'voice-library') throw errno();
      return actual.listEntries(...args);
    },
  };
});
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      if (fault.which === 'voices') throw errno();
      return actual.writeJsonAtomic(...args);
    },
  };
});
vi.mock('../parsers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parsers/index.js')>();
  return {
    ...actual,
    parseManuscript: async (...args: Parameters<typeof actual.parseManuscript>) => {
      if (fault.which === 'import' || fault.which === 'samples') throw errno();
      return actual.parseManuscript(...args);
    },
  };
});

let workspaceRoot: string;
let samplesRoot: string;
let app: Express;
let curated: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-fs-error-other-routes-'));
  samplesRoot = mkdtempSync(join(tmpdir(), 'audiobook-fs-error-samples-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  fault.path = join(workspaceRoot, 'books', 'A', 'S', 'T', '.audiobook', 'state.json');
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { coverRouter } = await import('./cover.js');
  const { voiceLibraryRouter } = await import('./voice-library.js');
  const { voicesRouter } = await import('./voices.js');
  const { importRouter } = await import('./import.js');
  const samples = await import('./samples.js');
  curated = (await import('../workspace/file-lock.js')).FS_FAILURE_REQUEST_ERROR;
  samples.setSamplesRoot(samplesRoot);
  mkdirSync(join(samplesRoot, 'probe', '.audiobook'), { recursive: true });
  writeFileSync(join(samplesRoot, 'probe', 'manuscript.md'), '# One\n\nText.\n');
  writeFileSync(
    join(samplesRoot, 'probe', '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: 'probe',
      title: 'Probe',
      author: 'Probe Author',
      series: 'S',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'One', slug: '01-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', coverRouter);
  app.use('/api/voice-library', voiceLibraryRouter);
  app.use('/api/voices', voicesRouter);
  app.use('/api', importRouter);
  app.use('/api/samples', samples.samplesRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (samplesRoot) rmSync(samplesRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  fault.which = null;
});

/** No absolute path and no raw fs error, on every string field and on the JSON
 *  text in both spellings (Windows doubles each backslash in JSON). Same check
 *  as book-op.read-errors.test.ts. */
function expectNoPathLeak(body: unknown): void {
  const json = JSON.stringify(body);
  const fields: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') fields.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(body);
  for (const text of [...fields, json]) {
    expect(text).not.toContain(workspaceRoot);
    expect(text).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
    expect(text).not.toMatch(/EBUSY/);
  }
}

describe('a node fs error never puts a path in a 500 body (review pass 5)', () => {
  it('cover.ts -- GET candidates', async () => {
    fault.which = 'cover';
    const res = await request(app).get('/api/books/any-book/cover/candidates');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated);
    expectNoPathLeak(res.body);
  });

  it('voice-library.ts -- GET list', async () => {
    fault.which = 'voice-library';
    const res = await request(app).get('/api/voice-library');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated);
    expectNoPathLeak(res.body);
  });

  it('voices.ts -- PUT pin', async () => {
    fault.which = 'voices';
    const res = await request(app).put('/api/voices/af_x/pin').send({ pinned: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated);
    expectNoPathLeak(res.body);
  });

  it('import.ts -- POST /import', async () => {
    fault.which = 'import';
    const res = await request(app).post('/api/import').send({ text: '# One\n\nText.\n', fileName: 'a.md' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated);
    expectNoPathLeak(res.body);
  });

  it('samples.ts -- POST load', async () => {
    fault.which = 'samples';
    const res = await request(app).post('/api/samples/probe/load');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(curated);
    expectNoPathLeak(res.body);
  });
});
