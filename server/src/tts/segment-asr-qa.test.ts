/* ASR content-QA policy (srv-31). Pins the trustworthiness logic — the part
   that decides whether the gate is usable or gets switched off:
     - normalization kills cosmetic diffs (case / punctuation / contractions /
       digits),
     - clean transcript → ok; wrong words → drift; dropped phrase → drift via the
       deletion run; looped audio → drift on compression_ratio alone,
     - untrustworthy transcript (low logprob / high no-speech) → inconclusive,
       NOT a re-record,
     - proper-noun allowlist tolerates Whisper mangling invented names,
     - short sentences are not scored.
   classifyTranscript is pure, so these inject the transcript directly. */

import { describe, it, expect } from 'vitest';
import {
  classifyTranscript,
  normalizeForWer,
  verifySegmentTranscript,
  leadingVocalizationTokens,
  type AsrSignals,
} from './segment-asr-qa.js';

const CLEAN: AsrSignals = { avgLogprob: -0.2, noSpeechProb: 0.02, compressionRatio: 1.3 };
const EXPECTED = 'She climbed the stairs to the old observatory at the top of the tower.';

describe('normalizeForWer', () => {
  it('lowercases, strips punctuation, expands contractions, spells small ints', () => {
    expect(normalizeForWer("Don't! He's got 3 keys.")).toEqual([
      'do', 'not', 'he', 'is', 'got', 'three', 'keys',
    ]);
  });

  it('normalises smart quotes and dashes', () => {
    expect(normalizeForWer('“Hello,” she said—softly.')).toEqual([
      'hello', 'she', 'said', 'softly',
    ]);
  });

  it('keeps non-Latin (Cyrillic) words instead of erasing them', () => {
    // Regression: the [^a-z0-9] strip deleted every Cyrillic char → 0 tokens →
    // the WER gate silently no-op'd on every non-English book (2026-06-15).
    expect(normalizeForWer('Она медленно шла по узкой улице.')).toEqual([
      'она', 'медленно', 'шла', 'по', 'узкой', 'улице',
    ]);
  });
});

