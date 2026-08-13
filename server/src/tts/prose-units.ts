/* Shared prose-unit floor (#2263 — chapter-aware language detection). Moved
   out of scripts/repair-missing-book-language.mts so the chapter-aware
   detector (detect-language.ts's `detectManuscriptLanguageFromChapters`,
   single-body-chapter path) and the repair script share ONE copy rather than
   drifting. See the repair script's own header for the full corpus this was
   measured against.

   A "prose unit" is a run of text closed by sentence-terminal punctuation —
   the CJK fullwidth forms are included so zh/ja prose isn't penalised for
   using different terminal marks than Latin scripts. One or more
   consecutive terminal marks ("...", "?!") close ONE unit, not one per
   mark. */
const SENTENCE_TERMINAL_RE = /[.!?…。！？]+/g;

export function countProseUnits(sample: string): number {
  return (sample.match(SENTENCE_TERMINAL_RE) ?? []).length;
}

/* Measured 2026-08-11 over all 20 live (cache-backed) books vs. the junk
   classes #2246 round 2 review evidenced — counted on the SAME post-strip,
   post-slice sample the callers' own sample-preparation pipeline produces
   (detectionSample() in the repair script; prepareSample() in
   detect-language.ts):

     thinnest real book (Unlocked)          130 prose units
     next thinnest (Юный дрессировщик)      213
     every other real book                242-394
     TOC-only sample                          1
     nav-only EPUB stub                       1
     OCR-noise sample                         1

   Floor = 20: 6.5x below the thinnest real book, 20x above every evidenced
   junk class. Do not re-derive or move this number — see the repair
   script's header for the corpus it came from. */
export const PROSE_UNIT_FLOOR = 20;

