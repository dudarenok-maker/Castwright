/* Per-chapter loud Qwen→Kokoro fallback gate.
 *
 * When a chapter would SILENTLY render an undesigned Qwen voice in Kokoro, the
 * worker PARKS it (queue entry → awaiting_confirm) and emits
 * `chapter_awaiting_fallback_confirm` instead of rendering. The user then
 * confirms (render anyway) or skips it. This suite pins:
 *   - park: an undesigned-voice chapter flips to awaiting_confirm, emits the
 *     tick, and never calls synth / completes / fails.
 *   - confirm: a re-dispatch carrying `fallbackConfirmed:true` renders straight
 *     through (no re-park).
 *   - no-gate: a back-compat run with no queueEntryId is never gated.
 *
 * Boots a real http.Server + drives it with fetch, like the orphan-recovery
 * suite. synthesiseChapter + ensureSidecarEngineReady are stubbed so no GPU /
 * sidecar is touched. */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { QwenInstallState } from '../workspace/user-settings.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

let synthCalled = false;
let lastSynthArgs: {
  cast?: Array<{ id: string; ttsEngine?: string }>;
  forbidKokoroFallback?: boolean;
  bookLanguage?: string;
} | null = null;
let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: (args: unknown) => {
      synthCalled = true;
      lastSynthArgs = args as typeof lastSynthArgs;
      return synthesiseImpl(args);
    },
  };
});
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: () => ({ synthesize: vi.fn() }) };
});
/* No sidecar in the test — make the preload gate a no-op so the render path
   doesn't try to reach :9000 for the Kokoro fallback warm. */
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => undefined,
  /* Empty so the side-11 boundary-recycle check (the only SIDECAR_ENGINES
     consumer) is a no-op here. */
  SIDECAR_ENGINES: new Set(),
}));

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Fallback Gate Test';
const MANUSCRIPT_ID = 'm_fallback_gate_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let server: import('node:http').Server;
let baseUrl: string;
let bookId: string;
let queuePath: string;
let readQueueFile: (path: string) => Promise<import('../workspace/queue-io.js').QueueFile>;
let writeQueueFile: (
  path: string,
  file: import('../workspace/queue-io.js').QueueFile,
) => Promise<void>;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'fallback-gate-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  const [{ generationRouter }, { makeBookId, queueJsonPath }, cacheModule, migrateModule, settings] =
    await Promise.all([
      import('./generation.js'),
      import('../workspace/paths.js'),
      import('../store/analysis-cache.js'),
      import('../workspace/queue-migrate.js'),
      import('../workspace/user-settings.js'),
    ]);
  readQueueFile = migrateModule.readQueueFile;
  writeQueueFile = migrateModule.writeQueueFile;
  /* Qwen healthy → the gate is in play (an UNAVAILABLE Qwen takes the separate
     all-cast plan-135 warning path instead, which this suite is not about). */
  settings.setLastKnownQwenInstallState('loaded');

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  queuePath = queueJsonPath();
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      author: AUTHOR,
      title: TITLE,
      series: SERIES,
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-1' }],
    }),
  );
  /* Wren speaks, routes to Qwen, and has NO designed Qwen voice → she would
     fall back to Kokoro. That's exactly what the gate must catch. */
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'wren', name: 'Wren', ttsEngine: 'qwen' }],
    }),
  );

  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' }],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { rm } = await import('node:fs/promises');
  await rm(workspaceRoot, { recursive: true, force: true });
});

const ENTRY_ID = 'gate-entry-1';

beforeEach(async () => {
  synthCalled = false;
  lastSynthArgs = null;
  synthesiseImpl = async () => ({
    pcm: Buffer.alloc(2),
    sampleRate: 24000,
    durationSec: 1,
    segments: [{ characterId: 'wren', sentenceIds: [1] }],
  });
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-05-23T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});

/** POST a generation stream and collect the full SSE body text + resolve when
    the stream closes. */
async function runStream(extraBody: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${baseUrl}/api/books/${bookId}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelKey: 'gemini-2.5-flash',
      chapterIds: [1],
      force: true,
      queueEntryId: ENTRY_ID,
      ...extraBody,
    }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function readEntry(): Promise<import('../workspace/queue-io.js').QueueEntry | undefined> {
  const file = await readQueueFile(queuePath);
  return file.entries.find((e) => e.id === ENTRY_ID);
}

