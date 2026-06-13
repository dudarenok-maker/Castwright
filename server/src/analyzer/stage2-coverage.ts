/* Stage-2 attribution coverage guard.

   The per-chapter attribution model converts a chapter's prose into a
   per-sentence JSON list. A known degenerate failure (2026-06-05 The Drowning Bell
   ch12/ch18): the model falls into a repeat-loop — it re-emits a span of
   sentences and terminates early — so the chapter is BOTH duplicated and
   truncated. Output is internally consistent (ids 1..N, no gaps), so schema
   validation can't catch it, and the cache ingest trusts it blindly.

   `validateStage2Coverage` compares the attributed sentences against the EXACT
   input prose (`ch.body`, the same text the model was given) on three signals:

     - coverage ratio  — attributed-word-count ÷ source-word-count, out of band
                          → dropped content (too low) or a loop (too high),
     - ending present  — the chapter's last words must appear in the output
                          (catches truncation even when a loop masks the ratio),
     - duplicated block — a contiguous run of sentences that repeats an earlier
                          run at a constant offset (the loop signature).

   Comparing against `ch.body` directly (no prompt header, consistent
   normalisation) is what makes this reliable — the prompt-based forensic sweeps
   false-positived because they compared the cache against header-padded prompts
   with divergent normalisation.

   Purity: no I/O, no model calls. Mirrors the env-override pattern of
   audio-qa.ts / segment-qa.ts. */

export interface Stage2CoverageThresholds {
  /** attributed-words ÷ source-words below this → dropped/truncated content. */
  minCoverageRatio: number;
  /** attributed-words ÷ source-words above this → looped/runaway output. */
  maxCoverageRatio: number;
  /** How many of the source's trailing words must appear in the output for the
      chapter ending to count as "present". */
  endingTailWords: number;
  /** Smallest contiguous duplicated-sentence run (constant offset) to flag. */
  minDupRun: number;
}

/* minCoverageRatio is deliberately generous (0.6): the attribution legitimately
   compresses — healthy chapters measured 0.65–1.0 against their prose (The Hollow Tide
   ch22 0.71, The Ebb ch56 0.78 both reach their true endings). The loop-truncate
   defect is catastrophic by comparison (The Drowning Bell ch12 0.12, ch18 0.52), and
   a loop that doesn't also truncate is caught by the duplicated-block signal
   regardless of ratio — so a low floor avoids false-flagging normal compression
   without missing the real bug. */
export const DEFAULT_STAGE2_COVERAGE_THRESHOLDS: Stage2CoverageThresholds = {
  minCoverageRatio: 0.6,
  maxCoverageRatio: 1.6,
  endingTailWords: 8,
  minDupRun: 4,
};

export interface Stage2CoverageVerdict {
  ok: boolean;
  /** attributed-word-count ÷ source-word-count. */
  coverageRatio: number;
  /** Whether the source's trailing words survived into the output. */
  endingPresent: boolean;
  /** The largest duplicated contiguous run, or null. `startIndex` is the index
      of the second copy's first sentence; `offset` is how far back its twin sits. */
  duplicatedBlock: { startIndex: number; length: number; offset: number } | null;
  issues: string[];
}

import { configValue } from '../config/resolver.js';

function resolveThresholds(override?: Stage2CoverageThresholds): Stage2CoverageThresholds {
  if (override) return override;
  return {
    minCoverageRatio: configValue<number>('analyzer.stage2.minCoverage'),
    maxCoverageRatio: configValue<number>('analyzer.stage2.maxCoverage'),
    endingTailWords: configValue<number>('analyzer.stage2.endingTailWords'),
    minDupRun: configValue<number>('analyzer.stage2.minDupRun'),
  };
}

/** Lowercase, drop inline [tags], collapse to alphanumeric words. The same
    normalisation is applied to the source prose and the attributed text so the
    comparison is robust to punctuation, smart quotes, casing, and emotion tags. */
