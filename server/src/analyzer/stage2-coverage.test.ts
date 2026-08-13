/* Stage-2 attribution coverage guard. The per-chapter attribution model
   (prose → per-sentence JSON) can fall into a degenerate repeat-loop: it
   re-emits a span of sentences and terminates early, so the chapter is both
   DUPLICATED and TRUNCATED (the 2026-06-05 The Drowning Bell ch12/ch18 forensics).
   The cache ingest trusts the model's list with no coverage check, so it ships.

   These tests pin the detector that compares the attributed sentences against
   the EXACT input prose (`ch.body`) — same text the model saw — so it is robust
   to the tag/quote/split-normalization noise that broke the prompt-based
   forensic sweeps. */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import {
  validateStage2Coverage,
  runStage2WithCoverageGuard,
  DEFAULT_STAGE2_COVERAGE_THRESHOLDS,
  classifyDialogueLine,
  narratedSpeechShare,
  STAGE2_MAX_NARRATED_SPEECH_PCT,
  isBetterCoverage,
  type Stage2CoverageVerdict,
} from './stage2-coverage.js';
import * as us from '../workspace/user-settings.js';

const sent = (text: string) => ({ text });
/** Build a body of N simple sentences and the matching faithful attribution. */
function bodyOf(n: number): { body: string; sentences: Array<{ text: string }> } {
  const arr = Array.from({ length: n }, (_, i) => `This is sentence number ${i + 1} of the chapter.`);
  return { body: arr.join(' '), sentences: arr.map(sent) };
}

