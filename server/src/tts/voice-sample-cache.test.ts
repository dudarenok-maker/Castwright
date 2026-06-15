/* Unit tests for the shared voice-sample cache primitives. The voice-sample
   player and the Qwen design route both depend on voiceSampleFileName +
   buildSampleText producing identical output for identical inputs — that's
   the contract that makes "design preview" and "Play 12s" one synthesis. */

import { describe, it, expect } from 'vitest';
import {
  buildSampleText,
  djb2,
  voiceSampleFileName,
  voiceSamplePublicUrl,
} from './voice-sample-cache.js';
import type { VoiceLike } from './voice-mapping.js';

const VOICE: VoiceLike = { id: 'v_x', character: 'Halloran', attributes: ['Male', 'Gruff'] };

describe('buildSampleText', () => {
  it('returns the longest evidence quote, smart-quotes stripped', () => {
    const short = 'Aye.';
    const long = '“Hard to starboard, and not a word from any of you until it is done.”';
    expect(buildSampleText(VOICE, { evidence: [short, long] })).toBe(
      'Hard to starboard, and not a word from any of you until it is done.',
    );
  });

  it('uses a short real quote verbatim — never pads or fabricates', () => {
    expect(buildSampleText(VOICE, { evidence: ['Aye.', 'No, sir.'] })).toBe('No, sir.');
  });

  it('caps an over-long quote at 320 chars', () => {
    const huge = 'x'.repeat(500);
    expect(buildSampleText(VOICE, { evidence: [huge] })).toHaveLength(320);
  });

  it('treats whitespace / quote-mark-only entries as empty', () => {
    const text = buildSampleText(VOICE, { evidence: ['  ', '“”', '\n'] });
    expect(text.startsWith("Hello. I'm Halloran.")).toBe(true);
  });

  it('falls back to the canned script only when evidence is genuinely empty', () => {
    const text = buildSampleText(VOICE, { evidence: [] });
    expect(text.startsWith("Hello. I'm Halloran. Male, Gruff.")).toBe(true);
  });
});

describe('voiceSampleFileName', () => {
  const base = {
    cacheScope: 'char-marlow',
    modelKey: 'qwen3-tts-0.6b' as const,
    text: 'Hard to starboard.',
    voiceName: 'qwen-v_marlow',
  };

  it('is deterministic for identical inputs', () => {
    expect(voiceSampleFileName(base)).toBe(voiceSampleFileName({ ...base }));
  });

  it('matches the documented <scope>-<modelKey>-<hash>.mp3 shape', () => {
    expect(voiceSampleFileName(base)).toMatch(/^char-marlow-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
  });

  it('changes when any of scope / modelKey / text / voiceName change', () => {
    const f0 = voiceSampleFileName(base);
    expect(voiceSampleFileName({ ...base, cacheScope: 'char-other' })).not.toBe(f0);
    expect(voiceSampleFileName({ ...base, modelKey: 'kokoro-v1' })).not.toBe(f0);
    expect(voiceSampleFileName({ ...base, text: 'A different line.' })).not.toBe(f0);
    expect(voiceSampleFileName({ ...base, voiceName: 'qwen-v_oduvan' })).not.toBe(f0);
  });

  it('keeps an ASCII filename for a non-Latin (Cyrillic) scope, no collision (plan 219)', () => {
    const anna = voiceSampleFileName({ ...base, cacheScope: 'v_анна' });
    const maria = voiceSampleFileName({ ...base, cacheScope: 'v_мария' });
    // Filename is ASCII-safe (no raw Cyrillic) …
    expect(anna).toMatch(/^[A-Za-z0-9_.-]+\.mp3$/);
    // … and two distinct Cyrillic scopes don't collapse to the same file.
    expect(anna).not.toBe(maria);
    // Deterministic.
    expect(voiceSampleFileName({ ...base, cacheScope: 'v_анна' })).toBe(anna);
  });

  it('leaves an already-ASCII scope filename byte-identical (back-compat)', () => {
    expect(voiceSampleFileName(base)).toMatch(/^char-marlow-/);
  });

  it('the design route and the player land on the SAME filename for the same inputs', () => {
    /* The design route passes voiceName = deriveQwenVoiceId; the player passes
       voiceName = pickVoiceForEngine('qwen', …) = the same override id. text is
       buildSampleText(...) on both sides. This is the one-pass invariant. */
    const evidence = ['“Hard to starboard,” he said.', 'Aye.'];
    const text = buildSampleText(VOICE, { evidence });
    const fromDesign = voiceSampleFileName({
      cacheScope: 'char-halloran',
      modelKey: 'qwen3-tts-0.6b',
      text,
      voiceName: 'qwen-v_halloran',
    });
    const fromPlayer = voiceSampleFileName({
      cacheScope: 'char-halloran',
      modelKey: 'qwen3-tts-0.6b',
      text: buildSampleText(VOICE, { evidence }),
      voiceName: 'qwen-v_halloran',
    });
    expect(fromDesign).toBe(fromPlayer);
  });
});

describe('djb2 + voiceSamplePublicUrl', () => {
  it('djb2 is deterministic and non-negative', () => {
    expect(djb2('abc')).toBe(djb2('abc'));
    expect(djb2('abc')).toBeGreaterThanOrEqual(0);
  });

  it('voiceSamplePublicUrl mounts under /audio/voices', () => {
    expect(voiceSamplePublicUrl('char-x-kokoro-v1-abcd.mp3')).toBe(
      '/audio/voices/char-x-kokoro-v1-abcd.mp3',
    );
  });
});
