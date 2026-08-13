import type { LanguageConventions } from '../types.js';

export const de: LanguageConventions = {
  language: 'de',
  dialogueOpen: null,
  // German opens with U+201E „ and closes with U+201C “ in correct typography,
  // but real-world manuscripts (incl. our translated demo books) routinely close
  // it with an ASCII " (U+0022) or the U+201D ” glyph instead. All three must
  // pair with „, or German dialogue never forms a quote run and the structure
  // engine demotes every reply to the narrator (#1598). `findQuoteRuns` groups
  // these closers by opener and ends a „ run at the NEAREST of them, so a
  // paragraph mixing closer glyphs across turns still splits per turn (#1601);
  // array order does NOT set precedence. »…« is the alternate form.
  // #2279 — **NO NEW OPENER MAY BE ADDED TO THIS TABLE.** #2279 widened the
  // other six languages' quotePairs; German got nothing, and the reason is a
  // property of German specifically, so it will keep looking like an oversight
  // to anyone who does not read this. It is not. See #2288.
  //
  // The condition is NOT "same glyph" (`"…"`) — that was the first wrong
  // diagnosis. It is: **an added opener whose closer set is narrower than the
  // closer drift this language actually exhibits.** `„` above is deliberately
  // paired with THREE closers because German drift is routine; any new opener
  // carries one or two, so its run extends lazily past the NEXT turn's opener
  // to a later matching closer, and `findQuoteRuns`' leftmost-wins rule then
  // discards the genuine turn as overlapping it. All three candidates fail,
  // each measured against `main` on the real `parseChapterStructure` path:
  //
  //   ['"','"']   „Guten Tag", sagte er. Das Schild sagte "Zu". „Und du?", …
  //                 main ["Guten Tag","Und du?"]  ->  ["Guten Tag",". „Und du?"]
  //   ['“','”']   „Guten Tag”, sagte er. Das Schild sagte “Zu". „Und du?”, …
  //                 main ["Guten Tag","Und du?"]  ->  ["Guten Tag","Zu\". „Und du?"]
  //   ['«','»']   „Guten Tag“, sagte er. Das Schild sagte «Zu". »Und du?«, …
  //                 main ["Guten Tag","Und du?"]  ->  ["Guten Tag","Zu\". "]
  //
  // Every one destroys a turn and synthesises punctuation as speech. A sweep of
  // 16,250 generated German two-turn paragraphs found 642 main-right/shipped-
  // corrupt cases across the latter two alone. They are invisible to a corpus
  // replay because they need DRIFTED glyphs, and the live German book is
  // canonically typeset — which is exactly why two successive safety arguments
  // ("leftmost-wins protects it", then "a distinct closer glyph is safe")
  // both passed a 0-changed-chapters measurement and were both false.
  //
  // Recognising drifted German therefore needs an engine change — role-aware
  // candidate suppression, per-paragraph convention detection, or import-time
  // normalisation — not a table entry. #2288 carries the options.
  quotePairs: [
    ['„', '“'],
    ['„', '”'],
    ['„', '"'],
    ['»', '«'],
  ],
  secondaryQuotePairs: [],
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
  addresseePrepositions: ['zu', 'an'],
  tagClauseConjunctions: ['und', 'aber'],
};
