/* #3711 task 4 -- a render (POST /generation) is a registered `render` job: while it
   runs, a folder rename (PUT /state) and a DELETE are REFUSED with 409 `book_busy`
   and the folder is untouched; the registration is released on EVERY exit path
   (success, failure, early return); and a render's last chapter hands over to its
   `scoring` job with no instant in which the book is unregistered.

   Driven through the real entry points (generation POST + book-state PUT/DELETE) with
   the synth gated by the existing mock seam. Event-based, no sleeps. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return { ...actual, synthesiseChapter: (args: unknown) => synthesiseImpl(args) };
});
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize: vi.fn() })) };
});
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => undefined,
  reconcileResidentQwenTiers: vi.fn(async () => undefined),
  SIDECAR_ENGINES: new Set(),
}));
vi.mock('../system/prevent-sleep.js', () => ({
  preventSleep: vi.fn(),
  allowSleep: vi.fn(),
  isSleepPrevented: vi.fn(() => false),
}));

const AUTHOR = 'Render Job Author';
const SERIES = 'Standalones';
const TITLE = 'Render Job Book';
const NEW_TITLE = 'Render Job Book Renamed';
const MANUSCRIPT_ID = 'm_render_job_test';

let workspaceRoot: string;
let bookDir: string;
let newDir: string;
let app: Express;
let bookId: string;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;
let __awaitScoringSettled: typeof import('./generation.js').__awaitScoringSettled;
let configModule: typeof import('../config/resolver.js');
let aggregateModule: typeof import('../audio/render-integrity/aggregate.js');

const goodSynth = async () => ({
  pcm: Buffer.alloc(2),
  sampleRate: 24000,
  durationSec: 1,
  segments: [{ characterId: 'narrator', voiceName: 'Zephyr', sampleStart: 0, sampleEnd: 1, sentenceIds: [1] }],
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

function parseTicks(body: string): Array<{ type: string; [k: string]: unknown }> {
  return body
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((frame) =>
      JSON.parse(
        frame
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n'),
      ),
    );
}

function seedBook(): void {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-one' }],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'narrator', name: 'Narrator', attributes: ['observational'] }] }),
  );
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-render-job-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { generationRouter, __awaitScoringSettled: settled } = await import('./generation.js');
  __awaitScoringSettled = settled;
  const { bookStateRouter } = await import('./book-state.js');
  const paths = await import('../workspace/paths.js');
  const cacheModule = await import('../store/analysis-cache.js');
  bookJobKinds = (await import('../workspace/book-op-lock.js')).bookJobKinds;
  configModule = await import('../config/resolver.js');
  aggregateModule = await import('../audio/render-integrity/aggregate.js');
  bookId = paths.makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);
  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }] },
  });
  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  app.use('/api/books', bookStateRouter);
});

afterAll(async () => {
  const cacheModule = await import('../store/analysis-cache.js');
  await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  seedBook();
  synthesiseImpl = goodSynth;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const renameRequest = () =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: NEW_TITLE } });

const generate = (body: Record<string, unknown> = { chapterIds: [1], force: true }) =>
  request(app)
    .post(`/api/books/${bookId}/generation`)
    .send({ modelKey: 'gemini-2.5-flash', ...body });

describe('POST /generation is a registered render job (#3711)', () => {
  it('refuses a rename and a DELETE with 409 book_busy while a chapter renders, then allows them', async () => {
    const started = gate();
    const release = gate();
    synthesiseImpl = async () => {
      started.open();
      await release.promise;
      return goodSynth();
    };
    const run = generate().then((r) => r);
    await started.promise;
    expect(bookJobKinds(bookId)).toContain('render');

    const rename = await renameRequest();
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe('book_busy');
    expect(rename.body.error).toMatch(/rendering audio/i);
    const del = await request(app).delete(`/api/books/${bookId}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('book_busy');
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
    expect(JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).title).toBe(TITLE);

    release.open();
    const res = await run;
    expect(parseTicks(res.text).some((t) => t.type === 'chapter_complete')).toBe(true);
    expect(bookJobKinds(bookId)).toEqual([]);

    expect((await renameRequest()).status).toBe(200);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('releases the registration when the render fails', async () => {
    synthesiseImpl = async () => {
      throw new Error('boom: synth blew up');
    };
    const res = await generate();
    expect(parseTicks(res.text).some((t) => t.type === 'chapter_failed')).toBe(true);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('a render callback that THROWS outside the per-chapter handler still deregisters the job and ends the stream with idle', async () => {
    /* A `null` sentence makes processOneChapter throw (`s.excludeFromSynthesis` of
       null) BEFORE its own try/finally, so the throw escapes the chapter loop and
       skips the normal-path deregisterJob / endAllSubscribers. */
    const cacheModule = await import('../store/analysis-cache.js');
    const real = await cacheModule.loadAnalysisCache(MANUSCRIPT_ID);
    vi.spyOn(cacheModule, 'loadAnalysisCache').mockResolvedValue({ ...real, chapters: { 1: [null] } } as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { isGenerationActive } = await import('./generation.js');
    const res = await generate();
    const ticks = parseTicks(res.text);
    expect(ticks.find((t) => t.type === 'chapter_failed')?.errorReason).toBe('Could not start the render.');
    expect(ticks.map((t) => t.type)).toContain('idle'); // the subscribers were ended
    expect(isGenerationActive(bookId)).toBe(false); // the in-flight map entry was removed
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('releases the registration on an early return (no target chapters)', async () => {
    const res = await generate({ chapterIds: [99], force: true });
    expect(parseTicks(res.text).map((t) => t.type)).toContain('idle');
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('answers a start for a deleted book with the SSE chapter_failed frame, registering nothing', async () => {
    rmSync(bookDir, { recursive: true, force: true });
    const res = await generate();
    const ticks = parseTicks(res.text);
    expect(ticks.find((t) => t.type === 'chapter_failed')?.errorReason).toBe('Book not found.');
    expect(ticks.map((t) => t.type)).toContain('idle');
    expect(bookJobKinds(bookId)).toEqual([]);
  });

  it("hands over to `scoring` with no gap: scoring registers while the render still holds, and a rename after the last chapter is refused", async () => {
    const realConfigValue = configModule.configValue;
    vi.spyOn(configModule, 'configValue').mockImplementation(((key: string) =>
      key === 'qa.speaker.enabled' ? true : realConfigValue(key as never)) as typeof realConfigValue);
    const scoring = gate();
    let kindsWhenScoringStarted: string[] = [];
    vi.spyOn(aggregateModule, 'scoreBook').mockImplementation((async () => {
      kindsWhenScoringStarted = [...bookJobKinds(bookId)];
      await scoring.promise;
      return { usedQwenTiers: { keep06: false, keep17: false }, mismatchCount: 0 };
    }) as unknown as typeof aggregateModule.scoreBook);

    const res = await generate();
    expect(parseTicks(res.text).some((t) => t.type === 'chapter_complete')).toBe(true);

    /* Scoring was running (and registered) while the render's token was still held. */
    await vi.waitFor(() => expect(kindsWhenScoringStarted.length).toBeGreaterThan(0));
    expect(kindsWhenScoringStarted).toEqual(expect.arrayContaining(['render', 'scoring']));
    /* The render has settled, but the book is still busy: the scoring pass holds it. */
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual(['scoring']));
    const refused = await renameRequest();
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/scoring audio/i);
    expect(existsSync(newDir)).toBe(false);

    scoring.open();
    await __awaitScoringSettled(bookId);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });
});
