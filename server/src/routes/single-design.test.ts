/* Integration tests for the single-character voice-design background job.

   Seeds a minimal confirmed book with one character and drives the SSE job
   end to end. Stubs the design core and persist helper so no GPU/sidecar
   is needed. */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } from '../workspace/file-lock.js';

// Stub the shared design core so the job runs without a sidecar/GPU.
// vi.mock is hoisted to the top of the file, so it runs before any imports —
// these stubs are in effect for all dynamic imports in beforeAll too.
let capturedDesignArgs: Record<string, unknown> | null = null;
let resolveDesignCall: (() => void) | null = null;
vi.mock('./qwen-voice.js', async (orig) => ({
  ...(await orig<typeof import('./qwen-voice.js')>()),
  designQwenVoiceForCharacter: vi.fn(async (p: { characterId: string; preview?: boolean; progressToken?: string; progressUrl?: string }) => {
    capturedDesignArgs = p as Record<string, unknown>;
    if (resolveDesignCall) resolveDesignCall();
    return {
      voiceId: p.preview ? `qwen-${p.characterId}-preview` : `qwen-${p.characterId}`,
      url: `/api/voice-sample/${p.characterId}.mp3`,
    };
  }),
}));

// Targeted mock of readJson so a test can corrupt cast.json on disk between
// the route handler's own upfront read (single-design.ts ~261, before the SSE
// stream even opens) and the SECOND read inside runSingleDesign (~116 — the
// pre-#3171-fix pre-try read). Both reads hit the exact same path, so a
// static corrupt fixture alone can't isolate the failure to just the second
// call. `readJsonFailAfter` names the path to target and how many real calls
// to let pass through before corrupting it; the factory runs lazily (on the
// first dynamic import in beforeAll), so it picks up these module-scope
// `let`s once a test sets them, matching the capturedDesignArgs pattern above.
let readJsonFailAfter: { path: string; passThroughCalls: number; error?: Error } | null = null;
const readJsonCallCounts = new Map<string, number>();
vi.mock('../workspace/state-io.js', async (orig) => {
  const real = await orig<typeof import('../workspace/state-io.js')>();
  return {
    ...real,
    readJson: vi.fn(async <T>(path: string) => {
      if (readJsonFailAfter && path === readJsonFailAfter.path) {
        const n = (readJsonCallCounts.get(path) ?? 0) + 1;
        readJsonCallCounts.set(path, n);
        if (n > readJsonFailAfter.passThroughCalls) {
          if (readJsonFailAfter.error) {
            // A synthetic error (e.g. a real LockAcquisitionTimeoutError) for
            // a case that cares about the error's own identity/message, not
            // about reproducing a real on-disk failure.
            throw readJsonFailAfter.error;
          }
          /* Corrupt the file right before THIS read, so it hits a genuine
             JSON.parse failure from a real file on disk — the actual defect
             shape, not a synthetic throw — while the earlier pass-through
             call(s) above already saw valid JSON. */
          writeFileSync(path, '{ this is not valid json');
        }
      }
      return real.readJson<T>(path);
    }),
  };
});

const applyOverrideStub = vi.fn(
  async (): Promise<{ updated: number; skipped: Array<{ bookDir: string; characterId: string; reason: string }> }> => ({
    updated: 1,
    skipped: [],
  }),
);
vi.mock('./voices.js', async (orig) => {
  const real = await orig<typeof import('./voices.js')>();
  return {
    ...real,
    applyOverrideToCastFiles: applyOverrideStub,
  };
});


const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let BOOK_ID: string;
let bookDir: string;
let designLock: typeof import('../tts/design-lock.js');
let castJsonPath: (bookDir: string) => string;

function writeBookOnDisk(dir: string, id: string) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'c1',
          name: 'Aria',
          role: 'lead',
          color: 'rose',
          voiceStyle: 'a warm, confident voice',
        },
        /* GATE 2 fix-lane-1b — cloned on coqui, no qwen slot at all: the
           exact shape a "first design" qwen call must refuse rather than
           retarget. */
        {
          id: 'c2',
          name: 'Kael',
          role: 'supporting',
          color: 'teal',
          voiceStyle: 'a low, careful voice',
          ttsEngine: 'coqui',
          overrideTtsVoices: {
            coqui: { name: 'xtts-c2-uuid', libraryUuid: 'c2-uuid', provenance: 'cloned' },
          },
        },
      ],
    }),
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-single-design-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  // All imports are dynamic so WORKSPACE_DIR (above) is set before paths.ts
  // reads process.env.WORKSPACE_DIR at module load time.
  // #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
  // imports races the async vi.mock factories above (module-under-test can
  // receive the real binding instead of the mock). Measured latent for this
  // file — 0 failures in 14 runs (#2083's own survey) — not the live
  // ~2-in-5 rate, which belongs to voices.test.ts, a different file already
  // fixed under #2046.
  const { singleDesignRouter } = await import('./single-design.js');
  const { makeBookId, castJsonPath: castJsonPathFn } = await import('../workspace/paths.js');
  castJsonPath = castJsonPathFn;
  const lock = await import('../tts/design-lock.js');
  designLock = lock;

  BOOK_ID = makeBookId(AUTHOR, SERIES, BOOK);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', singleDesignRouter);
});

