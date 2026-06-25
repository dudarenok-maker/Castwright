/* Integration tests for POST /api/books/:bookId/generation.

   The real route walks: validate modelKey → load cast.json → load analysis
   cache → for each chapter call synthesiseChapter → encode PCM → write
   .mp3 + segments.json → emit ticks. We mock synthesiseChapter so the test
   doesn't depend on a live sidecar or Gemini API key, and we control its
   behaviour per case (happy, throws, throws same reason twice).

   Mirrors the supertest + tempdir pattern used by chapter-audio.test.ts and
   book-state.test.ts. The route emits Server-Sent Events as `data: <json>`
   frames; the parseTicks helper splits the response body back into typed
   ticks for assertions. */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Mock synthesiseChapter so the route never needs a real TTS provider. The
   mock is mutable per test case via the synthesiseImpl ref. */
let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  /* Spread the real module so the route's other imports from here
     (toVoiceLike + buildHintFromCast, used to compute the per-character
     resolvedVoiceName snapshot since plan 108 Wave 2b) keep their real
     implementations — they're pure transforms. Only synthesiseChapter is
     stubbed so the route never needs a live TTS provider. */
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: (args: unknown) => synthesiseImpl(args),
  };
});

/* Mock selectTtsProvider so the route doesn't reach for GEMINI_API_KEY or a
   live sidecar — the route only uses the provider to feed into
   synthesiseChapter, which is itself mocked above, so the value is a
   throwaway sentinel. */
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});
/* No sidecar in the test. The preload gate now POLLS through a respawn (plan
   147), so a qwen/kokoro run with nothing at :9000 would wait out its full
   readiness budget and hang. Stub it to a no-op — the gate is exercised
   directly in ensure-sidecar-loaded.test.ts, not through this route suite. */
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => undefined,
  /* Empty so the side-11 boundary-recycle check (the only SIDECAR_ENGINES
     consumer) is a no-op here — these tests don't exercise it and must not
     fire a real /health probe at a dev-box sidecar. */
  SIDECAR_ENGINES: new Set(),
}));

/* srv-28 — control the disk-space probe so the disk guard is deterministic.
   Default: ample free space (guard → ok, no tick) so the existing cases are
   untouched. A test flips `diskFreeGb` low to exercise the warn-tick path. */
let diskFreeGb = 9999;
vi.mock('../diagnostics/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../diagnostics/disk.js')>();
  return {
    ...actual,
    probeDiskSpace: async (path: string) => ({ status: 'ok' as const, freeGb: diskFreeGb, path }),
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Generation Route Test';
const MANUSCRIPT_ID = 'm_gen_route_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

interface ParsedTick {
  type: string;
  [k: string]: unknown;
}

function parseTicks(body: string): ParsedTick[] {
  return body
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      return JSON.parse(lines.join('\n')) as ParsedTick;
    });
}

beforeAll(async () => {
  /* Plan 45 (vitest pool tuning) — async mkdtemp under Windows tmpdir contention. */
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-generation-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ generationRouter }, { makeBookId }, cacheModule] = await Promise.all([
    import('./generation.js'),
    import('../workspace/paths.js'),
    import('../store/analysis-cache.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
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
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'narrator', name: 'Narrator', attributes: ['observational'] }],
    }),
  );

  /* Seed the analysis cache — the route reads it from server/handoff/cache,
     not from the workspace, so we have to drive it via the module's own
     saveAnalysisCache helper. */
  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
      2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
});

afterAll(async () => {
  const cacheModule = await import('../store/analysis-cache.js');
  await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  /* Default: ample disk + DISK_GUARD_MODE unset (defaults to warn, but the
     ample free space keeps the guard at ok so no tick is emitted). */
  diskFreeGb = 9999;
  delete process.env.DISK_GUARD_MODE;
  /* Default: every synthesise call succeeds with a one-segment PCM body. */
  synthesiseImpl = async () => ({
    pcm: Buffer.alloc(2),
    sampleRate: 24000,
    durationSec: 1,
    segments: [
      {
        characterId: 'narrator',
        voiceName: 'Zephyr',
        sampleStart: 0,
        sampleEnd: 1,
        sentenceIds: [1],
      },
    ],
  });
});

