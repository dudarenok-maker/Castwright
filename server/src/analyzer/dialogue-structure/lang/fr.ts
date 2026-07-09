import type { LanguageConventions } from '../types.js';

export const fr: LanguageConventions = {
  language: 'fr',
  dialogueOpen: /^\s*(?:&mdash;|[-–—])\s*/iu,
  quotePairs: [['«', '»']],
  speechVerbStems: [
    'dit', 'demand', 'répond', 'murmur', 'cri', 'soupir', 'ajout', 'repri', 'lanc', 'rétorqu',
    'continu', 'interrupt', 'observ', 'remark', 'affirm', 'assur', 'promis', 'averti', 'déclara', 'ajouta',
  ],
  beatVerbStems: ['hocha', 'sourit', 'soupira', 'fronça', 'rit', 'haussa'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^a-z])je([^a-z]|$)/iu,
    male: /(^|[^a-z])il([^a-z]|$)/iu,
    female: /(^|[^a-z])elle([^a-z]|$)/iu,
  },
};
