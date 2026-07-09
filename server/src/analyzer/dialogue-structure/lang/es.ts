import type { LanguageConventions } from '../types.js';

export const es: LanguageConventions = {
  language: 'es',
  dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu,
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
};
