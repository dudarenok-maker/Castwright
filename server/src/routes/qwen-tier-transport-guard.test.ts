/* G1 — behavioural transport guard (plan 293 §5.0, precondition for the Qwen keep-set chain, #1393).

   WHAT IT PROVES. A live sidecar call inside `designQwenVoiceForCharacter` keeps the generation
   run-start reconcile from evicting a Qwen tier. The three transports are:
     - design           `${sidecar}/qwen/design-voice`   (a base design)
     - mint             `${sidecar}/qwen/mint-variant`   (an emotion variant, `purpose: 'mint'`)
     - fallback design  `${sidecar}/qwen/design-voice`   (the mint answered 503 base17-unavailable)
   For each one the call is started through the real entry point with the sidecar `undici` fetch
   replaced by a deferred promise, held open, and a real chapter POST is made for a book whose keep
   WOULD evict that tier (a Quality book has `keep06:false`, a Standard book `keep17:false`). While
   the call is held no reconcile may run; once it is released and settled, the same POST reconciles
   with the evicting keep.

   WHY. `/unload {engine:'qwen'}` nulls the VoiceDesign model with the 0.6B base, and a bare
   `/unload {model:'1.7b'}` does not wait for a mint, so a reconcile that names the tier a live
   design or mint is using kills it mid-forward. #4497 counts live designs and mints
   (`inFlightByPurpose` in tts/design-voice-core.ts), and the run-start reconcile skips while
   `otherTierWorkActive` is true. The Stage 1 keep narrowing (#4556 onward) makes a reconcile more
   likely to name such a tier; this file is what makes that safe, and #4556 re-runs it once the keep
   narrows. The counter is never set by hand here: it moves only because the real call is in flight.

   Harness: a real http.Server + the real generation router (as generation-fallback-gate.test.ts),
   with `reconcileResidentQwenTiers` replaced by a recorder and synthesis stubbed. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

/* ---- sidecar fetch: every call is parked until the test releases it ---- */
interface HeldCall {
  url: string;
  respond: (res: Response) => void;
}
const heldCalls: HeldCall[] = [];
/* Calls answered at once (the mint's 503 in the fallback case). */
let immediateAnswer: ((url: string) => Response | null) | null = null;

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  const { writesStagedPt } = await import('../test-utils/staged-sidecar-fetch.js');
  return {
    ...actual,
    fetch: writesStagedPt((url: unknown) => {
      const u = String(url);
      const now = immediateAnswer?.(u);
      if (now) return Promise.resolve(now);
      return new Promise<Response>((resolve) => {
        heldCalls.push({ url: u, respond: resolve });
      });
    }),
  };
});

/* ---- run-start reconcile recorder + stubbed synthesis (generation-fallback-gate.test.ts precedent) ---- */
const reconcileCalls: unknown[][] = [];
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => undefined,
  reconcileResidentQwenTiers: async (...args: unknown[]) => {
    reconcileCalls.push(args);
    return undefined;
  },
  SIDECAR_ENGINES: new Set(),
}));
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: async () => ({
      pcm: Buffer.alloc(2),
      sampleRate: 24000,
      durationSec: 1,
      segments: [{ characterId: 'wren', sentenceIds: [1] }],
    }),
  };
});
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: () => ({ synthesize: vi.fn() }) };
});
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {},
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));

const AUTHOR = 'Guard Author';
const SERIES = 'Standalones';
const GEN_TITLE = 'Guard Generation Book';
const DESIGN_SERIES = 'Guard Series';
const DESIGN_TITLE = 'Guard Design Book';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let server: import('node:http').Server;
let baseUrl: string;
let genBookId: string;
let designBookId: string;
let designBookDir: string;
let designQwenVoiceForCharacter: typeof import('./qwen-voice.js').designQwenVoiceForCharacter;

function writeBook(dir: string, id: string, title: string, series: string, characters: object[]) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
      author: AUTHOR,
      series,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-1' }],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-05-23T00:00:00.000Z',
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'qwen-tier-guard-'));
  audioDir = mkdtempSync(join(tmpdir(), 'qwen-tier-guard-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  process.env.GEN_WORKERS = '1';

  /* Sequential awaits, not Promise.all: a Promise.all of dynamic imports races the async vi.mock
     factories above (#2083). */
  const { generationRouter } = await import('./generation.js');
  ({ designQwenVoiceForCharacter } = await import('./qwen-voice.js'));
  const { makeBookId } = await import('../workspace/paths.js');
  const cacheModule = await import('../store/analysis-cache.js');
  const settings = await import('../workspace/user-settings.js');
  /* Qwen healthy: an unavailable Qwen takes the separate plan-135 path, which this suite is not about. */
  settings.setLastKnownQwenInstallState('loaded');

  genBookId = makeBookId(AUTHOR, SERIES, GEN_TITLE);
  writeBook(join(workspaceRoot, 'books', AUTHOR, SERIES, GEN_TITLE), genBookId, GEN_TITLE, SERIES, [
    { id: 'wren', name: 'Wren', ttsEngine: 'qwen' },
  ]);
  await cacheModule.saveAnalysisCache(`m_${genBookId}`, {
    chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' }] },
  });

  designBookId = makeBookId(AUTHOR, DESIGN_SERIES, DESIGN_TITLE);
  designBookDir = join(workspaceRoot, 'books', AUTHOR, DESIGN_SERIES, DESIGN_TITLE);
  writeBook(designBookDir, designBookId, DESIGN_TITLE, DESIGN_SERIES, [
    {
      id: 'char1',
      name: 'Char One',
      voiceId: 'v_char1',
      voiceUuid: 'uuid-char1',
      voiceStyle: 'a warm narrator',
      evidence: [{ quote: '"Hello there."' }],
    },
  ]);

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});