describe('POST /api/books/:bookId/generation', () => {
  it('happy path: emits progress + chapter_complete + idle for every chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    /* At least: progress for ch1, chapter_assembling ch1, chapter_complete ch1,
       progress for ch2, chapter_assembling ch2, chapter_complete ch2, idle. */
    expect(ticks.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(true);
    expect(ticks.some((t) => t.type === 'chapter_complete' && t.chapterId === 2)).toBe(true);
    expect(ticks[ticks.length - 1].type).toBe('idle');
    /* chapter_complete must carry durationSec — belt-and-suspenders with
       chapter_assembling so the Listen view chapter row never lags at
       '00:00' when the assembling tick is dropped (cross-book guard,
       parallel-chapter coalesce, hidden tab). Matches the synthesise
       impl in beforeEach which returns durationSec: 1. */
    const liveCompletes = ticks.filter(
      (t) => t.type === 'chapter_complete' && typeof t.runTotal === 'number',
    );
    expect(liveCompletes.length).toBeGreaterThan(0);
    for (const tick of liveCompletes) {
      expect(tick.durationSec).toBe(1);
    }
  });

  it('progress tick from a group completion carries that group\'s completed sentence ids (fs-13)', async () => {
    /* fs-13: each completed-group tick must carry the just-completed group's
       sentence ids + its character, so the frontend can track an EXACT per-
       character done set under out-of-order completion — while the chapter
       counter (currentLine) stays the monotonic group count it is today.
       Fire two completions out of narrative order (a late-clustered character
       finishes first) to mirror parallel dispatch. */
    synthesiseImpl = async (args: unknown) => {
      const opts = args as {
        onGroupComplete?: (e: {
          group: { index: number; characterId: string; sentenceIds: number[] };
          totalGroups: number;
          accumulatedSec: number;
          completed: number;
        }) => void;
      };
      opts.onGroupComplete?.({
        group: { index: 7, characterId: 'wren', sentenceIds: [14, 15] },
        totalGroups: 10,
        accumulatedSec: 0,
        completed: 1,
      });
      opts.onGroupComplete?.({
        group: { index: 0, characterId: 'narrator', sentenceIds: [1] },
        totalGroups: 10,
        accumulatedSec: 0,
        completed: 2,
      });
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: [1],
          },
        ],
      };
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    const completed = ticks.filter(
      (t) => t.type === 'progress' && Array.isArray((t as { completedSentenceIds?: unknown }).completedSentenceIds),
    ) as Array<ParsedTick & { completedSentenceIds: number[]; characterId: string; currentLine: number }>;
    /* Each completed group surfaces its own sentence ids + character. */
    expect(
      completed.some((t) => t.characterId === 'wren' && t.completedSentenceIds.join(',') === '14,15'),
    ).toBe(true);
    expect(
      completed.some((t) => t.characterId === 'narrator' && t.completedSentenceIds.join(',') === '1'),
    ).toBe(true);
    /* currentLine stays monotonic within a chapter's completed-group ticks
       (the chapter-level count is unchanged by fs-13; it resets per chapter). */
    const ch1Lines = completed.filter((t) => t.chapterId === 1).map((t) => t.currentLine);
    expect(ch1Lines.length).toBeGreaterThan(0);
    expect(ch1Lines).toEqual([...ch1Lines].sort((a, b) => a - b));
  });

  it('rejects an unsupported modelKey with a stream-level chapter_failed and ends', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'not-a-real-model' });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].chapterId).toBeUndefined();
    expect(ticks[0].errorReason).toMatch(/modelKey/i);
  });

  it('srv-28: emits a disk_low warning tick (warn mode) when free space is tight, run proceeds', async () => {
    diskFreeGb = 0.5; // well below the estimate + headroom
    process.env.DISK_GUARD_MODE = 'warn';
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    const warn = ticks.find((t) => t.type === 'warning' && t.code === 'disk_low');
    expect(warn).toBeDefined();
    expect(String(warn!.message)).toMatch(/disk space/i);
    /* Warn is non-blocking — the chapters still render. */
    expect(ticks.some((t) => t.type === 'chapter_complete')).toBe(true);
  });

  it('srv-28: block mode short-circuits with a disk-full chapter_failed and ends', async () => {
    diskFreeGb = 0.2;
    process.env.DISK_GUARD_MODE = 'block';
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].errorCode).toBe('disk-full');
    expect(ticks[0].chapterId).toBeUndefined();
    expect(String(ticks[0].remediation)).toMatch(/free up disk space/i);
  });

  /* ── Pause endpoint + sticky-across-reload contract ──────────────── */

  it('POST /generation/pause sees a registered job and reports paused:true', async () => {
    /* The route registers its RunningJob in inFlightByBook BEFORE the
       chapter loop's first synthesiseChapter call. We block synth until
       synthStarted resolves so /pause races against the loop's await.
       The fact that the pause endpoint sees the job and returns
       paused:true proves the route-to-pause coupling works. The actual
       abort delivery is exercised independently (controller.abort + the
       loop's AbortError catch are tiny mechanical pieces). */
    let resolveSynthStarted: () => void;
    const synthStarted = new Promise<void>((r) => {
      resolveSynthStarted = r;
    });
    /* synth blocks until either signal aborts or the test timeout fires.
       Honouring abort is essential — without it the route's loop never
       breaks, inFlightByBook stays populated, and the next test sees a
       leftover entry (the no-op pause case below would then report
       paused:true and fail). */
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) {
          reject(abortErr());
          return;
        }
        signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
        resolveSynthStarted();
      });
    };

    /* Fire-and-forget — we don't await this. */
    const genReq = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    /* swallow the (eventually-aborted) promise to avoid an unhandled
       rejection on the worker. */
    genReq.then(
      () => {},
      () => {},
    );

    await synthStarted;
    const pauseRes = await request(app).post(`/api/books/${bookId}/generation/pause`).send({});
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body).toEqual({ ok: true, paused: true });
  }, 8_000);

  it('POST /generation/pause when no job is running is an idempotent no-op (200, paused:false)', async () => {
    /* Double-click on Pause, or a Pause that arrives after the queue
       drained naturally, must NOT 404 — the middleware fires this
       blindly on every setPaused(true) without coordinating with the
       loop's end-of-life. */
    const res = await request(app).post(`/api/books/${bookId}/generation/pause`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, paused: false });
  });

  it('escalates to fatal on the second identical non-fatal failure (cascade kill)', async () => {
    /* This is the regression for the screenshot — chapter 1 fails with
       "index out of range in self" (which we classify as fatal directly),
       but for a non-mapped error the cascade detector kicks in on the
       second repeat. Use a generic message here so we can prove the
       cascade itself works without relying on the XTTS-specific pattern
       (that's covered in generation-error.test.ts). */
    synthesiseImpl = async () => {
      throw new Error('Sidecar returned 500: weird thing');
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    const failed = ticks.filter((t) => t.type === 'chapter_failed');
    /* Chapter 1 fails non-fatally (first hit), chapter 2 escalates to fatal
       (second hit, same reason). Run must stop there — no third failure
       even though there are no more chapters; the loop break + idle is
       what matters. */
    expect(failed).toHaveLength(2);
    expect(failed[1].errorReason as string).toMatch(/same failure repeated|stopping run/i);
    expect(ticks[ticks.length - 1].type).toBe('idle');
  });

  it('skips chapters whose excluded flag is true even with force=true / explicit chapterIds', async () => {
    /* Excluded chapters never get audio — the user opted out of narrating
       them (typically front/back-matter like Dedication, Copyright). The
       route must skip them in:
       - default mode (no requestedIds, chapterAudioExists check)
       - force=true (which would normally regenerate everything)
       - explicit chapterIds (defense-in-depth against a frontend bug
         that lets an excluded id slip into the list)
       Also: the catch-up replay must not emit a chapter_complete for an
       excluded chapter even if stale audio is still on disk. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const fs = await import('node:fs');
    const original = fs.readFileSync(statePath, 'utf8');
    const stateJson = JSON.parse(original) as {
      chapters: Array<{ id: number; excluded?: boolean }>;
    };
    stateJson.chapters = stateJson.chapters.map((c) => (c.id === 1 ? { ...c, excluded: true } : c));
    writeFileSync(statePath, JSON.stringify(stateJson));

    /* Clear any stale audio left by earlier tests so the assertions are
       deterministic. */
    const audioRoot = join(bookDir, 'audio');
    if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });

    let synthCalls = 0;
    synthesiseImpl = async () => {
      synthCalls += 1;
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: [1],
          },
        ],
      };
    };

    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1, 2] });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      const completes = ticks.filter((t) => t.type === 'chapter_complete');
      /* Exactly one chapter_complete — for the non-excluded ch2. */
      expect(completes.map((t) => t.chapterId)).toEqual([2]);
      /* And synthesiseChapter must have been invoked exactly once. */
      expect(synthCalls).toBe(1);
    } finally {
      writeFileSync(statePath, original);
    }
  });

  it('preserves prior chapter audio as .previous.* before the new render lands', async () => {
    /* Rollback model: every regen renames the existing
       <slug>.{mp3,segments.json} to <slug>.previous.* BEFORE the new
       render writes. The revision-diff player auditions the preserved
       pair (A) vs the new render (B). First renders no-op because
       findChapterAudio returns null — verified by `preserved=false` in
       the helper's own tests. Here we verify the integration: seed
       prior audio, run regen, assert both .previous.* files exist with
       the prior content. */
    const fs = await import('node:fs');
    const audioRoot = join(bookDir, 'audio');
    /* Clear any leftovers from earlier tests so the assertions are
       deterministic. */
    if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });
    fs.mkdirSync(audioRoot, { recursive: true });
    fs.writeFileSync(join(audioRoot, '01-chapter-one.mp3'), 'PRIOR-mp3-bytes');
    fs.writeFileSync(
      join(audioRoot, '01-chapter-one.segments.json'),
      JSON.stringify({ prior: true }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    expect(res.status).toBe(200);

    /* New render landed at live names. */
    expect(fs.existsSync(join(audioRoot, '01-chapter-one.mp3'))).toBe(true);
    expect(fs.existsSync(join(audioRoot, '01-chapter-one.segments.json'))).toBe(true);
    /* Prior pair was preserved with the OLD content (not the freshly
       rendered new pair). */
    expect(fs.existsSync(join(audioRoot, '01-chapter-one.previous.mp3'))).toBe(true);
    expect(fs.readFileSync(join(audioRoot, '01-chapter-one.previous.mp3'), 'utf8')).toBe(
      'PRIOR-mp3-bytes',
    );
    expect(fs.existsSync(join(audioRoot, '01-chapter-one.previous.segments.json'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(join(audioRoot, '01-chapter-one.previous.segments.json'), 'utf8')),
    ).toEqual({ prior: true });
  });

  it('catch-up replay skips in-scope chapters so a force-regen does not snap back to "Done"', async () => {
    /* Repro for screenshot 2026-05-21 174722: user changed a voice setting
       on The Ebb (every chapter Done with audio on disk), hit "Regenerate
       this chapter" on ch3, the activity log fired the right events but
       the chapter row immediately snapped back to "Done" and no progress
       UI ever appeared. Root cause: the catch-up replay (designed to snap
       a reconnecting client to current on-disk state) was emitting a
       chapter_complete for the very chapter about to be regenerated,
       which raced the synthesis loop and froze the frontend row at the
       stale duration.

       Fix: the catch-up replay must skip any chapter in the current run's
       scope. This test pins that invariant — and the negative control
       (chapter 2 is OUT of scope and still gets its catch-up tick)
       confirms the replay is still doing its job for unrelated chapters.

       Catch-up tick convention (see Bug E doc-comment below): catch-up
       ticks lack runTotal; live ticks always carry it. */
    const fs = await import('node:fs');
    const audioRoot = join(bookDir, 'audio');
    if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });
    fs.mkdirSync(audioRoot, { recursive: true });
    /* Both chapters have audio on disk before the request — like The Ebb. */
    fs.writeFileSync(join(audioRoot, '01-chapter-one.mp3'), 'PRIOR-ch1');
    fs.writeFileSync(join(audioRoot, '01-chapter-one.segments.json'), '{}');
    fs.writeFileSync(join(audioRoot, '02-chapter-two.mp3'), 'PRIOR-ch2');
    fs.writeFileSync(join(audioRoot, '02-chapter-two.segments.json'), '{}');

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);

    /* In-scope chapter (ch1): NO catch-up chapter_complete (would lack
       runTotal), MUST have at least one live one (carries runTotal). */
    const ch1Completes = ticks.filter((t) => t.type === 'chapter_complete' && t.chapterId === 1);
    const ch1Catchup = ch1Completes.filter((t) => typeof t.runTotal !== 'number');
    const ch1Live = ch1Completes.filter((t) => typeof t.runTotal === 'number');
    expect(ch1Catchup).toHaveLength(0);
    expect(ch1Live.length).toBeGreaterThan(0);

    /* Out-of-scope chapter (ch2): MUST get a catch-up chapter_complete
       (proves the replay still works for chapters not in the regen
       target). No live one — ch2 isn't synthesised this run. */
    const ch2Completes = ticks.filter((t) => t.type === 'chapter_complete' && t.chapterId === 2);
    const ch2Catchup = ch2Completes.filter((t) => typeof t.runTotal !== 'number');
    expect(ch2Catchup).toHaveLength(1);
  });

  it('classifies XTTS "index out of range in self" as fatal on first hit', async () => {
    synthesiseImpl = async () => {
      throw new Error('Local TTS sidecar returned 500: {"detail":"index out of range in self"}');
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    const ticks = parseTicks(res.text);
    const failed = ticks.filter((t) => t.type === 'chapter_failed');
    /* The error classifier maps "index out of range" directly to fatal, so
       chapter 1 fails and the run stops — chapter 2 is never attempted. */
    expect(failed).toHaveLength(1);
    expect(failed[0].errorReason as string).toMatch(/voice catalog is out of sync/i);
    expect(ticks[ticks.length - 1].type).toBe('idle');
  });

  it('fails an all-excluded chapter with a distinct reason, not a 0-byte success (fs-58 Unit B)', async () => {
    /* Seed ch1 with sentences that are ALL excludeFromSynthesis:true.
       The guard must fire before synthesis and broadcast chapter_failed
       with the "flagged non-story" reason — NOT produce a 0-byte complete. */
    const cacheModule = await import('../store/analysis-cache.js');
    await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: {
        1: [
          {
            id: 1,
            chapterId: 1,
            characterId: 'narrator',
            text: 'p. 42',
            excludeFromSynthesis: true,
          },
        ],
        2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
      },
    });
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      const failed = ticks.find(
        (t) => t.type === 'chapter_failed' && t.chapterId === 1,
      );
      expect(failed).toBeDefined();
      expect(failed?.errorReason as string).toMatch(/flagged non-story/i);
      /* The run must NOT produce a chapter_complete for the all-excluded chapter. */
      expect(ticks.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(false);
    } finally {
      /* Restore the seeded cache so other tests are unaffected. */
      await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
        chapters: {
          1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
          2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
        },
      });
    }
  });
});

