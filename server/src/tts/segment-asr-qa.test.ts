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

import { afterEach, describe, it, expect } from 'vitest';
import {
  classifyTranscript,
  looksLikeCalibrationBleed,
  normalizeForWer,
  resolveAsrThresholds,
  verifySegmentTranscript,
  leadingVocalizationTokens,
  bridgeCompounds,
  editDistanceAtMost1,
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

  it('English-spells integers for English / default language', () => {
    expect(normalizeForWer('I have 3 keys.')).toEqual(['i', 'have', 'three', 'keys']);
    expect(normalizeForWer('I have 3 keys.', 'en')).toEqual(['i', 'have', 'three', 'keys']);
  });

  it('does NOT English-spell integers for a non-English language (keeps the digit)', () => {
    // "3" → "three" only makes sense against English audio; on a Spanish/Russian
    // book Whisper hears "tres"/"три", so injecting "three" is a false error (#1084).
    expect(normalizeForWer('Tengo 3 llaves.', 'es')).toEqual(['tengo', '3', 'llaves']);
    expect(normalizeForWer('У меня 3 ключа.', 'ru')).toEqual(['у', 'меня', '3', 'ключа']);
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

  it('threads language so a non-English digit is not English-spelled into extra errors', () => {
    // "21" → "twenty one" inflates the expected tokens and mis-aligns against the
    // Spanish "veintiún" Whisper actually heard; with language=es the digit stays
    // one token → a single clean substitution (#1084).
    const esExpected = 'Compró 21 manzanas rojas en el mercado.';
    const esHeard = 'Compró veintiún manzanas rojas en el mercado.';
    const withEs = classifyTranscript(esExpected, esHeard, CLEAN, { language: 'es' });
    const withoutLang = classifyTranscript(esExpected, esHeard, CLEAN);
    expect(withEs.sub).toBe(1);
    expect(withEs.del).toBe(0);
    expect(withEs.verdict).toBe('ok');
    expect(withoutLang.wer).toBeGreaterThan(withEs.wer);
  });
});

describe('resolveAsrThresholds per-language maxWer (#1084 scaffold)', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_MAX_WER_ES;
  });

  it('defaults every language to the global maxWer', () => {
    expect(resolveAsrThresholds(undefined, 'es').maxWer).toBe(0.4);
    expect(resolveAsrThresholds(undefined, 'ru').maxWer).toBe(0.4);
    expect(resolveAsrThresholds(undefined).maxWer).toBe(0.4);
  });

  it('honours a per-language override, leaving other languages on the global', () => {
    process.env.SEG_ASR_MAX_WER_ES = '0.55';
    expect(resolveAsrThresholds(undefined, 'es').maxWer).toBeCloseTo(0.55);
    expect(resolveAsrThresholds(undefined, 'ru').maxWer).toBe(0.4);
    expect(resolveAsrThresholds(undefined, 'en').maxWer).toBe(0.4);
  });
});

describe('looksLikeCalibrationBleed', () => {
  // A bad/runaway Qwen voice clone can echo its ICL ref_text (the voice-design
  // calibration pangram) into chapter audio (#1074). The detector catches that
  // bleed in an ASR transcript so the QA path can quarantine it — but only when
  // the manuscript ITSELF doesn't contain the pangram (a legit quote stays).
  const NARRATION = 'Sophie hurried down the long museum hallway toward the exit.';
  const EN_PANGRAM =
    'The quick brown fox jumps over the lazy dog, and she wondered what tomorrow would bring.';

  it('English calibration pangram in transcript over normal narration → bleed', () => {
    expect(looksLikeCalibrationBleed(EN_PANGRAM, NARRATION)).toBe(true);
  });

  it('does NOT fire when the manuscript itself contains the pangram (legit quote)', () => {
    expect(looksLikeCalibrationBleed(EN_PANGRAM, `He typed it out: ${EN_PANGRAM}`)).toBe(false);
  });

  it('ordinary transcript that matches the line → not a bleed', () => {
    expect(looksLikeCalibrationBleed(NARRATION, NARRATION)).toBe(false);
  });

  it('detects the per-language calibration siblings (es/fr/de/ru)', () => {
    expect(
      looksLikeCalibrationBleed('El veloz murciélago hindú comía feliz cardillo y kiwi.', NARRATION),
    ).toBe(true);
    expect(
      looksLikeCalibrationBleed('Portez ce vieux whisky au juge blond qui fume.', NARRATION),
    ).toBe(true);
    expect(
      looksLikeCalibrationBleed('Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich.', NARRATION),
    ).toBe(true);
    expect(
      looksLikeCalibrationBleed('Съешь же ещё этих мягких французских булок да выпей чаю.', NARRATION),
    ).toBe(true);
  });
});