describe('per-chapter loud Qwen→Kokoro fallback gate', () => {
  it('parks an undesigned-voice chapter: awaiting_confirm + tick, no synth/complete', async () => {
    const body = await runStream();

    expect(body).toContain('chapter_awaiting_fallback_confirm');
    expect(body).toContain('wren'); // the affected character is named
    expect(body).not.toContain('chapter_complete');
    expect(synthCalled).toBe(false); // never rendered

    const entry = await readEntry();
    expect(entry?.status).toBe('awaiting_confirm');
    expect(entry?.fallbackCharacters?.map((c) => c.id)).toEqual(['wren']);
  }, 10_000);

  it('renders straight through when the re-dispatch carries fallbackConfirmed', async () => {
    const body = await runStream({ fallbackConfirmed: true });

    expect(body).not.toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(true); // confirmed → rendered (in Kokoro)

    /* srv-16 done-prunes the entry once rendered. */
    await vi.waitFor(async () => {
      expect(await readEntry()).toBeUndefined();
    });
  }, 10_000);

  it('does NOT gate a back-compat run with no queueEntryId', async () => {
    /* No queue row to park → render straight through (legacy callers). */
    const res = await fetch(`${baseUrl}/api/books/${bookId}/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).not.toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(true);
  }, 10_000);
});

/* fs-2 — never-cross-language enforcement at the generation route. A non-English
   book forces every character (incl. narrator) onto Qwen, threads
   forbidKokoroFallback + bookLanguage into synth, and a cross-language reused
   voice is treated as undesigned. An unavailable Qwen is FATAL (English Kokoro
   can't read the language), aborting the run before any chapter renders. */
describe('fs-2 never-cross-language generation gate', () => {
  const RU_TITLE = 'Russian Gate Test';
  const RU_MANUSCRIPT = 'm_ru_gate_test';
  const RU_ENTRY = 'ru-gate-entry-1';
  let ruBookId: string;
  let qwenVoiceSidecarPath: (name: string) => string;
  let setQwenState: (s: QwenInstallState) => void;

  /** Write a designed-voice manifest with a given baked language. */
  function writeManifest(name: string, language: string) {
    writeFileSync(
      qwenVoiceSidecarPath(name),
      JSON.stringify({ voiceId: name, instruct: 'persona', language }),
    );
  }

  beforeAll(async () => {
    const [{ makeBookId }, paths, cacheModule, settings] = await Promise.all([
      import('../workspace/paths.js'),
      import('../workspace/paths.js'),
      import('../store/analysis-cache.js'),
      import('../workspace/user-settings.js'),
    ]);
    qwenVoiceSidecarPath = paths.qwenVoiceSidecarPath;
    setQwenState = settings.setLastKnownQwenInstallState;
    ruBookId = makeBookId(AUTHOR, SERIES, RU_TITLE);
    const ruDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RU_TITLE);
    mkdirSync(join(ruDir, '.audiobook'), { recursive: true });
    mkdirSync(join(ruDir, 'audio'), { recursive: true });
    mkdirSync(join(workspaceRoot, 'voices', 'qwen'), { recursive: true });
    writeFileSync(
      join(ruDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: ruBookId,
        manuscriptId: RU_MANUSCRIPT,
        author: AUTHOR,
        title: RU_TITLE,
        series: SERIES,
        updatedAt: '2026-06-01T00:00:00.000Z',
        schema: 1,
        language: 'ru',
        chapters: [{ id: 1, title: 'Глава 1', slug: 'glava-1' }],
      }),
    );
    /* narrator + sofiya both carry designed Qwen voices; neither sets ttsEngine
       (the route forces it). The narrator deliberately has NO ttsEngine so the
       force-Qwen path is what routes it. */
    writeFileSync(
      join(ruDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', voiceId: 'v_narr', overrideTtsVoices: { qwen: { name: 'qwen-v_narr' } } },
          { id: 'sofiya', name: 'Sofiya', voiceId: 'v_sofiya', overrideTtsVoices: { qwen: { name: 'qwen-v_sofiya' } } },
        ],
      }),
    );
    await cacheModule.saveAnalysisCache(RU_MANUSCRIPT, {
      chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'sofiya', text: 'Привет.' }] },
    });
  });

  afterEach(() => {
    /* Restore the healthy default the other suite relies on. */
    setQwenState('loaded');
  });

  async function runRuStream(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/books/${ruBookId}/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelKey: 'gemini-2.5-flash',
        chapterIds: [1],
        force: true,
        queueEntryId: RU_ENTRY,
      }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text;
  }

  beforeEach(async () => {
    setQwenState('loaded');
    /* Both designed voices have Russian manifests → not cleared by the reuse
       guard, so the chapter renders (synth is mocked). */
    writeManifest('qwen-v_narr', 'Russian');
    writeManifest('qwen-v_sofiya', 'Russian');
    await writeQueueFile(queuePath, {
      entries: [
        {
          id: RU_ENTRY,
          bookId: ruBookId,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-06-01T00:00:00.000Z',
          status: 'in_progress',
          order: 0,
        },
      ],
      paused: false,
    });
  });

  it('forces every character onto Qwen and threads forbidKokoroFallback + bookLanguage', async () => {
    const body = await runRuStream();
    expect(body).not.toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(true);
    expect(lastSynthArgs?.forbidKokoroFallback).toBe(true);
    expect(lastSynthArgs?.bookLanguage).toBe('ru');
    /* Narrator (no ttsEngine on disk) AND sofiya both forced to qwen. */
    expect(lastSynthArgs?.cast?.every((c) => c.ttsEngine === 'qwen')).toBe(true);
  }, 10_000);

  it('treats a cross-language (English-manifest) reused voice as undesigned', async () => {
    /* sofiya's designed voice was baked English — reusing it into a Russian book
       must NOT render it. The reuse guard clears the override, so the existing
       fallback gate parks the chapter (undesigned Qwen) instead of rendering. */
    writeManifest('qwen-v_sofiya', 'English');
    const body = await runRuStream();
    expect(body).toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(false);
  }, 10_000);

  it('is FATAL (no synth, no park) when Qwen is unavailable on a Russian book', async () => {
    setQwenState('not-installed');
    const body = await runRuStream();
    expect(body).toContain('chapter_failed');
    expect(body).toMatch(/requires Qwen/i);
    expect(body).not.toContain('chapter_awaiting_fallback_confirm');
    expect(synthCalled).toBe(false);
  }, 10_000);
});
