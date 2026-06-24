---
status: draft
issue: 976
backlog-id: fs-53
area: fs
---

# fs-53 — Automatic text normalisation (numbers / dates / currency / abbreviations) pre-synth

## Problem

Published prose is full of written forms that TTS engines read literally or
wrong: `$1,200` becomes "dollar one comma two hundred", `Jan 3rd` becomes
"jan three-r-d", `1999` becomes "one thousand nine hundred ninety-nine" where
"nineteen ninety-nine" was meant, `50%` becomes "fifty percent sign". A basic
audiobook-quality floor (the kind Pandrator/NeMo-style pipelines already clear)
requires expanding numbers, dates, currency, common abbreviations and symbols
to their spoken form **before** synthesis.

This is the generic, language-aware expansion layer. It is **distinct from
`fs-24`** (per-character proper-noun pronunciation lexicon) and **complements
`fs-50`** (per-language analyzer/text rules) — fs-53 owns number/date/symbol
speech, fs-50 owns the surrounding per-language detection grammar.

The codebase already has the right seam. `server/src/tts/text-normalize.ts`
exposes `normaliseForTts(text)` — the single TTS-boundary normaliser that
`synthesiseChapter` calls — composing today's language-neutral transforms
(all-caps fold, dash softening, unsafe-char strip, audio-tag removal). It is
**TTS-boundary-only**: the original `sentence.text` is never mutated, so
captions, the manuscript view, and quote-audit keep showing the written form.
fs-53 extends this seam; it does not invent a new one.

## Goals

1. Expand numbers, dates, currency, a curated abbreviation set, and a closed
   symbol set to spoken form at the TTS boundary, **language-aware** including
   per-language **decimal/thousands separator** conventions.
2. Ship **working rules for all five registry languages** — `en`, `es`, `ru`
   (currently `supported:true`) plus `fr`, `de` **pre-populated** so they are
   live the moment their fs-50 gate flips `supported`.
3. Stay **always-on, invisible, and zero-regression** for the existing
   pipeline — no toggle, original text untouched, and the no-language call
   path byte-identical to today.
4. **Feed the same normalised text to the ASR content-QA gate** so number
   expansion does not desync the WER comparison (see "ASR-QA alignment" — this
   is load-bearing, not optional).
5. A **regression fixture set** per language, each heuristic carrying both a
   success and a documented known-failure line.

## Non-goals (v1 — YAGNI)

- Per-book or global toggle UI / setting. Normalisation is a baseline quality
  guarantee, not an option.
- Any "will be read as…" preview in the UI.
- General Russian numeral–noun **case agreement** for arbitrary nouns
  (declining the *noun* for 2–4 / 5+). Only known currency units get it.
- Full oblique-case declension of Russian numerals after arbitrary
  prepositions. Only the **closed set of year-governing prepositions** is
  cased (см. Russian floor); all other oblique numerals stay nominative.
- Numeric-date disambiguation (`3/1/2026` — M/D vs D/M). Textual-month dates
  only.
- **Currency ISO codes** (`USD`, `EUR`, `GBP`). v1 handles currency **symbols**
  only ($, €, £, ₽). Codes are additionally pre-mangled by the existing
  `denormaliseAllCaps` fold (`USD`→`Usd`) which runs before expansion, so
  handling them would mean reordering that transform — out of scope.
