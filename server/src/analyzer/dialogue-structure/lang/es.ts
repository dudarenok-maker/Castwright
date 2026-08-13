import type { LanguageConventions } from '../types.js';

export const es: LanguageConventions = {
  language: 'es',
  // #2289: some EPUB toolchains leave the entity literal in the body text
  // (stripHtml only decodes a small named-entity set) — carry both &mdash;
  // and &ndash; alongside the literal dash glyphs, per the ru.ts precedent.
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