beforeEach(async () => {
  reconcileCalls.length = 0;
  heldCalls.length = 0;
  immediateAnswer = null;
  const { setProbeSidecarHealthProvider } = await import('../gpu/sidecar-health-gate.js');
  setProbeSidecarHealthProvider(async () => ({ kokoroLoaded: false, devices: {} }));
});

afterEach(async () => {
  const { setProbeSidecarHealthProvider } = await import('../gpu/sidecar-health-gate.js');
  setProbeSidecarHealthProvider(null);
  /* Never leave a parked call (and the counter it holds) behind for the next case. */
  for (const c of heldCalls.splice(0)) c.respond(okAudio());
});

function okAudio(): Response {
  return new Response(Buffer.alloc(24_000 * 2 * 0.3), { status: 200, headers: { 'X-Sample-Rate': '24000' } });
}

/** The run-start reconcile, driven by a real chapter POST. `modelKey` picks the run's tier. */
async function runChapterPost(modelKey: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/books/${genBookId}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, chapterIds: [1], force: true }),
  });
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

function params(over: Partial<import('./qwen-voice.js').DesignQwenVoiceParams> = {}): import('./qwen-voice.js').DesignQwenVoiceParams {
  return {
    bookId: designBookId,
    bookDir: designBookDir,
    character: {
      id: 'char1',
      name: 'Char One',
      voiceId: 'v_char1',
      voiceUuid: 'uuid-char1',
      voiceStyle: 'a warm narrator',
      evidence: [{ quote: '"Hello there."' }],
      role: 'supporting',
    },
    characterId: 'char1',
    persona: 'a warm narrator',
    sampleVoiceId: 'v_char1',
    modelKey: QWEN_KEY,
    language: 'English',
    ...over,
  } as import('./qwen-voice.js').DesignQwenVoiceParams;
}

async function waitForHeld(path: string): Promise<HeldCall> {
  await vi.waitFor(() => expect(heldCalls.some((c) => c.url.endsWith(path))).toBe(true), { timeout: 5_000 });
  return heldCalls.find((c) => c.url.endsWith(path))!;
}

/** Hold `call` open, prove the run-start reconcile stays off, release, then prove it evicts. */
async function assertGuardsReconcile(opts: {
  settle: Promise<unknown>;
  held: HeldCall;
  runModelKey: string;
  evictingKeep: Record<string, boolean>;
}): Promise<void> {
  const { settle, held, runModelKey, evictingKeep } = opts;
  await runChapterPost(runModelKey);
  expect(reconcileCalls).toHaveLength(0); // held: no eviction may be issued
  held.respond(okAudio());
  await settle;
  await runChapterPost(runModelKey);
  expect(reconcileCalls.length).toBeGreaterThan(0); // released: the same POST now reconciles
  expect(reconcileCalls[0]![0]).toMatchObject(evictingKeep);
}

describe('G1 — a live design or mint blocks the generation run-start reconcile (plan 293 §5.0)', () => {
  it('design (/qwen/design-voice): a Quality book would drop the 0.6B VoiceDesign host, but not while it runs', async () => {
    const settle = designQwenVoiceForCharacter(params());
    const held = await waitForHeld('/qwen/design-voice');
    await assertGuardsReconcile({
      settle,
      held,
      runModelKey: 'qwen3-tts-1.7b',
      evictingKeep: { keep06: false, keep17: true },
    });
  }, 30_000);

  it('mint (/qwen/mint-variant): a Standard book would drop the 1.7B Base, but not while it runs', async () => {
    const settle = designQwenVoiceForCharacter(params({ emotion: 'angry' }));
    const held = await waitForHeld('/qwen/mint-variant');
    await assertGuardsReconcile({
      settle,
      held,
      runModelKey: 'qwen3-tts-0.6b',
      evictingKeep: { keep06: true, keep17: false },
    });
  }, 30_000);

  it('fallback design (mint answered 503 base17-unavailable): the second transport is guarded too', async () => {
    immediateAnswer = (url) =>
      url.endsWith('/qwen/mint-variant')
        ? new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 })
        : null;
    const settle = designQwenVoiceForCharacter(params({ emotion: 'angry' }));
    /* The mint was answered at once and is over; the call now parked is the fallback design. */
    const held = await waitForHeld('/qwen/design-voice');
    await assertGuardsReconcile({
      settle,
      held,
      runModelKey: 'qwen3-tts-1.7b',
      evictingKeep: { keep06: false, keep17: true },
    });
  }, 30_000);
});
