/* Canonical dialogue-tag verb list — the single source of truth.

   A "dialogue tag" is the narrator's `<Name> <verb>` attribution beat next to a
   quote (`"…," Lessom repeated.`). Two consumers scan for these:

     - the roster-coverage guard (roster-coverage.ts) — at analysis time, to
       catch a speaker the stage-1 model dropped from the roster, and
     - scripts/recover-missing-character.mjs — the manual repair hotfix.

   The `.mjs` script is run by plain `node` and cannot import this `.ts` module,
   so it carries a LITERAL copy of this list. A drift test
   (scripts/tests/dialogue-verbs-drift.test.mjs) fails if the two ever diverge.

   Bias the list toward INCLUSION: a missing verb silently drops a real speaker
   (the Lessom/The Drowning Bell-ch19 bug), whereas an over-broad verb at worst adds
   a roster candidate that the guard's false-positive bounding (quote-adjacency /
   ≥2 hits) and the minor-cast fold filter back out. */
export const DIALOGUE_VERBS: readonly string[] = [
  // original set (kept aligned with the historical hotfix-script list)
  'said', 'growled', 'warned', 'insisted', 'added', 'continued', 'replied',
  'asked', 'answered', 'whispered', 'shouted', 'yelled', 'snapped', 'hissed',
  'spat', 'barked', 'snarled', 'grumbled', 'muttered', 'murmured', 'sighed',
  'breathed', 'laughed', 'cried', 'interrupted', 'interjected', 'countered',
  'noted', 'teased', 'chimed', 'sang', 'complained',
  // expansion — Lessom's own ch19 tags ("repeated", "agreed", "reminded")
  // plus common speech verbs the original set omitted.
  'repeated', 'agreed', 'reminded', 'demanded', 'prompted', 'protested',
  'wondered', 'clarified', 'corrected', 'offered', 'explained', 'admitted',
  'argued', 'observed', 'promised', 'called', 'urged', 'declared', 'exclaimed',
];
