/* #2040 final-review action item — pins that generation.ts, chapter-splice.ts,
   and chapter-qa-repair.ts actually THREAD `castIdHistory` into their
   `synthesiseChapter` calls, not merely that `synthesiseChapter`/
   `buildCastResolver` resolve a history entry correctly when handed one
   directly (that's already covered by synthesise-chapter.orphan-alias.test.ts
   and cast-resolve.test.ts).

   The gap this closes: the orphan-alias unit test injects `castIdHistory`
   straight into `synthesiseChapter`'s options, so it proves the RESOLVER
   works but never proves any of the three route call sites actually LOAD and
   PASS it. If a refactor silently dropped
   `const castIdHistory = await loadCastIdHistory(bookDir);` — or dropped the
   `castIdHistory,` line from a `synthesiseChapter({...})` call — every
   existing test in the repo would stay green while the feature regressed to
   narrator substitution for any retired id.

   #2040 Task 17 fix round 1 — each route now passes the WHOLE loaded
   `CastIdHistory` object (`{ schema, supersededBy, rejected? }`), not just
   `.supersededBy`, so `buildCastResolver` also honours a "not the same
   character" rejection at synth/splice/repair time (previously it only
   reached the orphan-collector's own resolver call — the banner and the
   analyzer's future matching, never the actual render). The assertions below
   were updated accordingly; the generation.ts block additionally seeds a
   `rejected` entry to prove that field specifically survives the route →
   synthesiseChapter hop, not just `supersededBy`.

   Each describe block below drives ONE of the three call sites through its
   existing supertest harness against a REAL cast-id-history.json written by
   the real `retireCharacterId`/`rejectOrphanedId` writers
   (server/src/store/cast-id-history.ts — not a hand-written fixture),
   intercepts the mocked `synthesiseChapter` call, and asserts it actually
   received the seeded history object. The seeded `from` id
   (`ghost-<route>`) never otherwise appears in the book's cast or segments,
   so it is inert for resolution/divergence checks — its sole job is to
   prove the object reaches `synthesiseChapter`'s options unchanged. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { CastIdHistory } from '../store/cast-id-history.js';

/* Captures every options object synthesiseChapter is called with, across all
   three routers mounted below on the shared `app`. Cleared at the top of each
   `it()` so an assertion only sees calls from its own request. */
let synthesiseCalls: Array<{ castIdHistory?: CastIdHistory }> = [];
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: vi.fn(async (args: { castIdHistory?: CastIdHistory }) => {
      synthesiseCalls.push(args);
      return {
        pcm: Buffer.alloc(4800, 0),
        sampleRate: 24000,
        durationSec: 0.1,
        segments: [
          { characterId: 'narrator', voiceName: 'Zephyr', sampleStart: 0, sampleEnd: 1, sentenceIds: [1] },
        ],
      };
    }),
  };
});
/* Same no-op provider stub generation.test.ts uses — synthesiseChapter is
   fully mocked above, so the provider object is never actually invoked; this
   just keeps selectTtsProvider from reaching for a live sidecar/API key. */
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: () => ({ synthesize: vi.fn() }) };
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
vi.mock('../diagnostics/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../diagnostics/disk.js')>();
  return {
    ...actual,
    probeDiskSpace: async (path: string) => ({ status: 'ok' as const, freeGb: 9999, path }),
  };
});

const SR = 24_000;
function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

