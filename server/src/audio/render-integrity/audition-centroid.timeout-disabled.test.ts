/* #3711 task 4 -- `SIDECAR_CALL_TIMEOUT_MS=0` disables the per-call ceiling, and
   `AbortSignal.timeout(0)` would abort IMMEDIATELY. The scoring pass must therefore pass NO
   signal at all in that case (audition-centroid.ts `scoringCallSignal`), not an
   already-expired one. The enabled branch is covered by audition-centroid.timeout.test.ts. */

import { describe, it, expect, beforeAll, vi } from 'vitest';

/* Read once at module load by tts/synth-call-timeout.ts, so it must be set before any import. */
vi.hoisted(() => {
  process.env.SIDECAR_CALL_TIMEOUT_MS = '0';
});

const { synthSignals, embedSignals } = vi.hoisted(() => ({
  synthSignals: [] as Array<AbortSignal | undefined>,
  embedSignals: [] as Array<AbortSignal | undefined>,
}));

vi.mock('../../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({
      synthesize: async (input: { signal?: AbortSignal }) => {
        synthSignals.push(input.signal);
        return { pcm: Buffer.alloc(24_000 * 2 * 3), sampleRate: 24_000, mimeType: 'audio/L16' };
      },
    }),
  };
});
vi.mock('../../tts/embed-client.js', () => ({
  embedSegment: async (_pcm: Buffer, _sr: number, opts: { signal?: AbortSignal } = {}) => {
    embedSignals.push(opts.signal);
    return new Float32Array([1, 0, 0, 0]);
  },
}));

let auditionCentroid: typeof import('./audition-centroid.js').auditionCentroid;
let SYNTH_CALL_TIMEOUT_MS: number;

const CHARACTER = {
  voiceName: 'af_sarah',
  modelKey: 'kokoro-v1' as never,
  voice: { id: 'v', name: 'Sarah', gender: 'female' } as never,
};

beforeAll(async () => {
  ({ auditionCentroid } = await import('./audition-centroid.js'));
  ({ SYNTH_CALL_TIMEOUT_MS } = await import('../../tts/synthesise-chapter.js'));
});

describe('scoring sidecar calls with the ceiling disabled (#3711)', () => {
  it('the ceiling really is disabled in this file', () => {
    expect(SYNTH_CALL_TIMEOUT_MS).toBe(0);
  });

  it('passes NO signal to the synth or the embed call (never an already-expired one)', async () => {
    await auditionCentroid(CHARACTER);
    expect(synthSignals.length).toBeGreaterThan(0);
    expect(embedSignals.length).toBeGreaterThan(0);
    expect(synthSignals.every((s) => s === undefined)).toBe(true);
    expect(embedSignals.every((s) => s === undefined)).toBe(true);
  });
});
