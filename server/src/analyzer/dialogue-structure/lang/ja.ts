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
