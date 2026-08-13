import type { LanguageConventions } from '../types.js';

export const es: LanguageConventions = {
  language: 'es',
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
  quotePairs: [['«', '»'], ['“', '”']],
  speechVerbStems: [
    'dijo', 'pregunt', 'respond', 'susurr', 'grit', 'murmur', 'exclam', 'contest', 'añad', 'insist',
    'coment', 'cont', 'interrump', 'observ', 'manifest', 'asegur', 'afirm', 'ment', 'advier', 'advert',
  ],
  beatVerbStems: ['asint', 'sonri', 'suspi', 'frunc', 'rí', 'encogi'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^\p{L}])yo([^\p{L}]|$)/iu,
    male: /(^|[^\p{L}])él([^\p{L}]|$)/iu,
    female: /(^|[^\p{L}])ella([^\p{L}]|$)/iu,
  },
  addresseePrepositions: ['a'],
  tagClauseConjunctions: ['y', 'pero'],
};
