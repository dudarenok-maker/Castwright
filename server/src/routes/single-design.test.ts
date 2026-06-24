/* Integration tests for the single-character voice-design background job.

   Seeds a minimal confirmed book with one character and drives the SSE job
   end to end. Stubs the design core and persist helper so no GPU/sidecar
   is needed. */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

const applyOverrideStub = vi.fn(async () => 1);
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
      ],
    }),
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-single-design-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  // All imports are dynamic so WORKSPACE_DIR (above) is set before paths.ts
  // reads process.env.WORKSPACE_DIR at module load time.
  const [{ singleDesignRouter }, { makeBookId }, lock] = await Promise.all([
    import('./single-design.js'),
    import('../workspace/paths.js'),
    import('../tts/design-lock.js'),
  ]);
  designLock = lock;

  BOOK_ID = makeBookId(AUTHOR, SERIES, BOOK);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', singleDesignRouter);
});

beforeEach(() => {
  applyOverrideStub.mockReset();
  applyOverrideStub.mockResolvedValue(1);
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
    const { progressToken, progressUrl } = capturedDesignArgs as { progressToken: unknown; progressUrl: unknown };
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
