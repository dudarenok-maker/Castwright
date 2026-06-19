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