beforeEach(() => {
  applyOverrideStub.mockReset();
  applyOverrideStub.mockResolvedValue({ updated: 1, skipped: [] });
  writeBookOnDisk(bookDir, BOOK_ID);
});

afterEach(() => {
  designLock.clearDesignBusy(bookDir);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Parse an SSE response body into the list of JSON `data:` events. */
function collectSse(res: request.Response): Record<string, unknown>[] {
  return res.text
    .split('\n\n')
    .map((b) =>
      b
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n'),
    )
    .filter(Boolean)
    .map((j) => JSON.parse(j));
}

describe('single-design job — first design', () => {
  it('streams the designed event, persists the override, and does NOT fake phase events', async () => {
    capturedDesignArgs = null;
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm, confident voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(200);
    const events = collectSse(res);
    // The sidecar now drives phase events — the server no longer fakes them.
    expect(events.find((e) => e.type === 'phase' && e.phase === 'designing')).toBeFalsy();
    expect(events.find((e) => e.type === 'phase' && e.phase === 'rendering')).toBeFalsy();
    const designed = events.find((e) => e.type === 'designed');
    expect(designed).toMatchObject({ characterId: 'c1', voiceId: 'qwen-c1' });
    expect(applyOverrideStub).toHaveBeenCalledWith(
      'c1', // matchKey = character.voiceId ?? character.id
      { engine: 'qwen', name: 'qwen-c1' },
      expect.anything(),
      bookDir, // fs-61 — book-scoped fallback when there's no seriesFilter
    );
  });
});

describe('single-design job — preview (re-design)', () => {
  it('emits preview_ready WITHOUT persisting, and previewUrl matches the core stub', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'warmer', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b', preview: true });

    expect(res.status).toBe(200);
    const events = collectSse(res);
    const ready = events.find((e) => e.type === 'preview_ready');
    expect(ready).toMatchObject({
      characterId: 'c1',
      previewVoiceId: 'qwen-c1-preview',
      previewUrl: '/api/voice-sample/c1.mp3', // URL forwarded from designQwenVoiceForCharacter stub
    });
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });

  /* srv-43: preview_ready must carry voiceUuid so the drawer can resolve the
     uuid-keyed sample-cache entry before the next cast refetch.
     Fail-before: voiceUuid was absent from the event; pass-after: it is a non-empty string. */
  it('emits preview_ready with a voiceUuid field (srv-43)', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'warmer', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b', preview: true });

    expect(res.status).toBe(200);
    const events = collectSse(res);
    const ready = events.find((e) => e.type === 'preview_ready');
    expect(typeof ready?.voiceUuid).toBe('string');
    expect(ready?.voiceUuid).not.toBe('');
  });
});

describe('single-design job — clone protection (GATE 2 fix-lane-1b)', () => {
  /* A "first design" (preview=false) persists via applyOverrideToCastFiles,
     which pins ttsEngine = 'qwen' unconditionally. For a character already
     cloned on coqui, that pin would silently retarget them off their clone
     while the clone marker stays intact — the defect this guard closes.
     Refused up front (409), before the SSE stream even starts, so the
     client gets an honest reason instead of a hollow "designed" event for a
     design that was never persisted. */
  it('refuses (409) to design a coqui-cloned character instead of retargeting it off its clone', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c2/design-voice/stream`)
      .send({ persona: 'a low, careful voice', sampleVoiceId: 'char-c2', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(res.body.error).toMatch(/cloned voice/i);
    /* The actual defect: applyOverrideToCastFiles (the call that pins
       ttsEngine = 'qwen') must never be reached — not merely that SOME
       4xx came back, which a differently-worded refusal could satisfy too. */
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });

  /* The preview ("redesign") branch never calls applyOverrideToCastFiles —
     nothing is persisted, so there is no retarget risk and it must NOT be
     refused just because the character happens to be cloned elsewhere. */
  it('does NOT refuse a preview/redesign request for the same cloned character', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c2/design-voice/stream`)
      .send({ persona: 'warmer', sampleVoiceId: 'char-c2', modelKey: 'qwen3-tts-0.6b', preview: true });

    expect(res.status).toBe(200);
    const events = collectSse(res);
    expect(events.some((e) => e.type === 'preview_ready')).toBe(true);
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });
});