describe('compound-word tolerance', () => {
  // Whisper splits closed compounds the manuscript writes solid
  // ("Curvebuster" → "Curve Buster") and joins ones it writes open
  // ("good bye" → "goodbye"). On a short sentence a single split is 1 sub + 1
  // ins on a tiny denominator → WER 0.5 > 0.4 → a false 'drift' on audio that
  // says exactly the right words. The bridge reconciles solid↔split forms.

  it('Whisper splitting a solid compound is not drift (Curvebuster → Curve Buster)', () => {
    const c = classifyTranscript('They called her Curvebuster.', 'They called her Curve Buster?', CLEAN);
    expect(c.verdict).toBe('ok');
    expect(c.wer).toBe(0);
    expect(c.sub).toBe(0);
    expect(c.ins).toBe(0);
  });

  it('Whisper joining an open compound is not drift (good bye → goodbye)', () => {
    const c = classifyTranscript('Tell him good bye now please.', 'Tell him goodbye now please.', CLEAN);
    expect(c.verdict).toBe('ok');
    expect(c.wer).toBe(0);
    expect(c.del).toBe(0);
    expect(c.sub).toBe(0);
  });

  it('does NOT mask a genuine wrong-word swap as a compound', () => {
    // None of these substitutions concatenate to the expected token, so the
    // bridge must leave them as real drift.
    const c = classifyTranscript(
      'She opened the wooden door slowly.',
      'She closed the metal gate quickly.',
      CLEAN,
    );
    expect(c.verdict).toBe('drift');
    expect(c.wer).toBeGreaterThan(0.4);
  });
});

