---
status: draft
issue: 1084
---

# srv: ASR content-QA non-English normalization (#1084)

## Problem

The per-sentence ASR content-QA gate (`server/src/tts/segment-asr-qa.ts`, srv-31 /
plan 186) was silently inert on non-English books until commit `3a56bf74`
(2026-06-15) made `normalizeForWer` script-aware (`\p{L}\p{N}` instead of
`[a-z0-9]`). Since that fix the gate is **active on every language**, but its
normalization helpers and thresholds were only ever built/tuned for English:

- `maxWer: 0.4` is an English-tuned cap.
- `CONTRACTIONS` (English-only expansions), `spellInteger` (English-only
  integer→word spelling), and possessive `'s` stripping have no non-English
  equivalents, so non-English numbers and constructs can read as errors they
  aren't.
- Plan 186 flagged this as owed: *"Non-English WER tuning — the language hint
  is threaded (bookLanguage → base subtag); Russian/etc. accuracy is owed
  validation."*

A prior round (alongside `3a56bf74`) landed a **scaffold**: `qa.asr.maxWer.es` /
`qa.asr.maxWer.ru` per-language override knobs (`registry.ts`), a
`perLanguageMaxWer()` resolver, and English-gating on contraction-expansion /
integer-spelling in `normalizeForWer()` — all defaulting to the global `0.4`
until actually tuned.

## Scope

This spec covers the **deterministic engineering half** of #1084's acceptance
criteria only:

- Non-English equivalents for integer-spelling and contraction-expansion,
  covering all four non-English supported languages (`es`, `fr`, `de`, `ru` —
  the full `language-registry.ts` supported set alongside `en`).
- A fixture-based regression-test suite locking this behavior, mirroring the
  existing English/Russian cases in `segment-asr-qa.test.ts`.
- Explicit documentation of the global-vs-per-language `maxWer` architecture
  decision.
- `qa.asr.maxWer.fr` / `qa.asr.maxWer.de` knobs, completing the scaffold to all
  four languages.

**Explicitly out of scope**: on-box calibration — actually rendering audio in
es/fr/de/ru, transcribing it, and picking real `maxWer` values from the WER
distribution. Per-language demo books (fs-61, Coalfall) aren't voice-designed
or rendered yet, so there's no real non-English audio to calibrate against
right now. All new per-language `maxWer` knobs ship at the current global
default (`0.4`) — unvalidated, same footing as the existing `.es`/`.ru`
scaffold. Calibration is tracked as a follow-up, filed at PR time, with #1084
left open (`Refs #1084`, not `Closes`) to represent that remainder.

Per explicit user direction: don't gate shipping on proving these tables
correct against real audio first — ship best-effort per-language normalization
now, using English's existing approach as the template, and let beta users'
real usage (over- or under-flagging reports) drive any correction. This is why
integer-spelling and contraction tables are built out fully now rather than
left as no-ops pending calibration.

## Data model

`LanguageEntry` (`server/src/tts/language-registry.ts`) — the codebase's
existing single-source-of-truth pattern for per-language data (it already
holds `headingLexicon.numberWords` for es/fr/de/ru, used for chapter-heading
detection) — gains two new optional fields:

```ts
/** ASR-QA word-error normalization data (#1084). Absent on en (English stays
    inline in segment-asr-qa.ts's existing ONES/TENS/CONTRACTIONS — unchanged). */
werIntegers?: (n: number) => string[] | null;   // 0..99 → token array; null = leave digit as-is
werContractions?: Record<string, string>;        // contracted form → expanded form (word-boundary match)
```

`werIntegers` returns a **token array**, not a string. This sidesteps the
hyphen-vs-space-vs-fused orthography question entirely: French `dix-sept` (17)
→ `['dix', 'sept']`, German `einundzwanzig` (21) → `['einundzwanzig']` (one
token), Spanish `treinta y uno` (31) → `['treinta', 'y', 'uno']`. Above 99,
`werIntegers` returns `null` and the digit stays a digit — matching today's
no-op and matching English's existing `spellInteger`, which already declines
to spell 3+ digit numbers.

`segment-asr-qa.ts` changes: `normalizeForWer`'s integer-spelling and
contraction-expansion steps become "English inline (unchanged), else look up
`getLanguageEntry(language).werIntegers` / `.werContractions`" — no per-language
`if` chains added to that file; all linguistic data lives in the registry.

## Per-language composition rules

**Spanish (`es`)** — 0–19 literal irregular (`cero`…`diecinueve`); decades
`veinte/treinta/cuarenta/cincuenta/sesenta/setenta/ochenta/noventa`. 21–29 fuse
into one token (`veintiuno`, `veintidós`, `veintitrés`, `veintiséis` — accented
forms, not naive concatenation). 31–99 (non-decade) are three tokens:
`[decade, 'y', ones]` (31 → `['treinta','y','uno']`).