/* #2256 — PROSE_UNIT_FLOOR closes the three UNPUNCTUATED junk classes above
   (they collapse to 1 unit, since they contain no terminator at all) but not
   a PUNCTUATED one: a long numbered table of contents or a periods-and-page-
   numbers index accumulates enough terminators to clear 20 units purely by
   having many short entries, none of which is real prose (#2251's own
   review comment measured a 1200-unit numbered TOC and a 1000-unit repeated-
   heading sample this way). A per-unit LENGTH metric can't separate that
   from a real CJK manuscript — the same comment measured a real zh book and
   a repeated "Chapter One." heading at the same 11-letters-per-unit median;
   there is no length threshold that keeps one and drops the other, because a
   CJK sentence really is that short in letters.

   Lexical variety survives where length doesn't: junk repeats a tiny
   vocabulary (a handful of character names, an index's term list, "Chapter"/
   "One") across hundreds of entries, while real prose — short-clause CJK
   included — keeps introducing new words. Guiraud's R (distinct word TYPES
   / sqrt(total word TOKENS)) is the length-corrected version of that
   ratio — plain type-token ratio trends down with sample length on its own
   (Heaps' law), which would unfairly penalise a long real novel against a
   short junk sample; dividing by sqrt(tokens) instead of tokens corrects for
   that. A "word token" is a run of Unicode letters (`/\p{L}+/gu`,
   case-folded) — digits and punctuation never count as a token, so a TOC's
   page numbers contribute to neither side of the ratio.

   That alone has two real gaps, both intentionally left open rather than
   chased:

   1. A punctuated list built from a WIDE, mostly-non-repeating vocabulary
      (e.g. many distinct chapter TITLES with no entry numbering at all) can
      reach a Guiraud's R close to real short prose. Not what closes the
      evidenced classes here — every evidenced shape (a numbered TOC, a
      page-numbered index) needs its number to be usable as a TOC or an
      index at all, so DIGIT_TOKEN_SHARE_CEILING catches those regardless of
      vocabulary width (see below) — a title-only list with no numbering at
      all is a softer, unevidenced edge, the same caveat #2251's review
      comment made about punctuated junk generally.
   2. Guiraud's R over the RAW sample decays with length even for real
      prose that happens to repeat verbatim — which is exactly how this
      repo's OWN test suite builds "thick" chapter fixtures
      (`Array(300).fill(REAL_SENTENCE).join(' ')`). Computed raw, a real
      sentence repeated 300 times scores LOWER than the evidenced junk
      classes, which would make the gate reject real content. guiraudR/
      digitTokenShare below fix this: both dedupe EXACT (normalised) prose
      units before measuring, so a real sentence repeated any number of
      times measures as ONE occurrence of itself — genuine junk's
      repetition is what's supposed to be invisible to dedup, not real
      prose's. A numbered TOC or index is barely affected by dedup (each
      entry's own number keeps it nominally distinct); a repeated heading
      with no number collapses straight to its own (tiny) vocabulary either
      way.

   Word tokens are matched by a shared script-aware tokenizer (see CHUNK_RE/
   tokenize() below): a run of non-CJK Unicode letters, a maximal run of
   kana characters, or a single Han character. CJK doesn't use whitespace,
   so treating a whole punctuation-delimited CJK clause as ONE token (a
   plain `/\p{L}+/gu`) undercounts its lexical variety severely —
   per-CHARACTER tokenisation is what countWords' own CJK branch already
   assumes (server/src/parsers/front-matter.ts's CJK_CHARS_PER_WORD). Digit-
   like tokens (ASCII/fullwidth digit runs, Han numeral runs) are never word
   tokens either way, so a TOC's page numbers contribute to neither side of
   guiraudR's ratio — see the "review round 2" addendum below for how that
   digit classification and the kana tokenization were both revised.

   Measured 2026-08-13 (round 1), read-only, against:
     - the 7 real books written by the 2026-08-11 repair run (Keeper of the
       Lost Cities series, replayed through a fresh manuscript re-parse
       exactly as the repair script's own manuscriptChaptersFor would) — R
       from 14.6 (Bonus Keefe Story, the shortest) to 24.8 (Unlocked),
       digitTokenShare from 0 to 0.0021 — real prose essentially never
       repeats a whole sentence verbatim, so dedup is a no-op here
     - this repo's OWN test-suite convention of building a chapter via
       `Array(N).fill(oneRealSentence).join(' ')` (detect-language.test.ts,
       N up to 300) — post-dedup this measures as just that ONE sentence's
       own richness, R from 4.36 (a single Russian sentence) to 5.69 (a
       single Chinese one, character-tokenised), regardless of N
     - REAL_CJK_PROSE (24 distinct real sentences, no dedup effect) — R=12.4
     - reconstructions of the three residual junk shapes from #2251's review
       comment (a numbered TOC, repeated "Chapter One." headings, a
       periods-and-page-numbers index), at every scale from just-clearing
       PROSE_UNIT_FLOOR up to 1000 entries — a numbered TOC dedupes to its
       fixed cast-name vocabulary regardless of entry count (constant
       R=2.45); repeated headings dedupe to one heading regardless of count
       (constant R=1.41); the index barely dedupes at all (each entry's own
       page number keeps it distinct) and decays with scale exactly like
       the un-deduped measurement did (R 1.83 down to 0.32) — the worst
       (highest) junk R measured, across every shape and scale, is 2.45
     - a deliberately adversarial edge (not evidenced): a numbered TOC or
       index shrunk to the SMALLEST size that still clears PROSE_UNIT_FLOOR
       (20 entries) with a WIDE, non-repeating vocabulary — R up to 4.47,
       above LEXICAL_RICHNESS_FLOOR. digitTokenShare (50%, unaffected by
       vocabulary width — the entry NUMBER is what makes it a TOC/index at
       all) closes this one; it is why the two floors are independent gates
       rather than one combined score

   LEXICAL_RICHNESS_FLOOR = 3 (round 1, UNCHANGED by round 2 below — see
   why): sits between the worst evidenced-shape junk (2.45, a numbered TOC,
   constant at every scale) and the thinnest sample that must still pass
   (4.36, this repo's own single-sentence test-fixture convention) — a real
   but tight ~1.2x/~1.5x margin on each side, driven by how short this
   repo's canonical test sentences are; the actual 7-book corpus clears it
   by 3.2x-5.5x more.

   --- #2256 independent review round 2 (2026-08-13), four findings -------

   Round 1's DIGIT_TOKEN_SHARE_CEILING derivation above (and the original
   digitTokenShare implementation) had two real defects, both closed here:

   Finding 1 (digit tokenizer ~9x stricter on CJK than Latin for identical
   content): digitTokenShare used to split on WHITESPACE, making the
   denominator "sentences" for whitespace-less CJK and "words" for Latin —
   one injected digit (e.g. a dated year in one sentence of several) scored
   far higher for CJK than for equivalent English, because the whole CJK
   sentence containing it counted as ONE token instead of the ~10-20
   word-equivalent tokens the same content produces in English. Fixed by
   giving digitTokenShare the SAME script-aware tokenizer guiraudR already
   used (CHUNK_RE/tokenize() below — kana trigrams, one Han character, or a
   Latin word run), so both scripts get comparable per-unit token
   granularity. Re-measured with a controlled 1-in-N-sentences digit
   injection (own synthetic real-shaped EN/ZH fixtures, matched sentence
   structure, N=4/6/7): the zh/en digit-share RATIO moved from the ~9x this
   finding reported (old tokenizer) to 0.6x-0.9x (new tokenizer) — i.e. CJK
   is now, if anything, slightly LESS sensitive to an isolated digit than
   Latin, not ~9x more.

   Finding 2 (the closed class stayed open for CJK): `/\d/` matches neither
   fullwidth digits (U+FF10-FF19) nor Han numeral characters (一二三...百千
   万, used for Chinese/Japanese chapter numbering, e.g. "第五十七章" = 57).
   A Han-numeral or fullwidth-digit numbered TOC scored digitTokenShare=0
   under the old check, regardless of entry count. Fixed by DIGIT_TOKEN_RE
   (below) matching fullwidth-digit and Han-numeral-character RUNS as
   digit-like tokens too, ordered ahead of the generic Han-character
   alternative in the shared tokenizer so a numeral run is captured whole.
   Re-measured against a 60-entry synthetic Han-numeral TOC (own
   fixture, real Chinese TOC formatting "N、Title。") and its fullwidth-digit
   twin: both score digitTokenShare ≈ 0.36 — comfortably above the
   recalibrated ceiling below, closing the class finding 2 reported open.
   Risk checked and accepted: Han numeral characters (一 "a/one", 十 "ten"
   especially) are also common ORDINARY vocabulary in real Chinese prose
   (idioms like 一阵风 "a gust of wind", 十分 "very"), so classifying every
   occurrence as digit-like risks a false positive on real prose. Measured
   against an own hand-authored, real-shaped Chinese fixture using these
   words at a deliberately HIGH density (every sentence carries at least one
   such idiom): digitTokenShare ≈ 0.095-0.10 — the recalibrated ceiling
   keeps ~2x margin above that.

   Finding 3 (round 2 — Guiraud's R is not length-corrected under
   per-character CJK tokenisation): voteLanguage joins every winning-
   language chapter's own sample with no overall cap, so N is unbounded (the
   corpus's own largest joined sample measured 815k chars) — R = V/sqrt(N)
   decays once a script's per-token vocabulary saturates (a few thousand Han
   characters, ~90 kana glyphs), which real round-1 measurement showed
   happening within the ja corpus itself (8.41 at N≈3.3k falling to 7.83 at
   N≈6.5k) and, extrapolated to the corpus's largest real sample, crossing
   the floor entirely. Round 2 shipped two independent fixes for this:
   (a) a RICHNESS_SAMPLE_CHARS prefix cap on the joined sample, and (b) kana
   tokenization changed to overlapping trigrams. **(a) was retracted in
   round 3 — see the finding-3(a) retraction below — only (b) survives.**

   Finding 3(b) survives unchanged: kana tokenization changed from
   one-character-per-token to OVERLAPPING TRIGRAMS (see tokenize()'s own
   comment) — per-character kana tokenization caps a kana-only sample's
   whole vocabulary at ~90 glyphs, which R falls below any fixed floor for
   once N passes roughly (floor/90)^2 characters (a few hundred to low
   thousands) — well inside a single real chapter. Trigrams raise the
   effective alphabet by orders of magnitude (up to ~90^3 triples) without
   collapsing to "one token per sentence" the way a full kana-RUN token
   would (real Japanese has no inter-word spacing, so a run can span an
   entire clause). Bigrams (n=2) were tried first and measured too thin: on
   the SAME ~86-word synthetic all-kana fixture described below, bigrams
   held R around 2.2-2.8 at a 20,000-character sample — BELOW
   LEXICAL_RICHNESS_FLOOR — while trigrams held R around 5.7-6.2 on the
   identical fixture; the bigram number is what an earlier pass of this same
   fix reported as passing, which relied on a fixture with an aliasing bug
   (a repeating index period that let dedup silently shrink the sample) and
   was itself wrong — a reminder that this fix's own regression lock is what
   should be trusted, not a comment.
     Re-measured against an own hand-authored all-kana fixture (no kanji at
     all, real hiragana words/particles, ~86 distinct base words — almost
     certainly LESS varied than any real all-kana book) at two scales:
       - at N≈4,200-4,900 characters (matching the specific real-book scale
         the finding measured, N=4,843), R rose from 1.72 (the finding's
         own reported old-scheme number on that real book — this repo
         cannot reproduce that exact book, since it isn't available outside
         the box that produced it, but the SAME mechanism, a capped
         ~90-glyph alphabet divided by sqrt(N), is what both measurements
         exercise) to ≈4.3-5.4 (new, trigram) — a genuine, meaningful fix at
         the reported failure scale.
       - at 20,000 characters, R holds around 5.7-6.2 for this fixture —
         still comfortably above LEXICAL_RICHNESS_FLOOR, but with a
         narrower, vocabulary-dependent margin than Han-based CJK. A
         genuinely narrower real all-kana vocabulary than this ~86-word
         synthetic fixture could still fall below the floor at large N.
     **Round 3 (finding C5) additionally found the richness gate is close to
     INERT for kana under trigrams beyond what dedupeProseUnits already
     catches**: an own degenerate near-repeated kana filler (one word
     repeated ~67% of the time, 20k chars) scored R≈7.13 (accepted, not
     refused), and an ordinal-prefixed heading list (8 cycling headings,
     2000 entries) scored R≈9.43 (accepted) — only an EXACT-duplicate
     heading (which dedupeProseUnits already collapses on its own, R≈2.24,
     refused) is caught. No kana junk shape this repo has tried, beyond
     exact duplication, is refused by LEXICAL_RICHNESS_FLOOR under trigrams.
     This does not cause a wrong-LANGUAGE outcome — the script pre-pass
     returns 'ja' for all-kana input regardless of what the richness gate
     decides — but it means the richness gate contributes nothing extra for
     kana beyond what dedup already provides. Stated plainly rather than
     implied otherwise: for kana specifically, this gate's only real
     backstop against low-effort junk is dedupeProseUnits; a genuinely novel
     kana junk shape not caught by exact-duplicate collapsing would very
     likely pass. LEXICAL_RICHNESS_FLOOR is NOT lowered further for kana
     (that would only make this worse) and no narrower kana-specific
     richness signal is invented here without real all-kana junk evidence to
     calibrate it against.

   Finding 3(a) — RETRACTED in round 3 (finding C1): capping the joined
   sample to a PREFIX made the two lexical gates chapter-ORDER-dependent — a
   single numeral-dense opening chapter (a dated chronicle, an epistolary
   frame, a real front-matter-surviving 大事记/Zeittafel) could refuse an
   entire book that reads fine once every chapter is counted, and the SAME
   chapter set in a DIFFERENT order could reach a DIFFERENT verdict — a
   worse, measured, real defect against the theoretical, largely unmeasured
   one it was meant to prevent. Re-examined: real Han content does not
   actually need a length cap. The round-2 fix relied on an EXTRAPOLATION
   from ja data at N≈3.3k-6.5k to the corpus's 815k-char worst case, never a
   direct measurement at that scale; round 3 measured the 815k-char worst
   case directly (real Han text) and found R≈4.4 — still above
   LEXICAL_RICHNESS_FLOOR (3), a genuine if tighter (~1.5x) margin than the
   smaller-scale real samples measured elsewhere in this file. Separately,
   this repo's own two real Coalfall Commission translations (zh, ja —
   `C:\AudiobookWorkspace\books\Castwright\Standalones\{煤落的委托,
   コールフォールの依頼}\manuscript.md`, read-only, Castwright-owned) score
   R=12.1 (zh, 5.6k chars) and R=27.3 (ja mixed, 7.8k chars) — comfortably
   clear, consistent with no cap being needed at realistic chapter scale
   either. The cap is REMOVED (`voteLanguage` now measures the full joined
   sample, uncapped) — guiraudR/digitTokenShare reduce to a token SET size
   and a total token count, neither of which depends on concatenation
   order, so the uncapped computation is mathematically chapter-order-
   invariant, which a prefix is not. `RICHNESS_SAMPLE_CHARS` no longer
   exists; nothing replaces it.

   Finding 4 (the digit ceiling's margin was fiction, not just wrongly
   stated): re-measured with the NEW tokenizer, a genuinely short-sentence
   real book (matching the corpus's own "~6.8 tokens/unit" data point) with
   verse-style numbering (own synthetic fixture, real-shaped short EN/ZH
   sentences, 1 digit token per unit) scores digitTokenShare up to ≈0.143
   (EN) / ≈0.101 (ZH) — both would have been WRONGLY refused under the old
   0.1 ceiling. DIGIT_TOKEN_SHARE_CEILING is raised to 0.2 below: ~1.4x
   margin above that worst measured real-shaped case, and still ~1.8x-2.4x
   below the evidenced junk shapes (short-titled numbered TOC/index, ≈0.36-
   0.87 under the new tokenizer — see round-1's numbers above, still valid,
   unaffected by these tokenizer changes for Latin/short-title CJK text).
   RESIDUAL, UNEVIDENCED GAP (same category as round 1's own acknowledged
   gap 1 above, not closed here): a numbered list built from UNUSUALLY LONG,
   sentence-like, wide-vocabulary entry titles can dilute digitTokenShare
   below even the raised ceiling (own adversarial fixture, 6-9-word titles,
   scored ≈0.14-0.18) while also clearing LEXICAL_RICHNESS_FLOOR — neither
   gate catches it. Not evidenced against this repo's actual junk corpus
   (every measured real junk shape uses short chapter-name/index-term
   entries, per round 1), and closing it needs a genuinely new signal (e.g.
   an entry-length/sentence-structure check) rather than a threshold move —
   filed as a follow-up issue rather than guessed at here.

   --- #2256 independent review round 3 (2026-08-13) --------------------

   Finding C1 (windowing made the decision chapter-order-dependent):
   RETRACTED round 2's finding-3(a) fix — see the finding-3 block above.

   Finding C2 (0.2 ceiling re-opens the ticket's acceptance class for the
   commonest real Chinese TOC layout, HIGH, NOT CLOSED — owner decision
   named, not guessed at): the finding-2 fixture above ("N、<title>。", 60
   entries, digitTokenShare≈0.36) is not the shape most real Chinese TOCs
   use. The standard layout is "第N章<title>" ("Chapter N: Title") with a
   4-character title — re-measured against 60 distinct 4-character titles:

     N、<title>。 (this file's finding-2 fixture)     digitTokenShare 0.24-0.36, refused
     第N章<title>。 (Han numeral, "第"..."章" markers) digitTokenShare ≈0.15-0.17, NOT refused
     第Ｎ章<title>。 (fullwidth digit)                  same ≈0.15-0.17, NOT refused
     第N章<title>。 (ASCII digit)                       same ≈0.15-0.17, NOT refused
     第N章<title>。, 200 entries                        same range — scale does not rescue it

   Mechanism: "第" and "章" are ordinary Han characters (not numerals), so
   they tokenize as two ordinary word tokens per entry — a 4-character title
   plus those two markers makes each entry ~7 tokens with only 1 digit-like
   token, well under the 0.2 ceiling, REGARDLESS of entry count. Round 1's
   0.1 ceiling would have caught this shape (0.15-0.17 > 0.1); finding 4's
   ceiling raise (0.1 -> 0.2, needed for real short-sentence verse-numbered
   content, see above) undid finding 2's fix for this specific, common TOC
   shape. The "evidenced junk range 0.36-0.87" cited in finding 4 above does
   NOT hold universally — it holds for the numbering styles measured there,
   not for a "第N章" chapter-marker TOC.

   NOT FIXED HERE. The digit-ratio signal alone cannot separate this TOC
   shape from genuine short-sentence real prose at any single threshold:
   finding 4's own worst real-shaped case (verse-numbered short sentences)
   measures ≈0.10-0.14, and this junk shape measures ≈0.15-0.17 — the two
   ranges OVERLAP, so no DIGIT_TOKEN_SHARE_CEILING value cleanly separates
   both without either re-opening finding 4's regression (refusing real
   short-sentence books) or re-opening this one (backfilling "第N章" TOCs).
   Closing this needs a DIFFERENT kind of signal than a token ratio — e.g. a
   STRUCTURAL check for the numbering PATTERN repeating once per prose unit
   (a "第<numeral>章" prefix recurring across most units), which is a
   different instrument from Guiraud's R / digitTokenShare and a genuine
   design decision (exactly which pattern counts, how narrowly scoped,
   what it costs in false positives on real prose with a recurring opener)
   — not invented here without a design pass. Recorded as a tracked, open
   gap rather than silently left to look closed; see
   https://github.com/dudarenok-maker/Castwright/issues/2341 for the
   decision owed and detect-language.test.ts's own "finding C2" test,
   which pins the current (imperfect) behavior so it stays visible.

   Do not re-derive or move any of these numbers without re-measuring
   against the same corpus/fixtures referenced above. */
