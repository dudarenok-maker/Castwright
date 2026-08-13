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
  // #2279/#2286 — **NO NEW OPENER MAY BE ADDED TO `quotePairs` (PRIMARY).**
  // `„` above is deliberately paired with THREE closers because German closer
  // drift is routine; a new opener in the PRIMARY table would carry only one
  // or two, so its run extends lazily past the NEXT turn's opener to a later
  // matching closer, and `findQuoteRuns`' leftmost-wins rule then discards the
  // genuine turn as overlapping it — which is why a primary-table addition is
  // dangerous here where it was merely awkward for other languages. Of the
  // three candidates re-measured against `main` @ `2fcfda0e` on the real
  // `parseChapterStructure` path, only ASCII `"…"` still destroys a turn
  // (`„Guten Tag", sagte er. Das Schild sagte "Zu". „Und du?", …` reads
  // `["Guten Tag",". „Und du?"]`, tag cut); curly `“…”` and Swiss `«…»` no
  // longer do — curly now reads both turns correctly plus a spurious
  // `speech:"Zu"`, and Swiss reads better than the baseline (which itself
  // mis-reads one case). So none of the three goes into `quotePairs`.
  //
  // The SECONDARY tier is a different mechanism: it declines a candidate
  // outright when it straddles into a primary turn, which is exactly the
  // failure the paragraph above describes — so a table entry there does work.
  // Plain `"…"` and curly `“…”` are genuinely clean under it at every arity
  // (any number of turns per paragraph). Swiss `«…»` is a NARROWER case:
  // it is near-unreachable, not clean, because the PRIMARY table already
  // claims `«` as `»`'s closer (`['»','«']` above) — a `»` that closes one
  // Swiss turn is also a valid primary opener, so a SECOND `«…»` turn in the
  // same paragraph seeds a primary run there that swallows the attribution
  // between them and reads both real turns as narration (#2352, pinned as a
  // known gap in parser.test.ts). It ships anyway because the entry is a
  // real, measured gain on every OTHER arity (one Swiss quote per paragraph —
  // by far the common case — plus `isSpokenLine`, which unions both tiers
  // and gets the line right even where `findQuoteRuns`' run boundary
  // doesn't) and the collision is rare and design-gated (16 of 63,941
  // corpus paragraphs, see below). It is not a substitute for fixing #2352.
  // All three candidates are measured under the tier:
  //   - generated sweep, each declared secondary alone: 6,250 shapes each
  //     (18,750 total), 0 DESTROYED (spurious spans, informational only per
  //     the owner's 2026-08-13 "zero destroyed, not zero spurious" decision:
  //     48 / 37 / 64).
  //   - corpus arm, all three at once over 40 German Gutenberg books: 63,941
  //     paragraphs, 23,925 with a speech run, 261 CHANGED — all GAINED, 0
  //     LOST / MERGED / SPLIT. Concentrated, not broad: one book
  //     (`pg/de/77073.txt`) is 217 of the 261; 12 books gain dialogue overall.
  //     These zeros are the M2 gap tier's structural guarantee
  //     (parser.ts:468-470 — append-only, cannot delete a primary run), not
  //     something this corpus arm could have failed to find; what it
  //     measures is the size/distribution of the gain. Separately, isolating
  //     the Swiss entry alone: it changes the parse of 16 of the 63,941
  //     paragraphs (15 with exactly one `«`, 1 with two or more) — the #2352
  //     collision above is what the "two or more" case is.
  quotePairs: [
    ['„', '“'],
    ['„', '”'],
    ['„', '"'],
    ['»', '«'],
  ],
  secondaryQuotePairs: [['"', '"'], ['“', '”'], ['«', '»']],
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
