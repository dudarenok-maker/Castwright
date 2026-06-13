/* Drift-stamp correctness (false "Generated with Kokoro" badge, 2026-06-07).
   Plan 35 (chapter-wide engine drift) predated plan 108 (per-character engine
   routing): finalize-chapter-write stamped `audioModelKey` with the request's
   DEFAULT engine, not the engine the audio actually rendered in. A narration-
   only chapter whose narrator carries `ttsEngine: 'qwen'`, regenerated while the
   project default was Kokoro, rendered 100% on Qwen but stamped `kokoro-v1` —
   a false drift badge once the project engine was set to Qwen.

   These pin the two pure helpers that fix it: the per-engine voice-count
   breakdown (drives the mixed-engine "Kokoro (1), Qwen (6)" display) and the
   effective chapter-wide model key (the corrected drift stamp). */

import { describe, it, expect } from 'vitest';
import { engineBreakdownFromSnapshots, effectiveAudioModelKey } from './engine-breakdown.js';

describe('engineBreakdownFromSnapshots', () => {
  it('counts a single speaker under the engine it rendered in', () => {
    const breakdown = engineBreakdownFromSnapshots({
      narrator: { voiceEngine: 'qwen' },
    });
    expect(breakdown).toEqual({ qwen: 1 });
  });

  it('counts distinct speakers per engine for a mixed-engine chapter', () => {
    const breakdown = engineBreakdownFromSnapshots({
      narrator: { voiceEngine: 'kokoro' },
      wren: { voiceEngine: 'qwen' },
      marlow: { voiceEngine: 'qwen' },
    });
    expect(breakdown).toEqual({ kokoro: 1, qwen: 2 });
  });

  it('attributes a fallen-back character to the engine it ACTUALLY rendered in', () => {
    const breakdown = engineBreakdownFromSnapshots({
      // Configured Qwen, but rendered Kokoro (no designed voice / Qwen down).
      wren: { voiceEngine: 'qwen', renderedFallbackEngine: 'kokoro' },
    });
    expect(breakdown).toEqual({ kokoro: 1 });
  });

  it('returns an empty breakdown for no snapshots', () => {
    expect(engineBreakdownFromSnapshots({})).toEqual({});
  });
});

describe('effectiveAudioModelKey', () => {
  it('returns the single engine canonical key when the chapter is uniform (the bug case)', () => {
    // Narrator-only Qwen chapter regenerated while the project default was Kokoro.
    expect(effectiveAudioModelKey({ qwen: 1 }, 'kokoro-v1')).toBe('qwen3-tts-0.6b');
  });

  it('keeps the request model key when the chapter mixes engines', () => {
    expect(effectiveAudioModelKey({ kokoro: 1, qwen: 2 }, 'kokoro-v1')).toBe('kokoro-v1');
  });

  it('keeps the request model key when there are no speakers', () => {
    expect(effectiveAudioModelKey({}, 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });

  it('preserves the specific Gemini variant when uniform on Gemini', () => {
    expect(effectiveAudioModelKey({ gemini: 1 }, 'gemini-3.1-flash')).toBe('gemini-3.1-flash');
  });
});
