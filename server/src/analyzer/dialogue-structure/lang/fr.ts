import type { LanguageConventions } from '../types.js';

export const fr: LanguageConventions = {
  language: 'fr',
  dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu,
  quotePairs: [['«', '»']],
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
