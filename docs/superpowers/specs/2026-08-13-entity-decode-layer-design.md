# Which layer decodes an HTML entity — design

- **Issue:** #2310
- **Status:** proposed (design), **v2** — awaiting owner approval of the recommended option.
  v2 folded in the mandatory `assumption-checker` pass ([Appendix B](#appendix-b--assumption-checker-findings))
  and a mid-flight correction from the coordinating thread ([Finding 0](#finding-0--the-ticket-omits-a-model-shaped-link-in-its-own-chain)).
  The recommendation is unchanged from v1; the *reasoning* for two decisions changed materially.
- **Date:** 2026-08-13
- **Scope:** server (`parsers/html-utils.ts` entity decode + one new `server/` dependency); no frontend, no OpenAPI, no schema change
- **Provenance:** found by the review gate on PR #2309 (#2289). Previously recorded, unfixed, at
  `docs/superpowers/plans/2026-06-16-russian-attribution-narrator-heuristic.md:480`.

## Problem

An HTML entity that survives `stripHtml` is correctly recognised as a **dialogue
opener** — the paragraph is classified as dialogue and the speaker attributed —
but the entity then reaches the TTS engine **verbatim** and is read aloud. An
`&ndash;`-opened Spanish line gets the right speaker and a corrupted first few
syllables, where a literal `—` would have produced a clean pause.

## The chain — verified, not inherited

Every link below was re-verified against the code in this worktree
(`6b60f632`). The probes are reproduced in
[Appendix A](#appendix-a--probe-transcripts); nothing here is asserted from the
ticket.

1. **`stripHtml` decodes five named entities plus numeric references**
   (`server/src/parsers/html-utils.ts:52-57`): `&nbsp; &lt; &gt; &quot; &amp;`,
   then `decodeNumericEntities` for `&#NNN;` / `&#xHH;`. **Verified.**
2. **`&ndash;` / `&mdash;` survive into the body text.** **Verified** — and the
   surviving class is much larger than the ticket states (see
   [Finding 2](#finding-2--the-defect-class-is-far-larger-than-two-dash-entities)).
3. **`dialogueOpen` matches the entity** and the paragraph is classified as
   dialogue (`lang/{es,fr,ru}.ts`). **Verified** — this part works and is not
   the defect.
4. **`LEADING_DASH = /^\s*[–—]\s*/`** (`server/src/tts/text-normalize.ts:57`)
   matches literal glyphs only, so the entity never becomes the `'... '` pause.
   **Verified.**
5. **The `&` expansion rule** (`server/src/tts/normalize/index.ts:88`) is
   `s.replace(/ & /g, …)` — space-delimited standalone token only, so `AT&T`
   survives and `&ndash;` passes through untouched. **Verified.**

6. **The body text does NOT go straight to the engine — a model sits in the
   middle.** See [Finding 0](#finding-0--the-ticket-omits-a-model-shaped-link-in-its-own-chain),
   which corrects the ticket's chain and an earlier revision of this spec.

**End-to-end, measured** (`normaliseForTts` output, the exact string handed to
the engine — for the *title* path unconditionally, and for the *body* path
whenever the model echoes the sentence verbatim):

| Input body text | Reaches the engine as |
|---|---|
| `— Un momento — dijo él.` (glyphs) | `"... Un momento, dijo él."` ✅ |
| `&ndash; Un momento &mdash; dijo &eacute;l.` | `"&ndash; Un momento &mdash; dijo &eacute;l."` ❌ |
| `&#8211; Un momento.` (**numeric**) | `"... Un momento."` ✅ |

The language argument (`es`/`fr`/`ru`/absent) changes nothing — all four produce
the identical untouched entity string.

## Finding 0 — the ticket omits a model-shaped link in its own chain

The ticket's chain implies parsed body text flows to the TTS engine. **It does
not.** Verified:

- `synthesise-chapter.ts:2514`, `:2570` (and the empty-text filter at `:921`)
  synthesise `normaliseForTts(group.text, langCode)`, where `group.text` traces
  to `SentenceOutput.text` — the **stage-2 model's returned sentence text**,
  stitched into narrative order at `routes/analysis.ts:5077-5080`. Nothing
  re-derives it from the source prose.

So `stripHtml`'s output reaches the **analyzer**; what reaches TTS is the
model's echo of it. `dialogueOpen` matching the entity proves the entity reaches
the analyzer — a *different string* from the one the engine reads.

**This adds a conditional the ticket does not state:** the entity is spoken only
if stage-2 echoes it into its returned text. A second thread has observed, on a
live run, that today's model does **not** echo verbatim — it returns sentences
with the leading dash **stripped** (`— сказал Егор.` → `сказал Егор.`). That was
measured, not hypothesised.

**What I verified and what I did not:** I verified the code path (the three call
sites and the stitch) by reading it. I did **not** verify the model's echo
behaviour for entity-opened lines — that needs a live analyzer run, which this
design pass did not do. I am not claiming the body-path symptom currently
reproduces, and I am not claiming it doesn't.

### The model-independent route: chapter titles

**Chapter titles bypass stage-2 entirely**, and that route reproduces
unconditionally. Traced end to end:

`epub.ts:142,252` → `mergeChapterTitle(ncxTitle, extractFirstHeading(html), n)`
→ `ChapterHint.title` → `generation.ts:1548` `buildChapterTitleNarration({id,
title})` → `chapterTitleNarration` → `synthesise-chapter.ts:1562` `titleText` →
**`:2248` `normaliseForTts(titleText, langCode)` → `provider.synthesize`.**

No model anywhere in that path. And `extractFirstHeading`
(`html-utils.ts:72-79`) carries **its own third copy of the same five-entity
list**, so `<h1>L&rsquo;&Eacute;t&eacute;</h1>` yields the chapter title
`L&rsquo;&Eacute;t&eacute;`, which is spoken verbatim.

**Consequences, all of which the design must carry:**

1. **The unconditional instance of this bug is a chapter title, not a dialogue
   line.** It is strictly better repro and acceptance evidence, because no model
   behaviour can mask it.
2. **This is decisive against option 3.** A fix at `normaliseForTts` only ever
   sees post-model text for bodies, so it inherits the whole conditional; a fix
   at `stripHtml`/`extractFirstHeading` runs *before* the model, so the model
   never sees an entity and cannot echo, strip, or mangle one. Options 1 and 2
   are immune to model behaviour; option 3 is defined by it.
3. **There are three copies of the entity set, not two** — `stripHtml`,
   `extractFirstHeading`, and `epub.ts`'s `decodeEntities` — which makes
   extracting one shared helper mandatory rather than optional.
4. **The end-to-end test must fix the sentence text explicitly** rather than
   round-tripping a real model, or it passes or fails by model version.

## Finding 1 — the numeric row above is the fact that decides this

**The same dash, expressed as `&#8211;`, already produces the correct output
today.** `decodeNumericEntities` decodes it at the parser, and everything
downstream — `dialogueOpen` (via its `[-–—]` character-class branch),
`LEADING_DASH`, `softenDashes` — then works with no change whatsoever.

This is a **positive control that already ships in production**. It proves:

- the desired end state is reachable by decoding alone;
- **no downstream layer needs to change** once decoding happens — the entire
  dash pipeline is already correct for a real dash character;
- the defect is precisely and only that **named** references are decoded from a
  five-entry hand-rolled list while **numeric** references are decoded
  completely.

The fix is therefore to make named references behave the way numeric references
already do. That is a statement about one function, not about the pipeline.

## Finding 2 — the defect class is far larger than two dash entities

The ticket frames this as `&ndash;`/`&mdash;` in three languages. Measured, the
surviving set is open-ended. Every one of these reaches the TTS engine verbatim
today:

| Entity | Survives `stripHtml`? | Consequence when spoken |
|---|---|---|
| `&ndash;` `&mdash;` | **survives** | the filed bug — corrupted dialogue opener |
| `&eacute;` `&egrave;` `&agrave;` `&ccedil;` … | **survives** | **corrupts words, not just openers** — accented letters are pervasive in `fr`/`es` prose |
| `&rsquo;` `&lsquo;` `&ldquo;` `&rdquo;` | **survives** | every apostrophe and quote mark in the chapter |
| `&laquo;` `&raquo;` | **survives** | the `ru`/`fr` guillemet — also a `quotePairs` marker |
| `&hellip;` | **survives** | ellipsis, a pause marker |
| `&apos;` | **survives** | **an XML-predefined entity** — see Finding 3 |
| `&shy;` `&thinsp;` | **survives** | invisible in HTML, spoken as gibberish |
| `&nbsp;` `&lt;` `&gt;` `&quot;` `&amp;` | decoded | — |

`&eacute;` is the one that reframes the severity. A French EPUB whose serializer
emitted named accent entities does not have a dialogue-opener problem — it has
**every accented word in the book** read as `"ampersand e acute semicolon"`.
That is not a cosmetic first-syllable defect.

**This finding is what disqualifies option 3** (soften on the TTS side). A
widened `LEADING_DASH` fixes exactly one entity in exactly one position and
leaves the whole rest of this table spoken.

## Finding 3 — why the entity set is exactly those five: it is incidental

This was the highest-value question in the brief, and it has a clean answer.

`git log -S'&nbsp;' --follow` traces the set to **`a922c075`, 2026-05-12 — the
very first server commit** ("Add local analysis server + Gemini analyzer"). It
was introduced whole, in its final form:

```js
.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
.replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
```

That is **the XML predefined entity set** (`&amp; &lt; &gt; &quot; &apos;`,
with `&apos;` written as `&#39;`) **plus `&nbsp;`** — i.e. the standard
"hand-rolled XML unescape" idiom, copied in wholesale. It is what you write
when you are unescaping XML, not a curated decision about which entities are
safe to decode in prose.

**Conclusions, load-bearing for the recommendation:**

- **The narrowness is incidental, not deliberate.** No commit ever narrowed it;
  no commit ever considered and rejected widening. There is no load-bearing
  reason to preserve it.
- Every subsequent change to entity handling has been a **reactive widening**
  after a production regression: `a4a9877b` added hex numeric refs after the
  Coalfall / Master Oduvan incident (an evidence-quote failure that cost a
  speaker his entire cast); `#2289` added `&ndash;` to `es`/`fr` after this
  same class bit again.
- **`&apos;` — one of the five XML entities the idiom is meant to cover — is
  not decoded at all.** The hand-rolled list dropped it in translation (it
  became `&#39;`, which only covers the numeric spelling). A latent, unfiled
  instance of this same bug has been shipping since day one.

**The set is not small because small is safe. It is small because nobody ever
widened it on purpose.** That removes the only stated reason to prefer a
narrow fix.

## Finding 4 — THREE divergent copies of the entity set

**Corrected from "two" after review.** The third is in the file being edited,
and it is the one on the model-independent path.

**Copy 2 — `extractFirstHeading` (`html-utils.ts:72-79`).** Its own verbatim
five-entity list. It feeds `mergeChapterTitle` (`epub.ts:142`, `:252`;
`mobi.ts`) → `ChapterHint.title` → **the spoken chapter-title beat**
(Finding 0). `<h1>L&rsquo;&Eacute;t&eacute;</h1>` yields a title read aloud as
`"L ampersand rsquo semicolon..."`. This is the filed defect, on the one surface
no model behaviour can mask — **in scope, not adjacent**.

**Copy 4 — `epub.ts:430` NCX chapter labels**, decoded via `decodeEntities`. The
first revision described `decodeEntities` as metadata-only (`readCalibreMeta`);
it also decodes the chapter labels that become titles. Same surface, same fix.

### Copy 3 — `decodeEntities` itself

`server/src/parsers/epub.ts:499` carries `decodeEntities`, commented **"Decode
the small entity set the parsers care about (matches stripHtml)"**. It does
**not** match: it decodes `&#39;` explicitly but has no general numeric decoding
at all, so `&#x27;` — the exact hex apostrophe that caused the Coalfall
regression `a4a9877b` fixed in `stripHtml` — is still literal here.

`decodeEntities` decodes **OPF/NCX metadata**: book title, author, series
(`readCalibreMeta`). So an entity-laden book *title* is a live instance of the
same defect on a different surface, and the comment claiming parity with
`stripHtml` is already false. Both are chores this work makes owed.

## Finding 5 — blast radius, measured

### Who consumes `stripHtml` output

`epub.ts:150` (epub2 path), `epub.ts:256` (raw-zip fallback), `mobi.ts:166`.
Each wraps it in the `tagShoutingDialog`/`tagExcitedDialog`/`tagHesitantDialog`
audio-tag inserters, which only add `[...]` spans and never touch entities. The
result becomes `ChapterHint.body` → `ParsedManuscript` → `ManuscriptRecord`
(`sourceText` = the bodies joined) → the analyzer, the evidence verifier, the
manuscript UI, and TTS.

### Does anything depend on entities *surviving*?

Grepped across `server/src/`. Everything that pattern-matches a literal entity
spelling is a **dash-detection compatibility shim carrying the entity as an
alternative alongside the real glyph**:

| Site | Shape |
|---|---|
| `lang/{ru,es,fr}.ts` `dialogueOpen` | `/^\s*(?:&mdash;\|&ndash;\|[-–—])\s*/iu` |
| `dialogue-structure/parser.ts:10` | `DASH = (?:&mdash;\|&ndash;\|[-–—])` |
| `dialogue-structure/legibility.ts:3` | same `DASH` constant |
| `dialogue-structure/aligner.ts:92-94` | `buildNormalizedMap` folds a 7-char `&mdash;`/`&ndash;` run to `-` with an offset map |

**Every one degrades gracefully**: each already carries the real dash character
in the same alternation, so once the entity is decoded to `–`/`—` the
character-class branch matches instead. **Nothing breaks; the entity branches
simply stop firing on freshly-parsed text.** Verified by reading each site, not
inferred.

`verifyEvidenceAgainstSource` (`routes/analysis.ts:612-671`) is the one exact
substring matcher, via `normaliseForMatch` (`util/text-match.ts:18-28`), which
folds typographic variants but **does not decode entities**. Both sides of that
comparison — the LLM's echoed quote and the source — are drawn from the *same*
post-`stripHtml` text, so they shift together. Self-consistent under widening.

### Does the fix reach already-imported books?

**Yes** — and this corrects a natural assumption worth stating because it is
wrong. `getOrHydrateManuscript` (`store/manuscripts.ts:71-90`) **re-parses the
original manuscript file from the workspace** on any cache miss (server restart,
`removeManuscript`), carrying forward only the user-set `excluded` flag. The
source `.epub`/`.mobi` is preserved on disk, so an existing book re-parsed after
this ships gets decoded text. The `state.json` `chapters[].body` snapshot still
holds the old entity-laden text until rewritten.

So the fix reaches existing books **on re-analysis**, exactly as the ru
attribution plan's cached-analysis scope note describes — not only new uploads.
It does **not** retroactively rewrite persisted `state.json` bodies.

### Blast radius the first revision missed (found by adversarial review)

Two real effects, neither hypothetical:

**`&NewLine;` → U+000A and `&Tab;` → U+0009 can change paragraph structure.**
The named decode runs at `html-utils.ts:52-56`, i.e. **before** the `[ \t]+\n`
and `\n{3,}` → `\n\n` collapses at `:58-59`. A serializer emitting `&NewLine;`
would therefore newly create line breaks, and the parsers emit **one paragraph
per line**. This is structural, not cosmetic. It is also vanishingly rare in
real EPUB body text — `&NewLine;` and `&Tab;` are HTML5 additions almost never
produced by ebook toolchains — but "rare" is not "handled", so the plan carries
a test pinning that both are decoded *and* that the collapse still yields the
expected paragraph count.

**Decoded quotes and ellipses newly fire the audio-tag inserters.** `stripHtml`'s
output is wrapped in `tagShoutingDialog`/`tagExcitedDialog`/`tagHesitantDialog`
(`epub.ts:149-150`, `:255-257`, `mobi.ts:165-167`). Those match on real
characters: `QUOTE_OPENS`/`QUOTE_CLOSES` (`audio-tags.ts:31-32`) and the
hesitation patterns at `:117-118`. Today `&ldquo;`/`&raquo;`/`&hellip;` survive,
so **`rewriteQuoteSpans` finds no spans at all** in an entity-encoded chapter and
no `[shouting]`/`[excited]`/`[hesitant]` tag is ever emitted. After decoding they
fire normally.

**This is the fix working, not a regression** — an entity-encoded book was
silently getting *no* audio-tag enrichment, which is the same defect class one
layer over. But it is a behaviour change that belongs in a section titled "blast
radius, measured", and the first revision omitted it. `stripAudioTags` removes
the bracket vocabulary before synthesis, so audio is unaffected; the tags reach
the analyzer and the UI, which is where they are meant to go.

### Other formats

`parsers/` holds `epub.ts`, `mobi.ts` (both via `stripHtml`), `pdf.ts`
(`pdf-parse` → plain Unicode), `text.ts` (`.txt`/`.md`, raw). **There is no
`.docx` parser** and — decisive for option 2 — **there is no universal
post-parse normalisation seam.** Each parser builds `ChapterHint.body`
independently and `assembleManuscript` merely joins them.

## The options, with measured blast radii

### Option 1 — widen the decode in `stripHtml` ✅ **recommended**

Fixes every downstream consumer at once, at the one place that already owns
entity decoding.

- **Blast radius, measured:** the four dash shims keep matching via their glyph
  branch (Finding 5). The evidence verifier is self-consistent. Nothing
  downstream depends on entities surviving. The *hypothesised* risk — "the small
  set may be load-bearing" — is **disproved** by Finding 3.
- **Cost:** one new `server/` dependency (see below), and two genuine edge cases
  that must be handled deliberately rather than absorbed (Finding 6).

### Option 2 — decode at import-time normalisation ✗

- **There is no import-time normalisation layer to put it in** (Finding 5). This
  option's premise does not exist in the codebase; choosing it means *creating*
  a new cross-parser seam.
- It would add a second place that knows about entities — and Finding 4 shows
  the codebase already has two, one of which has silently drifted out of sync
  with the other. Adding a third is the failure mode already in evidence.
- The only thing it buys over option 1 — sparing `pdf.ts`/`text.ts` — is worth
  nothing: those formats carry no entities.

### Option 3 — soften on the TTS side only ✗

- **Fixes one entity in one position and leaves the whole of Finding 2's table
  spoken**, including `&eacute;` corrupting every accented word.
- **The UI keeps displaying the raw entity.** `chapterHints[].body` is the same
  server-computed field the manuscript view renders, so today users see
  `&mdash;` in the manuscript too. Option 3 leaves the UI and the analyzer
  agreeing with each other and disagreeing with the audio — the ticket's own
  stated objection, confirmed against the render path.
- It is the only option that makes the `dialogueOpen` entity alternatives
  permanently necessary rather than merely retained.

## Recommendation

**Option 1** — widen `stripHtml`'s named-entity decode to the full HTML5 named
set, via `entities`' **`decodeHTMLStrict`**, scoped to named references only.

The single strongest fact behind it: **`&#8211;` already produces the correct
audio today through the unmodified pipeline.** The desired behaviour is not a
new capability to be built at some layer — it is behaviour the codebase already
has for one spelling of the character and lacks for the other, because a
five-entry list copied from an XML-unescape idiom on day one was never revisited.

### Why a library rather than a curated table

A hand-written table of "the ~40 entities that matter" is the option the repo
has already tried, twice, and been bitten by both times: the original five-entry
set (Finding 3), and `es`/`fr` `dialogueOpen` carrying `&mdash;` but not
`&ndash;` (#2289 — same dash, other spelling, silently unhandled for months).
**An enumeration of spellings loses a spelling per round.** The complete set is
the only one that does not need a third round.

`entities@8.0.0` — **BSD-2-Clause, zero dependencies, zero peer dependencies**,
`engines: node >=20.19.0` (this repo is on Node 20.6+/24). It is the decoder
behind `cheerio`/`parse5`/`htmlparser2`.

**Stated accurately, because the convenient version of this claim is false:**
`entities` *is* present in the root tree today — but as a **dev-only**
transitive of `parse5` ← `jsdom` (the frontend test environment). Adding it to
**`server/package.json` `dependencies`** therefore introduces a **genuine new
production dependency** for the server. It is not "already there". The cost is
judged acceptable — zero transitive deps, ~100 KB, permissive licence, in a
server that already ships `epub2`, `pdf-parse`, `sharp` and `undici` — but it is
a real cost and the owner is approving it, not being told it is free.

Relying on the hoisted root copy instead would be a **phantom dependency** and
is not an option: it resolves today only by accident of npm hoisting from a dev
tree, and would break a production install.

### Why `decodeHTMLStrict` and not `decodeHTML` — measured

`decodeHTML` implements HTML5's **legacy semicolon-less** entity rule and
**corrupts ordinary prose containing a bare ampersand**:

| Input | `decodeHTML` | `decodeHTMLStrict` |
|---|---|---|
| `Fish &notice this` | `Fish ¬ice this` ❌ | `Fish &notice this` ✅ |
| `Copyright &copy 2026` | `Copyright © 2026` ❌ | `Copyright &copy 2026` ✅ |
| `Smith & Sons` / `AT&T and R&D` | unchanged ✅ | unchanged ✅ |
| `&amp;lt;` | `&lt;` ✅ | `&lt;` ✅ |
| `&amp;ndash;` | `&ndash;` ✅ | `&ndash;` ✅ |

`decodeHTMLStrict` requires the terminating semicolon, so `AT&T`, `Smith & Sons`
and `&notice` are untouched, while `&amp;lt;` correctly single-passes to `&lt;`
rather than double-unescaping to `<`. **`decodeHTML` is not an acceptable
substitute and the plan must pin the difference with a test.**

## Finding 6 — two edge cases the swap must handle deliberately

Both were found by probe, and a naive "replace the five `.replace()` calls with
`decodeHTMLStrict(s)`" gets both wrong.

### 6a. Invalid numeric references — a real regression

`decodeNumericEntities` documents an explicit contract at
`html-utils.ts:15-16`: *"Invalid or out-of-range references are left untouched
rather than dropped."* `decodeHTMLStrict` **violates it** — it maps them to
U+FFFD:

| Input | current | `decodeHTMLStrict` |
|---|---|---|
| `A&#99999999;B` | `A&#99999999;B` | `A\uFFFDB` |
| `A&#x110000;B` | `A&#x110000;B` | `A\uFFFDB` |
| `A&#0;B` | `A<NUL>B` (**decodes**) | `A\uFFFDB` |
| `A&#xD800;B` | `A<lone surrogate>B` (**decodes**) | `A\uFFFDB` |

U+FFFD is **not** stripped by `stripUnsafeForTts`, so it would reach the engine.
This contract is documented in a comment but **not pinned by any test** — the 22
tests in `html-utils.test.ts` cover only valid references. The plan adds that
missing test.

**Correction, caught by probing rather than reading — an earlier revision of
this spec got the last two rows wrong.** `codePointOr` guards only
`!Number.isFinite`, `< 0`, and `> 0x10ffff`, so `&#0;` and `&#xD800;` **do**
decode today, to NUL and to a lone surrogate; `stripUnsafeForTts`'
`CONTROL_CHARS` and `UNPAIRED_SURROGATE` then remove both downstream. Only
genuinely out-of-range (`&#99999999;`, `&#x110000;`) and malformed (`&#;`,
`&#x;`) references are left literal.

The regression is therefore narrower than first claimed, but the two remaining
rows are real and the resolution is unchanged. **The plan's test must assert
only the rows that actually hold** — asserting all four would ship a red test,
which is exactly how this error surfaced.

**Resolution:** scope the library call to *named* references only —
`s.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (m) => decodeHTMLStrict(m))` — and leave
`decodeNumericEntities` untouched and still responsible for numerics. A
leftmost-match `replace` does not rescan its own output, so `&amp;ndash;` →
`&ndash;` correctly (verified).

### 6b. `&nbsp;` whitespace kind

Today `&nbsp;` → `' '` (U+0020). `decodeHTMLStrict` yields **U+00A0**, which
would newly flow into the body text and past `[ \t]+\n` collapsing.

**Resolution — and the obvious version of it is not quite enough.** Keeping the
existing `.replace(/&nbsp;/g, ' ')` line before the general pass preserves
`&nbsp;` byte-for-byte, but **misses HTML5's aliases**: probe shows
`&NonBreakingSpace;` still decodes to U+00A0. So the fold must be on the
*character*, not the spelling — apply `.replace(/ /g, ' ')` **after** the
named pass and **before** `decodeNumericEntities`. Positioned there it catches
every named spelling and alias, while leaving `&#160;` → U+00A0 exactly as
today, since the numeric decode runs afterwards.

That pre-existing named/numeric NBSP asymmetry is **noted, not changed** —
altering it is a separate behaviour question with no bearing on this defect.

### 6c. `&shy;` / `&thinsp;` become real invisible characters

Newly decodable entities include U+00AD SOFT HYPHEN (`&shy;`) and U+2009 THIN
SPACE (`&thinsp;`). Today these reach TTS as the literal text `"&shy;"` — read
aloud as gibberish — so decoding them is **strictly an improvement**. But
U+00AD is not covered by `ZERO_WIDTH_AND_BIDI`
(`text-normalize.ts:76`, which spans U+200B–U+200F, U+202A–U+202E, U+2060,
U+FEFF), so it would reach the engine as an invisible character with no audio
mapping — the exact class that file exists to strip.

This is a chore **this change makes owed**, not a pre-existing one to file and
walk past: adding U+00AD to that character class is one character of regex plus
a paired test, and the plan includes it as its own task.

## Do the `dialogueOpen` entity alternatives become redundant?

**They become redundant for freshly-parsed body text, and they stay anyway — but
the first version of this section justified that with a fact that is false, and
the corrected reason is both different and stronger.**

### The wrong reason (retracted)

An earlier revision argued the shims must stay because `state.json`'s
`chapters[].body` retains entity-laden text. **`BookStateJson.chapters[]` has no
`body` field at all** (`server/src/workspace/scan.ts:63-100` — `id`, `title`,
`slug`, `uuid`, `duration`, `excluded`, `held`, `audio*`, `generation*`), and
`routes/import.ts:312-317` explicitly re-maps to `{id, title, slug, excluded}`
before writing. Every `ChapterHint.body` producer traces to a fresh
`parseManuscript()`. **Retracted in full.** It was also filed under "what I could
not establish" when it was one grep away — presenting a checkable fact as
unestablished is precisely the deferral this repo's rules forbid.

### The right reason

**The text that reaches TTS is persisted, and it is not re-derived from the
source.** Per [Finding 0](#finding-0--the-ticket-omits-a-model-shaped-link-in-its-own-chain),
TTS reads the stage-2 model's returned `SentenceOutput.text`, and that text is
persisted in two places that a re-parse does **not** refresh:

- **`manuscript-edits.json`** — durable, inside the book's own directory
  (`server/src/export/manuscript-sentences.ts:2-6`);
- **`server/handoff/cache/{manuscriptId}.json`** — the analysis cache.

A book analysed before this ships has entity-laden sentence text in both. More
fundamentally, `parser.ts`/`legibility.ts`/`aligner.ts` normalise **LLM-returned
text**, which can echo an entity *whatever* `stripHtml` did — the model is not
bound by the parser's output. So the shims are not merely back-compat for old
books; they guard a class of input that remains reachable indefinitely.

Removing them would regress dialogue **attribution** — strictly worse than the
mispronunciation being fixed. Keeping them costs ~20 characters of regex
alternation, with no correctness risk (they cannot match decoded text).

**Decision: keep all of them** — `dialogueOpen` in
`server/src/analyzer/dialogue-structure/lang/{es,fr,ru}.ts`, the `DASH` constant
in `dialogue-structure/parser.ts:10` and `legibility.ts:3`, and `aligner.ts`'s
7-char atom at `:92-94` (six files, one shim shape). Amend their comments to
name `stripHtml` as the primary decode layer and record that they guard
model-returned and already-persisted text.

This disposes of the ticket's framing that option 1 makes #2289's change "dead
weight to be reverted": **#2289 remains correct and load-bearing**, for a better
reason than the ticket supposed.

## Test strategy

Four layers, so that a future change at any one of them cannot silently reopen
this.

1. **`html-utils.test.ts` — the decode itself.** `&ndash;`/`&mdash;`/`&eacute;`/
   `&hellip;`/`&laquo;`/`&apos;` decode; `AT&T`, `Smith & Sons`, `&notice`,
   `&copy 2026` untouched (the `decodeHTMLStrict`-vs-`decodeHTML` pin);
   `&amp;lt;` → `&lt;`; `&amp;ndash;` → `&ndash;`; `&nbsp;` → U+0020 **not**
   U+00A0; **invalid numeric refs still left literal** (the currently-unpinned
   contract from Finding 6a).
2. **End-to-end text handed to the engine** — the ticket's explicit requirement.
   `normaliseForTts(stripHtml('<p>&ndash; …</p>'), lang)` **equals**
   `normaliseForTts(stripHtml('<p>– …</p>'), lang)` for `es`, `fr`, `ru`, with
   the glyph in each pair matched to the entity (`&ndash;`↔`–`, `&mdash;`↔`—`).

   **Two vacuity holes this must close, both found by review:**

   - **`LEADING_DASH = /^\s*[–—]\s*/` collapses en *and* em dash to the same
     `'... '`**, so an equality assertion alone passes even if the decode
     produced the *wrong* dash — it proves "something dash-like emerged", not
     the right codepoint. The test therefore also asserts on the **pre-
     normalisation `stripHtml` output**, where the two dashes are still
     distinguishable.
   - **Equality holds if both sides are equally broken.** The test additionally
     pins that no `&name;` survives and that the marker actually became a pause.

   **The sentence text is fixed explicitly — no model in the loop.** Per
   Finding 0 the production body path runs through stage-2, so a test that
   round-tripped a real model would pass or fail by model version. This test
   deliberately pins the *decode → normalise* composition, which is the literal
   production path for **titles** and the "model echoed verbatim" case for
   bodies.

2b. **The model-independent title path.** `buildChapterTitleNarration` on a
   title carrying `&eacute;`/`&mdash;`, through `normaliseForTts`, yields no
   surviving entity. This is the assertion that reproduces regardless of model
   behaviour, and it is the better acceptance evidence.
3. **Attribution unchanged** — `parseChapterStructure` still classifies the
   decoded paragraph as `dialogue` in all three languages, pinning that the
   glyph branch carries the load once the entity branch stops firing.
4. **`epub.ts` `decodeEntities`** — Finding 4's metadata path, same widening,
   plus the hex-apostrophe case it currently misses.

### The vacuous-fixture trap — explicit, because it has already shipped twice

`&nbsp;` is one of the five entities `stripHtml` **does** decode, so a fixture
using `&nbsp;` to represent "an entity that survives" is vacuous while looking
correct. That exact mistake shipped in #2289 and was corrected to `&hellip;`.

**This change re-arms that trap one level up.** `parser.test.ts:709-713` is
#2289's negative control:

```
it('#2289: negative control — an unrelated entity (&hellip;) does not open dialogue', …)
// "&hellip; survives stripHtml so this control is realistic end-to-end"
```

Under option 1, **`&hellip;` no longer survives `stripHtml`**, so that comment
becomes false and the control stops being realistic end-to-end. Widening to the
complete named set means **no** entity survives, so no substitute fixture can
restore the property.

**Disposition — improved by review.** The first revision proposed a comment-only
rewrite, downgrading the control to a unit-level mutation guard on the claim
that "no entity survives, so no fixture can restore the property". **That claim
is false:** `decodeHTMLStrict` leaves *unknown* named references untouched
(probed: `&zzz;` → `&zzz;`, `&notanentity;` → `&notanentity;`).

So the control **stays realistic end-to-end** by swapping the fixture to an
unknown entity, which is strictly better than relabelling it. The plan swaps
`&hellip;` → `&zzz;` **and** fixes the comment, since `&hellip;` genuinely stops
surviving. A stale comment left behind here is exactly the trap re-armed for the
next reader.

## What I could not establish

- **How many real-world EPUBs carry named entities in body text.** No corpus
  measurement was run; `C:\AudiobookWorkspace` is read-only and was not
  surveyed. The class is established from the code path, not from prevalence.
  The fix's *correctness* does not depend on prevalence, but its *priority*
  does, and I am not claiming a frequency.
- **Whether the stage-2 model echoes a surviving entity into its returned
  sentence text.** This is the conditional in Finding 0, and it decides whether
  the *body-line* symptom reproduces on today's model. It needs a live analyzer
  run, which this design pass did not do. **It does not gate the fix**: the
  chapter-title path reproduces unconditionally, and options 1/2 act before the
  model either way. Recorded as on-box acceptance rather than guessed at.
- ~~Whether any persisted `state.json` body contains entities.~~ **Withdrawn** —
  `state.json` carries no body at all (Appendix B, finding 1). This was listed
  as unestablished in v1 when it was one grep away.
- **Adjacent observation, not folded in:** `softenDashes` renders
  `— Кто там? — спросил он.` as `"... Кто там?, спросил он."` — a comma directly
  after a question mark. Pre-existing, unrelated to entities, and fixing it
  needs its own decision about dashes following terminal punctuation. Noted so
  it is not mistaken for a regression introduced by this change.

## Appendix A — probe transcripts

Probes were run with `server/node_modules/.bin/tsx` against this worktree and
with `node` against `entities@8.0.0`; scripts are throwaway and live in the
session scratchpad, not the repo.

**Which entities survive `stripHtml`** (`stripHtml('<p>ENTITY X</p>')`):

```
&nbsp; &lt; &gt; &quot; &amp;      -> decoded
&#8211; &#x2014; &#160;           -> decoded (numeric)
&ndash; &mdash; &hellip; &apos;
&rsquo; &laquo; &raquo; &ldquo;
&eacute; &shy; &thinsp;           -> SURVIVE
```

**End-to-end `normaliseForTts`:**

```
entity, lang=es -> "&ndash; Un momento &mdash; dijo &eacute;l."
glyph,  lang=es -> "... Un momento, dijo él."
&#8211; Un momento.  -> "... Un momento."      <- already correct today
```

`decodeHTML` vs `decodeHTMLStrict` and the invalid-numeric divergence are
tabulated inline above (Finding 6, "Why `decodeHTMLStrict`").

## Appendix B — assumption-checker findings

A Premium-tier `assumption-checker` pass was run against v1 per CLAUDE.md's
mandatory spec-review gate. It was substantially right, and v2 changed the
*justification* for one decision and the *scope* of another. **No finding
changed the recommendation.**

| # | Finding | Severity | Disposition |
|---|---|---|---|
| 1 | **`state.json` carries no `chapters[].body`** — the sole stated reason to keep the dash shims is false | Critical | **Accepted, retracted, replaced.** Verified independently (`scan.ts:63-100`). The real reason is persisted *sentence* text (`manuscript-edits.json`, the analysis cache) plus the fact that the shims normalise **LLM-returned** text. Decision unchanged, reasoning rewritten. |
| 2 | **Three entity-set copies, not two** — `extractFirstHeading` is the third, and it feeds the *spoken chapter title*; `epub.ts:430` NCX labels a fourth site | Critical | **Accepted.** Finding 4 rewritten; both brought in scope. Converges with the coordinator's independent finding that titles are the model-independent route. |
| 3 | **`&NewLine;`/`&Tab;` decode before the whitespace collapse** and can change paragraph structure; decoded quotes/ellipses newly fire the audio-tag inserters | Significant | **Accepted.** New "blast radius the first revision missed" section. Audio-tag firing judged the fix working, not a regression, and said so explicitly. |
| 4 | **`entities` is a *dev* transitive** — this is a new production dep | Significant | **Already corrected** before the report landed (independently probed via the root lockfile). |
| 5 | **Unknown entities survive**, so the `&hellip;` control can stay realistic by swapping the fixture | Significant | **Accepted — better than my proposal.** Plan now swaps to `&zzz;` rather than relabelling the test. |
| 6 | **The e2e equality assertion can pass vacuously** — `LEADING_DASH` collapses en and em dash alike | Significant | **Accepted.** Test strategy now asserts on pre-normalisation `stripHtml` output too. (The specific mismatch alleged did not exist — the entity/glyph pairs were correctly matched — but the vacuity hole is real.) |
| 7 | Finding 1's positive control proves *reachability*, not *prevalence* | Significant | **Accepted as a wording fix.** Named references are far more common than numeric in real serializer output, so the behaviour delta is larger in practice than "one character already decodes" suggests. |
| 8 | Shim paths omitted `analyzer/`; "25 tests" (actually 22); "four shims" then six files | Nit | **Fixed** throughout. |

**One finding I did not accept as stated.** The report lists Finding 6a's four
invalid-numeric rows as verified correct. My own probe shows `&#0;` and
`&#xD800;` **do** decode under the *current* code (`codePointOr` guards only
non-finite, `<0`, `>0x10ffff`). Both statements are compatible — the reviewer
verified `decodeHTMLStrict`'s output, not the status quo's — but the spec now
carries the narrower, probed version, and the plan's test asserts only the two
rows that hold. See the correction under Finding 6a.