let workspaceRoot: string;
let app: Express;
let makeBookId: (author: string, series: string, title: string) => string;
let audioDirFn: (bookDir: string) => string;
let encodePcmToAudio: (
  pcm: Buffer,
  sr: number,
  opts: { format: 'mp3'; quality: number },
) => Promise<Buffer>;
let saveAnalysisCache: (
  manuscriptId: string,
  cache: import('../store/analysis-cache.js').AnalysisCache,
) => Promise<void>;
let clearAnalysisCache: (manuscriptId: string) => Promise<void>;
let retireCharacterId: (
  bookDir: string,
  from: string,
  to: string,
) => Promise<import('../store/cast-id-history.js').RetireCharacterIdResult>;
let rejectOrphanedId: (bookDir: string, id: string) => Promise<void>;
let rejectOrphanedPair: (bookDir: string, from: string, to: string) => Promise<void>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-castid-wiring-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factories above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { generationRouter } = await import('./generation.js');
  const { chapterSpliceRouter } = await import('./chapter-splice.js');
  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  const paths = await import('../workspace/paths.js');
  const mp3 = await import('../tts/mp3.js');
  const cacheModule = await import('../store/analysis-cache.js');
  const historyModule = await import('../store/cast-id-history.js');
  makeBookId = paths.makeBookId;
  audioDirFn = paths.audioDir;
  encodePcmToAudio = mp3.encodePcmToAudio;
  saveAnalysisCache = cacheModule.saveAnalysisCache;
  clearAnalysisCache = cacheModule.clearAnalysisCache;
  retireCharacterId = historyModule.retireCharacterId;
  rejectOrphanedId = historyModule.rejectOrphanedId;
  rejectOrphanedPair = historyModule.rejectOrphanedPair;

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  app.use('/api/books', chapterSpliceRouter);
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('#2040 castIdHistory route wiring — generation.ts', () => {
  const AUTHOR = 'CastId Wiring Author';
  const SERIES = 'Standalones';
  const TITLE = 'Generation Wiring Story';
  const MANUSCRIPT_ID = 'm_castid_wiring_generation';
  let bookId: string;
  let bookDir: string;

  beforeAll(async () => {
    bookId = makeBookId(AUTHOR, SERIES, TITLE);
    bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
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
        language: 'en',
        chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [{ id: 'narrator', name: 'Narrator' }] }),
    );
    await saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }] },
    });
    // A real writer call, not a hand-written history file. 'ghost-generation'
    // never appears in this book's cast or sentences — inert for resolution,
    // pure wiring probe. Also seeds a `rejected` entry (fix round 1) and a
    // `rejectedPairs` entry (#2092/#2089 task 3) so the assertion below
    // proves BOTH fields survive the route → synthesiseChapter hop, not just
    // `supersededBy` — the same "one object, not a bare map" contract this
    // file exists to pin, extended to the pair-scoped successor.
    await retireCharacterId(bookDir, 'ghost-generation', 'narrator');
    await rejectOrphanedId(bookDir, 'rejected-generation');
    await rejectOrphanedPair(bookDir, 'rejected-pair-generation', 'narrator');
  });

  afterAll(async () => {
    await clearAnalysisCache(MANUSCRIPT_ID);
  });

  it('threads the seeded cast-id-history.json into synthesiseChapter', async () => {
    synthesiseCalls = [];
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'chapter_complete'), `got: ${res.text}`).toBe(true);

    expect(synthesiseCalls.length).toBeGreaterThan(0);
    expect(synthesiseCalls[0].castIdHistory).toEqual({
      schema: 1,
      supersededBy: { 'ghost-generation': 'narrator' },
      rejected: ['rejected-generation'],
      rejectedPairs: [{ from: 'rejected-pair-generation', to: 'narrator' }],
      // #2128 — every write bumps seq and stamps recordedAtSeq/recordedAtIso;
      // three writers ran above (retireCharacterId, rejectOrphanedId,
      // rejectOrphanedPair), so seq lands at 3, with only the supersededBy
      // key ('ghost-generation') stamped, at the seq its write happened (1).
      seq: 3,
      recordedAtSeq: { 'ghost-generation': 1 },
      recordedAtIso: { 'ghost-generation': expect.any(String) },
    });
  });
});