/* Bug E — every LIVE broadcast tick (progress / chapter_assembling /
   chapter_complete / chapter_failed) carries run-level aggregates so the
   client's global header pill keeps moving even when the user has
   navigated to a different book and the per-chapter tick reducer drops
   the per-row mutation.

   Note on catch-up replay: chapter_complete ticks emitted by the
   pre-loop catch-up replay (line 248-266 in generation.ts) are sent
   via the subscriber's direct `send`, not through `broadcast`, because
   they pre-date the job and there's no run to aggregate over. Tests
   below split "catch-up" from "live" by the presence of the runTotal
   field — catch-up ticks lack it, live ticks always carry it. */
describe('POST /api/books/:bookId/generation — Qwen→Kokoro fallback is loud, never silent', () => {
  /* Regression for the 2026-05-29 stale-build incident: a whole Qwen book was
     silently rendered in Kokoro (wrong voices) because Qwen read unavailable
     and the only signal was an unsurfaced per-segment stamp. The route MUST
     emit a `warning` tick at setup so the user sees the downgrade. */
  it('emits a warning tick when a Qwen cast renders while Qwen is unavailable', async () => {
    const { setLastKnownQwenInstallState } = await import('../workspace/user-settings.js');
    setLastKnownQwenInstallState('not-installed');
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'qwen3-tts-0.6b', force: true });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      const warning = ticks.find((t) => t.type === 'warning');
      expect(warning).toBeDefined();
      expect(warning?.code).toBe('qwen_unavailable_kokoro_fallback');
      expect(String(warning?.message)).toMatch(/Kokoro/);
      expect(warning?.qwenInstallState).toBe('not-installed');
    } finally {
      setLastKnownQwenInstallState('not-installed');
    }
  });

  it('does NOT emit the fallback warning when Qwen is loaded', async () => {
    const { setLastKnownQwenInstallState } = await import('../workspace/user-settings.js');
    setLastKnownQwenInstallState('loaded');
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'qwen3-tts-0.6b', force: true });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      expect(
        ticks.some(
          (t) => t.type === 'warning' && t.code === 'qwen_unavailable_kokoro_fallback',
        ),
      ).toBe(false);
    } finally {
      setLastKnownQwenInstallState('not-installed');
    }
  });
});