- **Clock times** (`3:30`), **ratios** (`2:1`), and **numeric ranges**
  (`10–20`, already comma-softened upstream). They read acceptably-but-imperfectly
  via the plain-number pass; not specially handled (documented limitation #8/#9).
- Numbers above ~10⁹ (one billion). Out-of-range falls through untouched.
- A heavy WFST / NeMo-style grammar or any new Python-sidecar surface. This is
  hand-rolled, auditable TypeScript in the existing `text-normalize.ts` style.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Pragmatic hand-rolled regex transforms | Matches `text-normalize.ts` (auditable, anchored-to-failure-mode), no new runtime deps, YAGNI |
| Language scope | All five (en/es/ru working, fr/de pre-populated) | Multi-lingual is a hard requirement; fr/de "just await verification" — no scramble when they flip |
| Toggle | Always-on, no toggle | Like every existing transform; correct number/date reading is a baseline, not a setting |
| Visibility | TTS-boundary-only, original text untouched | Established `normaliseForTts` contract; captions show written form (standard for audiobooks) |
| Ambiguity posture | Balanced w/ documented heuristics | Expand common cases with sensible defaults; leave truly 50/50 cases; document each gamble + its known failure |
| Data home | `normalize/lang/*.ts` (alongside, not in the registry) | Data is behavioural (functions, not word lists); co-locate with the engine; registry stays the source of truth for language *identity/support* only |
| Caption desync risk | None | Verified: no word-level/karaoke audio-synced highlighting exists in the frontend |
| ASR-QA alignment | QA expected-text = the fs-53-normalised text | Audio is made from normalised text; the QA gate MUST compare against the same, or every expanded number is a false-positive `drift` |
| Activation gate | `expandForSpeech` self-gates on `isSupportedLanguage(langCode)` **and** a `lang/<code>.ts` module existing | fr/de rules ship dormant and auto-activate when their `supported` flag flips; the module clause stops a future `supported` language without rules from crashing at dispatch |
| Frontend work | None | Always-on / no toggle / invisible ⇒ server-only; the issue's "frontend" half of the Full-stack label is intentionally dropped |

## Architecture

### Integration point

`normaliseForTts(text)` gains an **optional** language argument:

```ts
normaliseForTts(text: string, langCode?: string): string
```

- **With `langCode`** — the audio-producing path passes `bookLanguage`. After
  today's language-neutral transforms run, the new `expandForSpeech(text,
  langCode)` pass runs.
- **Without `langCode`** — language-neutral call sites run **only** today's
  transforms. Output is byte-identical to current behaviour ⇒ **zero regression
  risk**, fully backward-compatible.

`expandForSpeech` is a **no-op** when `langCode` is absent, not in the registry,
maps to a `supported:false` language, **or** has no `lang/<code>.ts` module
(the `isSupportedLanguage` self-gate + a module-presence check). This is what
keeps fr/de dormant until their fs-50 gate flips — and it is a real gate, not an
assumption: `sidecarLanguageName` only fails-loud for languages *missing* from
the registry, but fr/de are *present* (just `supported:false`), so they would
otherwise slip through. The module clause is belt-and-suspenders for a future
registry language flipped `supported` before its rules land.

### Call-site threading (every audio + QA site, or none)

`normaliseForTts` is called at multiple sites. Number expansion changes word
count, so **every site that produces audio or is compared against audio MUST
pass the same `langCode`**, or sized batches / QA references drift out of sync.
Explicit table (line numbers approximate, re-confirm at implementation):

| Site | File:line | Pass `langCode`? | Why |
|---|---|---|---|
| Group synth text | `synthesise-chapter.ts:1090` | **Yes** | Produces audio |
| Group synth (variant) | `synthesise-chapter.ts:1139` | **Yes** | Produces audio |
| Chapter title synth | `synthesise-chapter.ts:917` | **Yes** | Produces audio (titles have numbers: "Chapter 3") |
| Batch-length key | `synthesise-chapter.ts:1281` | **Yes** | Must match the synthesised length, else mis-sized batches |
| **ASR-QA expected text** | `synthesise-chapter.ts:1489,1513` | **Yes** | Must match the audio; see ASR-QA alignment |
| Empty-sentence filter | `synthesise-chapter.ts:682` | Optional | Expansion never makes a sentence empty/non-empty; neutral is safe |
| ICL reference picker | `voice-mapping.ts:183` | Optional | Picks the longest sentence as the clone reference; internally consistent either way (see known-limit #9) |

The cleanest implementation resolves `langCode` once near the top of
`synthesiseChapter` and threads it to the helper closures (`synthGroup`,
`verify`, the length map) rather than re-deriving it per call.

### Module layout

A new directory keeps the sizable per-language data out of the lean
`text-normalize.ts`:

```
server/src/tts/normalize/
  index.ts            expandForSpeech(text, langCode) — self-gates + composes the ordered passes
  classifiers.ts      shared regex span-finders (currency/percent/date/ordinal/year/number/symbol/abbrev)
  number-to-words.ts  dispatch to the per-language engine
  lang/en.ts          per-language data + cardinal()/ordinal()/year() + currency/abbrev/symbol/month tables + separators
  lang/es.ts          Spanish: 16–29 contractions, quinientos/setecientos/novecientos, cien/ciento, y-placement, gender default, comma-decimal
  lang/ru.ts          Russian: years-as-ordinals (+ в…году frame), genitive-month dates, currency agreement, 1/2 gender heuristic, space-thousands/comma-decimal
  lang/fr.ts          French: soixante-dix / quatre-vingts / quatre-vingt-dix, vingt/cent pluralisation floor, space-thousands/comma-decimal
  lang/de.ts          German: unit-before-ten compounding, eins→ein before a scale word, period-thousands/comma-decimal
  __fixtures__/{en,es,ru,fr,de}.txt   input ⇒ expected pairs (the regression fixture set)