describe('hallucination deny-list', () => {
  // Whisper emits training-data boilerplate (pirate-EPUB watermarks, subtitle
  // credits, "thanks for watching") *confidently* on short/ambiguous audio, so
  // it sails past the logprob / no-speech guards and lands as 'drift'. These are
  // never real book content → inconclusive, not a re-record.
  const long = 'Sophie hurried down the long museum hallway toward the bright exit.';

  it('OceansofPDF.com watermark hallucination → inconclusive, not drift', () => {
    const c = classifyTranscript(long, 'OceansofPDF.com', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('subtitle-credit hallucination → inconclusive', () => {
    const c = classifyTranscript(long, 'Subtitles by the Amara.org community', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('thanks-for-watching hallucination → inconclusive', () => {
    const c = classifyTranscript(long, 'Thank you for watching!', CLEAN);
    expect(c.verdict).toBe('inconclusive');
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

describe('editDistanceAtMost1', () => {
  it('is true for equal / single-sub / single-indel, false otherwise', () => {
    expect(editDistanceAtMost1('skulduggery', 'skulduggery')).toBe(true); // equal
    expect(editDistanceAtMost1('skullduggery', 'skulduggery')).toBe(true); // 1 deletion (extra l)
    expect(editDistanceAtMost1('notted', 'nodded')).toBe(false); // 2 subs
    expect(editDistanceAtMost1('goodby', 'goodbye')).toBe(true); // 1 insertion
    expect(editDistanceAtMost1('cat', 'dog')).toBe(false); // 3 subs
  });
});

describe('bridgeCompounds (fuzzy)', () => {
  it('A2a: bridges a Whisper word-split 1 edit from the manuscript token', () => {
    const [exp, act] = bridgeCompounds(['skulduggery', 'froze'], ['skull', 'duggery', 'froze']);
    expect(exp).toEqual(['skulduggery', 'froze']);
    expect(act).toEqual(['skulduggery', 'froze']); // canonicalised to the manuscript form
  });

  it('A2a: still bridges an EXACT split (unchanged legacy behaviour)', () => {
    const [exp, act] = bridgeCompounds(['curvebuster'], ['curve', 'buster']);
    expect(exp).toEqual(['curvebuster']);
    expect(act).toEqual(['curvebuster']);
  });

  it('A2a: prefers an EXACT other-stream token over a 1-edit neighbour', () => {
    // other has both a 1-edit neighbour ('too') and the exact concat ('tos');
    // exact must win so legacy output is preserved regardless of array order.
    const [, act] = bridgeCompounds(['tos'], ['to', 's']);
    expect(act).toEqual(['tos']); // not 'too'
  });

  it('A2a: does NOT bridge a genuinely wrong pair (concat far from any token)', () => {
    const [exp, act] = bridgeCompounds(['hello', 'there'], ['banana', 'split']);
    expect(exp).toEqual(['hello', 'there']);
    expect(act).toEqual(['banana', 'split']);
  });

  it('A2d: bridges a 1→3 name split within 1 edit of the manuscript token', () => {
    // "Scapegrace" heard as "scape a grace" — concat "scapeagrace" is 1 deletion
    // from "scapegrace". The pair-only bridge missed this; the 3-run bridge joins it.
    const [exp, act] = bridgeCompounds(['scapegrace', 'appeared'], ['scape', 'a', 'grace', 'appeared']);
    expect(exp).toEqual(['scapegrace', 'appeared']);
    expect(act).toEqual(['scapegrace', 'appeared']);
  });

  it('A2d: prefers the shortest run that joins (a 2-run wins over a 3-run)', () => {
    // 'good'+'bye' = 'goodbye' joins at run 2 — must not greedily swallow 'now'.
    const [, act] = bridgeCompounds(['goodbye', 'now'], ['good', 'bye', 'now']);
    expect(act).toEqual(['goodbye', 'now']);
  });

  it('A2d: does NOT bridge three genuinely wrong tokens (concat far from any token)', () => {
    const [exp, act] = bridgeCompounds(['hello', 'there'], ['banana', 'apple', 'split']);
    expect(exp).toEqual(['hello', 'there']);
    expect(act).toEqual(['banana', 'apple', 'split']);
  });

  it('A2d: maxRun=2 restores pair-only bridging (3-run no longer joins)', () => {
    const [, act] = bridgeCompounds(['scapegrace', 'appeared'], ['scape', 'a', 'grace', 'appeared'], 2);
    expect(act).toEqual(['scape', 'a', 'grace', 'appeared']); // unchanged — 3-run skipped
  });

  it('A2d: also collapses the expected→actual direction (manuscript-split name)', () => {
    // The reverse split: the manuscript wrote three tokens, Whisper joined them.
    // collapse(expected, actual) must rejoin the expected run to the actual token.
    const [exp, act] = bridgeCompounds(['scape', 'a', 'grace', 'appeared'], ['scapegrace', 'appeared']);
    expect(exp).toEqual(['scapegrace', 'appeared']);
    expect(act).toEqual(['scapegrace', 'appeared']);
  });
});

describe('classifyTranscript — A2a word-split tolerance', () => {
  it('A2a: a 1-edit word-split on a short line is ok, not drift (RED→GREEN)', () => {
    const c = classifyTranscript('Skulduggery frowned at her.', 'Skull Duggery frowned at her.', CLEAN);
    expect(c.verdict).toBe('ok');
  });
});

describe('classifyTranscript — A2d 1→N name-split tolerance', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_MAX_BRIDGE_RUN;
  });

  it('A2d: a name split into 3 transcript tokens is ok, not drift (RED→GREEN)', () => {
    // "Scapegrace appeared." heard "Scape a grace appeared." — 1 sub + 2 ins on a
    // tiny denominator drove WER 1.5 > 0.4. The 3-run bridge rejoins it → ok.
    const c = classifyTranscript('Scapegrace appeared.', 'Scape a grace appeared.', CLEAN);
    expect(c.verdict).toBe('ok');
  });

  it('A2d: maxBridgeRun=2 restores the pre-PR drift (disable knob wired)', () => {
    process.env.SEG_ASR_MAX_BRIDGE_RUN = '2';
    const c = classifyTranscript('Scapegrace appeared.', 'Scape a grace appeared.', CLEAN);
    expect(c.verdict).toBe('drift');
  });

  it('A2d: a genuinely garbled 3-word run still drifts (no false bridge)', () => {
    const c = classifyTranscript('The hammer fell hard.', 'The banana apple split hard.', CLEAN);
    expect(c.verdict).toBe('drift');
  });
});

describe('classifyTranscript — A2b short-reference substitution backstop', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_MIN_REF_WORDS;
  });

  it('A2b: a single substitution on a 2-word reference is inconclusive, not drift (RED→GREEN)', () => {
    // "Valkyrie Cain." (14 chars, 2 words) heard "Volkery Cain": 1 sub / 2 words =
    // WER 0.5 > 0.4, but one homophone on a 2-word line is weak evidence.
    const c = classifyTranscript('Valkyrie Cain.', 'Volkery Cain.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.del).toBe(0);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2b: a single substitution on a 1-WORD reference still flags drift (strong evidence)', () => {
    // [rev R1-#1] "Extraordinarily." → 1 token, 16 chars. A full substitution is
    // wer 1.0 — the whole word is wrong. The >= 2 lower bound must keep this drift.
    const c = classifyTranscript('Extraordinarily.', 'Coincidentally.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: a DELETION on a short reference still flags drift (truncation/negation preserved)', () => {
    const c = classifyTranscript('Detective Inspector', 'Inspector', CLEAN);
    expect(c.del).toBe(1);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: TWO substitutions on a 2-word reference still flags drift (whole line wrong)', () => {
    const c = classifyTranscript('Crimson Sparrow', 'Velvet Hammer', CLEAN);
    expect(c.sub).toBe(2);
    expect(c.verdict).toBe('drift');
  });

  it('A2b: a single-substitution meaning-flip on a 2-word ref is inconclusive (disclosed tradeoff)', () => {
    // [rev R1-#2] Documents the accepted tradeoff: a directional flip expressible
    // as ONE substitution on a 2-word ref is weak ASR evidence → inconclusive
    // (recorded, not re-recorded). Deletion-shaped flips stay drift (case above).
    const c = classifyTranscript('Going forward.', 'Going backward.', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2b: the backstop does not touch a long reference', () => {
    const c = classifyTranscript(EXPECTED, EXPECTED.replace('observatory', 'laboratory'), CLEAN);
    expect(c.verdict).toBe('ok');
  });

  it('A2b: minRefWords=0 disables the backstop (post-impl wiring check)', () => {
    // NOTE [rev]: green before AND after the impl. Pre-A2b there is no backstop so
    // this is drift anyway; post-impl it proves the disable knob is wired.
    process.env.SEG_ASR_MIN_REF_WORDS = '0';
    const c = classifyTranscript('Valkyrie Cain.', 'Volkery Cain.', CLEAN);
    expect(c.verdict).toBe('drift');
  });
});

describe('classifyTranscript — A2e 1-word near-homophone backstop', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_HOMOPHONE_1WORD;
  });

  it('A2e: a long single word misheard by ≤1 edit is inconclusive, not drift (RED→GREEN)', () => {
    // "Uneventfully." (13 chars ≥ minChars 12, so it IS scored) heard
    // "Unaventfully." — 1 sub (e→a) → WER 1.0 > 0.4. One edit on a whole long
    // word is a spelling/schwa variant; the audio said the right phonemes.
    const c = classifyTranscript('Uneventfully.', 'Unaventfully.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2e: a far-apart single-word substitution still flags drift (strong evidence)', () => {
    // "Extraordinarily."→"Coincidentally." is a whole different word (edit
    // distance ≫ 1), not a mishearing → stays drift.
    const c = classifyTranscript('Extraordinarily.', 'Coincidentally.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.verdict).toBe('drift');
  });

  it('A2e: a real edit-1 word swap on a 1-word line is inconclusive (DISCLOSED tradeoff)', () => {
    // [review I-1/I-2] Documents the accepted tradeoff at the decision boundary:
    // a genuinely different word that happens to sit at CHARACTER edit-distance 1
    // ("Resignation."→"Designation.", r→d) is routed to inconclusive, not drift —
    // on a single-word line the audio and ASR are equally likely to be the source,
    // so it is weak evidence (flagged, never auto-re-recorded). Same philosophy as
    // the A2b "Going forward"→"Going backward" backstop. Set SEG_ASR_HOMOPHONE_1WORD
    // =false (test above) to flag these as drift instead.
    const c = classifyTranscript('Resignation.', 'Designation.', CLEAN);
    expect(c.sub).toBe(1);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2e: a short single word (< minChars) is unaffected — still inconclusive via the floor', () => {
    // "Uneventful." (11 chars) never reaches scoring; the minChars floor already
    // routes it to inconclusive. A2e must not change that path.
    const c = classifyTranscript('Uneventful.', 'Unaventful.', CLEAN);
    expect(c.verdict).toBe('inconclusive');
  });

  it('A2e: SEG_ASR_HOMOPHONE_1WORD=false restores the pre-PR drift (disable knob wired)', () => {
    process.env.SEG_ASR_HOMOPHONE_1WORD = 'false';
    const c = classifyTranscript('Uneventfully.', 'Unaventfully.', CLEAN);
    expect(c.verdict).toBe('drift');
  });
});

describe('classifyTranscript — A2c short-line loop detection', () => {
  it('A2c: a looped short line flags drift even under the minChars floor (RED→GREEN)', () => {
    // "No." (3 chars, < minChars 12) looped → high compression. Before A2c the
    // minChars floor returns inconclusive first; after, the loop tell wins.
    const looped: AsrSignals = { avgLogprob: -0.2, noSpeechProb: 0.02, compressionRatio: 3.0 };
    const c = classifyTranscript('No.', 'no no no no no no', looped);
    expect(c.verdict).toBe('drift');
  });

  it('A2c: a normal short line is still inconclusive (not over-flagged)', () => {
    const c = classifyTranscript('Oh.', 'Oh.', CLEAN); // compression 1.3 < 2.4
    expect(c.verdict).toBe('inconclusive');
  });
});

/* Integration test: vocalizationAllowlist forwarded through verifySegmentTranscript (fs-57)
   These tests exercise the PRODUCTION entry point (verifySegmentTranscript), not classifyTranscript.
   The critical test (first one) FAILS before Fix 1 (when vocalizationAllowlist was dropped on
   forward) and PASSES after — because it relies on the allowlist to suppress a deletion run of 5
   that exceeds maxDeletionRun (4), flipping the verdict from drift → ok. */

describe('verifySegmentTranscript vocalizationAllowlist integration (fs-57)', () => {
  const CLEAN_SIGNALS: AsrSignals = { avgLogprob: -0.2, noSpeechProb: 0.01, compressionRatio: 1.2 };

  // Expected: "haah ooh ah mm hmm i did not see you walk in there"
  // ASR drops the 5 vocalization tokens ("haah", "ooh", "ah", "mm", "hmm") — a deletion run of 5
  // which exceeds maxDeletionRun (4). Without the allowlist forwarded, longestDeletionRun = 5 →
  // drift. WITH the allowlist forwarded, those 5 deletions are tolerated → run resets → ok.
  // This test FAILS before Fix 1 (no forwarding) and PASSES after.
  it('vocalizationAllowlist forwarded: suppresses a 5-token deletion run that would otherwise drift', async () => {
    const c = await verifySegmentTranscript(
      Buffer.from([0, 0]),
      24000,
      'Haah! Ooh! Ah! Mm! Hmm! I did not see you walk in there.',
      {
        transcribeFn: async () => ({
          text: 'I did not see you walk in there.',
          language: 'en',
          ...CLEAN_SIGNALS,
        }),
        vocalizationAllowlist: ['haah', 'ooh', 'ah', 'mm', 'hmm'],
      },
    );
    expect(c.verdict).toBe('ok');
  });

  it('WITHOUT vocalizationAllowlist the same 5-token drop drifts (regression guard)', async () => {
    // Same input but no allowlist — the 5-token deletion run (haah ooh ah mm hmm) exceeds
    // maxDeletionRun (4), so verdict is drift. This confirms the allowlist is the flip.
    const c = await verifySegmentTranscript(
      Buffer.from([0, 0]),
      24000,
      'Haah! Ooh! Ah! Mm! Hmm! I did not see you walk in there.',
      {
        transcribeFn: async () => ({
          text: 'I did not see you walk in there.',
          language: 'en',
          ...CLEAN_SIGNALS,
        }),
        // no vocalizationAllowlist
      },
    );
    expect(c.verdict).toBe('drift');
  });
});
