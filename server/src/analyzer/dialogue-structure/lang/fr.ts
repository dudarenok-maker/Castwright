import type { LanguageConventions } from '../types.js';

export const fr: LanguageConventions = {
  language: 'fr',
  /* #2289 / #2310 — the entity alternatives are RETAINED, not redundant.
     Since #2310 `stripHtml` decodes the full named set, so freshly-parsed body
     text reaches here with a real dash and the `[-–—]` branch does the work.
     But the text that reaches TTS is the stage-2 model's RETURNED sentence
     text, not a re-derivation of the parsed body, and that text is persisted
     in `manuscript-edits.json` and the analysis cache — neither refreshed by a
     re-parse. A model can also echo an entity whatever `stripHtml` did.
     Dropping these alternatives would regress dialogue ATTRIBUTION for
     already-analysed books — strictly worse than the mispronunciation #2310
     fixed. (`state.json` carries no chapter body at all, so that is not the
     reason — see the design spec's Appendix B finding 1.) Same reasoning
     covers the `DASH` constants in dialogue-structure/{parser,legibility}.ts
     and aligner.ts's 7-char atom. */
  dialogueOpen: /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu,
  quotePairs: [['«', '»']],
  // #2279 — `“…”` and `"…"` added for translated / converted texts that use
  // Western doubles rather than French guillemets. Secondary tier (#2288 M2):
  // only fills gaps between primary runs.
  secondaryQuotePairs: [['“', '”'], ['"', '"']],
  speechVerbStems: [
    'dit', 'demand', 'répond', 'murmur', 'cri', 'soupir', 'ajout', 'repri', 'lanç', 'rétorqu',
    'continu', 'interromp', 'observ', 'remarqu', 'affirm', 'assur', 'promis', 'averti', 'déclara',
  ],
  beatVerbStems: ['hocha', 'sourit', 'soupira', 'fronça', 'rit', 'haussa'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^\p{L}])je([^\p{L}]|$)/iu,
    male: /(^|[^\p{L}])il([^\p{L}]|$)/iu,
    female: /(^|[^\p{L}])elle([^\p{L}]|$)/iu,
  },
  addresseePrepositions: ['à'],
  tagClauseConjunctions: ['et', 'mais'],
};