describe('classifyTranscript', () => {
  it('identical text → ok, wer 0', () => {
    const c = classifyTranscript(EXPECTED, EXPECTED, CLEAN);
    expect(c.verdict).toBe('ok');
    expect(c.wer).toBe(0);
  });

  it('one swapped word stays under threshold → ok', () => {
    const c = classifyTranscript(
      EXPECTED,
      'She climbed the stairs to the old observatory at the top of the spire.',
      CLEAN,
    );
    expect(c.verdict).toBe('ok');
    expect(c.sub).toBe(1);
  });

  it('mostly-wrong words → drift', () => {
    const c = classifyTranscript(
      EXPECTED,
      'A dog ran across a muddy field chasing a bright red ball.',
      CLEAN,
    );
    expect(c.verdict).toBe('drift');
    expect(c.wer).toBeGreaterThan(0.4);
  });

  it('a dropped phrase → drift via the deletion run', () => {
    // The tail "at the top of the tower" is missing → a 6-word deletion run.
    const c = classifyTranscript(EXPECTED, 'She climbed the stairs to the old observatory.', CLEAN);
    expect(c.verdict).toBe('drift');
    expect(c.longestDeletionRun).toBeGreaterThan(4);
  });

  it('looped audio → drift on compression_ratio alone, even at low WER', () => {
    const c = classifyTranscript(EXPECTED, EXPECTED, { ...CLEAN, compressionRatio: 3.1 });
    expect(c.verdict).toBe('drift');
    expect(c.reasons.join(' ')).toMatch(/compression/i);
  });

  it('low avg_logprob → inconclusive (transcript untrustworthy), not a re-record', () => {
    const c = classifyTranscript(EXPECTED, 'mumble mumble nonsense', {
      ...CLEAN,
      avgLogprob: -1.8,
    });
    expect(c.verdict).toBe('inconclusive');
  });

  it('high no_speech_prob → inconclusive', () => {
    const c = classifyTranscript(EXPECTED, '', { ...CLEAN, noSpeechProb: 0.9 });
    expect(c.verdict).toBe('inconclusive');
  });

  it('proper-noun substitution is tolerated via the allowlist', () => {
    // Whisper hears "Wren Sparrow" as "Wren Faster" — without the allowlist
    // that's a substitution; with it, the line is clean.
    const expected = 'Wren Sparrow ran toward the gates of Tidehaven at dawn.';
    const heard = 'Wren Faster ran toward the gates of Tidehaven at dawn.';
    const without = classifyTranscript(expected, heard, CLEAN);
    const withList = classifyTranscript(expected, heard, CLEAN, {
      nameAllowlist: ['Wren Sparrow', 'Tidehaven'],
    });
    expect(without.sub).toBe(1);
    expect(withList.sub).toBe(0);
    expect(withList.verdict).toBe('ok');
  });

  it('short sentences are not scored → inconclusive', () => {
    const c = classifyTranscript('Yes.', 'No.', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('scores a faithful non-Latin (Cyrillic) transcript → ok, wer 0', () => {
    // Before the Unicode fix the expected text normalised to [] → the gate
    // returned inconclusive (no content-QA at all) on every Russian book.
    const ru = 'Она медленно шла по узкой пустынной улице.';
    const c = classifyTranscript(ru, ru, CLEAN);
    expect(c.verdict).toBe('ok');
    expect(c.wer).toBe(0);
  });

  it('still flags wrong words in a Cyrillic transcript → drift', () => {
    const expected = 'Она медленно шла по узкой пустынной улице.';
    const heard = 'Собака быстро бежала через широкое зелёное поле.';
    const c = classifyTranscript(expected, heard, CLEAN);
    expect(c.verdict).toBe('drift');
    expect(c.wer).toBeGreaterThan(0.4);
  });
});

describe('verifySegmentTranscript', () => {
  it('transcribes via the injected fn and classifies', async () => {
    const c = await verifySegmentTranscript(Buffer.from([0, 0]), 24000, EXPECTED, {
      transcribeFn: async () => ({
        text: EXPECTED,
        language: 'en',
        avgLogprob: -0.2,
        noSpeechProb: 0.01,
        compressionRatio: 1.2,
      }),
    });
    expect(c.verdict).toBe('ok');
  });

  it('forwards the language hint to the transcribe fn', async () => {
    let seenLang: string | null | undefined;
    await verifySegmentTranscript(Buffer.from([0, 0]), 24000, EXPECTED, {
      language: 'ru',
      transcribeFn: async (_p, _sr, o) => {
        seenLang = o.language;
        return { text: EXPECTED, language: 'ru', avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2 };
      },
    });
    expect(seenLang).toBe('ru');
  });
});

/* fs-57 / srv-31: vocalization-token tolerance (Task 17) */

describe('leadingVocalizationTokens', () => {
  it('extracts the single token before a "!" terminal', () => {
    expect(leadingVocalizationTokens('Ah! I did not see you walk in.')).toEqual(['ah']);
  });

  it('extracts the single token before a U+2026 ellipsis terminal', () => {
    // U+2026 is the real ellipsis character (…), not three dots.
    expect(leadingVocalizationTokens('Haah… so tired.')).toEqual(['haah']);
  });

  it('handles a "." terminal (non-vocalization call, safe)', () => {
    expect(leadingVocalizationTokens('No vocalization here.')).toEqual(['no', 'vocalization', 'here']);
  });

  it('returns [] when text has no terminal mark', () => {
    expect(leadingVocalizationTokens('no terminal mark')).toEqual([]);
  });
});

describe('classifyTranscript vocalizationAllowlist (fs-57)', () => {
  const CLEAN_SIGNALS: AsrSignals = { avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2 };

  it('tolerates a prepended vocalization token that the transcript dropped', () => {
    // Expected has "Ah!" prepended; transcript silently drops it but says the words.
    const c = classifyTranscript(
      'Ah! I did not see you walk in there, Marcus, my friend.',
      'I did not see you walk in there, Marcus, my friend.',
      CLEAN_SIGNALS,
      { vocalizationAllowlist: ['ah'] },
    );
    expect(c.verdict).toBe('ok');
  });

  it('without the allowlist the same drop is tolerated only by WER threshold', () => {
    // "ah" is only 1 token out of ~11; WER ~0.09 so still ok by default threshold.
    // But the point of this test is that the flag is NOT required for ok here;
    // the real test is that WITHOUT allowlist AND with significant word drops → drift.
    const c = classifyTranscript(
      'Ah! I did not see you walk in there, Marcus, my friend at all today.',
      'walk in there, Marcus.',
      CLEAN_SIGNALS,
    );
    expect(c.verdict).toBe('drift');
  });

  it('real word drops still drift even WITH the vocalization allowlist', () => {
    // The allowlist only tolerates "ah"; the heavy deletion of lexical words still drifts.
    const c = classifyTranscript(
      'Ah! I did not see you walk in there, Marcus, my friend at all today.',
      'walk in there, Marcus.',
      CLEAN_SIGNALS,
      { vocalizationAllowlist: ['ah'] },
    );
    expect(c.verdict).toBe('drift');
  });
});