describe('POST /api/books/:bookId/generation — Bug E run aggregates on every tick', () => {
  it('every LIVE broadcast tick carries runDone / runTotal / runInProgress', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    /* Live ticks are anything that went through broadcast — they all
       carry the three aggregates. Catch-up replay ticks (chapter_complete
       for chapters already on disk before this run started) lack them
       by design. */
    const liveTicks = ticks.filter((t) => typeof t.runTotal === 'number');
    expect(liveTicks.length).toBeGreaterThan(0);
    for (const t of liveTicks) {
      expect(typeof t.runDone).toBe('number');
      expect(typeof t.runInProgress).toBe('number');
      /* Invariant: done + inProgress never exceeds total. */
      expect((t.runDone as number) + (t.runInProgress as number)).toBeLessThanOrEqual(
        t.runTotal as number,
      );
    }
  });

  it('runDone jumps to 1 → 2 across the two live chapter_complete ticks (force regen of two chapters)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    const ticks = parseTicks(res.text);
    /* Filter to LIVE chapter_complete (carries runTotal). */
    const liveCompletes = ticks.filter(
      (t) => t.type === 'chapter_complete' && typeof t.runTotal === 'number',
    );
    expect(liveCompletes.length).toBe(2);
    /* Force regen of both chapters: runDoneBase counts chapters not in
       targetChapters with audio on disk — but BOTH chapters ARE in the
       force target set, so runDoneBase=0. After the first chapter
       completes broadcast carries runDone=1; after the second, runDone=2. */
    expect(liveCompletes[0].runDone).toBe(1);
    expect(liveCompletes[1].runDone).toBe(2);
    expect(liveCompletes[0].runTotal).toBe(2);
    expect(liveCompletes[1].runTotal).toBe(2);
    /* After each chapter_complete the in-progress count goes back to 0. */
    expect(liveCompletes[0].runInProgress).toBe(0);
    expect(liveCompletes[1].runInProgress).toBe(0);
  });

  it('runInProgress is 1 during the first progress tick (chapter is between loop entry and chapter_complete)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    const ticks = parseTicks(res.text);
    /* The very first progress tick (sent at chapter loop entry, before
       synthesise is called) lands while runInProgress contains that
       chapter. */
    const firstProgress = ticks.find(
      (t) => t.type === 'progress' && t.chapterId === 1 && t.progress === 0.01,
    );
    expect(firstProgress).toBeDefined();
    expect(firstProgress!.runInProgress).toBe(1);
    expect(firstProgress!.runTotal).toBe(2);
  });
});