describe('single-design job — series-wide clone veto (#2006)', () => {
  /* This file's own writeBookOnDisk(dir, id) (above) is a fixed-shape helper
     for THIS ONE book (bookDir/BOOK_ID, characters c1/c2) — it takes no
     characters param and can't mint a sibling book, so don't try to reuse it
     for this. Write the sibling book directly, mirroring its exact on-disk
     shape (state.json + manuscript.txt + cast.json), in the SAME series
     (AUTHOR/SERIES) so findAuthorSeriesForBookId's real (unmocked) scan
     finds it. c1 (this file's existing fixture character, no voiceId of its
     own — so its link key is the bare id 'c1') is the target; the sibling's
     character shares that same link key via its OWN voiceId: 'c1' and
     carries the clone. */
  let siblingDir: string;

  /* Mints the sibling book only when a test actually needs the REAL upfront
     scan to find a clone. The write-time test below must NOT seed a real
     clone here — with the upfront check now series-wide, a real sibling
     clone would refuse the request at the upfront gate before it ever
     reaches the mocked applyOverrideToCastFiles this test is exercising,
     which is a different code path than the one under test (found while
     verifying this test against the actual implementation: an earlier
     version of this fixture seeded the clone unconditionally in a shared
     beforeEach and the write-time test never reached applyOverrideStub). */
  function writeSiblingBook(cloned: boolean) {
    siblingDir = join(workspaceRoot, 'books', AUTHOR, SERIES, 'Sibling Book');
    mkdirSync(join(siblingDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(siblingDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'sibling-book-id',
        manuscriptId: 'm_sibling-book-id',
        title: 'Sibling Book',
        author: AUTHOR,
        series: SERIES,
        seriesPosition: 2,
        isStandalone: false,
        language: 'en',
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(siblingDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(siblingDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'sibling-c1', name: 'Aria (sibling)', voiceId: 'c1',
            ...(cloned ? { overrideTtsVoices: { coqui: { name: 'clone-y', provenance: 'cloned' } } } : {}),
          },
        ],
      }),
    );
  }

  afterEach(() => {
    if (siblingDir) rmSync(siblingDir, { recursive: true, force: true });
  });

  it('refuses (409) up front when the character is cloned on a SIBLING book, not this one', async () => {
    writeSiblingBook(true);
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });

  it('write-time: when applyOverrideToCastFiles reports a series-wide skip, the job ends with a clone_protected error event instead of "designed"', async () => {
    writeSiblingBook(false); // no real clone — upfront gate must pass so the write-time mock is actually reached
    applyOverrideStub.mockResolvedValueOnce({
      updated: 0,
      skipped: [{ bookDir, characterId: 'c1', reason: 'already_cloned' }],
    });
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    expect(res.status).toBe(200); // SSE stream itself opens fine
    const events = collectSse(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'clone_protected' });
    expect(events.some((e) => e.type === 'designed')).toBe(false);
  });
});