beforeEach(() => {
  (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
});

afterEach(() => {
  delete process.env.STAGE2_MIN_COVERAGE;
  delete process.env.STAGE2_MAX_COVERAGE;
});

describe('validateStage2Coverage', () => {
  it('passes a faithful attribution (full coverage, ending present, no dup)', () => {
    const { body, sentences } = bodyOf(12);
    const v = validateStage2Coverage(body, sentences);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
    expect(v.coverageRatio).toBeGreaterThan(0.9);
    expect(v.coverageRatio).toBeLessThan(1.2);
    expect(v.endingPresent).toBe(true);
    expect(v.duplicatedBlock).toBeNull();
  });

  it('flags a truncated attribution (only the first third emitted)', () => {
    const { body, sentences } = bodyOf(12);
    const v = validateStage2Coverage(body, sentences.slice(0, 4));
    expect(v.ok).toBe(false);
    expect(v.endingPresent).toBe(false); // chapter ending never emitted
    expect(v.coverageRatio).toBeLessThan(0.5);
    expect(v.issues.some((i) => /truncat|cover|ending/i.test(i))).toBe(true);
  });

  it('flags a duplicated contiguous block (loop with full ending)', () => {
    const { body, sentences } = bodyOf(8);
    // emit 1..8 then re-emit 3..6 (a 4-sentence loop) — ending still present
    const looped = [...sentences, ...sentences.slice(2, 6)];
    const v = validateStage2Coverage(body, looped);
    expect(v.ok).toBe(false);
    expect(v.duplicatedBlock).not.toBeNull();
    expect(v.duplicatedBlock!.length).toBeGreaterThanOrEqual(4);
    expect(v.issues.some((i) => /duplicat|loop|repeat/i.test(i))).toBe(true);
  });

  it('flags the ch18 shape: loop-and-truncate (dup block + missing ending)', () => {
    const { body, sentences } = bodyOf(12);
    // analyze 1..6, then loop back and re-emit 3..6 — never reaches 7..12
    const looped = [...sentences.slice(0, 6), ...sentences.slice(2, 6)];
    const v = validateStage2Coverage(body, looped);
    expect(v.ok).toBe(false);
    expect(v.endingPresent).toBe(false); // back half missing
    expect(v.duplicatedBlock).not.toBeNull(); // and a loop
  });

  it('does NOT flag normal analyzer compression (coverage ~0.7, ending present)', () => {
    // The attribution legitimately drops/merges minor fragments — a healthy
    // chapter can read ~70% coverage and still reach its ending (The Hollow Tide ch22).
    const { body, sentences } = bodyOf(20);
    // keep 14 of 20 sentences (incl. the last) → ~0.7 coverage, ending intact
    const compressed = sentences.filter((_, i) => i < 13 || i === 19);
    const v = validateStage2Coverage(body, compressed);
    expect(v.coverageRatio).toBeGreaterThan(0.6);
    expect(v.coverageRatio).toBeLessThan(0.95);
    expect(v.endingPresent).toBe(true);
    expect(v.ok).toBe(true);
  });

  // Pure-Cyrillic prose, NO ASCII letters or digits — the real failing shape
  // (the digit in "sentence 1" would survive the ASCII normaliser and mask it).
  const CYRILLIC_SENTENCES = [
    'Туман опустился на старый город.',
    'Колокол прозвонил где-то вдалеке.',
    'Она шла по узкой улице совсем одна.',
    'Дождь негромко стучал по крышам домов.',
    'Никто не вышел ей навстречу в тот час.',
    'В тёмных окнах горел тусклый жёлтый свет.',
    'Холодный ветер нёс запах моря и дыма.',
    'Старик у ворот лишь молча проводил её взглядом.',
    'Дорога вела вниз к заброшенной каменной пристани.',
    'Там, у самой воды, её ждал последний корабль.',
    'Сердце билось часто, тревожно и неровно.',
    'Она хорошо знала, что назад пути уже нет.',
  ];

  it('passes a faithful attribution of a non-Latin (Cyrillic) chapter', () => {
    // Regression: the normaliser kept only [a-z0-9], so a Russian chapter's
    // prose AND its faithful attribution both collapsed to ~0 words → ratio 0.00
    // → flagged "truncated" on every retry forever (the 2026-06-15 stuck run).
    const body = CYRILLIC_SENTENCES.join(' ');
    const v = validateStage2Coverage(body, CYRILLIC_SENTENCES.map(sent));
    expect(v.coverageRatio).toBeGreaterThan(0.9);
    expect(v.coverageRatio).toBeLessThan(1.2);
    expect(v.endingPresent).toBe(true);
    expect(v.ok).toBe(true);
    expect(v.issues).toHaveLength(0);
  });

  it('still flags a truncated Cyrillic attribution (signals work, not bypassed)', () => {
    const body = CYRILLIC_SENTENCES.join(' ');
    const v = validateStage2Coverage(body, CYRILLIC_SENTENCES.slice(0, 4).map(sent));
    expect(v.ok).toBe(false);
    expect(v.coverageRatio).toBeLessThan(0.5);
    expect(v.endingPresent).toBe(false);
  });

  it('flags a CJK short-dialogue repeat-loop the <8 key floor used to miss', () => {
    const line = (t: string) => ({ text: t });
    const base = ['「そうだ」', '「本当に」', '「行こう」', '「まだだ」'].map(line);
    const sentences = [...base, ...base]; // a 4-run repeat at constant offset
    const v = validateStage2Coverage('', sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS);
    expect(v.duplicatedBlock).not.toBeNull();
  });

  it('does NOT false-positive a faithful CJK dialogue attribution (short but unique lines)', () => {
    // Guard test: ensure the CJK floor of 2 doesn't flag legitimate unique short CJK text
    const line = (t: string) => ({ text: t });
    const sentences = ['「そうだ」', '「本当に」', '「行こう」', '「まだだ」', '「違うな」'].map(line);
    const body = sentences.map((s) => s.text).join('');
    const v = validateStage2Coverage(body, sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS);
    expect(v.ok).toBe(true);
    expect(v.duplicatedBlock).toBeNull();
  });

  it('does NOT flag a word-free source (e.g. a *** scene break) as truncated', () => {
    // Regression (2026-06-19 Ночной дозор ch7): a lone scene-break paragraph
    // ("***") normalises to ZERO words, so the ratio was forced to 0.00 and the
    // span was flagged "truncated" on every retry — a permanent stuck loop. A
    // zero-word source is un-evaluable (nothing to under-cover): with attributed
    // output present it must PASS, not report dropped/truncated content. Same
    // failure class as the Cyrillic case above, different trigger.
    const v = validateStage2Coverage('***\n\n', [{ text: '***' }]);
    expect(v.ok).toBe(true);
    expect(v.issues.some((i) => /truncat|dropped|cover|loop|excess/i.test(i))).toBe(false);
  });

  it('does NOT gate the ratio when the source is too small to evaluate (heading-sized span)', () => {
    /* Regression (2026-07-16 Ночной дозор ch6): an isolated "Глава 4" chunk
       (2 source words) on which the model looped produced 1405 output words →
       ratio 702.50, rejected as a "repeat-loop" on every retry → the chapter
       stuck. A span this small can't be ratio-checked: the denominator is noise,
       so any real output blows past maxCoverageRatio. Such a span is un-evaluable
       for the ratio — a genuine loop is still caught by the duplicated-block
       signal, and an empty result by the no-sentences check. Here the (unique)
       output must NOT be flagged as excess coverage. */
    const body = 'Глава 4'; // 2 attributable words
    const looped = Array.from({ length: 300 }, (_, i) => ({ text: `word ${i} unique line here` }));
    const v = validateStage2Coverage(body, looped);
    expect(v.duplicatedBlock).toBeNull(); // unique lines → not a real loop
    expect(v.issues.some((i) => /excess|loop|cover/i.test(i))).toBe(false);
    expect(v.ok).toBe(true);
  });

  it('does NOT false-positive a short-but-complete chapter (e.g. a preface)', () => {
    const body = 'PREFACE. A short opening note. For the future.';
    const sentences = [sent('PREFACE.'), sent('A short opening note.'), sent('For the future.')];
    const v = validateStage2Coverage(body, sentences);
    expect(v.ok).toBe(true);
    expect(v.endingPresent).toBe(true);
  });

  it('tolerates inline [emotion] tags and minor wording in the sentence text', () => {
    const { body } = bodyOf(6);
    const tagged = bodyOf(6).sentences.map((s, i) =>
      sent(i % 2 ? `[emphatic] ${s.text}` : s.text),
    );
    const v = validateStage2Coverage(body, tagged);
    expect(v.ok).toBe(true);
    expect(v.duplicatedBlock).toBeNull();
  });

  it('honours an env-override that tightens the min-coverage floor', () => {
    const { body, sentences } = bodyOf(10);
    const slightlyShort = sentences.slice(0, 9); // 90% coverage
    expect(validateStage2Coverage(body, slightlyShort).coverageRatio).toBeGreaterThan(0.85);
    // default min (0.8) passes coverage; tighten to 0.95 → flagged
    process.env.STAGE2_MIN_COVERAGE = '0.95';
    const strict = validateStage2Coverage(body, slightlyShort);
    expect(strict.ok).toBe(false);
    expect(strict.issues.some((i) => /cover/i.test(i))).toBe(true);
  });

  it('accepts an explicit thresholds argument (overrides env + defaults)', () => {
    const { body, sentences } = bodyOf(8);
    const looped = [...sentences, ...sentences.slice(2, 6)];
    // raise the dup-run floor above the loop length → not flagged as dup
    const v = validateStage2Coverage(body, looped, {
      ...DEFAULT_STAGE2_COVERAGE_THRESHOLDS,
      minDupRun: 99,
      maxCoverageRatio: 5,
    });
    expect(v.duplicatedBlock).toBeNull();
  });

  it('handles empty input without throwing', () => {
    expect(validateStage2Coverage('', []).ok).toBe(false);
    expect(validateStage2Coverage('some text here', []).ok).toBe(false);
  });
});

describe('runStage2WithCoverageGuard', () => {
  const body = bodyOf(12).body;
  const good = () => ({ sentences: bodyOf(12).sentences });
  const truncated = () => ({ sentences: bodyOf(12).sentences.slice(0, 3) });

  it('accepts a good first attempt without retrying', async () => {
    const call = vi.fn(async () => good());
    const out = await runStage2WithCoverageGuard({ body, maxRetries: 2, call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.coverage.ok).toBe(true);
    expect(out.attempts).toBe(1);
  });

  it('re-runs on a coverage failure and keeps the good retake', async () => {
    const call = vi
      .fn()
      .mockImplementationOnce(async () => truncated())
      .mockImplementationOnce(async () => good());
    const onRetry = vi.fn();
    const out = await runStage2WithCoverageGuard({ body, maxRetries: 2, call, onRetry });
    expect(call).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(out.coverage.ok).toBe(true);
    expect(out.result.sentences.length).toBe(12); // the good take
    expect(out.attempts).toBe(2);
  });

  /* #2287-adjacent, found on the Ночной дозор C2/C3 acceptance run: the retry's
     whole premise is that the loop-and-truncate defect is stochastic. On ch8 it
     was not — five attempts across two server lifetimes all failed with the same
     rule at the same offset. The loop burned its entire budget re-running a call
     that provably could not succeed, then reported it as a soft "SUSPECT after
     retries" as though it had been transient. */
  it('stops early when a retry reproduces the previous failure EXACTLY (deterministic)', async () => {
    const identicalFailure = () => ({ sentences: bodyOf(12).sentences.slice(0, 2) });
    const call = vi.fn(async () => identicalFailure());
    const onRetry = vi.fn();
    const onExhausted = vi.fn();

    const out = await runStage2WithCoverageGuard({
      body,
      maxRetries: 5,
      call,
      onRetry,
      onExhausted,
    });

    /* Two calls, not six: the first attempt plus ONE retry that proved the
       failure reproduces. Without the early stop this is 6. */
    expect(call).toHaveBeenCalledTimes(2);
    expect(out.attempts).toBe(2);
    expect(out.deterministicFailure).toBe(true);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0]).toBe(2);
    expect(out.coverage.ok).toBe(false); // still reported as failing, never silently accepted
  });

  it('keeps retrying while the failure signature CHANGES (a genuinely stochastic defect)', async () => {
    /* The control for the test above: differing failures must NOT trip the
       early stop, or the fix would defeat the retry it is protecting. */
    const call = vi
      .fn()
      .mockImplementationOnce(async () => ({ sentences: bodyOf(12).sentences.slice(0, 2) }))
      .mockImplementationOnce(async () => ({ sentences: bodyOf(12).sentences.slice(0, 4) }))
      .mockImplementationOnce(async () => ({ sentences: bodyOf(12).sentences }));
    const onExhausted = vi.fn();

    const out = await runStage2WithCoverageGuard({ body, maxRetries: 5, call, onExhausted });

    expect(call).toHaveBeenCalledTimes(3);
    expect(out.coverage.ok).toBe(true);
    expect(out.deterministicFailure).toBe(false);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('stops on identical repeats even when the FIRST attempt remains the least-bad take', async () => {
    /* The shape that made the early stop inert: the signature must be compared
       against the attempt just made, NOT against the running best. Attempt 1 is
       a plain truncation (no duplicated block, so it scores well); attempts 2+
       are an identical repeat-loop, which scores WORSE and therefore never
       replaces `coverage`. Comparing against `coverage` freezes on attempt 1's
       signature, no repeat ever matches it, and the whole budget burns.

       This is the ordinary case, not an exotic one — any run whose first attempt
       is the least-bad hits it, which is why the two tests above cannot see it:
       one makes every attempt byte-identical, the other makes them improve. */
    const { sentences: full } = bodyOf(12);
    const plainTruncation = () => ({ sentences: full.slice(0, 6) });
    const repeatLoop = () => ({ sentences: [...full.slice(0, 5), ...full.slice(0, 5)] });
    const call = vi
      .fn()
      .mockImplementationOnce(async () => plainTruncation())
      .mockImplementation(async () => repeatLoop());
    const onExhausted = vi.fn();

    const out = await runStage2WithCoverageGuard({ body, maxRetries: 5, call, onExhausted });

    /* Three calls: attempt 1, the first repeat-loop, and the second one that
       proves it reproduces. Comparing against the running best gives 6. */
    expect(call).toHaveBeenCalledTimes(3);
    expect(out.deterministicFailure).toBe(true);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    /* The best take is still returned — the stop must not cost us attempt 1. */
    expect(out.result.sentences.length).toBe(6);
  });

  it('exhausts retries and returns the best (least-bad) take, still flagged', async () => {
    // attempt1: 3/12 (worse), attempt2: 8/12 (better but still <0.6? 0.67>0.6 ok) → use a clearer bad
    const veryShort = () => ({ sentences: bodyOf(12).sentences.slice(0, 2) }); // 0.17
    const lessShort = () => ({ sentences: bodyOf(12).sentences.slice(0, 6) }); // 0.5 (<0.6, still bad)
    const call = vi
      .fn()
      .mockImplementationOnce(async () => veryShort())
      .mockImplementationOnce(async () => lessShort())
      .mockImplementationOnce(async () => veryShort());
    const out = await runStage2WithCoverageGuard({ body, maxRetries: 2, call });
    expect(call).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(out.coverage.ok).toBe(false);
    expect(out.result.sentences.length).toBe(6); // kept the least-bad (highest coverage)
    expect(out.attempts).toBe(3);
  });

  it('does not retry when maxRetries is 0 (guard disabled)', async () => {
    const call = vi.fn(async () => truncated());
    const out = await runStage2WithCoverageGuard({ body, maxRetries: 0, call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.coverage.ok).toBe(false);
  });
});

describe('config resolver wiring — analyzer-chunking', () => {
  it('app override of analyzer.stage2.minCoverage changes resolveThresholds().minCoverageRatio', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'analyzer.stage2.minCoverage': 0.75,
    });
    // Use a body that would pass with default 0.6 floor but fail with 0.75
    // Body: 100 words; sentences: 70 words (ratio 0.70, passes 0.6, fails 0.75)
    const bodyWords = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    const sentWords = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
    const v = validateStage2Coverage(bodyWords, [{ text: sentWords }]);
    // With override 0.75, ratio 0.70 should be flagged as truncated
    expect(v.ok).toBe(false);
    expect(v.issues.some((s) => s.includes('truncated') || s.includes('dropped'))).toBe(true);
  });
});