/* ── Plan 70c — auto-heal empty analysis cache from manuscript-edits.json ─
   Pre-fix, a merge/split/reorder wiped server/handoff/cache/{mId}.json
   and the next Generate POST halted with "No analysed sentences cached
   for this book." The route now rebuilds the cache from
   manuscript-edits.json transparently before falling through to that
   error path. */
describe('POST /api/books/:bookId/generation — plan 70c auto-heal', () => {
  let editsPath: string;
  let cacheModule: typeof import('../store/analysis-cache.js');
  let fsModule: typeof import('node:fs');

  beforeAll(async () => {
    cacheModule = await import('../store/analysis-cache.js');
    fsModule = await import('node:fs');
    const { manuscriptEditsJsonPath } = await import('../workspace/paths.js');
    editsPath = manuscriptEditsJsonPath(bookDir);
  });

  /* Each case manipulates the on-disk cache; restore the seeded state
     after so unrelated tests in other describe blocks still find their
     pre-seeded cache. */
  afterEach(async () => {
    if (fsModule.existsSync(editsPath)) fsModule.rmSync(editsPath);
    await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: {
        1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
        2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
      },
    });
    /* Clear any chapter audio rendered during the auto-heal happy-path
       case so subsequent tests start from the same on-disk audio
       baseline as beforeAll left things in. */
    const audioRoot = join(bookDir, 'audio');
    if (fsModule.existsSync(audioRoot))
      fsModule.rmSync(audioRoot, { recursive: true, force: true });
  });

  it('rebuilds the cache from manuscript-edits.json when the cache is empty and proceeds', async () => {
    await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
    fsModule.writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' },
          { id: 1, chapterId: 2, characterId: 'narrator', text: 'World.' },
        ],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    /* No halting error fires — generation proceeds through both chapters. */
    expect(
      ticks.some(
        (t) =>
          t.type === 'chapter_failed' &&
          typeof t.errorReason === 'string' &&
          /No analysed sentences cached/i.test(t.errorReason),
      ),
    ).toBe(false);
    expect(ticks.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(true);
    /* Cache file now exists on disk with both chapters re-keyed. */
    const restored = await cacheModule.loadAnalysisCache(MANUSCRIPT_ID);
    expect(Object.keys(restored.chapters).sort()).toEqual(['1', '2']);
  });

  it('still emits the original error when both cache AND manuscript-edits.json are empty', async () => {
    /* Never-analysed book — nothing to rebuild from. The original
       error path stays in place so the user knows what to do. */
    await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
    /* No manuscript-edits.json written — rebuild attempt finds nothing
       and the second emptiness check fires the error. */

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].errorReason as string).toMatch(/No analysed sentences cached/i);
  });
});

/* ── Plan 80 — regenerate applies manuscript-edits overlay before synth ──
   The user edits per-sentence speaker attribution in the manuscript view;
   those edits flush to manuscript-edits.json via PUT /state. Pre-fix, the
   generation route loaded only the analysis cache (the analyzer's frozen
   output) and never overlaid the edits, so regenerate rendered audio with
   the original speakers — the user's reassignments never reached TTS.

   Fix promotes rebuildCacheFromEdits from the plan-70c "cache empty"
   auto-heal to "any edits exist" so synth always sees the canonical
   post-edit sentence list. These tests pin that: a synth-args capture
   asserts the synthesiseChapter receives the EDITED characterId / split
   offspring, not the cached values. */
