import type { LanguageConventions } from '../types.js';

export const de: LanguageConventions = {
  language: 'de',
  dialogueOpen: null,
  quotePairs: [['„', '"'], ['»', '«']],
  speechVerbStems: [
    'sagt', 'fragt', 'antwortet', 'flüstert', 'rief', 'murmelt', 'erwidert', 'ergänzte', 'bemerkt', 'meint',
    'verkündet', 'ruft', 'stammelt', 'quietscht', 'grollte', 'heult', 'bewahrt', 'äußert', 'beteuert', 'versichert',
  ],
  beatVerbStems: ['nickt', 'lächelt', 'seufzt', 'runzelt', 'lacht', 'zuckt'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^a-z])ich([^a-z]|$)/iu,
    male: /(^|[^a-z])er([^a-z]|$)/iu,
    female: /(^|[^a-z])sie([^a-z]|$)/iu,
  },
};