export const LEXICAL_RICHNESS_FLOOR = 3;
export const DIGIT_TOKEN_SHARE_CEILING = 0.2;

/* #2256 review round 2 (finding 1, finding 2) — digit detection needs to
   catch three shapes, not just ASCII `\d`: fullwidth digits (U+FF10-FF19,
   used in some CJK-typeset TOCs/indexes) and Han numeral characters (used
   for chapter numbering in Chinese/Japanese front matter, e.g. "五十七" =
   57, "第一章" = "Chapter One"). Numeral CHARACTER RUNS are matched ahead of
   the generic Han-script alternative in CHUNK_RE (regex alternation is
   ordered, first match wins at each position) so a numeral run is captured
   as ONE digit-like token rather than N separate Han-character word tokens
   -- keeping it out of guiraudR's vocabulary count the same way an ASCII
   digit run already was (digits never contribute to either side of that
   ratio), and making it visible to digitTokenShare as a digit token. */
const FULLWIDTH_DIGIT_RUN_RE = '[\\uFF10-\\uFF19]+';
const HAN_NUMERAL_CHARS = '〇零一二三四五六七八九十百千万億兆';
const HAN_NUMERAL_RUN_RE = `[${HAN_NUMERAL_CHARS}]+`;
const DIGIT_TOKEN_RE = new RegExp(`^(?:[0-9]+|${FULLWIDTH_DIGIT_RUN_RE}|${HAN_NUMERAL_RUN_RE})$`);

