import type { LanguageConventions } from '../types.js';

export const de: LanguageConventions = {
  language: 'de',
  dialogueOpen: null,
  // German opens with U+201E „ and closes with U+201C “ in correct typography,
  // but real-world manuscripts (incl. our translated demo books) routinely close
  // it with an ASCII " (U+0022) or the U+201D ” glyph instead. All three must
  // pair with „, or German dialogue never forms a quote run and the structure
  // engine demotes every reply to the narrator (#1598). Ordered „-first so a
  // „…" run always wins over any bare ASCII pair; »…« is the alternate form.
  quotePairs: [
    ['„', '“'],
    ['„', '”'],
    ['„', '"'],
    ['»', '«'],
  ],
  speechVerbStems: [
    'sagt', 'fragt', 'antwortet', 'flüstert', 'rief', 'murmelt', 'erwidert', 'ergänzt', 'bemerkt', 'meint',
    'verkündet', 'ruft', 'stammelt', 'quietscht', 'grollt', 'heult', 'beharrt', 'äußert', 'beteuert', 'versichert',
  ],
  beatVerbStems: ['nickt', 'lächelt', 'seufzt', 'runzelt', 'lacht', 'zuckt'],
  nameStemmer: (t) => t,
  minStemLength: 3,
  pronouns: {
    firstPerson: /(^|[^\p{L}])ich([^\p{L}]|$)/iu,
    male: /(^|[^\p{L}])er([^\p{L}]|$)/iu,
    female: /(^|[^\p{L}])sie([^\p{L}]|$)/iu,
  },
};
