/* Deterministic narrator-default heuristic (plan 221 Wave A; generalized to all
   languages 2026-06-20; made conventions-driven #2245).

   The per-sentence attribution model mislabels third-person NARRATION as the
   named character (e.g. "She was lost." -> stephanie), which would read
   narration in that character's voice. The spoken-vs-narration distinction is
   mechanical, so we decide it in code: any sentence that is NOT a spoken line is
   forced to narrator. Runs for English too (the model ignores the same rule in
   the skill prompt).

   A spoken line is driven by the same `LanguageConventions` tables the
   structure engine uses (`dialogue-structure/lang/*.ts`), not a separate
   language-blind regex bundle — see #2245: the old bundle carried only one of
   the German `quotePairs` forms (four at the time, six since #2279) and
   recognised no CJK quote glyphs at all.
   Everything else is narration. Demote-only at the sentence level: it never
   reassigns a quoted line and never promotes narrator->character (it does
   lower line counts, which fold/reconcile consume downstream). Coverage is
   unaffected (the coverage guard keys on sentence text, not characterId).
   Pure: no I/O, no model calls. */

import type { SentenceOutput } from '../handoff/schemas.js';
import type { LanguageConventions } from './dialogue-structure/types.js';

const NARRATOR_ID = 'narrator';

/** True when the sentence text reads as spoken dialogue under `conventions`:
    (1) `conventions.dialogueOpen` matches at line start; (2) any opener from
    `conventions.quotePairs` OR `conventions.secondaryQuotePairs` occurs at
    line start; (3) any pair from either tier forms an embedded `open…close`
    span with at least one character between. Both tiers are read as one
    union, not two separate checks — `findQuoteRuns` needs the secondary tier
    to rank below primary because it computes RUN BOUNDARIES and a low-ranked
    candidate can straddle a real turn; this function computes no boundary at
    all, so it cannot straddle, and inheriting the tier restriction here would
    just mean #2286's secondary-convention pairs land in a field this function
    never reads — real dialogue typeset in that convention would demote to
    narrator. `conventions` is required — the no-table case (no basis to
    judge) is handled one level up, in `applyNarratorDefault`, so "no table ->
    no demotion" is a structural property of that function rather than
    something this one has to special-case for a `null` input. */
export function isSpokenLine(text: string, conventions: LanguageConventions): boolean {
  const t = (text ?? '').trimStart();
  if (!t) return false;
  if (conventions.dialogueOpen && conventions.dialogueOpen.test(t)) return true;
  const pairs = [...conventions.quotePairs, ...conventions.secondaryQuotePairs];
  for (const [open] of pairs) {
    if (t.startsWith(open)) return true;
  }
  for (const [open, close] of pairs) {
    const o = t.indexOf(open);
    if (o >= 0 && t.indexOf(close, o + open.length + 1) > o) return true;
  }
  return false;
}

/** Return a new sentence list where every non-spoken sentence's characterId is
    `narrator`. Spoken lines are returned unchanged. With `conventions === null`
    (no table for this language) there is no basis to judge spoken vs.
    narration, so the input array itself is returned by reference, untouched —
    the paired test asserts `toBe(input)`. Otherwise pure — never mutates
    input. Deliberately retained though it has no production caller — see
    docs/superpowers/plans/2026-06-20-english-narrator-default.md:215, "Do NOT
    delete it as dead code." */
export function forceNarratorOnNonSpokenLines(
  sentences: SentenceOutput[],
  conventions: LanguageConventions | null,
): SentenceOutput[] {
  if (!conventions) return sentences;
  return sentences.map((s) =>
    isSpokenLine(s.text, conventions) ? s : { ...s, characterId: NARRATOR_ID },
  );
}

/** Apply the narrator-default heuristic for ALL languages that have a
    conventions table. Each non-spoken sentence whose model-assigned
    characterId is a real character is demoted to `narrator`; the FIRST such
    override in each contiguous demoted run has its confidence clamped to
    <= 0.5 so the Confirm-view low-confidence navigator gets one review stop
    per block (not one per sentence). Spoken lines and pre-existing-narrator
    lines are returned by reference, untouched. With `conventions === null`
    (no table for this language) there is no basis to judge spoken vs.
    narration, so the whole list is returned by reference, untouched — no
    demotion at all, which is a far milder failure than sending the whole
    book to the narrator. Pure. */
export function applyNarratorDefault(
  sentences: SentenceOutput[],
  conventions: LanguageConventions | null,
): SentenceOutput[] {
  if (!conventions) return sentences;
  let clampedThisRun = false;
  return sentences.map((s) => {
    if (isSpokenLine(s.text, conventions)) {
      clampedThisRun = false;
      return s;
    }
    if (s.characterId === NARRATOR_ID) return s; // already narrator — not an override
    if (!clampedThisRun) {
      clampedThisRun = true;
      return { ...s, characterId: NARRATOR_ID, confidence: Math.min(s.confidence ?? 1, 0.5) };
    }
    return { ...s, characterId: NARRATOR_ID };
  });
}
