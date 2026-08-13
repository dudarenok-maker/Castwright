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
  /** #2342 — the #2325 dialogue-collapse measurement, exposed rather than
      collapsed into the `dialogueCollapse`-derived issue string alone. Three
      states an operator (or the retry scorer below) needs to tell apart:
      `null` — no `dialogueOpen` was supplied, i.e. a marker-less language;
      `evaluable: false` — a marker language, but too few speech halves in
      this span to judge (see `STAGE2_MIN_SPEECH_HALVES`); `evaluable: true`
      — judged, with the measured `pct`. Populated whenever `dialogueOpen` is
      given, even when `evaluable` is false — a caller that only ever saw this
      field on a breach couldn't distinguish "little dialogue here" from "the
      guard was blind here". */
  narratedSpeech: { speechHalves: number; narrated: number; pct: number; evaluable: boolean } | null;
  /** #2342 round 2 — the individual gates that feed `ok`, exposed so the
      retry scorer (`isBetterCoverage`/`verdictSignature`, below) can rank
      verdicts by SEVERITY TIER instead of summing terms into one score. An
      additive scheme was tried first (#2342 round 1) and an independent
      review found it produced two backwards orderings — see the tier
      function's own comment for the detail. `duplicatedBlock` and
      `coverageRatio` are not duplicated here; they already carry the
      equivalent information. */
  noSentences: boolean;
  truncated: boolean;
  excess: boolean;
  /** #2342 defect B — the attribution lost the dialogue markers themselves
      (see the "markers lost" check below), as distinct from `dialogueCollapse`
      (the markers survived but went overwhelmingly to `narrator`). Always
      `false` when `truncated` is true — see that check's own comment. */
  markersLost: boolean;
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
    comparison is robust to punctuation, smart quotes, casing, and emotion tags.

    Letters/digits are matched script-agnostically via the Unicode \p{L}\p{N}
    classes (NOT [a-z0-9]): an ASCII-only filter erased every Cyrillic/CJK/
    accented character, so a non-Latin chapter's prose AND its faithful
    attribution both collapsed to ~0 words → ratio 0.00 → flagged "truncated"
    on every retry forever (the 2026-06-15 Russian-book stuck run). English
    behaviour is unchanged (ASCII letters are \p{L}). */
