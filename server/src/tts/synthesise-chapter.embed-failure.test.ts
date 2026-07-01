/* Regression coverage for the B1 `embedMs` accounting fix (PR-2 telemetry,
   task review round 2).

   The SPK embed pass (`collectGroupEmbeddings`, gated on
   `qa.speaker.enabled`) is non-fatal: a failed embed call is caught and
   logged so synthesis never breaks on a missing/unreachable sidecar. The
   wall-clock time spent in that pass must still be credited to `embedMs`
   even when the pass throws — `synthesise-chapter.ts` does this via a
   `finally` block around the `embT0`/`embedMs` accounting.

   This is a DEDICATED, isolated test file (not added to the giant shared
   `synthesise-chapter.test.ts`, which has ~97 other tests that all rely on
   `qa.speaker.enabled` defaulting to `false`) because proving the fix
   requires a file-wide `vi.mock` of `../config/resolver.js` to force
   `qa.speaker.enabled: true`, plus a mock of `./embed-client.js` to make
   `embedSegment` throw after a controlled delay. Bolting that onto the
   shared file would risk silently changing the other 97 tests' behaviour.

   Proof this test is not a placebo: with the pre-fix code (embedMs
   accounting inside the `try` block, AFTER the `await collectGroupEmbeddings`
   call, instead of in a `finally`), a thrown rejection from `embedSegment`
   skips the `embedMs += …` line entirely and `embedMs` stays at its initial
   value of `0` — so `expect(result.embedMs).toBeGreaterThan(0)` below would
   fail. Verified by temporarily reverting the `finally` to the old in-try
   placement and confirming this test goes red, then restoring the fix and
   confirming it goes green (see task-1-report.md). */

import { describe, it, expect, vi } from 'vitest';

// ── Module mocks (must come before any imports of the mocked modules) ──────

// Force qa.speaker.enabled on for this file only; delegate every other key
// to the real configValue (same precedent as
// src/routes/chapter-qa-repair-spk.test.ts).
vi.mock('../config/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/resolver.js')>();
  return {
    ...real,
    configValue: vi.fn((key: string) => {
      if (key === 'qa.speaker.enabled') return true;
      return real.configValue(key);
    }),
  };
});

// embedSegment: a controlled, non-trivial delay (tens of ms — long enough
// that a Date.now() delta reliably registers as > 0, short enough to keep
// the test fast) followed by a rejection, so the embed pass always throws.
vi.mock('./embed-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./embed-client.js')>();
  return {
    ...real,
    embedSegment: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error('embedSegment: simulated sidecar failure');
    }),
  };
});

import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';

function sentence(id: number, characterId: string, text = 'Line.'): SentenceOutput {
  return { id, chapterId: 1, characterId, text };
}

/** A tone PCM buffer long enough to clear the SPK embed pass's 3.0s duration
    floor (`MIN_DURATION_SEC`, src/audio/render-integrity/constants.ts) — a
    shorter clip would be skipped by `collectGroupEmbeddings` before ever
    calling `embedSegment`, and the embed pass would never throw. */
function tonePcm(seconds: number, sampleRate = 24000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / sampleRate) * 0.3 * 32767), i * 2);
  }
  return buf;
}

describe('synthesiseChapter — SPK embed-pass failure path (B1 regression)', () => {
  it('credits embedMs wall time via the finally block even when the embed pass throws', async () => {
    const provider: TtsProvider & { calls: SynthesizeInput[] } = {
      calls: [],
      async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
        provider.calls.push(input);
        // Engine must be 'qwen' or 'coqui' (the stochastic-engine filter in
        // collectGroupEmbeddings) and long enough to clear MIN_DURATION_SEC,
        // or the embed pass would skip the group without ever calling
        // embedSegment.
        return { pcm: tonePcm(3.5), sampleRate: 24000, mimeType: 'audio/pcm' };
      },
    };
    const cast: CastCharacter[] = [{ id: 'narrator', name: 'Narrator' }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await synthesiseChapter({
      sentences: [
        sentence(1, 'narrator', 'A line long enough to clear the embed duration floor.'),
      ],
      cast,
      provider,
      modelKey: 'qwen3-tts-0.6b',
      engine: 'qwen',
      groupHeartbeatMs: 0,
    });

    // The embed pass threw (after the controlled 30ms delay) — the finally
    // block must still have credited that wall time to embedMs.
    expect(result.embedMs).toBeGreaterThan(0);
    // Non-fatal: synthesis must complete and return normally, not throw.
    expect(result.pcm.length).toBeGreaterThan(0);
    // The catch block logs the failure (existing behaviour, asserted here
    // as a secondary check, not the primary regression).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('render-integrity embed pass failed'),
    );

    warnSpy.mockRestore();
  });
});
