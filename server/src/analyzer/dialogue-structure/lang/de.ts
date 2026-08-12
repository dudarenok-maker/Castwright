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
  // #2279 — the closer-drift above has an opener-side twin: a manuscript run
  // through English-typeset tooling loses the „ too, leaving "…" or “…".
  // `“…”` and the Swiss `«…»` are added; **the same-glyph `"…"` is NOT, and
  // must not be.** German is the one language whose own dialogue CLOSER is the
  // ASCII quote, so making that glyph an opener as well lets `findQuoteRuns`
  // re-pair a paragraph's " glyphs sequentially (1↔2, 3↔4) and swallow a real
  // turn — the #1601 mixed-glyph hazard, one level up:
  //
  //   „Guten Tag", sagte er. Das Schild sagte "Zu". „Und du?", fragte sie.
  //     without: speech „Guten Tag" · tag · speech „Und du?"          <- right
  //     with:    speech „Guten Tag" · tag · speech `. „Und du?`       <- WRONG
  //
  // The second turn's run is discarded and punctuation is synthesised as
  // speech, because the "-opener candidate starts at the SIGN's closer — after
  // turn 1's run ends and before turn 2's begins — so leftmost-wins never sees
  // it. The earlier claim that the overlap rule protects this was measured
  // only against the live German book, which is canonically typeset and cannot
  // produce the shape. Found by the PR #2286 review gate; the German
  // ASCII-only manuscript it leaves unfixed needs an engine change, not a
  // table entry — see #2288.
  //
  // `“…”` is safe by comparison: its closer is a DISTINCT glyph, so it can add
  // a spurious run over a quoted sign but never swallows the following turn —
  // the same documented false positive `en` has carried since plan 221.
  quotePairs: [
    ['„', '“'],
    ['„', '”'],
    ['„', '"'],
    ['»', '«'],
    ['“', '”'],
    ['«', '»'],
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
  addresseePrepositions: ['zu', 'an'],
  tagClauseConjunctions: ['und', 'aber'],
};