describe('#2040 castIdHistory route wiring — chapter-splice.ts', () => {
  const AUTHOR = 'CastId Wiring Author';
  const SERIES = 'Standalones';
  const TITLE = 'Splice Wiring Story';
  const SLUG = 'chapter-one';
  const MANUSCRIPT_ID = 'm_castid_wiring_splice';
  let bookId: string;
  let bookDir: string;
  let audioRoot: string;

  beforeAll(async () => {
    bookId = makeBookId(AUTHOR, SERIES, TITLE);
    bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    audioRoot = audioDirFn(bookDir);
    mkdirSync(audioRoot, { recursive: true });
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
        language: 'en',
        chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:01' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: [{ id: 'amy', name: 'Amy', gender: 'female', attributes: [] }] }),
    );

    const chapterPcm = tone(1.0, 12000);
    const mp3Bytes = await encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 1.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 }],
      }),
    );

    await saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'amy', text: 'Line.' }] },
    });
    await retireCharacterId(bookDir, 'ghost-splice', 'amy');
  });

  afterAll(async () => {
    await clearAnalysisCache(MANUSCRIPT_ID);
  });

  it('threads the seeded cast-id-history.json into synthesiseChapter (rerecord)', async () => {
    synthesiseCalls = [];
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'amy', modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'splice_complete'), `got: ${res.text}`).toBe(true);

    expect(synthesiseCalls.length).toBeGreaterThan(0);
    expect(synthesiseCalls[0].castIdHistory).toEqual({
      schema: 1,
      supersededBy: { 'ghost-splice': 'amy' },
      // #2128 — the sole writer above (retireCharacterId) bumps seq to 1 and
      // stamps its own key at that seq.
      seq: 1,
      recordedAtSeq: { 'ghost-splice': 1 },
      recordedAtIso: { 'ghost-splice': expect.any(String) },
    });
  });
});

describe('#2040 castIdHistory route wiring — chapter-qa-repair.ts', () => {
  const AUTHOR = 'CastId Wiring Author';
  const SERIES = 'Standalones';
  const TITLE = 'QA Repair Wiring Story';
  const SLUG = 'chapter-one';
  const MANUSCRIPT_ID = 'm_castid_wiring_qa_repair';
  let bookId: string;
  let bookDir: string;
  let audioRoot: string;

  beforeAll(async () => {
    bookId = makeBookId(AUTHOR, SERIES, TITLE);
    bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    audioRoot = audioDirFn(bookDir);
    mkdirSync(audioRoot, { recursive: true });
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
        language: 'en',
        chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:02' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'amy', name: 'Amy', gender: 'female', attributes: [] },
          { id: 'castor', name: 'Castor', gender: 'female', attributes: [] },
        ],
      }),
    );

    // Healthy Amy segment + a DEAD SILENT Castor segment — the silence gets
    // auto-flagged by the signal scan and re-recorded by the repair loop,
    // reaching a real synthesiseChapter call.
    const amy = tone(1.0, 12000);
    const castorSilent = Buffer.alloc(SR * 2);
    const chapterPcm = Buffer.concat([amy, castorSilent]);
    const mp3Bytes = await encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 2.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 },
          { groupIndex: 1, characterId: 'castor', sentenceIds: [2], startSec: 1.0, endSec: 2.0 },
        ],
      }),
    );

    await saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: {
        1: [
          { id: 1, chapterId: 1, characterId: 'amy', text: 'Line one.' },
          { id: 2, chapterId: 1, characterId: 'castor', text: 'Line two.' },
        ],
      },
    });
    await retireCharacterId(bookDir, 'ghost-qa-repair', 'castor');
  });

  afterAll(async () => {
    await clearAnalysisCache(MANUSCRIPT_ID);
  });

  it('threads the seeded cast-id-history.json into synthesiseChapter (repair)', async () => {
    synthesiseCalls = [];
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'qa_repair_complete'), `got: ${res.text}`).toBe(true);

    expect(synthesiseCalls.length).toBeGreaterThan(0);
    expect(synthesiseCalls[0].castIdHistory).toEqual({
      schema: 1,
      supersededBy: { 'ghost-qa-repair': 'castor' },
      // #2128 — the sole writer above (retireCharacterId) bumps seq to 1 and
      // stamps its own key at that seq.
      seq: 1,
      recordedAtSeq: { 'ghost-qa-repair': 1 },
      recordedAtIso: { 'ghost-qa-repair': expect.any(String) },
    });
  });
});