describe('single-design job — reattach + busy', () => {
  it('bare subscribe to a book with no job idles immediately', async () => {
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/design-single/subscribe`)
      .send({});

    expect(res.status).toBe(200);
    const events = collectSse(res);
    expect(events.map((e) => e.type)).toContain('idle');
  });

  it('409s the start route when a design is already busy for the book', async () => {
    designLock.markDesignBusy(bookDir);
    try {
      const res = await request(app)
        .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
        .send({ persona: 'warm', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });
      expect(res.status).toBe(409);
    } finally {
      designLock.clearDesignBusy(bookDir);
    }
  });
});

describe('single-design job — progress token (task-5)', () => {
  it('passes a non-empty progressToken + progressUrl to the design core, token resolves during design and is gone after', async () => {
    capturedDesignArgs = null;
    const { resolveProgressToken } = await import('./single-design.js');

    // Wire resolveDesignCall so we can capture the token resolution state from
    // inside the mock, before endJob cleans the token up.
    let tokenLiveDuringDesign: boolean | null = null;
    resolveDesignCall = () => {
      const token = (capturedDesignArgs as Record<string, unknown> | null)?.progressToken;
      tokenLiveDuringDesign = typeof token === 'string' ? resolveProgressToken(token) !== undefined : false;
    };

    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm, confident voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    resolveDesignCall = null; // reset for other tests

    expect(res.status).toBe(200);

    // (a) designQwenVoiceForCharacter was called with a non-empty progressToken
    //     and a progressUrl ending in /api/internal/design-progress.
    expect(capturedDesignArgs).not.toBeNull();
    const { progressToken, progressUrl } = capturedDesignArgs as unknown as { progressToken: unknown; progressUrl: unknown };
    expect(typeof progressToken).toBe('string');
    expect((progressToken as string).length).toBeGreaterThan(0);
    expect(typeof progressUrl).toBe('string');
    expect((progressUrl as string).endsWith('/api/internal/design-progress')).toBe(true);

    // (b) Token was live inside the design call (before endJob), and gone after.
    expect(tokenLiveDuringDesign).toBe(true);
    const tokenAfter = resolveProgressToken(progressToken as string);
    expect(tokenAfter).toBeUndefined();

    // (c) Server itself does NOT broadcast phase:'rendering' or phase:'designing'.
    const events = collectSse(res);
    expect(events.find((e) => e.type === 'phase' && e.phase === 'rendering')).toBeFalsy();
    expect(events.find((e) => e.type === 'phase' && e.phase === 'designing')).toBeFalsy();
  });
});
describe('single-design job — unset book language (Task 6 #2246)', () => {
  it('emits an SSE error with code "language_unset" (not a silent English design)', async () => {
    // Remove the `language` key the baseline fixture sets — a legacy/unset book.
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    delete state.language;
    writeFileSync(statePath, JSON.stringify(state));

    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm, confident voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

    const events = collectSse(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    expect(err?.code).toBe('language_unset');
    /* No client-facing message may carry a filesystem path. */
    expect(String(err?.message)).not.toMatch(/[A-Za-z]:\\|\/(Users|home|AudiobookWorkspace)/);
    /* It must not have silently designed in English. */
    expect(events.find((e) => e.type === 'designed')).toBeFalsy();
    expect(applyOverrideStub).not.toHaveBeenCalled();
  });

  it('the control: a book WITH a language still designs normally', async () => {
    // Baseline fixture already sets language:'en'; just drive the happy path.
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({ persona: 'a warm, confident voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });
    const events = collectSse(res);
    expect(events.find((e) => e.type === 'designed')).toBeTruthy();
    expect(events.find((e) => e.type === 'error')).toBeFalsy();
  });
});

describe('single-design job — runtime exception during persist (post-setup failure)', () => {
  /* NOT a #3171 regression test: applyOverrideToCastFiles is called from
     inside the existing try/catch on BOTH sides of the #3171 fix (it was
     never the pre-try leak), so this doesn't reproduce that bug and can't
     detect its absence. Kept because it covers something the rest of the
     suite didn't: a throw from the PERSIST step specifically still ends the
     job cleanly (curated error, design-busy cleared, no unhandled
     rejection) rather than only a resolved-with-skips persist failure
     (covered separately by the "write-time" test above) or a genuinely
     pre-try failure (covered by the #3171 regression test below). */
  it('emits a curated error event when applyOverrideToCastFiles throws, and clears the design-busy flag', async () => {
    applyOverrideStub.mockRejectedValueOnce(
      new Error('Simulated persist failure'),
    );
    let unhandledRejection: unknown = null;
    const handler = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', handler);

    try {
      const res = await request(app)
        .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
        .send({ persona: 'a warm voice', sampleVoiceId: 'char-c1', modelKey: 'qwen3-tts-0.6b' });

      expect(res.status).toBe(200);

      const events = collectSse(res);
      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeTruthy();
      expect(errorEvent?.code).toBe('design_failed');
      expect(String(errorEvent?.message ?? '')).toBeTruthy();

      // The design-busy flag must be cleared even when the job errors.
      expect(designLock.isDesignBusy(bookDir)).toBe(false);

      // No unhandled rejection should have occurred.
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', handler);
      applyOverrideStub.mockReset();
      applyOverrideStub.mockResolvedValue({ updated: 1, skipped: [] });
    }
  });
});

describe('single-design job — pre-try cast-read leak (#3171)', () => {
  /* The actual #3171 regression test. Before the fix, `runSingleDesign`
     awaited `readJson(castJsonPath(job.bookDir))` BEFORE its try/finally —
     a throw there (corrupt cast.json, EBUSY, ...) became an unhandled
     rejection: endJob never ran, the heartbeat interval and SSE subscriber
     leaked, the job stayed in inFlightByBook, and the design-busy flag
     stayed set until server restart. The fix moved that read inside the
     try. This test corrupts cast.json on disk between the route handler's
     OWN upfront read (single-design.ts ~261 — needed so the SSE stream
     opens at all) and the read inside runSingleDesign (~116), so only the
     second, in-job read fails — the exact shape of the original bug. */
  afterEach(() => {
    readJsonFailAfter = null;
    readJsonCallCounts.clear();
  });

  it('ends the job terminally, clears design-busy, logs, and leaks nothing when the pre-try cast read fails', async () => {
    const castPath = castJsonPath(bookDir);
    /* passThroughCalls: 1 — call #1 is the route handler's own upfront read;
       call #2 is the read inside runSingleDesign. preview:true skips the
       (!preview) clone-check branch, which would otherwise interpose a
       THIRD readJson(castJsonPath(bookDir)) call (via
       hasClonedSlotAmongMatches) between the two calls this test cares
       about. */
    readJsonFailAfter = { path: castPath, passThroughCalls: 1 };

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let unhandledRejection: unknown = null;
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejection = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const res = await request(app)
        .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
        .send({
          persona: 'a warm voice',
          sampleVoiceId: 'char-c1',
          modelKey: 'qwen3-tts-0.6b',
          preview: true,
        });

      // The SSE stream itself opens fine — the route's OWN read (call #1)
      // still saw valid JSON; only the in-job read (call #2) is corrupted.
      expect(res.status).toBe(200);
      const events = collectSse(res);
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeTruthy();
      expect(err?.code).toBe('design_failed');
      // Curated: a real JSON.parse error, never a raw filesystem path.
      expect(String(err?.message ?? '')).toBeTruthy();
      expect(String(err?.message ?? '')).not.toMatch(/[A-Za-z]:\\|\/(Users|home|AudiobookWorkspace)/);
      expect(events.some((e) => e.type === 'preview_ready' || e.type === 'designed')).toBe(false);

      // The design-busy flag and in-flight job registration must both clear.
      expect(designLock.isDesignBusy(bookDir)).toBe(false);

      // The raw error was logged server-side, under the failure's own prefix
      // (not just any console.error call during the request).
      const loggedFailure = consoleErrorSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('[single-design] failed'),
      );
      expect(loggedFailure, 'expected a console.error("[single-design] failed", …) call').toBeDefined();

      // No unhandled rejection reached the process.
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
      consoleErrorSpy.mockRestore();
      readJsonFailAfter = null;
      // Our mock corrupted the real cast.json on disk — restore it before
      // the follow-up request below (and before the next test's beforeEach,
      // which would otherwise be racing this cleanup).
      writeBookOnDisk(bookDir, BOOK_ID);
    }

    // A second single-design POST for the same book must NOT be rejected
    // with 409 — proof the job/design-busy leak did not survive the failure.
    const res2 = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({
        persona: 'a warm voice',
        sampleVoiceId: 'char-c1',
        modelKey: 'qwen3-tts-0.6b',
        preview: true,
      });
    expect(res2.status).not.toBe(409);
    expect(res2.status).toBe(200);
    const events2 = collectSse(res2);
    expect(events2.some((e) => e.type === 'preview_ready')).toBe(true);
  });

  it('curates a LockAcquisitionTimeoutError from the pre-try cast read into the lock-contention message, and does not leak its embedded path', async () => {
    const castPath = castJsonPath(bookDir);
    // #3173 M1 — the JSON-parse case above never contains a path, so its
    // "not a path" assertion can't fail regardless of curation. A real
    // LockAcquisitionTimeoutError's message DOES embed an absolute path (see
    // its constructor in workspace/file-lock.ts), so this is the shape that
    // actually exercises `requestFailureMessage`.
    readJsonFailAfter = {
      path: castPath,
      passThroughCalls: 1,
      error: new LockAcquisitionTimeoutError(
        'cast:C:\\Users\\real-name\\books\\Some Author\\Some Series\\Some Title\\.audiobook\\cast.json',
        10_000,
      ),
    };

    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/cast/c1/design-voice/stream`)
      .send({
        persona: 'a warm voice',
        sampleVoiceId: 'char-c1',
        modelKey: 'qwen3-tts-0.6b',
        preview: true,
      });

    expect(res.status).toBe(200);
    const events = collectSse(res);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    expect(err?.code).toBe('lock-contention');
    // The curated sentence, not the raw message (which embeds the lock key,
    // including the absolute workspace path).
    expect(String(err?.message ?? '')).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(String(err?.message ?? '')).not.toContain('real-name');
    expect(String(err?.message ?? '')).not.toMatch(/[A-Za-z]:\\|\/(Users|home|AudiobookWorkspace)/);

    expect(designLock.isDesignBusy(bookDir)).toBe(false);
  });
});