describe('POST /api/books/:bookId/generation — plan 80 edits override cache', () => {
  let editsPath: string;
  let cacheModule: typeof import('../store/analysis-cache.js');
  let fsModule: typeof import('node:fs');

  beforeAll(async () => {
    cacheModule = await import('../store/analysis-cache.js');
    fsModule = await import('node:fs');
    const { manuscriptEditsJsonPath } = await import('../workspace/paths.js');
    editsPath = manuscriptEditsJsonPath(bookDir);
  });

  afterEach(async () => {
    if (fsModule.existsSync(editsPath)) fsModule.rmSync(editsPath);
    await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: {
        1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
        2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
      },
    });
    const audioRoot = join(bookDir, 'audio');
    if (fsModule.existsSync(audioRoot))
      fsModule.rmSync(audioRoot, { recursive: true, force: true });
  });

  it('passes the EDITED characterId to synth, not the cached one (regen-after-reassign)', async () => {
    /* Cast has both narrator and ellie so the reassigned id resolves. */
    fsModule.writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
          { id: 'ellie', name: 'Ellie', attributes: ['warm'] },
        ],
      }),
    );
    /* Cache says sentence 1 is the narrator — this is the stale analyzer
       view that pre-fix regenerate would have synthesised. */
    await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
      chapters: {
        1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
        2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
      },
    });
    /* User opened the manuscript view and reassigned sentence 1 from
       narrator to ellie. The manuscript persistence middleware flushed
       the full sentence snapshot to manuscript-edits.json. */
    fsModule.writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'ellie', text: 'Hello.' },
          { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
        ],
      }),
    );

    /* Capture every call's sentences[] so we can assert what synth actually
       received per chapter. */
    const synthCallsByChapter: Record<number, Array<{ id: number; characterId: string }>> = {};
    synthesiseImpl = async (args: unknown) => {
      const a = args as {
        sentences: Array<{ id: number; chapterId: number; characterId: string }>;
      };
      const ch = a.sentences[0]?.chapterId;
      if (typeof ch === 'number') {
        synthCallsByChapter[ch] = a.sentences.map((s) => ({
          id: s.id,
          characterId: s.characterId,
        }));
      }
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: a.sentences[0]?.characterId ?? 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: a.sentences.map((s) => s.id),
          },
        ],
      };
    };

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);

    /* The smoking-gun assertion: chapter 1's sentence 1 is rendered with
       characterId 'ellie' (the user's edit), NOT 'narrator' (the stale
       cache). Pre-fix this would have been 'narrator' and the user's
       reassignment would have been silently discarded by synth. */
    expect(synthCallsByChapter[1]).toEqual([{ id: 1, characterId: 'ellie' }]);
    /* Chapter 2 had no edits to its existing sentence — confirms the
       overlay doesn't accidentally rewrite untouched chapters. */
    expect(synthCallsByChapter[2]).toEqual([{ id: 2, characterId: 'narrator' }]);
  });

  it('includes split-offspring sentences (ids above the cache max) in synth input', async () => {
    /* User split sentence 1 of chapter 1 in the manuscript view; the split
       offspring takes id maxId+1 (sentence 99 here — well above the cache's
       max id of 2). Pre-fix regenerate would have iterated analysis.chapters
       which only knows about the original sentence 1, dropping the split
       half on the floor. Post-fix the rebuild from edits picks up both. */
    fsModule.writeFileSync(
      editsPath,
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' },
          { id: 99, chapterId: 1, characterId: 'narrator', text: 'There.' },
          { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
        ],
      }),
    );

    const synthCallsByChapter: Record<number, number[]> = {};
    synthesiseImpl = async (args: unknown) => {
      const a = args as {
        sentences: Array<{ id: number; chapterId: number; characterId: string }>;
      };
      const ch = a.sentences[0]?.chapterId;
      if (typeof ch === 'number') synthCallsByChapter[ch] = a.sentences.map((s) => s.id);
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: a.sentences.map((s) => s.id),
          },
        ],
      };
    };

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    /* Both ids reach synth, sorted ascending (rebuildCacheFromEdits sorts
       per chapter — see analysis-cache-rebuild.ts:50-52). */
    expect(synthCallsByChapter[1]).toEqual([1, 99]);
  });

  it('leaves the cache untouched when manuscript-edits.json is absent (rebuild skipped)', async () => {
    /* Never-edited book — manuscript-edits.json doesn't exist, hasEdits
       is false, rebuild is skipped, cache survives byte-for-byte. Guards
       against accidentally clobbering a freshly-analysed book's cache
       with whatever rebuild semantics happen to do on an empty file. */
    /* Take a fingerprint of the cache before the request. */
    const before = await cacheModule.loadAnalysisCache(MANUSCRIPT_ID);
    const beforeJson = JSON.stringify(before.chapters);

    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);

    const after = await cacheModule.loadAnalysisCache(MANUSCRIPT_ID);
    expect(JSON.stringify(after.chapters)).toBe(beforeJson);
  });
});

/* ── Queue-sole concurrency — one POST = one chapter ──────────────────────
   The within-book worker pool (plan 87) was removed: the queue dispatcher
   fires a separate POST per chapter, and the server keys in-flight jobs by
   `${bookId}::${chapterId}`. These cases pin the new contract:
     - same-book non-abort: two concurrent POSTs for different chapters of
       one book both complete; neither aborts the other.
     - same-chapter displace: two POSTs for the SAME book + chapter — the
       first is aborted (regen-same-chapter), the second completes.
     - /pause aborts EVERY in-flight job for the book.
     - isGenerationActive stays book-accurate while any job runs and flips
       false once all jobs drain.

   A small gating harness lets two requests overlap deterministically:
   synthesiseImpl blocks each chapter's synth on a per-chapter deferred so we
   can prove both chapters are mid-synth at once before releasing them. */
