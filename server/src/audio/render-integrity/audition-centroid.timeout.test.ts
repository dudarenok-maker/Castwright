/* #3711 task 4 -- the scoring pass is a registered `scoring` job (a folder move is refused
   while it runs, and there is no TTL), so its sidecar calls MUST be bounded: the audition
   synth and the ECAPA embed carry `AbortSignal.timeout(SYNTH_CALL_TIMEOUT_MS)`, the same
   per-call ceiling a render uses. A call that never returns therefore times out, the
   audition returns null (the existing non-terminal "sidecar unavailable" result), and the
   job's registration is released. Render's own embed calls are unchanged. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Read once at module load by synthesise-chapter.ts, so it must be set before any import. */
vi.hoisted(() => {
  process.env.SIDECAR_CALL_TIMEOUT_MS = '60';
});

const { synthSignals, embedSignals } = vi.hoisted(() => ({
  synthSignals: [] as Array<AbortSignal | undefined>,
  embedSignals: [] as Array<AbortSignal | undefined>,
}));

/** Never resolves; rejects the moment `signal` aborts (what a real fetch does). */
function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // an unbounded call: hangs forever (the defect)
    const abort = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

vi.mock('../../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({
      synthesize: (input: { signal?: AbortSignal }) => {
        synthSignals.push(input.signal);
        return hangUntilAbort(input.signal);
      },
    }),
  };
});
vi.mock('../../tts/embed-client.js', () => ({
  embedSegment: (_pcm: Buffer, _sr: number, opts: { signal?: AbortSignal } = {}) => {
    embedSignals.push(opts.signal);
    return hangUntilAbort(opts.signal);
  },
}));

const AUTHOR = 'Scoring Timeout Author';
const SERIES = 'The Series';
const TITLE = 'Scoring Timeout Book';

let workspaceRoot: string;
let auditionCentroid: typeof import('./audition-centroid.js').auditionCentroid;
let SYNTH_CALL_TIMEOUT_MS: number;
let runBookJob: typeof import('../../workspace/book-jobs.js').runBookJob;
let bookJobKinds: typeof import('../../workspace/book-op-lock.js').bookJobKinds;
let bookId: string;

const CHARACTER = {
  voiceName: 'af_sarah',
  modelKey: 'kokoro-v1' as never,
  voice: { id: 'v', name: 'Sarah', gender: 'female' } as never,
};

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-scoring-timeout-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  ({ auditionCentroid } = await import('./audition-centroid.js'));
  ({ SYNTH_CALL_TIMEOUT_MS } = await import('../../tts/synthesise-chapter.js'));
  ({ runBookJob } = await import('../../workspace/book-jobs.js'));
  ({ bookJobKinds } = await import('../../workspace/book-op-lock.js'));
  const { makeBookId } = await import('../../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_scoring_timeout',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      isStandalone: false,
      language: 'en',
      chapters: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.SIDECAR_CALL_TIMEOUT_MS;
});

describe('scoring sidecar calls are bounded (#3711)', () => {
  it('exports the per-call ceiling it reuses', () => {
    expect(SYNTH_CALL_TIMEOUT_MS).toBe(60);
  });

  it('an audition synth call that never returns times out; the audition gives up (null) instead of hanging', async () => {
    synthSignals.length = 0;
    const result = await auditionCentroid(CHARACTER);
    expect(result).toBeNull();
    expect(synthSignals.length).toBeGreaterThan(0);
    expect(synthSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('an ECAPA embed call that never returns times out as well (default embed fn)', async () => {
    embedSignals.length = 0;
    const pcm = Buffer.alloc(24_000 * 2 * 3); // 3 s: above the duration floor
    const result = await auditionCentroid(CHARACTER, {
      synthFn: async () => ({ pcm, sampleRate: 24_000, mimeType: 'audio/L16' }),
    });
    expect(result).toBeNull();
    expect(embedSignals.length).toBeGreaterThan(0);
    expect(embedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('a scoring job holding a hung call releases its registration once the call times out', async () => {
    const registered = await runBookJob(bookId, 'scoring', async () => auditionCentroid(CHARACTER));
    if (typeof registered === 'symbol') throw new Error('book vanished');
    expect(bookJobKinds(bookId)).toEqual(['scoring']);
    await expect(registered.done).resolves.toBeNull();
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});