/* #2325 — dialogue collapse. The 2026-08-12 Ночной дозор run persisted a book
   at 95.7% narrator with a coverage ratio of ~1.00 and `ok: true`, because
   handing every spoken line to the narrator re-emits the prose verbatim and so
   is invisible to all three prose-survival signals. */
describe('dialogue-collapse detection (#2325)', () => {
  const RU_DIALOGUE_OPEN = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  /* A speech half opens with the marker then a CAPITAL; a tag half opens with
     the marker then lowercase and is legitimately the narrator. */
  const speech = (n: number, characterId: string) =>
    Array.from({ length: n }, (_, i) => ({
      text: `- Реплика номер ${i} для проверки.`,
      characterId,
    }));
  const tags = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `- сказал Егор ${i}.`, characterId: 'narrator' }));
  const body = (ss: Array<{ text: string }>) => ss.map((s) => s.text).join('\n\n');

  describe('classifyDialogueLine', () => {
    it('splits speech from tag by the case of the first cased letter', () => {
      expect(classifyDialogueLine('- Ничего нет,', RU_DIALOGUE_OPEN)).toBe('speech');
      expect(classifyDialogueLine('- сказал Егор.', RU_DIALOGUE_OPEN)).toBe('tag');
    });
    it('is indeterminate without the marker or without a cased letter', () => {
      expect(classifyDialogueLine('Просто проза.', RU_DIALOGUE_OPEN)).toBe('indeterminate');
      expect(classifyDialogueLine('- 123 456 …', RU_DIALOGUE_OPEN)).toBe('indeterminate');
    });
  });

  it('breaches when the spoken lines were handed to the narrator', () => {
    const ss = speech(30, 'narrator');
    const v = validateStage2Coverage(body(ss), ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
    expect(v.ok).toBe(false);
    expect(v.issues.join(' ')).toMatch(/Dialogue collapse/);
    // The prose-survival signals are all clean — that is the whole point.
    expect(v.coverageRatio).toBeGreaterThan(0.9);
    expect(v.duplicatedBlock).toBeNull();
  });

  it('passes when the same lines carry real speakers', () => {
    const ss = speech(30, 'anton');
    const v = validateStage2Coverage(body(ss), ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
    expect(v.ok).toBe(true);
    expect(v.issues.join(' ')).not.toMatch(/Dialogue collapse/);
  });

  it('does NOT breach on tag halves, which are correctly the narrator', () => {
    /* The false positive that would make this guard unusable: `- сказал Егор.`
       lines open with the same marker but ARE narration. */
    const ss = tags(40);
    const v = validateStage2Coverage(body(ss), ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
    expect(v.issues.join(' ')).not.toMatch(/Dialogue collapse/);
    expect(v.ok).toBe(true);
  });

  it('is inert for a language with no dialogue marker (English)', () => {
    const ss = speech(30, 'narrator');
    const v = validateStage2Coverage(body(ss), ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS);
    expect(v.ok).toBe(true);
    expect(v.issues.join(' ')).not.toMatch(/Dialogue collapse/);
  });

  it('does not judge a span with too few spoken lines to be meaningful', () => {
    const ss = speech(5, 'narrator');
    const v = validateStage2Coverage(body(ss), ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
    expect(v.issues.join(' ')).not.toMatch(/Dialogue collapse/);
  });

  it('treats sentences with no characterId as un-evaluable, not as clean', () => {
    /* Counting them would read as "not narrator" and drag the share DOWN, so a
       caller passing unattributed sentences would get a silent vacuous pass. */
    const ss = Array.from({ length: 30 }, (_, i) => ({ text: `- Реплика ${i} тут.` }));
    const share = narratedSpeechShare(ss, RU_DIALOGUE_OPEN);
    expect(share.speechHalves).toBe(0);
    expect(share.evaluable).toBe(false);
  });

  it('sits below the threshold for the good run and above it for the collapsed one', () => {
    /* Calibration from two full-book runs of the same first-person novel:
       good run's worst chapter 39.3%, collapsed run's best 72.2%. */
    const mix = (narratedPct: number) => {
      const total = 100;
      const n = Math.round((narratedPct / 100) * total);
      return [...speech(n, 'narrator'), ...speech(total - n, 'anton')];
    };
    expect(narratedSpeechShare(mix(39.3), RU_DIALOGUE_OPEN).pct).toBeLessThan(
      STAGE2_MAX_NARRATED_SPEECH_PCT,
    );
    expect(narratedSpeechShare(mix(72.2), RU_DIALOGUE_OPEN).pct).toBeGreaterThan(
      STAGE2_MAX_NARRATED_SPEECH_PCT,
    );
  });

  it('retries a collapsed section through the coverage guard', async () => {
    let attempt = 0;
    const collapsed = speech(30, 'narrator');
    const good = speech(30, 'anton');
    const out = await runStage2WithCoverageGuard({
      body: body(collapsed),
      maxRetries: 2,
      dialogueOpen: RU_DIALOGUE_OPEN,
      call: async () => ({ sentences: (attempt++ === 0 ? collapsed : good) }),
    });
    expect(attempt).toBeGreaterThan(1); // it did not accept the collapsed take
    expect(out.coverage.ok).toBe(true);
    expect(out.result.sentences[0].characterId).toBe('anton');
  });
});

/* #2342 — three follow-ups from the #2325 review gate (PR #2333):
   (A) the retry's two scoring functions never learned about `dialogueCollapse`,
       so a retry that halves the narrated share can lose to a worse-collapsed
       first attempt AND get mistaken for "retrying can't help";
   (B) the guard tests `dialogueOpen` against the ATTRIBUTED text, so a model
       that drops/reformats the leading dash makes every line indeterminate and
       the guard passes silently on the output shape most likely to be broken;
   (C) nothing reported `speechHalves`/`pct` below the evaluable floor, so an
       operator couldn't tell "little dialogue here" from "guard was blind
       here". */
describe('narratedSpeech scoring, signature and observability (#2342)', () => {
  const RU_DIALOGUE_OPEN = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  /* Same shape as the #2325 describe block's `speech` helper, duplicated
     locally rather than hoisted out of that block's closure — matches the
     file's existing pattern of each describe owning its own fixtures. */
  const speechAt = (narratedCount: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({
      text: `- Реплика номер ${i} для проверки.`,
      characterId: i < narratedCount ? 'narrator' : 'anton',
    }));
  const joinBody = (ss: Array<{ text: string }>) => ss.map((s) => s.text).join('\n\n');

  describe('defect A — retry scoring learns the collapse dimension', () => {
    it('prefers a less-collapsed retry over a more-collapsed first attempt when ratio/dup are tied', async () => {
      /* Both takes share the SAME sentence text (only characterId differs), so
         coverageRatio and duplicatedBlock are identical between them — before
         the fix, `isBetterCoverage` is blind to the collapse axis entirely, so
         a tie on those two terms means the retry is never preferred, no matter
         how much less collapsed it is. */
      const body = joinBody(speechAt(0, 100));
      const heavilyCollapsed = speechAt(95, 100); // 95% narrated — breaches
      const lessCollapsed = speechAt(61, 100); // 61% narrated — still breaches, far less so
      const call = vi
        .fn()
        .mockImplementationOnce(async () => ({ sentences: heavilyCollapsed }))
        .mockImplementationOnce(async () => ({ sentences: lessCollapsed }));

      const out = await runStage2WithCoverageGuard({
        body,
        maxRetries: 1,
        dialogueOpen: RU_DIALOGUE_OPEN,
        call,
      });

      expect(call).toHaveBeenCalledTimes(2);
      expect(out.coverage.narratedSpeech?.pct).toBeCloseTo(61, 0);
    });

    it('does not treat two collapsed takes at materially different rates as the SAME failure (signature)', async () => {
      /* All three attempts share ratio/dup/ending (same sentence text every
         time), so before the fix `verdictSignature` is identical across all
         three and the loop declares "deterministic" after just ONE retry
         (attempt 2, at 65%, would already look like a repeat of attempt 1's
         95% failure). The fix must let attempt 2 (65%) survive as "different
         from attempt 1 (95%)" and only stop once attempt 3 repeats attempt
         2's OWN rate exactly. */
      const body = joinBody(speechAt(0, 100));
      const call = vi
        .fn()
        .mockImplementationOnce(async () => ({ sentences: speechAt(95, 100) }))
        .mockImplementationOnce(async () => ({ sentences: speechAt(65, 100) }))
        .mockImplementationOnce(async () => ({ sentences: speechAt(65, 100) }));
      const onExhausted = vi.fn();

      const out = await runStage2WithCoverageGuard({
        body,
        maxRetries: 3,
        dialogueOpen: RU_DIALOGUE_OPEN,
        call,
        onExhausted,
      });

      // 3 calls, not 2: attempt 1 (95%) and attempt 2 (65%) must NOT be
      // treated as a signature match even though ratio/dup/ending agree.
      expect(call).toHaveBeenCalledTimes(3);
      expect(out.deterministicFailure).toBe(true);
      expect(onExhausted).toHaveBeenCalledTimes(1);
      expect(onExhausted.mock.calls[0][0]).toBe(3);
      expect(out.coverage.narratedSpeech?.pct).toBeCloseTo(65, 0);
    });
  });

  describe('defect B — the guard fails open when the output drops the dialogue marker', () => {
    it('flags "dialogue markers lost" when the attribution strips the leading dash from a heavily-spoken source', () => {
      // 60 source dash-opening speech lines; the attribution keeps the WORDS
      // but drops the leading "- " on every one, so classifyDialogueLine reads
      // them as indeterminate — the exact shape #2325's own check is blind to.
      const sourceLines = Array.from(
        { length: 60 },
        (_, i) => `- Реплика номер ${i} для проверки.`,
      );
      const body = sourceLines.join('\n\n');
      const sentences = sourceLines.map((line, i) => ({
        text: line.replace(/^- /, ''),
        characterId: i % 2 ? 'anton' : 'narrator',
      }));

      const v = validateStage2Coverage(body, sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);

      expect(v.ok).toBe(false);
      expect(v.issues.join(' ')).toMatch(/marker/i);
      // Distinct failure from "dialogue collapse" — the cast wasn't ignored,
      // the marker just didn't survive, and the message must say so.
      expect(v.issues.join(' ')).not.toMatch(/Dialogue collapse/);
    });

    it('does not fire below STAGE2_MIN_SPEECH_HALVES source openers (too little dialogue to judge)', () => {
      const sourceLines = Array.from({ length: 10 }, (_, i) => `- Реплика номер ${i} тут.`);
      const body = sourceLines.join('\n\n');
      const sentences = sourceLines.map((line) => ({
        text: line.replace(/^- /, ''),
        characterId: 'narrator',
      }));
      const v = validateStage2Coverage(body, sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      expect(v.issues.join(' ')).not.toMatch(/marker/i);
    });

    /* Calibration from two real full-book runs of the same Russian chapter
       (recorded run: 246 source → 213 attributed; controlled replay: 241 →
       209) — both far above the half-of-source bar. A healthy chapter at
       these proportions must NOT trip the guard. */
    it('does not flag markers lost at healthy real-run proportions (246→213, 241→209)', () => {
      for (const [source, attributed] of [
        [246, 213],
        [241, 209],
      ] as const) {
        const sourceLines = Array.from(
          { length: source },
          (_, i) => `- Реплика номер ${i} для проверки.`,
        );
        const body = sourceLines.join('\n\n');
        const sentences = sourceLines.slice(0, attributed).map((line, i) => ({
          text: line,
          characterId: i % 2 ? 'anton' : 'nadya',
        }));
        const v = validateStage2Coverage(body, sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
        expect(v.issues.join(' ')).not.toMatch(/marker/i);
      }
    });
  });

  describe('defect C — narratedSpeech is exposed on the verdict in all three states', () => {
    it('is null when no dialogue-marker language was supplied (unchanged behaviour)', () => {
      const { body, sentences } = bodyOf(12);
      const v = validateStage2Coverage(body, sentences);
      expect(v.narratedSpeech).toBeNull();
    });

    it('is populated with evaluable:false (not omitted) when too few speech halves to judge', () => {
      const ss = Array.from({ length: 5 }, (_, i) => ({
        text: `- Реплика ${i} тут.`,
        characterId: 'narrator',
      }));
      const body = joinBody(ss);
      const v = validateStage2Coverage(body, ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      expect(v.narratedSpeech).not.toBeNull();
      expect(v.narratedSpeech!.evaluable).toBe(false);
      expect(v.narratedSpeech!.speechHalves).toBe(5);
    });

    it('is populated with evaluable:true and the measured pct when judged', () => {
      const ss = speechAt(10, 30);
      const body = joinBody(ss);
      const v = validateStage2Coverage(body, ss, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      expect(v.narratedSpeech).not.toBeNull();
      expect(v.narratedSpeech!.evaluable).toBe(true);
      expect(v.narratedSpeech!.pct).toBeCloseTo(33.33, 1);
    });
  });
});

/* #2342 round 2 — an independent review of round 1's ADDITIVE scoring scheme
   (isBetterCoverage summing a capped collapse penalty into the ratio/dup
   score, verdictSignature appending a whole-percent collapse term to every
   verdict) measured three concrete bugs:

     1. the penalty was gated on `narratedSpeech.evaluable`, and losing the
        dialogue markers entirely is exactly what drives `evaluable: false` —
        so a dash-stripped take (penalty 0) could beat an intact-but-collapsing
        take (penalty >0);
     2. the penalty floor (>1.0) exceeded the ENTIRE low-side range of
        `|1 - coverageRatio|` (max ~1.0 for `truncated`), so a take that lost
        88% of the chapter could outrank a COMPLETE take that merely collapsed
        — backwards from the module's stated intent;
     3. the signature's collapse term was appended to EVERY verdict, and
        `toFixed(0)` at a realistic denominator moves on roughly half of all
        single-flipped-line diffs — so `deterministicFailure` almost never
        fired once `dialogueOpen` was supplied, defeating #2304's early stop
        for exactly the languages (ru/es/fr) this guard serves.

   Round 2 replaces the sum with a severity TIER (see `verdictTier`'s own
   comment for the ordering rationale) plus a tie-break, and gates/re-buckets
   the signature term. These tests pin the three regressions directly, using
   the reviewer's own measured shapes, PLUS the tier/tie-break pairwise
   orderings an additive scheme cannot get wrong the same way. */
describe('severity-tier scoring and gated signature (#2342 round 2)', () => {
  const RU_DIALOGUE_OPEN = /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu;
  const speechAt = (narratedCount: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({
      text: `- Реплика номер ${i} для проверки.`,
      characterId: i < narratedCount ? 'narrator' : 'anton',
    }));
  const joinBody = (ss: Array<{ text: string }>) => ss.map((s) => s.text).join('\n\n');

  /** Minimal, fully-specified fake verdict — lets the pairwise orderings be
      pinned directly against `isBetterCoverage`, independent of
      `runStage2WithCoverageGuard`'s single-shared-`body` constraint (which
      makes it awkward to build two attempts with genuinely different tiers
      against the same source text). */
  const verdict = (overrides: Partial<Stage2CoverageVerdict>): Stage2CoverageVerdict => ({
    ok: false,
    coverageRatio: 1.0,
    endingPresent: true,
    duplicatedBlock: null,
    narratedSpeech: null,
    noSentences: false,
    truncated: false,
    excess: false,
    markersLost: false,
    issues: [],
    ...overrides,
  });

  describe('isBetterCoverage — tier ordering (direct)', () => {
    it('prefers a duplicated-block take over an empty one (reverses the pre-#2342 ordering, deliberately)', () => {
      /* Old sum: empty scored `0 + |1-0| = 1.0`, any dup take scored `≥100`,
         so the OLD code preferred nothing at all over a repeat-loop take —
         an accident of the `+100` constant. A repeat-loop take still
         contains real (if duplicated) prose; an empty one contains none.
         The new tier order is the intended one, and this reversal is
         deliberate, not a regression — see `verdictTier`'s own comment. */
      const dupTake = verdict({ duplicatedBlock: { startIndex: 0, length: 5, offset: 3 } });
      const emptyTake = verdict({ noSentences: true, coverageRatio: 0, endingPresent: false });
      expect(isBetterCoverage(dupTake, emptyTake)).toBe(true);
      expect(isBetterCoverage(emptyTake, dupTake)).toBe(false);
    });

    it('[bug 1 regression] a markers-intact collapsing take (61.7%) beats a dash-stripped (markersLost) take', () => {
      /* Reviewer's measured shapes: dash-stripped take scored 0.00 under the
         round-1 sum (markersLost drives evaluable:false, so the penalty term
         vanished), a markers-intact 61.7%-collapsed take scored 1.617 — so
         round 1 KEPT the dash-stripped take. Both are tier 0 (prose intact);
         the tie-break must put markersLost (200) above any collapse pct. */
      const collapsing = verdict({
        narratedSpeech: { speechHalves: 100, narrated: 62, pct: 61.7, evaluable: true },
      });
      const dashStripped = verdict({ markersLost: true });
      expect(isBetterCoverage(collapsing, dashStripped)).toBe(true);
      expect(isBetterCoverage(dashStripped, collapsing)).toBe(false);
    });

    it('[bug 2 regression] a complete take collapsing at 61% beats a take with only 12% coverage', () => {
      /* Reviewer's measured shapes: ratio 0.120 (88% of the chapter missing)
         scored 0.880 under the round-1 sum; a COMPLETE take collapsing at 61%
         scored 1.610 — so round 1 kept 12 sentences out of 100 over a
         complete, faithfully-transcribed-but-miscast chapter. The 12%-ratio
         take is `truncated` (tier 1); the 61%-collapse take is tier 0 —
         tier 0 always wins, regardless of how large the ratio deviation is. */
      const collapsing = verdict({
        coverageRatio: 1.0,
        narratedSpeech: { speechHalves: 100, narrated: 61, pct: 61, evaluable: true },
      });
      const gutted = verdict({ truncated: true, coverageRatio: 0.12 });
      expect(isBetterCoverage(collapsing, gutted)).toBe(true);
      expect(isBetterCoverage(gutted, collapsing)).toBe(false);
    });

    it('prefers a breaching take over a duplicated-block take (tier 0 vs tier 2)', () => {
      const breaching = verdict({
        narratedSpeech: { speechHalves: 100, narrated: 70, pct: 70, evaluable: true },
      });
      const dupTake = verdict({ duplicatedBlock: { startIndex: 5, length: 6, offset: 12 } });
      expect(isBetterCoverage(breaching, dupTake)).toBe(true);
    });

    it('does not treat a too-small-to-judge sample as breaching in the tie-break (the evaluable gate)', () => {
      /* 5/5 narrated is 100% — but only 5 speech halves, under
         STAGE2_MIN_SPEECH_HALVES (20), so `evaluable: false`. Without the
         evaluable gate the raw `pct` (100) would read as WORSE than a
         genuine, evaluable 70% breach; with the gate this take reads as
         non-breaching (tie-break 0) and wins. */
      const tooSmallToJudge = verdict({
        narratedSpeech: { speechHalves: 5, narrated: 5, pct: 100, evaluable: false },
      });
      const genuineBreach = verdict({
        narratedSpeech: { speechHalves: 100, narrated: 70, pct: 70, evaluable: true },
      });
      expect(isBetterCoverage(tooSmallToJudge, genuineBreach)).toBe(true);
      expect(isBetterCoverage(genuineBreach, tooSmallToJudge)).toBe(false);
    });

    it('still orders two duplicated-block takes by |1 - coverageRatio| (unchanged from the pre-#2342 baseline)', () => {
      const closer = verdict({
        duplicatedBlock: { startIndex: 0, length: 5, offset: 3 },
        coverageRatio: 0.95,
      });
      const farther = verdict({
        duplicatedBlock: { startIndex: 0, length: 5, offset: 3 },
        coverageRatio: 1.4,
      });
      expect(isBetterCoverage(closer, farther)).toBe(true);
    });
  });

  describe('verdictSignature — gated + coarsely-bucketed collapse term (via the guard)', () => {
    it('[bug 3 regression] a repeat-loop take with one flipped (non-breaching) speaker still stops early with dialogueOpen supplied', async () => {
      /* The ch8 shape: a repeat-loop (duplicatedBlock present) chapter whose
         narratedSpeech is evaluable but NOT breaching (33% < 60% threshold).
         Attempts differ by exactly one flipped characterId OUTSIDE the
         duplicated block — under round 1's ungated whole-percent term this
         could move the signature's collapse component and defeat the
         deterministic-failure stop; round 2 only appends a collapse term
         when the verdict actually BREACHES, so a non-breaching verdict's
         term is 'n/a' regardless of the flip, restoring the pre-#2342 stop. */
      const base = Array.from({ length: 24 }, (_, i) => ({
        text: `- Реплика номер ${i} для проверки.`,
        characterId: i < 8 ? 'narrator' : 'anton', // 8/24 = 33% before the loop duplicates any
      }));
      const loop = [...base, ...base.slice(2, 6)]; // duplicatedBlock: 4-run at offset 24
      const body = loop.map((s) => s.text).join('\n\n');
      const flipOneOutsideTheLoop = (id: string) =>
        loop.map((s, i) => (i === 20 ? { ...s, characterId: id } : s));
      const attempt1 = flipOneOutsideTheLoop('anton');
      const attempt2 = flipOneOutsideTheLoop('narrator');
      // Sanity: both attempts stay non-breaching (evaluable, well under 60%).
      const v1 = validateStage2Coverage(body, attempt1, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      const v2 = validateStage2Coverage(body, attempt2, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      expect(v1.duplicatedBlock).not.toBeNull();
      expect(v1.narratedSpeech?.evaluable).toBe(true);
      expect(v1.narratedSpeech!.pct).toBeLessThan(STAGE2_MAX_NARRATED_SPEECH_PCT);
      expect(v2.narratedSpeech!.pct).toBeLessThan(STAGE2_MAX_NARRATED_SPEECH_PCT);

      const call = vi
        .fn()
        .mockImplementationOnce(async () => ({ sentences: attempt1 }))
        .mockImplementation(async () => ({ sentences: attempt2 }));
      const onExhausted = vi.fn();

      const withMarkerLanguage = await runStage2WithCoverageGuard({
        body,
        maxRetries: 5,
        dialogueOpen: RU_DIALOGUE_OPEN,
        call,
        onExhausted,
      });

      expect(call).toHaveBeenCalledTimes(2);
      expect(withMarkerLanguage.deterministicFailure).toBe(true);
      expect(onExhausted).toHaveBeenCalledTimes(1);

      // Parity check: the SAME shape without a marker language must behave
      // identically — that parity is the whole point of the fix.
      const callNoLang = vi
        .fn()
        .mockImplementationOnce(async () => ({ sentences: attempt1 }))
        .mockImplementation(async () => ({ sentences: attempt2 }));
      const withoutMarkerLanguage = await runStage2WithCoverageGuard({
        body,
        maxRetries: 5,
        call: callNoLang,
      });
      expect(callNoLang).toHaveBeenCalledTimes(2);
      expect(withoutMarkerLanguage.deterministicFailure).toBe(true);
    });

    it('buckets the collapse term to 10 percentage points, so a single flipped line inside one bucket still stops early', async () => {
      /* 160/213 = 75.12%, 161/213 = 75.59% — a realistic ~0.47pp-per-line
         denominator (the reviewer's own calibration). Both round to bucket 8
         (`Math.round(pct/10)`), so the two attempts are the SAME signature
         and the guard stops after one retry. Under whole-percent
         quantisation (round 1) these are "75" vs "76" — DIFFERENT — and the
         stop would be defeated. */
      const total = 213;
      const body = joinBody(speechAt(0, total));
      const attempt1 = speechAt(160, total); // 75.12%, breaching
      const attempt2 = speechAt(161, total); // 75.59%, breaching, same bucket
      const call = vi
        .fn()
        .mockImplementationOnce(async () => ({ sentences: attempt1 }))
        .mockImplementation(async () => ({ sentences: attempt2 }));
      const onExhausted = vi.fn();

      const out = await runStage2WithCoverageGuard({
        body,
        maxRetries: 5,
        dialogueOpen: RU_DIALOGUE_OPEN,
        call,
        onExhausted,
      });

      expect(call).toHaveBeenCalledTimes(2);
      expect(out.deterministicFailure).toBe(true);
      expect(onExhausted).toHaveBeenCalledTimes(1);
    });
  });

  describe('markersLost does not misattribute a truncated take (round 2 nit 7)', () => {
    it('never sets markersLost when the take is truncated, and the message does not blame the marker', () => {
      // 60 source dash-opening lines, but the attribution kept only 3 of
      // them — drastically truncated, well under minCoverageRatio. The
      // marker-recovery ratio (3/60) also fails the "under half" test, but
      // the CAUSE here is missing prose, not a mis-emitted marker.
      const sourceLines = Array.from({ length: 60 }, (_, i) => `- Реплика номер ${i} для проверки.`);
      const body = sourceLines.join('\n\n');
      const sentences = sourceLines.slice(0, 3).map((line, i) => ({
        text: line,
        characterId: i % 2 ? 'anton' : 'narrator',
      }));
      const v = validateStage2Coverage(body, sentences, DEFAULT_STAGE2_COVERAGE_THRESHOLDS, RU_DIALOGUE_OPEN);
      expect(v.truncated).toBe(true);
      expect(v.markersLost).toBe(false);
      expect(v.issues.join(' ')).not.toMatch(/marker/i);
    });
  });
});