describe('POST /api/books/:bookId/generation — queue-sole per-chapter concurrency', () => {
  afterEach(async () => {
    const fs = await import('node:fs');
    const audioRoot = join(bookDir, 'audio');
    if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });
  });

  /* Build a synthesiseImpl that records max concurrent in-flight synths and
     releases each call only once `releaseAfter` calls are simultaneously
     in-flight (or the abort signal fires). Lets two single-chapter POSTs
     overlap. */
  function gatedSynth(releaseAfter: number): { maxInflight: () => number } {
    let inflight = 0;
    let maxInflight = 0;
    const resolvers: Array<() => void> = [];
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise((resolve, reject) => {
        const settle = () => {
          inflight -= 1;
          resolve({
            pcm: Buffer.alloc(2),
            sampleRate: 24000,
            durationSec: 1,
            segments: [
              {
                characterId: 'narrator',
                voiceName: 'Zephyr',
                sampleStart: 0,
                sampleEnd: 1,
                sentenceIds: [1],
              },
            ],
          });
        };
        const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) {
          inflight -= 1;
          reject(abortErr());
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            inflight -= 1;
            reject(abortErr());
          },
          { once: true },
        );
        resolvers.push(settle);
        if (resolvers.length >= releaseAfter) {
          for (const r of resolvers.splice(0)) r();
        }
      });
    };
    return { maxInflight: () => maxInflight };
  }

  it('same-book non-abort: two concurrent POSTs (ch1, ch2) both complete, neither aborts the other', async () => {
    const gate = gatedSynth(2);
    /* Two POSTs, one chapter each, both forced — like the dispatcher firing
       two queue workers for the same book. */
    const p1 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    const p2 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [2] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    /* Both synths overlapped — proves the two same-book chapters ran
       concurrently rather than one aborting the other. */
    expect(gate.maxInflight()).toBe(2);
    const t1 = parseTicks(r1.text);
    const t2 = parseTicks(r2.text);
    /* Each stream completed its own chapter and ended on idle. */
    expect(t1.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(true);
    expect(t2.some((t) => t.type === 'chapter_complete' && t.chapterId === 2)).toBe(true);
    expect(t1[t1.length - 1].type).toBe('idle');
    expect(t2[t2.length - 1].type).toBe('idle');
    /* Neither stream emitted the OTHER book chapter's complete, and neither
       was silently aborted (an aborted run emits idle with no
       chapter_complete for its target). */
    expect(t1.some((t) => t.type === 'chapter_complete' && t.chapterId === 2)).toBe(false);
    expect(t2.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(false);
  }, 15_000);

  it('same-chapter displace: a second forced POST for the same chapter aborts the first', async () => {
    /* First POST blocks in synth (never released until aborted). The second
       POST for the SAME chapter must abort it (regen-same-chapter), so the
       first never emits chapter_complete and the second does. */
    let resolveStarted: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    let firstCallSeen = false;
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      if (!firstCallSeen) {
        firstCallSeen = true;
        /* First (to-be-displaced) call: block until aborted. */
        return new Promise((_resolve, reject) => {
          const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
          if (signal?.aborted) return reject(abortErr());
          signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
          resolveStarted();
        });
      }
      /* Second call: complete immediately. */
      return Promise.resolve({
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: [1],
          },
        ],
      });
    };

    const p1 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    p1.then(
      () => {},
      () => {},
    );
    await started;
    const r2 = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    const r1 = await p1;

    const t1 = parseTicks(r1.text);
    const t2 = parseTicks(r2.text);
    /* First run was displaced — no chapter_complete, just idle. */
    expect(t1.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(false);
    /* Second run completed the chapter. */
    expect(t2.some((t) => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(true);
  }, 15_000);

  it('/pause aborts ALL same-book jobs', async () => {
    /* Two concurrent single-chapter jobs both block in synth; one /pause
       call must abort BOTH so the GPU is fully freed for the analyzer. */
    let started = 0;
    let resolveBothStarted: () => void;
    const bothStarted = new Promise<void>((r) => {
      resolveBothStarted = r;
    });
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) return reject(abortErr());
        signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
        started += 1;
        if (started === 2) resolveBothStarted();
      });
    };

    const p1 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    const p2 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [2] });
    p1.then(
      () => {},
      () => {},
    );
    p2.then(
      () => {},
      () => {},
    );
    await bothStarted;

    const pauseRes = await request(app).post(`/api/books/${bookId}/generation/pause`).send({});
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body).toEqual({ ok: true, paused: true });

    /* Both runs unblocked via abort → both responses resolve with idle and
       neither chapter_complete. */
    const [r1, r2] = await Promise.all([p1, p2]);
    const t1 = parseTicks(r1.text);
    const t2 = parseTicks(r2.text);
    expect(t1.some((t) => t.type === 'chapter_complete')).toBe(false);
    expect(t2.some((t) => t.type === 'chapter_complete')).toBe(false);
    expect(t1[t1.length - 1].type).toBe('idle');
    expect(t2[t2.length - 1].type).toBe('idle');
  }, 15_000);

  it('isGenerationActive is true while any same-book job runs and false after all drain', async () => {
    const { isGenerationActive } = await import('./generation.js');
    /* Each synth blocks until released or aborted; collect the resolvers so
       we can release both at once after asserting the active state. */
    let started = 0;
    let resolveBothStarted: () => void;
    const bothStarted = new Promise<void>((r) => {
      resolveBothStarted = r;
    });
    const releasers: Array<() => void> = [];
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      return new Promise((resolve, reject) => {
        const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) return reject(abortErr());
        signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
        releasers.push(() =>
          resolve({
            pcm: Buffer.alloc(2),
            sampleRate: 24000,
            durationSec: 1,
            segments: [
              {
                characterId: 'narrator',
                voiceName: 'Zephyr',
                sampleStart: 0,
                sampleEnd: 1,
                sentenceIds: [1],
              },
            ],
          }),
        );
        started += 1;
        if (started === 2) resolveBothStarted();
      });
    };

    const p1 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1] });
    const p2 = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [2] });
    /* Swallow so an unexpected early settle can't surface as an unhandled
       rejection on the worker. */
    p1.then(
      () => {},
      () => {},
    );
    p2.then(
      () => {},
      () => {},
    );
    await bothStarted;

    /* Two jobs in flight for the book → active. */
    expect(isGenerationActive(bookId)).toBe(true);

    /* Release both synths and let the runs drain. */
    for (const r of releasers.splice(0)) r();
    await Promise.all([p1, p2]);

    /* All jobs drained → inactive. */
    expect(isGenerationActive(bookId)).toBe(false);
  }, 15_000);
});

