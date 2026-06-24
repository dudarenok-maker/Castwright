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
   symbol set to spoken form at the TTS boundary, **language-aware**.
2. Ship **working rules for all five registry languages** — `en`, `es`, `ru`
   (currently `supported:true`) plus `fr`, `de` **pre-populated** so they are
   live the moment their fs-50 gate flips `supported`.
3. Stay **always-on, invisible, and zero-regression** for the existing
   pipeline — no toggle, original text untouched, and the no-language call
   path byte-identical to today.
4. A **regression fixture set** per language, each heuristic carrying both a
   success and a documented known-failure line.

## Non-goals (v1 — YAGNI)

- Per-book or global toggle UI / setting. Normalisation is a baseline quality
  guarantee, not an option.
- Any "will be read as…" preview in the UI.
- General Russian numeral–noun **case agreement** for arbitrary nouns
  (declining the *noun* for 2–4 / 5+). Only known currency units get it.
- Numeric-date disambiguation (`3/1/2026` — M/D vs D/M). Textual-month dates
  only.
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
| Frontend work | None | Always-on / no toggle / invisible ⇒ server-only; the issue's "frontend" half of the Full-stack label is intentionally dropped |

## Architecture

### Integration point

`normaliseForTts(text)` gains an **optional** language argument:

```ts
normaliseForTts(text: string, langCode?: string): string
```

- **With `langCode`** — the synth path passes `bookLanguage`. After today's
  language-neutral transforms run, the new `expandForSpeech(text, langCode)`
  pass runs.
- **Without `langCode`** — the ~6 other call sites (empty-sentence filter,
  batch-length key, the ICL-reference picker in `voice-mapping.ts`) run **only**
  today's transforms. Output is byte-identical to current behaviour ⇒ **zero
  regression risk**, fully backward-compatible.

The synth-path length/filter sites (`synthesise-chapter.ts` lines ~682, ~1281)
get `bookLanguage` threaded so their length/empty keys stay consistent with
what is actually synthesised. `expandForSpeech` is a no-op when `langCode` is
absent, unknown to the registry, or maps to no language data.

### Module layout

A new directory keeps the sizable per-language data out of the lean
`text-normalize.ts`:

```
server/src/tts/normalize/
  index.ts            expandForSpeech(text, langCode) — composes the ordered passes
  classifiers.ts      shared regex span-finders (currency/percent/date/ordinal/year/number/symbol/abbrev)
  number-to-words.ts  dispatch to the per-language engine
  lang/en.ts          per-language data + cardinal()/ordinal()/year() + currency/abbrev/symbol/month tables
  lang/es.ts          Spanish: 16–29 contractions, quinientos/setecientos/novecientos, cien/ciento, gender default
  lang/ru.ts          Russian: years-as-ordinals, genitive-month dates, currency agreement, 1/2 gender heuristic
  lang/fr.ts          French: soixante-dix / quatre-vingts / quatre-vingt-dix, vingt/cent pluralisation floor
  lang/de.ts          German: unit-before-ten compounding, eins→ein before a scale word
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

1. **Currency** — `$1,200.50`, `€5`, `£3`, `₽100`. Symbol → per-language
   currency word; amount via `cardinal()`; cents split. → "one thousand two
   hundred dollars and fifty cents". Handles symbol-before-number (en/£/$) and
   number-before-symbol (`5 €`, common in es/fr/de).
2. **Dates** — textual-month forms confidently (`January 3, 2026` → "January
   third, twenty twenty-six"; per-language month tables + ordinal day + year
   reading). **Conservative on bare numeric dates** (`3/1/2026`) — M/D vs D/M is
   unresolvable without locale certainty, so left to the plain-number pass.
3. **Percent & symbols** — `50%` → "fifty percent"; curated **closed** symbol
   set → per-language words: `&`→and/y/и/et/und, `°`, `#`, `@`, `×`, and
   `+`/`-`/`=` in number-ish context. No guessing at arbitrary punctuation.
4. **Ordinals** — `3rd`, `21st`, es `1.º`/`1.ª`, fr `1er`/`2e` → per-language
   ordinal word.