**French (`fr`)** — 0–16 literal irregular (`zéro`…`seize`); 17–19 are two
tokens (`dix-sept` → `['dix','sept']`). Decades: `vingt(20)/trente(30)/
quarante(40)/cinquante(50)/soixante(60)`, then base-20 counting: 70 =
`['soixante','dix']`, 80 = `['quatre','vingts']`, 90 =
`['quatre','vingt','dix']`. Within-decade composition: X1 uses `et` for the
20s–60s (21 → `['vingt','et','un']`) but **not** for the 70s/80s/90s or for
81/91 (81 → `['quatre','vingt','un']`); X2–X9 just append (22 →
`['vingt','deux']`). Implemented as an explicit rule table with breakpoints at
70/80, not a generic formula — this is the most irregular of the four and
worth getting right by enumeration rather than clever composition.

**German (`de`)** — 0–12 literal irregular (`null`…`zwölf`); 13–19 single-token
`-zehn` suffix (`dreizehn`). Decades `zwanzig/dreißig/vierzig/fünfzig/sechzig/
siebzig/achtzig/neunzig`. 21–99 (non-decade) fuse into **one token**, reversed
order, joined with `und` (`einundzwanzig` = `ein`+`und`+`zwanzig`, note
`eins→ein`).

**Russian (`ru`)** — 0–19 literal (`ноль`…`девятнадцать`); decades
`двадцать/тридцать/сорок/пятьдесят/шестьдесят/семьдесят/восемьдесят/
девяносто`. Composition is decade + ones as two separate tokens, no
conjunction (21 → `['двадцать','один']`) — same shape as English's
`spellInteger`, Cyrillic vocabulary.

**German contractions** (`werContractions`): a flat table — `im→in dem`,
`zum→zu dem`, `beim→bei dem`, `am→an dem`, `ins→in das`, `ans→an das`,
`vom→von dem`. Applied via word-boundary regex replacement before
tokenization, same mechanical shape as English's existing `CONTRACTIONS`
expansion, gated on `de` instead of `en`/unset.

**Spanish/French/Russian contractions**: no `werContractions` entry.
Spanish (`del`, `al`) and French (elisions: `l'`, `qu'`, `d'`, etc.) mandatory
contractions have no manuscript/Whisper variance to reconcile — they're always
written contracted, so there's nothing to expand. French elisions are already
handled generically today: `normalizeForWer` strips apostrophes for every
language unconditionally (not English-gated), so `qu'il` already normalizes
consistently on both the manuscript and transcript side. Russian has no
equivalent construct. This is a deliberate no-op, pinned by regression tests
(see below) rather than left as an unstated gap.

**Possessive `'s` stripping**: already language-agnostic (the strip runs
unconditionally, not gated on `english`) — harmless no-op for non-English text
where this English-only genitive construct essentially never appears. No
change needed; documented as-is.

## Fixture-test plan

New `describe` blocks in `server/src/tts/segment-asr-qa.test.ts`, mirroring
the existing English/Russian structure:

- `normalizeForWer` per-language integer cases — one test per language hitting
  the tricky boundaries: a teen, a fused-decade number, and the language's
  irregular breakpoint (Spanish 21 vs. 31; French 70/80/90; German 21; Russian
  21).
- Explicit **no-op proof tests** for Spanish/French/Russian contractions — "a
  mandatory contraction in the manuscript normalizes identically whether or
  not `werContractions` exists for this language" — so the "no table needed"
  decision is pinned by a test, not just a comment.
- German contraction-expansion tests (`im` ↔ `in dem` reconciles to the same
  token stream).
- `classifyTranscript`-level faithful-transcript→`ok` and
  wrong-words→`drift` tests for es/fr/de (mirroring the existing Cyrillic pair
  at `segment-asr-qa.test.ts:135`/`:144` — ru is already covered).
- A `resolveAsrThresholds` test confirming the new fr/de per-language `maxWer`
  knobs plumb through identically to the existing es/ru ones.

## Registry additions

`qa.asr.maxWer.fr` / `qa.asr.maxWer.de` (env `SEG_ASR_MAX_WER_FR` /
`SEG_ASR_MAX_WER_DE`) — byte-identical pattern to the existing `.es`/`.ru`
entries in `registry.ts`: default `0.4`, help text noting the value is
unvalidated until on-box calibration.

## Architecture decision: global vs. per-language `maxWer`

**Decision**: per-language override wins when an operator has explicitly set
it (env var or app override); otherwise the global `qa.asr.maxWer` applies.
This is what the existing `.es`/`.ru` scaffold already implements
(`perLanguageMaxWer()` in `segment-asr-qa.ts` returns `undefined` — falling
through to global — unless `resolveKnob(knob).source !== 'default'`). This
spec makes that architecture the **documented, deliberate** answer to
acceptance criterion 4, rather than an implicit side-effect of how the
scaffold happened to be built.

**Why not a single global knob**: languages differ in tokenization, casing,
morphology, and transliteration variance, so a single English-tuned cap is not
expected to be the right precision/recall point everywhere (this is the
premise of the whole issue). Per-language override-with-fallback gets the
override capability without forcing every language to be configured before any
of them can differ from the shipped default.

## Follow-up (explicitly out of scope here)

File a new issue at PR time: on-box calibration of `maxWer` (and the other
`AsrThresholds`) per language against real renders, starting with the
languages closest to having real audio available (es/ru demo books once
voice-designed and rendered), then fr/de. Comment on #1084 clarifying what
shipped in this round (normalization + fixtures) vs. what remains (the
calibration pass), and link the new follow-up issue. The implementing PR uses
`Refs #1084`, not `Closes #1084`.
