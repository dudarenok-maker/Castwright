import type { LanguageConventions } from '../types.js';

/* Japanese: quote-only dialogue, no dash-dialogue convention. No inflection
   to strip (nameStemmer is identity) and CJK has no inter-word spacing, so
   minStemLength stays permissive (1) — the CJK tokenizer gap itself is Task
   3.5's problem, not this table's. */
export const ja: LanguageConventions = {
  language: 'ja',
  dialogueOpen: null,
  quotePairs: [
    ['「', '」'],
    ['『', '』'],
  ],
  // #2279 — `“…”` and `"…"` appear in translated / web-converted Japanese that
  // uses Western quotes instead of corner brackets. `zh` already carried `“…”`
  // in its primary tier and `ja` did not, so the same line used to split by
  // language. Secondary tier (#2288 M2): only fills gaps between primary runs.
  secondaryQuotePairs: [['“', '”'], ['"', '"']],
  speechVerbStems: ['言', '話', '答', '尋', '叫', '呟', '囁', '続け', '応え'],
  beatVerbStems: ['頷', '笑', '頬', '息'],
  nameStemmer: (t) => t,
  minStemLength: 1,
  pronouns: {
    firstPerson: /(私|僕|俺)/u,
    male: /彼(?!女)/u,
    female: /彼女/u,
  },
};
