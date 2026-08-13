import type { LanguageConventions } from '../types.js';

export const fr: LanguageConventions = {
  language: 'fr',
  // #2289: some EPUB toolchains leave the entity literal in the body text
  // (stripHtml only decodes a small named-entity set) — carry both &mdash;
  // and &ndash; alongside the literal dash glyphs, per the ru.ts precedent.
  dialogueOpen: /^\s*(?:&mdash;|&ndash;|[-–—])\s*/iu,
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