function words(text: string): string[] {
  return (text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Does this prose normalise to ≥1 attributable word? A span that doesn't — a
    lone scene break ("***", "* * *"), a rule of dashes, pure punctuation — has
    nothing to attribute, so the chunk runner skips it rather than spend a model
    call and trip the coverage guard's un-evaluable zero-word source (the
    2026-06-19 Ночной дозор ch7 stuck loop). */
export function hasAttributableContent(text: string): boolean {
  return words(text).length > 0;
}

/** How many attributable words this prose normalises to (see {@link words}). */
export function attributableWordCount(text: string): number {
  return words(text).length;
}

/* Below this many normalised source words a span is too small for the coverage
   RATIO to be a reliable signal: a handful of stray or looped output words blows
   the ratio past `maxCoverageRatio` even though nothing is wrong. The 2026-07-16
   Ночной дозор ch6 defect: an internal heading "Глава 4" (2 source words) was
   isolated as its own chunk between two over-budget paragraphs; the model looped
   on the near-empty span → 1405 output words vs ~2 source → ratio 702.50, so the
   excess-coverage guard rejected it on every retry and the chapter stuck, then
   flagged. Such a span is treated as ratio-un-evaluable here (a genuine loop is
   still caught by the duplicated-block signal, an empty result by the
   no-sentences check). The stage-2 chunker uses the SAME floor to MERGE a
   fragment-sized chunk into an adjacent one so it is never attributed alone. */
export const STAGE2_MIN_EVALUABLE_WORDS = 5;

/* #2325 — dialogue-attribution sanity.

   Every signal above measures whether the source PROSE survived. None measures
   whether the attribution is usable, so a chapter in which every spoken line
   was handed to `narrator` re-emits the prose verbatim, scores a coverage ratio
   of ~1.00, and passes `ok: true`. That is not hypothetical: the 2026-08-12
   Ночной дозор run persisted a whole book at 95.7% narrator across 15,100
   sentences (the good run of the same book was 67.9%) and nothing warned,
   retried, or flagged — it simply shipped a single-voice audiobook.

   For a language whose conventions carry a `dialogueOpen` marker the check is
   deterministic, because the convention itself says which paragraphs are
   speech. Only SPEECH HALVES count: `- Ничего нет,` opens with the marker and
   continues with a capital, whereas the tag half `- сказал Егор.` opens with
   the same marker but continues lowercase and is CORRECTLY the narrator. Mixing
   the two would put a legitimately-narrated population in the denominator and
   move the bar to wherever that book's tag ratio happened to sit. */
export const STAGE2_MAX_NARRATED_SPEECH_PCT = 60;

/* Below this many speech halves the share is noise, so the span is not judged
   — a short section near a chunk seam can hold two or three spoken lines. */
export const STAGE2_MIN_SPEECH_HALVES = 20;

/** Split a dialogue-marked line into `speech` (marker then an UPPERCASE first
    cased letter — an actual spoken turn) and `tag` (marker then lowercase — a
    `- сказал Егор.` narration tag, legitimately the narrator). A line with no
    cased letter at all is `indeterminate` and counted in neither, so it can
    never be silently folded into the population that decides the verdict. */
export function classifyDialogueLine(
  text: string,
  dialogueOpen: RegExp,
): 'speech' | 'tag' | 'indeterminate' {
  const trimmed = (text ?? '').trim();
  if (!dialogueOpen.test(trimmed)) return 'indeterminate';
  const after = trimmed.replace(dialogueOpen, '');
  for (const ch of after) {
    if (ch.toLowerCase() !== ch.toUpperCase()) return ch === ch.toLowerCase() ? 'tag' : 'speech';
  }
  return 'indeterminate';
}

/** Share of a span's SPEECH HALVES that were attributed to `narrator`.
    `evaluable` is false when there are too few to judge. */
export function narratedSpeechShare(
  sentences: Array<{ text: string; characterId?: string }>,
  dialogueOpen: RegExp,
): { speechHalves: number; narrated: number; pct: number; evaluable: boolean } {
  let speechHalves = 0;
  let narrated = 0;
  for (const s of sentences) {
    /* A sentence with no `characterId` carries no attribution to judge. Counting
       it would make it read as "not narrator" and drag the share DOWN, so a
       caller that forgot to pass attributed sentences would get a silent,
       vacuous pass instead of a breach. Excluded from the population entirely,
       which leaves such a span un-evaluable rather than falsely clean. */
    if (typeof s.characterId !== 'string') continue;
    if (classifyDialogueLine(s.text, dialogueOpen) !== 'speech') continue;
    speechHalves += 1;
    if (s.characterId === 'narrator') narrated += 1;
  }
  return {
    speechHalves,
    narrated,
    pct: speechHalves ? (100 * narrated) / speechHalves : 0,
    evaluable: speechHalves >= STAGE2_MIN_SPEECH_HALVES,
  };
}

/** Whether a `narratedSpeechShare` measurement breaches the collapse
    threshold. Shared between `validateStage2Coverage` (which builds the
    `dialogueCollapse` issue), the retry scorer below (which recomputes the
    SAME condition from a `Stage2CoverageVerdict`'s `narratedSpeech` field),
    and — #2342 item 2 — the route's failure-code selector (same reason:
    "was this a collapse" must stay ONE definition, not a copy that drifts). */
export function isDialogueCollapseBreach(speech: { pct: number; evaluable: boolean } | null): boolean {
  return !!(speech && speech.evaluable && speech.pct > STAGE2_MAX_NARRATED_SPEECH_PCT);
}

/* #2342 defect B — the guard above tests `dialogueOpen` against the
   ATTRIBUTED sentence text, so it is blind to the one output shape most
   likely to be broken: a model that drops or reformats the leading dash on
   every spoken line. Every line then reads `indeterminate`, `speechHalves`
   drops to (or towards) zero, `evaluable` goes false, and the collapse check
   above passes SILENTLY — on output that lost more information than a
   narrator-collapse, not less. The source's own dialogue-opening count is
   the control: it doesn't depend on anything the model did, so a healthy
   attribution should recover at least roughly half of it (production
   compression legitimately drops SOME lines — see the calibration numbers on
   the "markers lost" check below — but not nearly all of them). */

/** How many of `bodyText`'s lines open with the dialogue marker AND are a
    SPEECH half (not a narration tag) — the source-side control for the
    "markers lost" check. Splits on newlines, same granularity a paragraph-
    per-line manuscript source is written in. */
export function sourceSpeechHalfCount(bodyText: string, dialogueOpen: RegExp): number {
  return bodyText.split('\n').filter((line) => classifyDialogueLine(line, dialogueOpen) === 'speech')
    .length;
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
    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(key);
    if (key.length < (hasCjk ? 2 : 8)) return; // ignore very short sentences ("No.", "What?"); 2-char CJK is meaningful
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
  sentences: Array<{ text: string; characterId?: string }>,
  thresholds?: Stage2CoverageThresholds,
  /* #2325 — the language's dialogue marker. Omitted (English and every other
     language whose conventions define no marker) leaves the attribution check
     inert and this function byte-identical to before. */
  dialogueOpen?: RegExp,
): Stage2CoverageVerdict {
  const t = resolveThresholds(thresholds);
  const issues: string[] = [];

  const bodyWords = words(bodyText);
  const outWords = sentences.flatMap((s) => words(s.text));

  /* A source with too few words is UN-EVALUABLE for the coverage RATIO — the
     denominator is meaningless, so a handful of stray or looped output words
     blows past `maxCoverageRatio` and it must not gate. Two shapes hit this: a
     ZERO-word span (a lone "***" scene break — the 2026-06-19 Ночной дозор ch7
     stuck loop; cf. the 2026-06-15 Cyrillic case in the module header), and a
     tiny NONZERO span (an isolated "Глава 4" heading — the 2026-07-16 Ночной
     дозор ch6 stuck loop, 1405 output words vs ~2 source → ratio 702.50). Below
     `STAGE2_MIN_EVALUABLE_WORDS` the ratio is suppressed; a genuine loop is
     still caught by the duplicated-block signal and an empty OUTPUT by the "No
     sentences attributed" check, so nothing broken slips. The ratio itself is
     still reported (informative in logs) — only the pass/fail gate is skipped. */
  const sourceEvaluable = bodyWords.length >= STAGE2_MIN_EVALUABLE_WORDS;
  const coverageRatio = bodyWords.length > 0 ? outWords.length / bodyWords.length : 0;

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
  const truncated = sourceEvaluable && coverageRatio < t.minCoverageRatio;
  const excess = sourceEvaluable && coverageRatio > t.maxCoverageRatio;

  /* An empty result is always a failure — and now it MUST gate `ok` directly:
     it used to be caught only as a side effect of the forced-zero ratio (which
     a word-free source no longer produces), so without this an empty
     attribution of an empty source would wrongly pass. */
  const noSentences = sentences.length === 0;
  if (noSentences) {
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

  /* #2325 — dialogue collapse. Gated on an evaluable population so a
     dialogue-light span is never judged on three lines. Factored into
     `isDialogueCollapseBreach` (below `narratedSpeechShare`) so the retry
     scorer can recompute the SAME condition from a `Stage2CoverageVerdict`
     alone, instead of the two definitions drifting apart. */
  const speech = dialogueOpen ? narratedSpeechShare(sentences, dialogueOpen) : null;
  const dialogueCollapse = isDialogueCollapseBreach(speech);
  if (dialogueCollapse) {
    issues.push(
      `Dialogue collapse — ${speech!.narrated}/${speech!.speechHalves} spoken lines (${speech!.pct.toFixed(1)}%) were attributed to the narrator, above ${STAGE2_MAX_NARRATED_SPEECH_PCT}%; the cast is being ignored.`,
    );
  }

  /* #2342 defect B — dialogue markers lost. Independent of `dialogueCollapse`
     above: that check asks "who got the spoken lines", this one asks "did the
     attribution keep the dialogue markers AT ALL". Gated on the SOURCE'S own
     count (not the attributed one) being past the noise floor, exactly like
     `dialogueCollapse` is gated on its own population — the two use different
     denominators on purpose, because a run that lost its markers has, by
     definition, an unreliable ATTRIBUTED count.

     The "at least half" bar is calibrated off two full-book runs of the same
     Russian chapter, both healthy: recorded 246 source → 213 attributed
     (86.6%), controlled replay 241 → 209 (86.7%) — comfortably clear of the
     50% floor, which exists only to catch the shape where markers are mostly
     GONE, not to police ordinary compression (`coverageRatio`'s job).

     `!truncated` guards a misattribution the round-2 review caught (nit 7): a
     take that is 88% MISSING also fails this ratio (a mostly-absent source
     recovers "under half" of its own dash-openers trivially), but the cause
     there is the missing prose, not a dropped marker — the message must not
     claim the model mangled a marker it never got the chance to emit.
     `truncated` already gates `ok` on its own, so nothing slips through by
     suppressing this one here. */
  const sourceSpeechHalves = dialogueOpen ? sourceSpeechHalfCount(bodyText, dialogueOpen) : 0;
  const markersLost = !!(
    !truncated &&
    speech &&
    sourceSpeechHalves >= STAGE2_MIN_SPEECH_HALVES &&
    speech.speechHalves < sourceSpeechHalves / 2
  );
  if (markersLost) {
    issues.push(
      `Dialogue markers lost — the source has ${sourceSpeechHalves} dash-opening speech lines but only ` +
        `${speech!.speechHalves} were recognised as speech in the attribution (below half); the model likely ` +
        `dropped or reformatted the dialogue marker, not that the cast is being ignored.`,
    );
  }

  return {
    ok: !noSentences && !truncated && !excess && !duplicatedBlock && !dialogueCollapse && !markersLost,
    coverageRatio,
    endingPresent,
    duplicatedBlock,
    narratedSpeech: speech,
    noSentences,
    truncated,
    excess,
    markersLost,
    issues,
  };
}

/** Severity tier for `isBetterCoverage`, below. Lower is better.

      3 — nothing attributed at all (`noSentences`) — nothing to compare;
      2 — a duplicated block (repeat-loop, degenerate output);
      1 — truncated or excess coverage (prose missing or looped);
      0 — the prose survived; only the attribution itself is wrong
          (dialogue collapse or lost markers).

    #2342 round 1 replaced the original two-term SUM (`(duplicatedBlock ?
    100 : 0) + |1 - coverageRatio|`) with a three-term sum that added a
    collapse PENALTY, and an independent review caught two ways an additive
    scheme hides a wrong ordering: the penalty was gated on `evaluable`,
    which losing the dialogue markers entirely also defeats — so a
    dash-stripped take (penalty 0) could beat an intact-but-collapsing one —
    and the penalty floor (>1.0) exceeded the ENTIRE low-side range of
    `|1 - coverageRatio|` (max ~1.0 for anything `truncated`/`excess`), so
    gross truncation could outrank a collapsing-but-COMPLETE take — exactly
    backwards from the module's own stated intent. A lexicographic tier +
    tie-break (below) cannot exhibit either failure mode: a lower tier always
    wins outright regardless of magnitude, and the two attribution-only
    failures inside tier 0 are compared on one shared, correctly-ordered
    scale instead of being summed into a ratio-shaped term.

    This tier order matches the ORIGINAL (pre-#2342) sum for every pairing
    except one: `noSentences` (tier 3) now loses to `duplicatedBlock` (tier
    2), reversed from before. Under the original sum an empty attribution
    scored `0 + |1 - 0| = 1.0` (a zero-word output makes the ratio 0) while
    any dup take scored `≥100`, so the sum picked "nothing at all" over a
    repeat-loop take — an accident of the `+100` constant, not a considered
    decision: a repeat-loop take still contains real (if duplicated) prose,
    where an empty one contains none, so tier 2 losing to tier 3 was
    backwards and the new ordering is the intended one, not a regression to
    guard against.

    Every other pairing is unchanged: a dup take (tier 2) still always loses
    to a `truncated`/`excess` take (tier 1) and to a clean-prose take (tier
    0) — `truncated`/`excess` require `sourceEvaluable`, the only source of
    an unbounded ratio term, so `|1 - coverageRatio|` stays under 100 for
    every take that can reach tier 1, matching the original `+100` dup
    constant exactly; two dup takes still order by `|1 - coverageRatio|`, as
    before; a collapse-only take (tier 0) still beats a `truncated` take
    (tier 1), as before (collapse contributed nothing to the original sum);
    and `markersLost` — which the original sum had no term for at all — sits
    inside tier 0 same as `dialogueCollapse`, so it likewise beats a
    `truncated` take, consistent with "no term" behaving as "always tier 0". */
function verdictTier(v: Stage2CoverageVerdict): 0 | 1 | 2 | 3 {
  if (v.noSentences) return 3;
  if (v.duplicatedBlock) return 2;
  if (v.truncated || v.excess) return 1;
  return 0;
}

/** Tie-break within a tier — only meaningful when both verdicts share a
    tier (`isBetterCoverage` checks tier first). Tier 0's tie-break puts
    `markersLost` (200) strictly above any `dialogueCollapse` `pct` (≤100):
    losing the dialogue markers entirely is worse than misattributing SOME of
    them, per #2342 round 2. Tiers 1 and 2 both use `|1 - coverageRatio|`,
    identical to the original scoring. Tier 3 has nothing left to compare. */
function verdictTieBreak(v: Stage2CoverageVerdict): number {
  switch (verdictTier(v)) {
    case 0:
      if (v.markersLost) return 200;
      return isDialogueCollapseBreach(v.narratedSpeech) ? v.narratedSpeech!.pct : 0;
    case 1:
    case 2:
      return Math.abs(1 - v.coverageRatio);
    default:
      return 0;
  }
}

/** Between two failing verdicts, the "least bad" is chosen by severity tier
    first, then by the tier's own tie-break. See `verdictTier`'s comment for
    the full rationale and the one deliberate ordering reversal from the
    pre-#2342 baseline.

    Exported (round 2) so the pairwise orderings themselves — the exact shape
    an additive score hid two bugs inside — can be pinned directly against
    hand-built verdicts, rather than reconstructed indirectly through
    `runStage2WithCoverageGuard`'s single-shared-`body` constraint. */
export function isBetterCoverage(a: Stage2CoverageVerdict, b: Stage2CoverageVerdict): boolean {
  if (a.ok !== b.ok) return a.ok;
  const ta = verdictTier(a);
  const tb = verdictTier(b);
  if (ta !== tb) return ta < tb;
  return verdictTieBreak(a) < verdictTieBreak(b);
}

/** A failure's identity, for deciding whether re-running could possibly help.
    Structural rather than the rendered `issues` strings: those embed a
    formatted ratio, so two materially identical failures could differ by a
    digit. `coverageRatio` is quantised for the same reason — a retry that moves
    it in the fourth decimal has not found anything new.

    Deliberately NOT including sentence COUNT or text: the question is "did the
    model fail the same way", not "did it emit the same bytes".

    #2342 round 1 added a collapse term to EVERY verdict (quantised to whole
    percent). Round 2's independent review found this broke the deterministic-
    failure stop for exactly the population the guard exists to serve: with a
    realistic denominator (~100 speech halves, so ~1pp moves per flipped
    `characterId`), `toFixed(0)` flips the signature on roughly HALF of all
    single-line differences between two otherwise-identical repeat-loop
    attempts, so `deterministicFailure` almost never fires when `dialogueOpen`
    is supplied — measured on the ch8 repeat-loop shape: 2 calls and `true`
    without a marker language, 5 calls and `false` with one, though the model's
    failure was identical either way.

    Two changes restore this:

    (1) The term is appended ONLY when the verdict actually BREACHES on
        collapse (`markersLost` or `isDialogueCollapseBreach`) — every other
        verdict gets the same `collapse:n/a` a marker-less language always
        got, INCLUDING a repeat-loop take whose narrated share happens to be
        measurable but not over threshold. A repeat-loop's signature is then
        identical across attempts exactly as it was before #2342 touched this
        function at all, restoring the ch8 early stop.

    (2) Breaching verdicts bucket `pct` to 10 percentage points
        (`Math.round(pct / 10)`), not whole percent. 95% vs 65% still land in
        different buckets (9 vs 6), so a retry that genuinely improves the
        collapse rate is still recognised as different — but 95.2% vs 95.6%
        collapse to the SAME bucket, so an identical repeat still stops, and a
        single flipped line only crosses a bucket boundary near a multiple of
        10%, not on roughly half of all single-line diffs.

    `markersLost` gets its own token (`collapse:markersLost`), never a
    percentage — the two failures are different KINDS of breach (see
    `verdictTier`'s comment), so collapsing their signatures onto the same
    numeric scale would let a markers-lost attempt and a collapse attempt that
    happen to bucket to the same number look like a signature match when they
    are not the same failure at all. */
function verdictSignature(v: Stage2CoverageVerdict): string {
  const d = v.duplicatedBlock;
  const breaching = v.markersLost || isDialogueCollapseBreach(v.narratedSpeech);
  const collapseTerm = !breaching
    ? 'collapse:n/a'
    : v.markersLost
      ? 'collapse:markersLost'
      : `collapse:${Math.round(v.narratedSpeech!.pct / 10)}`;
  return [
    v.endingPresent ? 'end' : 'noend',
    d ? `dup:${d.startIndex}:${d.length}:${d.offset}` : 'nodup',
    `cov:${v.coverageRatio.toFixed(3)}`,
    collapseTerm,
  ].join('|');
}

/** Run a stage-2 attribution call, validate its coverage against the source
    prose, and re-run on failure. Keeps the least-bad take when all attempts
    fail — the caller decides what to do with a still-failing verdict (warn +
    flag for retry, never silently accept). Pure except for the injected
    `call`, so it unit-tests without the analyzer or the network.

    The retry exists because the loop-and-truncate defect is USUALLY stochastic,
    so a fresh sample usually clears it. When it is not, retrying is futile and
    actively harmful: it burns the whole budget re-running a call that cannot
    succeed, then reports the result as a soft "SUSPECT after retries" as though
    it had been transient. Observed 2026-08-12/13 on Ночной дозор ch8 — five
    attempts across two server lifetimes, every one failing with the same rule
    at the same offset (`repeat-loop` at 19), which rules out in-process state.

    So: if a retry reproduces the PREVIOUS attempt's failure signature exactly,
    stop and report it. One identical repeat is the signal — the retry's whole
    premise is sampling variance, and two consecutive identical structural
    verdicts are strong evidence there is too little of it here to help.

    Deliberately NOT claimed: that variance is absent. The comparison is against
    the immediately preceding attempt, so a sequence like A,B,A,A stops on the
    third-and-fourth pair having ALREADY observed variance at B. That is the
    intended trade — the escalation this feeds (a re-split, i.e. a different
    prompt) is a better use of the remaining budget than another identical call
    either way, and a false stop costs a split rather than a lost retry.

    `onExhausted` fires only on that path, so a caller can distinguish "we ran
    out of attempts" from "more attempts are very unlikely to help". */
export async function runStage2WithCoverageGuard<
  T extends { sentences: Array<{ text: string; characterId?: string }> },
>(opts: {
  body: string;
  maxRetries: number;
  call: () => Promise<T>;
  thresholds?: Stage2CoverageThresholds;
  /** #2325 — the language's dialogue marker, enabling the dialogue-collapse
      check. Omitted leaves the guard's behaviour unchanged. */
  dialogueOpen?: RegExp;
  onRetry?: (attempt: number, verdict: Stage2CoverageVerdict) => void;
  /** Fired instead of a further retry when an attempt reproduced the previous
      one's failure signature exactly — i.e. the defect is deterministic here
      and the remaining budget cannot help. */
  onExhausted?: (attempts: number, verdict: Stage2CoverageVerdict) => void;
}): Promise<{
  result: T;
  coverage: Stage2CoverageVerdict;
  attempts: number;
  /** True when the loop stopped early because a retry reproduced the previous
      failure signature. Distinguishes a provably-futile retry from simply
      running out of attempts. */
  deterministicFailure: boolean;
}> {
  let result = await opts.call();
  let coverage = validateStage2Coverage(opts.body, result.sentences, opts.thresholds, opts.dialogueOpen);
  let attempts = 1;
  let deterministicFailure = false;
  /* The signature of the attempt JUST MADE — tracked separately from `coverage`,
     which is the running BEST and stops advancing as soon as a retry scores
     worse. Comparing against `coverage` looks equivalent and is not: once
     attempt 1 is the least-bad take, `coverage` freezes on it and every
     subsequent identical repeat is compared against a verdict no attempt since
     has produced, so the match never fires and the whole budget burns — the
     exact behaviour this guard exists to stop. That shape is ordinary, not
     exotic: a first attempt that merely truncates outscores repeat-loop takes,
     which carry a duplicated block. */
  let lastAttemptVerdict = coverage;
  while (!coverage.ok && attempts <= opts.maxRetries) {
    /* `lastAttemptVerdict`, not `coverage` — otherwise `onRetry` and
       `onExhausted` describe DIFFERENT attempts and the operator log reads as
       two contradictory issue strings for one moment (e.g. a ratio message from
       attempt 1 followed by "reproduced exactly … (repeat-loop at 19)"). */
    opts.onRetry?.(attempts + 1, lastAttemptVerdict);
    const retryResult = await opts.call();
    const retryCoverage = validateStage2Coverage(
      opts.body,
      retryResult.sentences,
      opts.thresholds,
      opts.dialogueOpen,
    );
    attempts += 1;
    if (isBetterCoverage(retryCoverage, coverage)) {
      result = retryResult;
      coverage = retryCoverage;
    }
    if (coverage.ok) break;
    if (verdictSignature(retryCoverage) === verdictSignature(lastAttemptVerdict)) {
      deterministicFailure = true;
      opts.onExhausted?.(attempts, retryCoverage);
      break;
    }
    lastAttemptVerdict = retryCoverage;
  }
  return { result, coverage, attempts, deterministicFailure };
}