/* Durable per-chapter failure status (side: stuck-queued bug). A chapter that
   fails writes no audio, so it's absent from completedSlugs and used to
   re-hydrate as the misleading neutral "Queued" once its queue entry was
   cleared. The failure path now persists `generationState:'failed'` +
   `generationError` to state.json so the chapter survives a reload as
   "Failed · reason"; a later successful render clears both. */
describe('POST /api/books/:bookId/generation — persists generationState on failure', () => {
  const statePath = () => join(bookDir, '.audiobook', 'state.json');

  /* Reset to a clean two-chapter baseline so prior tests' mutations (excluded
     flags, persisted failures) can't bleed in. */
  beforeEach(() => {
    writeFileSync(
      statePath(),
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
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  async function readState(): Promise<{
    chapters: Array<{ id: number; generationState?: string; generationError?: string }>;
  }> {
    const fs = await import('node:fs');
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  }

  it('writes generationState:"failed" + generationError to state.json on a synth failure', async () => {
    synthesiseImpl = async () => {
      throw new Error('Local TTS sidecar returned 400: {"detail":"Item 0: \'text\' is required."}');
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    const failed = ticks.find((t) => t.type === 'chapter_failed' && t.chapterId === 1);
    expect(failed).toBeDefined();

    const state = await readState();
    const ch1 = state.chapters.find((c) => c.id === 1)!;
    expect(ch1.generationState).toBe('failed');
    /* The persisted reason matches the broadcast errorReason verbatim. */
    expect(ch1.generationError).toBe(failed!.errorReason as string);
    /* Untouched sibling carries no failure. */
    expect(state.chapters.find((c) => c.id === 2)!.generationState).toBeUndefined();
  });

  it('clears generationState + generationError on a subsequent successful render', async () => {
    /* First fail chapter 1 so the failure is persisted. */
    synthesiseImpl = async () => {
      throw new Error('Local TTS sidecar returned 400: {"detail":"Item 0: \'text\' is required."}');
    };
    await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true });
    expect((await readState()).chapters.find((c) => c.id === 1)!.generationState).toBe('failed');

    /* Now render it successfully — the success path must wipe the stale flag. */
    synthesiseImpl = async () => ({
      pcm: Buffer.alloc(2),
      sampleRate: 24000,
      durationSec: 1,
      segments: [
        {
          characterId: 'narrator',
          voiceName: 'Zephyr',
          sampleStart: 0,
          sampleEnd: 1,
          sentenceIds: [1],
        },
      ],
    });
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true });
    expect(res.status).toBe(200);

    const ch1 = (await readState()).chapters.find((c) => c.id === 1)!;
    expect(ch1.generationState).toBeUndefined();
    expect(ch1.generationError).toBeUndefined();
  });
});

// fs-57 — liveInstruct threading from state.json through to synthesiseChapter
describe('fs-57 — generation route threads liveInstruct from state into synthesiseChapter', () => {
  let capturedOpts: Record<string, unknown>[] = [];

  beforeEach(() => {
    capturedOpts = [];
    synthesiseImpl = async (args: unknown) => {
      capturedOpts.push(args as Record<string, unknown>);
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [
          {
            characterId: 'narrator',
            voiceName: 'Zephyr',
            sampleStart: 0,
            sampleEnd: 1,
            sentenceIds: [1],
          },
        ],
      };
    };
  });

  async function patchStateLiveInstruct(value: boolean | undefined) {
    const { readJson, writeJsonAtomic } = await import('../workspace/state-io.js');
    const { stateJsonPath } = await import('../workspace/paths.js');
    const statePath = stateJsonPath(join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE));
    const current = await readJson<Record<string, unknown>>(statePath);
    const next = { ...current };
    if (value === undefined) {
      delete next.liveInstruct;
    } else {
      next.liveInstruct = value;
    }
    await writeJsonAtomic(statePath, next);
  }

  it('passes liveInstruct=true into synthesiseChapter when state has liveInstruct=true', async () => {
    await patchStateLiveInstruct(true);
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true });
    expect(res.status).toBe(200);
    /* synthesiseImpl was called at least once; every call should carry liveInstruct=true. */
    expect(capturedOpts.length).toBeGreaterThan(0);
    for (const opts of capturedOpts) {
      expect(opts.liveInstruct).toBe(true);
    }
  });

  it('passes liveInstruct=false (default) when state omits the field (legacy book)', async () => {
    await patchStateLiveInstruct(undefined);
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', chapterIds: [1], force: true });
    expect(res.status).toBe(200);
    expect(capturedOpts.length).toBeGreaterThan(0);
    for (const opts of capturedOpts) {
      /* The generation route's `?? false` guard MUST have fired — the value
         reaching synthesiseChapter is strictly `false`, never `undefined`. */
      expect(opts.liveInstruct).toBe(false);
    }
    /* Reset state for subsequent tests. */
    await patchStateLiveInstruct(false);
  });

  afterEach(async () => {
    /* Ensure state doesn't bleed between tests. */
    await patchStateLiveInstruct(false);
  });
});
