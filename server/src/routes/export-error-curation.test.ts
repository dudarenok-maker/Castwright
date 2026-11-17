/* #4236 -- an export job's `errorReason` is returned by GET /exports[/:id],
   rendered in the export row and persisted in the manifest. A node fs error's
   message embeds the absolute path it failed on (the book folder keeps the
   display title), so the reason is curated through `requestFailureMessageFs`.
   The raw error -- including the ffmpeg/ffprobe stderr the scrubbed message
   drops -- goes to the log instead. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const ABS = 'C:\\Users\\someone\\Castwright\\books\\The Quota\\Series\\Title\\exports\\.x.partial-1';

function fsError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${code}: failure, ${syscall} '${ABS}'`), { code, syscall, path: ABS });
}

const seam = vi.hoisted(() => ({ build: null as unknown, rename: null as unknown }));

vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async () => {
    if (seam.build) throw seam.build;
    return { sizeBytes: 1, entries: [] };
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));
vi.mock('../workspace/atomic-rename.js', async (orig) => ({
  ...(await orig<typeof import('../workspace/atomic-rename.js')>()),
  /* Only the export artifact's own rename is faulted: writeJsonAtomic (the manifest) renames through here too. */
  renameWithRetry: vi.fn(async (src: string, dest: string) => {
    if (!src.includes('.partial-')) {
      return (await orig<typeof import('../workspace/atomic-rename.js')>()).renameWithRetry(src, dest);
    }
    if (seam.rename) throw seam.rename;
  }),
}));

const AUTHOR = 'Curation Author';
const SERIES = 'Standalones';
const TITLE = 'Curation Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;
let awaitInFlightJobs: () => Promise<void>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-curation-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { exportRouter, _resetExportJobs, _awaitInFlightExportJobs } = await import('./export.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const { _resetUserSettingsCache } = await import('../workspace/user-settings.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetJobs = _resetExportJobs;
  awaitInFlightJobs = _awaitInFlightExportJobs;
  _resetUserSettingsCache();

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_curation',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), Buffer.alloc(1024));

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
});

beforeEach(async () => {
  await awaitInFlightJobs?.();
  resetJobs?.();
  seam.build = null;
  seam.rename = null;
  for (const d of [join(bookDir, 'exports'), join(bookDir, '.audiobook', 'export-manifests')]) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await awaitInFlightJobs?.();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function runFailing(): Promise<{ body: Record<string, unknown>; manifest: Record<string, unknown> }> {
  const create = await request(app)
    .post(`/api/books/${bookId}/exports`)
    .send({ format: 'mp3-zip', destination: 'download' });
  expect(create.status).toBe(201);
  const exportId = create.body.id as string;
  /* Poll the manifest on disk: it is written in runExportJob's `finally`, so a
     terminal manifest means the job's reason is final. */
  const manifestFile = join(bookDir, '.audiobook', 'export-manifests', `${exportId}.json`);
  let manifest: Record<string, unknown> | null = null;
  for (let i = 0; i < 100 && !manifest; i++) {
    if (existsSync(manifestFile)) {
      const m = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
      if (m.status === 'failed' && m.errorReason != null) manifest = m;
    }
    if (!manifest) await new Promise((r) => setTimeout(r, 20));
  }
  if (!manifest) throw new Error('export did not fail within timeout');
  const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
  return { body: res.body, manifest };
}

describe('export job failure reason is path-free (#4236)', () => {
  it('an EBUSY on the final rename answers the curated sentence, in memory and in the manifest', async () => {
    seam.rename = fsError('EBUSY', 'rename');
    const { body, manifest } = await runFailing();
    expect(body.status).toBe('failed');
    expect(body.errorReason).toBe('Files could not be read or written right now. Try again.');
    expect(manifest.errorReason).toBe(body.errorReason);
    for (const s of [JSON.stringify(body), JSON.stringify(manifest)]) {
      expect(s).not.toContain('Quota');
      expect(s).not.toContain('someone');
    }
  });

  it('an ENOSPC from a builder answers the permanent sentence', async () => {
    seam.build = fsError('ENOSPC', 'write');
    const { body, manifest } = await runFailing();
    expect(body.errorReason).toBe(
      'Files could not be read or written. Check free disk space and folder permissions.',
    );
    expect(manifest.errorReason).toBe(body.errorReason);
    expect(JSON.stringify(body)).not.toContain('someone');
  });

  it('an ordinary builder error keeps its own message', async () => {
    seam.build = new Error('ordinary failure text');
    const { body } = await runFailing();
    expect(body.errorReason).toBe('ordinary failure text');
  });

  it('the raw error and the ffmpeg stderr reach the log, not the body', async () => {
    seam.build = Object.assign(new Error('ffmpeg exited with code 1: <path>'), {
      ffmpegStderr: `${ABS}: Invalid data found when processing input`,
    });
    const { body } = await runFailing();
    expect(JSON.stringify(body)).not.toContain('Invalid data');
    const logged = errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('Invalid data found when processing input');
    expect(logged).toContain('ffmpeg exited with code 1');
  });
});