5. **Years (the heuristic)** — bare 4-digit integer in ~**1100–2099**, no
   comma/decimal → year-style reading ("nineteen ninety-nine", "twenty
   twenty-six"). Outside the range, or comma-grouped/decimal → falls through to
   cardinal. The one documented gamble; right for the overwhelming majority of
   prose.
6. **Plain numbers** — comma-grouped (`1,200`) and bare integers → `cardinal()`;
   decimals (`3.14`) → "three point one four" (digit-by-digit after the point);
   a leading minus → "minus".
7. **Abbreviations** — a **curated, closed, per-language map** where one reading
   dominates: `Mr.`→Mister, `Mrs.`, `Ms.`, `Dr.`→Doctor, `Prof.`, `vs.`, `etc.`,
   `e.g.`/`i.e.`, `a.m.`/`p.m.`, `No.`→Number. `St.`→Saint **only when
   title-cased before a capitalised word**, else left alone (the documented 50/50
   escape). Anything not in the map is untouched.

Every heuristic (year range, `St.` rule, conservative numeric-date,
RU mis-gender) carries a comment anchored to its rationale — mirroring how
`text-normalize.ts` documents each transform against an observed failure mode —
and a matching fixture line including its **known-failure** case.

**Idempotency caveat.** Unlike the current transforms, this pass is **not**
strictly idempotent (a second run could re-touch output). The contract is
"apply exactly once at the boundary" — already how `normaliseForTts` is used.
Stated explicitly in the module header so no one composes it twice.

## Multi-language strategy & quality-floor morphology

Each `lang/<code>.ts` exports `cardinal(n)`, `ordinal(n)`, `year(n)` plus data
tables (currency words, month names, symbol words, abbreviation map). The
shared `classifiers.ts` does language-agnostic *detection*; rendering dispatches
to the language file. v1 range: **0 – 999,999,999**; out-of-range untouched.

- **English** — clean, full correctness. The reference implementation.
- **Spanish** — real irregulars (*dieciséis…veintinueve*, *quinientos /
  setecientos / novecientos*, *cien* vs *ciento*). **Gender floor:** default
  masculine (*un*, *doscientos*); currency uses the unit's known gender
  (*dólar*→masc, *libra*→fem). Documented limit: a bare count modifying a
  feminine noun renders masculine.
- **Russian — the raised floor** (the hardest, deliberately pushed past a bare
  masculine-cardinal default):
  1. **Years as ordinals** — `1999` → *тысяча девятьсот девяносто девя́тый*
     (final component inflects to ordinal, nominative). Deterministic.
  2. **Dates** — day as **neuter ordinal** + month in **genitive**
     (`3 января` → *третье января*); both from hardcoded tables (12 genitive
     months, neuter ordinals 1–31). Deterministic.
  3. **Currency 1 / 2–4 / 5+ agreement** — *рубль / рубля / рублей*,
     *доллар / доллара / долларов* (unit noun known).
  4. **1 and 2 gender heuristic** — infer the following bare noun's gender from
     its ending to pick *один/одна/одно* and *два/две*. Catches clear
     *-а/-я* feminine and consonant masculine; **will mis-gender** soft-sign
     nouns and irregulars like *папа* — each documented with a fixture.
  5. Cardinals otherwise nominative; the numeral does not decline in oblique
     contexts (documented limit).
- **French** — *soixante-dix / quatre-vingts / quatre-vingt-dix*; *vingt*/*cent*
  pluralisation common-case rule (edge documented).
- **German** — unit-before-ten compounding (*einundzwanzig*), long-form
  concatenation; *eins*→*ein* before a scale word.

`fr`/`de` ship **fully populated and unit-tested** but ride behind their
`supported:false` gate — they simply never receive a `langCode` from the synth
path until fs-50 flips them, at which point normalisation is already live. No
follow-up wiring.

## Testing

Satisfies the acceptance "regression test over a normalisation fixture set."

- **Per-language fixture files** `normalize/__fixtures__/{en,es,ru,fr,de}.txt` —
  `input ⇒ expected` pairs, table-driven. Every heuristic contributes a success
  line **and** its documented known-failure line (year gamble, `St.` left-alone,
  RU mis-gender edges, conservative numeric dates).
- **Unit tests per engine** — `cardinal`/`ordinal`/`year` edge numbers per
  language: 0, 21, 100, 101, 999, 1000, 1_000_000, the range cap, RU
  years-as-ordinals, ES 16–29 contractions, FR 70/80/90, DE unit-before-ten.
- **Regression guard** — `normaliseForTts(text)` with **no** `langCode` is
  byte-identical to today's output across a sample corpus, locking the
  zero-regression promise for the existing transforms.
- Pure text-level; no golden-audio tier needed.

> **Non-ASCII fixture caution:** the expected outputs are full of Cyrillic /
> accented Latin. Write any non-ASCII regex char-classes as `\u` escapes and
> verify fixtures at the byte level — Write/Edit can silently flatten curly
> quotes / glyphs into valid-but-wrong content. (See the project memory note on
> Unicode regex escapes.)

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
  fixtures), per the layout above.
- `server/src/tts/synthesise-chapter.ts` — thread `bookLanguage` into the synth
  `normaliseForTts` calls (incl. the length/filter keys).
- `server/src/tts/language-registry.ts` — unchanged as the support/identity
  source of truth (normalize data lives alongside, not inside).