/* Shared CHUNK scanner for both guiraudR and digitTokenShare: digit-like
   runs (ASCII, fullwidth, Han-numeral) are matched FIRST so they're
   captured whole rather than falling through to the word alternatives,
   then a maximal kana RUN, then one Han character at a time, then a
   Latin/Cyrillic/other-script word run. A kana chunk is expanded into
   overlapping TRIGRAMS by tokenize() below, not used as one token as-is --
   see that comment for why. */
const CHUNK_RE = new RegExp(
  ['(?:[0-9]+|' + FULLWIDTH_DIGIT_RUN_RE + '|' + HAN_NUMERAL_RUN_RE + ')', '[\\p{Script=Hiragana}\\p{Script=Katakana}]+', '\\p{Script=Han}', '\\p{L}+'].join('|'),
  'gu',
);
const KANA_CHUNK_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}]+$/u;

/** Collapses EXACT (trimmed, case-folded, whitespace-normalised) duplicate
 *  prose units to their first occurrence, joined back with a space — so a
 *  real sentence repeated N times measures, for guiraudR/digitTokenShare
 *  purposes, as ONE occurrence of itself rather than N. Genuine junk's
 *  repetition survives this unaffected: a numbered TOC/index entry carries
 *  its own number, so dedup barely reduces it (see this file's own header);
 *  a repeated heading with no number collapses to one occurrence either
 *  way, which is exactly the shape both floors are meant to catch. */