function words(text: string): string[] {
  return (text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Largest contiguous run of sentences whose normalised text repeats an earlier
    sentence's text at a CONSTANT offset (the loop signature). */
function findDuplicatedBlock(
  sentences: Array<{ text: string }>,
  minDupRun: number,
): { startIndex: number; length: number; offset: number } | null {
  const firstSeen = new Map<string, number>();
  const repeats: Array<{ i: number; offset: number }> = [];
  sentences.forEach((s, i) => {
    const key = words(s.text).join(' ');
    if (key.length < 8) return; // ignore very short sentences ("No.", "What?")
    if (firstSeen.has(key)) repeats.push({ i, offset: i - firstSeen.get(key)! });
    else firstSeen.set(key, i);
  });
  let best: { startIndex: number; length: number; offset: number } | null = null;
  let runLen = 0;
  let runOffset: number | null = null;
  let runStart = 0;
  let lastI = -2;
  for (const r of repeats) {
    if (r.i === lastI + 1 && r.offset === runOffset) {
      runLen += 1;
    } else {
      runLen = 1;
      runOffset = r.offset;
      runStart = r.i;
    }
    if (runLen >= minDupRun && (!best || runLen > best.length)) {
      best = { startIndex: runStart, length: runLen, offset: runOffset! };
    }
    lastI = r.i;
  }
  return best;
}

/** Validate that the attributed sentences faithfully cover the source chapter
    prose. See the module header for the three signals. */
export function validateStage2Coverage(
  bodyText: string,
  sentences: Array<{ text: string }>,
  thresholds?: Stage2CoverageThresholds,
): Stage2CoverageVerdict {
  const t = resolveThresholds(thresholds);
  const issues: string[] = [];

  const bodyWords = words(bodyText);
  const outWords = sentences.flatMap((s) => words(s.text));

  const coverageRatio = bodyWords.length === 0 ? 0 : outWords.length / bodyWords.length;

  // Ending present: do the source's trailing words appear (contiguously) in the
  // attributed word stream?
  let endingPresent: boolean;
  if (bodyWords.length === 0) {
    endingPresent = false;
  } else {
    const tail = bodyWords.slice(-Math.min(t.endingTailWords, bodyWords.length)).join(' ');
    endingPresent = outWords.join(' ').includes(tail);
  }

  const duplicatedBlock = findDuplicatedBlock(sentences, t.minDupRun);

  /* Pass/fail rests on the two robust signals: coverage ratio (out of band →
     dropped or looped content) and a duplicated block (the loop signature).
     `endingPresent` is NOT a gate — at high coverage a missing tail is almost
     always normalisation noise (the parser's last words split/format
     differently), which false-positived clean chapters at 94–99% coverage. It
     stays in the verdict, and supports the truncation message only when
     coverage is already low. */
  const truncated = coverageRatio < t.minCoverageRatio;
  const excess = coverageRatio > t.maxCoverageRatio;

  if (sentences.length === 0) {
    issues.push('No sentences attributed for this chapter.');
  }
  if (truncated) {
    issues.push(
      `Low coverage — attributed ${outWords.length} words vs ~${bodyWords.length} source (ratio ${coverageRatio.toFixed(2)} below ${t.minCoverageRatio})${
        !endingPresent ? ", and the chapter's final words never appear" : ''
      }; content was dropped/truncated.`,
    );
  } else if (excess) {
    issues.push(
      `Excess coverage — attributed ${outWords.length} words vs ~${bodyWords.length} source (ratio ${coverageRatio.toFixed(2)} above ${t.maxCoverageRatio}); likely a repeat-loop.`,
    );
  }
  if (duplicatedBlock) {
    issues.push(
      `Duplicated block — ${duplicatedBlock.length} consecutive sentences repeat earlier ones at offset ${duplicatedBlock.offset} (repeat-loop).`,
    );
  }

  return {
    ok: !truncated && !excess && !duplicatedBlock,
    coverageRatio,
    endingPresent,
    duplicatedBlock,
    issues,
  };
}

/** Between two failing verdicts, the "least bad" is the one with no duplicated
    block, then the coverage ratio closest to 1.0. */
function isBetterCoverage(a: Stage2CoverageVerdict, b: Stage2CoverageVerdict): boolean {
  if (a.ok !== b.ok) return a.ok;
  const score = (v: Stage2CoverageVerdict) => (v.duplicatedBlock ? 100 : 0) + Math.abs(1 - v.coverageRatio);
  return score(a) < score(b);
}

/** Run a stage-2 attribution call, validate its coverage against the source
    prose, and re-run on failure (the loop-and-truncate defect is stochastic, so
    a fresh attempt usually clears it). Keeps the least-bad take when all
    attempts fail — the caller decides what to do with a still-failing verdict
    (warn + flag for retry, never silently accept). Pure except for the injected
    `call`, so it unit-tests without the analyzer or the network. */
export async function runStage2WithCoverageGuard<T extends { sentences: Array<{ text: string }> }>(opts: {
  body: string;
  maxRetries: number;
  call: () => Promise<T>;
  thresholds?: Stage2CoverageThresholds;
  onRetry?: (attempt: number, verdict: Stage2CoverageVerdict) => void;
}): Promise<{ result: T; coverage: Stage2CoverageVerdict; attempts: number }> {
  let result = await opts.call();
  let coverage = validateStage2Coverage(opts.body, result.sentences, opts.thresholds);
  let attempts = 1;
  while (!coverage.ok && attempts <= opts.maxRetries) {
    opts.onRetry?.(attempts + 1, coverage);
    const retryResult = await opts.call();
    const retryCoverage = validateStage2Coverage(opts.body, retryResult.sentences, opts.thresholds);
    attempts += 1;
    if (isBetterCoverage(retryCoverage, coverage)) {
      result = retryResult;
      coverage = retryCoverage;
    }
    if (coverage.ok) break;
  }
  return { result, coverage, attempts };
}