```

**Per-language `cardinal(n)` functions, not one generic engine + config.** The
compounding is genuinely irregular across these five (Spanish *dieciséis*/
*veintiuno*, French *soixante-dix*/*quatre-vingts*, German *einundzwanzig*).
A config-driven generic engine would be a leaky abstraction full of exceptions;
five small honest functions are easier to read, test, and get right — the same
isolation `tag-grammar.ts` / `descriptor-grammar.ts` already use next to their
logic rather than in `language-registry.ts`.

`language-registry.ts` stays the source of truth for language **identity and
support** (`code` / `supported`); the `normalize` module owns **speech rules**.

## The pipeline

`expandForSpeech(text, langCode)` runs **after** the existing transforms, as
ordered passes. Order matters — composite patterns must match before their
parts, so a number inside `$1,200` is never expanded standalone first. Each
pass is a span-replace that **consumes** its match, so later passes never see an
already-expanded region.

**Separator normalisation runs first (per-language).** Each `lang/<code>.ts`
declares its `decimalSep` and `thousandsSep`. Before any number/currency pass,
the classifier rewrites the matched numeric span into a canonical
`<integer>.<fraction>` internal form using the language's separators:

- `en`: `,`=thousands, `.`=decimal → `1,200.50` ⇒ 1200.50
- `de`: `.`=thousands, `,`=decimal → `1.200,50` ⇒ 1200.50
- `es`: `.`=thousands, `,`=decimal → `1.200,50` ⇒ 1200.50
- `fr`/`ru`: space = thousands, `,`=decimal → `1 200,50` ⇒ 1200.50.
  The space matcher MUST include `U+0020`, `U+00A0` (NBSP), `U+202F` (narrow
  NBSP), `U+2009` (thin) — verified these survive `stripUnsafeForTts` (they are
  not in its zero-width set), so they reach this pass and must be matched.

This is **critical for multilingual correctness**: without it, German `3,14`
(π) reads as "three thousand fourteen". The separator rule is data, not code —
one `{decimalSep, thousandsSep}` per language.

**Thousands separators only count in valid 3-digit groups.** A period/comma is
treated as a thousands separator **only** when it groups exactly-3-digit runs
(`\d{1,3}(<sep>\d{3})+`). A lone non-grouping separator is the decimal (per
locale) or left literal — so German `1.5` / `3.5x` (a casual decimal or a
version) is **not** mangled to `15` / `35`. Without this guard the separator fix
itself introduces a new mis-read class.

Then the ordered passes (operating on the canonicalised numbers):

1. **Currency** — `$1,200.50`, `€5`, `£3`, `₽100`, `1.200,50 €`. Symbol →
   per-language currency word; amount via `cardinal()`; minor units split. →
   "one thousand two hundred dollars and fifty cents". Handles
   symbol-before-number (en/£/$) **and** number-before-symbol (`5 €`, the es/fr/
   de convention). Minor-unit agreement uses the unit's known gender/plural
   (see Russian/Spanish floors). **Symbols only** — ISO codes (`USD`/`EUR`) are
   out of scope (see non-goals; the all-caps fold pre-mangles them anyway).
2. **Dates** — textual-month forms confidently (`January 3, 2026` → "January
   third, twenty twenty-six"; per-language month tables + ordinal day + year
   reading). **Conservative on bare numeric dates** (`3/1/2026`) — M/D vs D/M is
   unresolvable without locale certainty, so left to the plain-number pass.
3. **Percent & symbols** — `50%` → "fifty percent"; curated **closed** symbol
   set → per-language words: `&`→and/y/и/et/und, `°`, `#`, `@`, `×`, and
   `+`/`-`/`=` in number-ish context. No guessing at arbitrary punctuation.
4. **Ordinals** — `3rd`, `21st`, es `1.º`/`1.ª`, fr `1er`/`2e` → per-language
   ordinal word.