function dedupeProseUnits(sample: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sample.split(SENTENCE_TERMINAL_RE)) {
    const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out.join(' ');
}

/** Tokenizes the sample's DEDUPED prose units with the shared CHUNK_RE
 *  scanner (digit-like runs, a maximal kana run, one Han character, or a
 *  Latin/Cyrillic/etc. word run) — the ONE tokenization both guiraudR and
 *  digitTokenShare read, so a token is classified identically ("is this a
 *  digit?") for both gates rather than by two independently-drifting
 *  definitions (#2256 review round 2, finding 1).
 *
 *  A kana CHUNK is expanded here into overlapping character TRIGRAMS rather
 *  than kept as one token (#2256 review round 2, finding 3): Hiragana and
 *  Katakana are a ~90-glyph phonetic syllabary, not a morphemic script the
 *  way Han is, so per-CHARACTER tokenisation caps a kana-only sample's
 *  entire vocabulary at that ~90-glyph inventory regardless of how much
 *  real, varied prose it contains -- Guiraud's R (V/sqrt(N)) is
 *  mathematically guaranteed to fall below any fixed floor once N passes
 *  roughly (floor/90)^2 characters, a few hundred to low thousands, well
 *  inside a single real chapter. Treating the whole maximal run as ONE
 *  token instead over-corrects: real Japanese has no inter-word spacing, so
 *  a kana run can span an entire sentence with no internal terminator, and
 *  "one token per sentence" makes R grow roughly as sqrt(N) with no ceiling
 *  at all -- it would never flag repetitive-but-not-byte-identical kana
 *  filler either. TRIGRAMS (overlapping, so a run of length L yields L-2 of
 *  them) sit between those two failure modes: the effective alphabet is
 *  bounded by ~90^3 possible triples rather than 90 single glyphs, several
 *  orders of magnitude larger, while each token still corresponds to a
 *  bounded, short span of text rather than a whole sentence -- the standard
 *  fallback n-gram technique for richness measurement on an unsegmented
 *  script where no word-segmentation dictionary is available. Bigrams
 *  (n=2) were tried first and measured too thin at realistic chapter
 *  lengths -- an own synthetic all-kana fixture (~85 distinct words) held
 *  R around 2.2-2.8 at a 20,000-character window under bigrams, BELOW
 *  LEXICAL_RICHNESS_FLOOR (3); the identical fixture held R around 5.7-6.2
 *  under trigrams, comfortably above it -- see prose-units's own
 *  LEXICAL_RICHNESS_FLOOR/DIGIT_TOKEN_SHARE_CEILING block for the honest
 *  numbers and the residual gap at even longer lengths. A kana chunk
 *  shorter than 3 characters (no trigram possible) is kept as-is. Han
 *  stays per-character (unlike kana, each Han character is closer to a
 *  morpheme than a phoneme, and the ORIGINAL per-character choice, see
 *  this file's own header, was made specifically to avoid undercounting a
 *  Han clause as a single token) and digit-like chunks stay whole (so
 *  digitTokenShare sees ONE digit token per number, not per digit). */
