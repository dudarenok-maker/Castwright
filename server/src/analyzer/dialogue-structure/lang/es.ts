import type { LanguageConventions } from '../types.js';

export const es: LanguageConventions = {
  language: 'es',
  dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu,
  quotePairs: [['«', '»'], ['"', '"']],
  speechVerbStems: [
    'dijo', 'pregunt', 'respond', 'susurr', 'grit', 'murmur', 'exclam', 'contest', 'añad', 'insist',
    'coment', 'cont', 'interrupt', 'observ', 'manifest', 'asegur', 'afirm', 'ment', 'advier', 'advert',
  ],
  beatVerbStems: ['asint', 'sonri', 'suspi', 'funci', 'rí', 'encogi'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^a-z])yo([^a-z]|$)/iu,
    male: /(^|[^a-z])él([^a-z]|$)/iu,
    female: /(^|[^a-z])ella([^a-z]|$)/iu,
  },
};