5. **Decades** — `1990s` / `1990's` → per-language decade reading ("nineteen
   nineties"). Runs **before** the year pass so the trailing `s` isn't orphaned
   into "…ninety s". The bare `'90s` apostrophe-elided form is left alone
   (ambiguous century) — documented limit.
6. **Years (the heuristic)** — bare 4-digit integer in ~**1100–2099**, no
   separator → year-style reading ("nineteen ninety-nine", "twenty
   twenty-six"). Outside the range, or grouped/decimal → falls through to
   cardinal. The one documented gamble; right for the overwhelming majority of
   prose. Known false positives (`Room 1999`, `Apartment 2024`, `Highway 1500`)
   are accepted and pinned as fixture known-failures (limitation #1).
7. **Plain numbers** — grouped and bare integers → `cardinal()`; decimals →
   "three point one four" (digit-by-digit after the point); a leading hyphen
   that is **preceded by a non-alphanumeric** (so `well-being` / `twenty-one`
   are untouched) → "minus".
8. **Abbreviations** — a **curated, closed, per-language map** where one reading
   dominates: `Mr.`→Mister, `Mrs.`, `Ms.`, `Dr.`→Doctor, `Prof.`, `vs.`, `etc.`,
   `e.g.`/`i.e.`, `a.m.`/`p.m.`. `No.`→Number **only when followed by a digit**
   (`No. 5`) — never the sentence-initial negation *"No."*. `St.`→Saint
   **only when title-cased before a capitalised word**, else left alone (the
   documented 50/50 escape). Anything not in the map is untouched.

Every heuristic (year range, `St.`/`No.` rules, conservative numeric-date,
RU mis-gender, separator inversion) carries a comment anchored to its rationale
— mirroring how `text-normalize.ts` documents each transform against an
observed failure mode — and a matching fixture line including its
**known-failure** case.

**Idempotency caveat.** Unlike the current transforms, this pass is **not**
strictly idempotent (a second run could re-touch output). The contract is
"apply exactly once at the boundary" — already how `normaliseForTts` is used.
Stated explicitly in the module header so no one composes it twice.

## ASR content-QA alignment (load-bearing)

The per-sentence ASR content-QA gate (srv-31, `segment-asr-qa.ts`) transcribes
sampled group audio with Whisper and word-error-rates it against an **expected
text**, re-recording (best-of-N) on a `drift` verdict. Today the gate is fed the
**raw** `group.text` (`synthesise-chapter.ts:1489` / `:1513`), while the audio
is synthesised from `normaliseForTts(group.text)`.

**Without this section's fix, fs-53 breaks the gate.** Audio says "one thousand
two hundred dollars"; Whisper transcribes that; expected text `$1,200`
normalises (via `normalizeForWer`, which only spells English integers 0–99 and
is gated off entirely for non-English per #1084) to the lone token `1200`. WER
explodes → **false-positive `drift` on correct audio** → burns the re-record
budget → ships flagged `asrSuspect`. This is exactly the FP class the project
already fights (#1074, #1084).

**Fix:** feed the ASR-QA gate the **same fs-53-normalised, language-aware
text** the audio was produced from — i.e. pass `normaliseForTts(group.text,
langCode)` (or the already-normalised string) as `expectedText` at both
`verify(...)` call sites. `normalizeForWer` then tokenises matching word
streams on both sides.

**Bonus this unlocks:** because fs-53 is language-aware, the Spanish expected
`$1,200` becomes *"mil doscientos dólares"*, which matches what Spanish Whisper
hears. Precisely: fs-53 **pre-spells** the numbers, so `normalizeForWer`'s own
integer-speller — which is English-only and disabled for non-English (#1084) —
is no longer *needed* on the non-English path. This requires **no change to
`normalizeForWer`**; fs-53 simply sidesteps the gap by handing it matching word
streams on both sides. The QA gate goes from a liability to an asset.

**Latent pre-existing skew, also fixed:** even today, raw `group.text` vs
`normaliseForTts` audio differ for dashes/all-caps/audio-tags; routing the
normalised text into `expectedText` cleans that up as a side effect. A
regression test should assert the QA expected text equals the synth-input text.

**Interaction note:** `normalizeForWer` does its own English 0–99 integer
spelling. Feeding it text already spelled by fs-53 is harmless (words stay
words), but the WER fixture set must include a normalised-number line to lock
that the two normalisers compose without double-counting.

## Multi-language strategy & quality-floor morphology

Each `lang/<code>.ts` exports `cardinal(n)`, `ordinal(n)`, `year(n)`, the
`{decimalSep, thousandsSep}` pair, plus data tables (currency words + minor-unit
gender, month names incl. genitive forms where needed, symbol words,
abbreviation map). The shared `classifiers.ts` does language-agnostic
*detection*; rendering dispatches to the language file. v1 range:
**0 – 999,999,999**; out-of-range untouched.

- **English** — clean, full correctness. The reference implementation.
- **Spanish** — real irregulars (*dieciséis…veintinueve*, *quinientos /
  setecientos / novecientos*, *cien* vs *ciento*), and the **`y`-placement
  rule**: `y` joins tens–units (*treinta y uno*) but **not** after hundreds
  (*ciento uno*, not *ciento y uno*) and **not** inside 21–29 (*veintiuno*).
  **Gender floor:** default masculine (*un*, *doscientos*); currency uses the
  unit's known gender (*dólar*→masc, *libra*→fem). Documented limit: a bare
  count modifying a feminine noun renders masculine. Separators: `.`=thousands,
  `,`=decimal.
- **Russian — the raised floor** (the hardest, deliberately pushed past a bare
  masculine-cardinal default):
  1. **Years as ordinals** — `1999` → *тысяча девятьсот девяносто девя́тый*
     (final component inflects to ordinal, nominative). Deterministic.
  2. **Year-preposition frames (closed set, cased)** — Russian years inflect by
     their governing preposition, so handling only `в` would make `в` right and
     its siblings *worse-than-uniform* (partial correctness hides the gap). The
     **closed set** is cased on the final ordinal component:
     - `в`/`во` + `году` → **prepositional**: *в … девя́том году*
     - `с` / `до` / `от` / `после` + `года` → **genitive**: *с … девя́того года*
     - `к` + `году` → **dative**: *к … девя́тому году*

     Detected by the governing preposition + the `год`-stem case marker. Any
     year **outside** this closed set stays nominative (documented limit) — but
     the common frames are now internally consistent, not half-right.
  3. **Dates** — day as **neuter ordinal** + month in **genitive**
     (`3 января` → *третье января*); both from hardcoded tables (12 genitive
     months, neuter ordinals 1–31). Deterministic.
  4. **Currency 1 / 2–4 / 5+ agreement** — *рубль / рубля / рублей*,
     *доллар / доллара / долларов* (unit noun known).
  5. **1 and 2 gender heuristic** — infer the following bare noun's gender from
     its ending to pick *один/одна/одно* and *два/две*. Catches clear
     *-а/-я* feminine and consonant masculine; **will mis-gender** soft-sign
     nouns and irregulars like *папа* — each documented with a fixture.
  6. Cardinals otherwise nominative; the numeral does not decline in other
     oblique contexts (documented limit). Separators: space=thousands,
     `,`=decimal.
- **French** — *soixante-dix / quatre-vingts / quatre-vingt-dix*; *vingt*/*cent*
  pluralisation common-case rule (edge documented). Separators: space=thousands,
  `,`=decimal.
- **German** — unit-before-ten compounding (*einundzwanzig*), long-form
  concatenation; *eins*→*ein* before a scale word. Separators: `.`=thousands,
  `,`=decimal.

`fr`/`de` ship **fully populated and unit-tested** but stay dormant behind the
`isSupportedLanguage` self-gate — `expandForSpeech` returns the input unchanged
for them until their fs-50 gate flips `supported:true`, at which point
normalisation is already live. No follow-up wiring.

## Testing

Satisfies the acceptance "regression test over a normalisation fixture set."

- **Per-language fixture files** `normalize/__fixtures__/{en,es,ru,fr,de}.txt` —
  `input ⇒ expected` pairs, table-driven. Every heuristic contributes a success
  line **and** its documented known-failure line: year gamble + `Room 1999`
  type FPs, `St.` left-alone + `No.`-vs-negation, RU mis-gender edges, the RU
  **year-preposition closed set** (`в…году` prepositional, `с…года` genitive,
  `к…году` dative) **and** a sibling left nominative, conservative numeric
  dates, ES `y`-placement, **decades** (`1990s`→nineteen nineties; `'90s`
  left-alone), and **separator** cases per language: inversion (de `3,14`,
  `1.200,50`), and the 3-digit-group guard (de `1.5` must NOT become `15`).
- **Unit tests per engine** — `cardinal`/`ordinal`/`year`/`decade` edge numbers
  per language: 0, 21, 100, 101, 999, 1000, 1_000_000, the range cap, RU
  years-as-ordinals + all three preposition cases, ES 16–29 contractions +
  `y`-placement, FR 70/80/90, DE unit-before-ten, and separator-group parsing
  (`1.5` vs `1.500` per locale).
- **ASR-QA alignment tests** — (a) a regression test asserting the QA
  `expectedText` equals the synth-input text for the same group; (b) a WER
  fixture line over a normalised-number sentence (en + es) proving
  `expandForSpeech` + `normalizeForWer` compose without a false `drift`.
- **Regression guard** — `normaliseForTts(text)` with **no** `langCode` is
  byte-identical to today's output across a sample corpus, locking the
  zero-regression promise for the existing transforms.
- **Activation-gate test** — `expandForSpeech` with a `supported:false` langCode
  (fr/de today) returns input unchanged; flipping the flag activates it.
- Pure text-level; no golden-audio tier needed.

> **Non-ASCII fixture caution:** the expected outputs are full of Cyrillic /
> accented Latin. Write any non-ASCII regex char-classes as `\u` escapes and
> verify fixtures at the byte level — Write/Edit can silently flatten curly
> quotes / glyphs into valid-but-wrong content. (See the project memory note on
> Unicode regex escapes.)

## Known limitations (documented, accepted for v1)

1. Year heuristic mis-reads non-year 4-digit frames in 1100–2099 (`Room 1999`).
2. `St.` left untouched outside the title-case-before-capital frame (model
   guesses Saint/Street).
3. Russian numeral declension only resolved for the **closed year-preposition
   set** (`в`/`во`, `с`/`до`/`от`/`после`, `к`) and for currency units; any
   other oblique numeral stays nominative.
4. Russian 1/2 gender heuristic mis-genders soft-sign and irregular nouns.
5. Spanish/French gender floor renders bare counts masculine before feminine
   nouns.
6. Numeric-only dates (`3/1/2026`) are not expanded as dates (M/D vs D/M).
7. Apostrophe-elided decades (`'90s`) left alone (ambiguous century); only the
   full `1990s` form is expanded.
8. Clock times (`3:30`), ratios (`2:1`), and numeric ranges (`10–20`,
   comma-softened upstream) read via the plain-number pass — acceptable but not
   idiomatic ("ten, twenty" not "ten to twenty"). Not specially handled.
9. ICL reference-clip text (`voice-mapping.ts`) stays language-neutral; a
   reference sentence containing numbers has a minor text/audio convention
   mismatch (low impact — it's a clone reference, not shipped narration).
10. Currency ISO codes (`USD`/`EUR`) not handled (symbols only); the all-caps
    fold pre-alters them regardless.

## Before-shipping

- New regression plan `docs/features/<next>-fs53-text-normalisation.md` from
  `TEMPLATE.md` (status `draft` → `active` on implementation); the next free
  number is ~230 (current ceiling 229 — re-scan in-flight worktree branches at
  implementation time).
- `docs/features/INDEX.md` entry under its area.
- `Closes #976` in the PR body. Note the intentional drop of the "frontend"
  half of the Full-stack label.
- Full `npm run verify` (typecheck + all tests + e2e + build).

## Key files

- `server/src/tts/text-normalize.ts` — `normaliseForTts` gains optional
  `langCode`; calls `expandForSpeech` when present.
- `server/src/tts/normalize/**` — new module (engine + per-language data +
  separators + fixtures), per the layout above.
- `server/src/tts/synthesise-chapter.ts` — resolve `langCode` once; thread it
  into every audio-producing `normaliseForTts` call, the batch-length key, AND
  the two ASR-QA `verify(...)` expected-text args.
- `server/src/tts/segment-asr-qa.ts` — no signature change required (it already
  takes `expectedText`); the fix is at the call site. Add the
  compose-without-double-count fixture line.
- `server/src/tts/language.ts` / `language-registry.ts` — unchanged as the
  support/identity source of truth; `expandForSpeech` reuses
  `isSupportedLanguage`. Normalize data lives alongside, not inside.