const KANA_NGRAM_SIZE = 3;
function tokenize(sample: string): string[] {
  const chunks = dedupeProseUnits(sample).toLowerCase().match(CHUNK_RE) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length >= KANA_NGRAM_SIZE && KANA_CHUNK_RE.test(chunk)) {
      for (let i = 0; i <= chunk.length - KANA_NGRAM_SIZE; i++) tokens.push(chunk.slice(i, i + KANA_NGRAM_SIZE));
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

/** Guiraud's R — distinct word types / sqrt(total word tokens), over the
 *  sample's DEDUPED prose units (see dedupeProseUnits). Digit-like tokens
 *  (ASCII/fullwidth digit runs, Han numeral runs) are excluded from both
 *  sides of the ratio, same as before (#2256 finding 2 extended this to
 *  fullwidth/Han-numeral runs, not just ASCII digits). 0 for a token-less
 *  sample (never a real winner: the script pre-pass / franc gates upstream
 *  already require letters to reach here). */
export function guiraudR(sample: string): number {
  const tokens = tokenize(sample).filter((t) => !DIGIT_TOKEN_RE.test(t));
  if (tokens.length === 0) return 0;
  return new Set(tokens).size / Math.sqrt(tokens.length);
}

/** Share of tokens that are digit-like (ASCII/fullwidth digit runs, or Han
 *  numeral runs), over the sample's DEDUPED prose units (see
 *  dedupeProseUnits) — a numbered table of contents or a page-numbered
 *  index is dense in these by construction (every usable entry needs its
 *  own number, so dedup barely thins them); real narrative prose is not.
 *
 *  #2256 review round 2 (finding 1) — this used to split on WHITESPACE,
 *  which makes the denominator "sentences" for whitespace-less CJK and
 *  "words" for Latin scripts: an identical single injected digit (e.g. one
 *  dated year in one sentence out of several) scored ~9x higher for CJK
 *  than for equivalent English text, because the CJK sentence containing it
 *  counted as ONE token rather than the ~10-20 word-equivalent tokens the
 *  same content produces in English. Tokenizing with the same script-aware
 *  scanner guiraudR uses (kana trigrams, one Han char, Latin word runs) gives
 *  both scripts comparable per-unit token granularity, closing that gap. 0
 *  for an empty sample. */
export function digitTokenShare(sample: string): number {
  const tokens = tokenize(sample);
  if (tokens.length === 0) return 0;
  const withDigit = tokens.filter((t) => DIGIT_TOKEN_RE.test(t)).length;
  return withDigit / tokens.length;
}
