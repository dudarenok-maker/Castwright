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
left open (`Refs #1084`, not `Closes`) to represent that remainder. The
follow-up also inherits two specific open questions this spec deliberately
defers rather than guesses at blind (see "Known residual risks" below):
gendered-number mismatch rates, and whether Whisper actually emits German
compound numbers as a single token.

Per explicit user direction: don't gate shipping on proving these tables
correct against real audio first — ship best-effort per-language normalization
now, using English's existing approach as the template, and let beta users'
real usage (over- or under-flagging reports) drive any correction. This is why
integer-spelling and contraction tables are built out fully now rather than
left as no-ops pending calibration. This posture is only safe because of two
facts that bound its blast radius, both stated explicitly rather than left
implicit: (1) the gate is **off unless `SEG_ASR_ENABLED`** (`asrEnabled()`,
segment-asr-qa.ts:140) — only operators who've opted in are exposed; (2) a
false `drift` verdict is not merely a cosmetic report — it burns real
`resolveAsrRerecords` budget (default 2 re-record attempts) and, if still
wrong after budget exhausts, ships a best-of-N take that may be worse than the
original. "Ship now, correct via beta feedback" is accepted specifically
because (1) limits exposure and the tables below are linguistically verified
(not guessed) wherever verification was possible without real audio.

## Data model

A **new, dedicated module** — `server/src/tts/asr-language-normalization.ts`
— holds the per-language WER-normalization data as literal data structures,
imported by `segment-asr-qa.ts`. This does **not** live on `language-registry.ts`'s
`LanguageEntry`: that interface's existing fields (including
`headingLexicon.numberWords`) are all declarative data serving heading/
front-matter parsing, a file whose own header comment describes it as "the
single source of truth for per-language **data**" for that purpose. ASR-QA
normalization is a distinct concern with its own consumer; keeping it in a
dedicated file avoids coupling two unrelated parsing/QA concerns into one
interface and avoids forcing a closure (imperative logic) onto an
otherwise-data-only registry.

```ts
// server/src/tts/asr-language-normalization.ts

/** Index = the integer (0..99). null = no spelling for this language/number;
    leave the digit as-is (mirrors segment-asr-qa.ts's English spellInteger,
    which also declines 3+ digit numbers). Multi-word numbers are pre-split
    into their token array — never a single string with embedded spaces/
    hyphens — so callers never re-tokenize. */
export const WER_INTEGERS: Readonly<Record<string, ReadonlyArray<readonly string[] | null>>> = {
  es: [ /* 0..99, see composition rules below */ ],
  fr: [ /* 0..99 */ ],
  de: [ /* 0..99 */ ],
  ru: [ /* 0..99 */ ],
};

/** Contracted form -> expanded form, word-boundary matched. Only `de` has an
    entry (see rationale below); es/fr/ru intentionally absent. */
export const WER_CONTRACTIONS: Readonly<Record<string, Record<string, string>>> = {
  de: { im: 'in dem', zum: 'zu dem', beim: 'bei dem', am: 'an dem',
        ins: 'in das', ans: 'an das', vom: 'von dem' },
};
```

`segment-asr-qa.ts`'s `normalizeForWer` looks up `WER_INTEGERS[lang]?.[n]` /
`WER_CONTRACTIONS[lang]` instead of the current `if (english)` branch —
English itself is unaffected (its `ONES`/`TENS`/`CONTRACTIONS` stay inline,
unchanged) since `WER_INTEGERS`/`WER_CONTRACTIONS` only need entries for the
four non-English languages.

## Per-language composition rules

**Spanish (`es`)** — 0–19 literal irregular (`cero`…`diecinueve`); decades
`veinte/treinta/cuarenta/cincuenta/sesenta/setenta/ochenta/noventa`. 21–29 fuse
into one token (`veintiuno`, `veintidós`, `veintitrés`, `veintiséis` —
accented forms, not naive concatenation). 30–99 (non-decade) are regular
three-token compounds: `[decade, 'y', ones]` for every decade 30 through 90
(31 → `['treinta','y','uno']`, 71 → `['setenta','y','uno']`, 95 →
`['noventa','y','cinco']` — Spanish, unlike French, has no irregularity past
29).

**French (`fr`)** — 0–16 literal irregular (`zéro`…`seize`); 17–19 are two
tokens (`dix-sept` → `['dix','sept']`). Decades `vingt(20)/trente(30)/
quarante(40)/cinquante(50)/soixante(60)`, each composing regularly through 69:
X1 uses `et` (21 → `['vingt','et','un']`, 61 → `['soixante','et','un']`), X2–X9
just append (22 → `['vingt','deux']`). **70–99 switch to base-20 counting and
do NOT follow the decade+ones pattern**:
- 70 = `['soixante','dix']`; **71 = `['soixante','et','onze']`** (still takes
  `et`, unlike 81/91); 72–79 = *soixante* + the teen word 12–19 (72 →
  `['soixante','douze']`, 77 → `['soixante','dix','sept']`, 79 →
  `['soixante','dix','neuf']`).
- 80 = `['quatre','vingts']` (with the plural -s only at the bare decade); 81
  = `['quatre','vingt','un']` (**no** `et`, and `vingt` drops its -s before
  another number); 82–89 = `quatre-vingt-` + ones (82 →
  `['quatre','vingt','deux']`).
- 90 = `['quatre','vingt','dix']`; 91 = `['quatre','vingt','onze']` (no `et`);
  92–99 = `quatre-vingt-` + the teen word (92 → `['quatre','vingt','douze']`,
  97 → `['quatre','vingt','dix','sept']`, 99 →
  `['quatre','vingt','dix','neuf']`).

This is standard (France) French; Belgian/Swiss regular forms
(septante/octante/nonante for 70/80/90) are an explicit non-goal for this
pass. Every value 0–99 is enumerated literally in `WER_INTEGERS.fr` rather
than derived by a generic formula — French's irregularity is exactly the kind
of thing that must be checked by enumeration, not composed cleverly.

**German (`de`)** — 0–12 literal irregular (`null`…`zwölf`); 13–15 and 18–19
regular `-zehn` suffix (`dreizehn`, `vierzehn`, `fünfzehn`, `achtzehn`,
`neunzehn`); **16 and 17 drop letters from the ones-root** (`sechzehn`, not
`sechszehn`; `siebzehn`, not `siebenzehn` — matching the same root truncation
the decades already show at `sechzig`/`siebzig`). Decades
`zwanzig/dreißig/vierzig/fünfzig/sechzig/siebzig/achtzig/neunzig`. 21–99
(non-decade) fuse into **one token**, reversed order, joined with `und`
(`einundzwanzig` = `ein`+`und`+`zwanzig`, note `eins→ein`).

**Russian (`ru`)** — 0–19 literal (`ноль`…`девятнадцать`); decades
`двадцать/тридцать/сорок/пятьдесят/шестьдесят/семьдесят/восемьдесят/
девяносто`. Composition is decade + ones as two separate tokens, no
conjunction (21 → `['двадцать','один']`).

**German contractions** (`WER_CONTRACTIONS.de`): a flat table — `im→in dem`,
`zum→zu dem`, `beim→bei dem`, `am→an dem`, `ins→in das`, `ans→an das`,
`vom→von dem`. Applied via word-boundary regex replacement before
tokenization, same mechanical shape as English's existing `CONTRACTIONS`
expansion, gated on `de` instead of `en`/unset.

**Spanish/French/Russian contractions**: no `WER_CONTRACTIONS` entry.
Spanish (`del`, `al`) and French (elisions: `l'`, `qu'`, `d'`, etc.) mandatory
contractions have no manuscript/Whisper variance to reconcile — they're always
written contracted in standard orthography, so there's nothing to expand.
French elisions are already handled generically today: `normalizeForWer`
strips apostrophes for every language unconditionally (not English-gated), so
`qu'il` already normalizes consistently on both the manuscript and transcript
side. Russian has no equivalent construct. This is a deliberate no-op, pinned
by regression tests (see below) rather than left as an unstated gap.

**Possessive `'s` stripping**: already language-agnostic (the strip runs
unconditionally, not gated on `english`) — harmless no-op for non-English text
where this English-only genitive construct essentially never appears. No
change needed; documented as-is.

## Known residual risks (deliberately deferred, not fixed here)

**Gendered numbers.** Spanish 1 (*uno/un/una*), French 1 (*un/une*), and
Russian 1 (*один/одна/одно*) / 2 (*два/две*) grammatically agree with the noun
they modify; a bare manuscript digit carries no gender information, so
`WER_INTEGERS` can only emit one canonical spelling. **Decision: emit the
masculine/default form** (`uno`, `un`, `один`, `два`) — mirroring English's
already-ungendered simplicity — and accept that a feminine-context reading
will substitution-mismatch against it. Two things bound the practical impact
rather than leaving it fully unmitigated: (a) `classifyTranscript`'s existing
short-reference backstop (`minRefWords`) already routes a lone substitution on
a short reference to `inconclusive` rather than `drift`, which is exactly the
shape of this mismatch on a short sentence; (b) on a longer sentence, one
token mismatch rarely moves WER past the 0.4 cap alone. The residual risk —
how often this actually bites in practice — is explicitly added to the
calibration follow-up's validation list, rather than solved here by a more
invasive fix (e.g. an allow-set of gendered alternates at match time, which
would need real audio evidence to justify the added complexity). Spanish
apocope (*veintiún* before a masculine noun, vs. the emitted *veintiuno*) is
the same family of gap and gets the same treatment.

**German single-token assumption.** Representing German compound numbers as
one fused `WER_INTEGERS` token (`einundzwanzig`) assumes Whisper's German
output actually tokenizes compound numbers this way — plausible, since
standard German orthography writes them as one word, but **unverified**
(no real German audio exists yet to check against). Also added to the
calibration follow-up's validation list.

## Fixture-test plan

New `describe` blocks in `server/src/tts/segment-asr-qa.test.ts`, mirroring
the existing English/Russian structure:

- `normalizeForWer` per-language integer cases — one test per language hitting
  the tricky boundaries: a teen, a fused-decade number, and the language's
  irregular breakpoint (Spanish 31 and 71 — regular past 29; French 71/77/81/
  91/97 — the base-20 switch and the et/no-et split; German 16/17/21 — the
  root-truncated teens and the fused compound; Russian 21).
- Explicit **no-op proof tests** for Spanish/French/Russian contractions — "a
  mandatory contraction in the manuscript normalizes identically whether or
  not `WER_CONTRACTIONS` has an entry for this language" — so the "no table
  needed" decision is pinned by a test, not just a comment.
- German contraction-expansion tests (`im` ↔ `in dem` reconciles to the same
  token stream).
- `classifyTranscript`-level faithful-transcript→`ok` and
  wrong-words→`drift` tests for es/fr/de (mirroring the existing Cyrillic pair
  at `segment-asr-qa.test.ts:135`/`:144` — ru is already covered).
- A `resolveAsrThresholds` test confirming the new fr/de per-language `maxWer`
  knobs plumb through identically to the existing es/ru ones.
- A dedicated French 70–99 test block, since that's the range most likely to
  be coded wrong from prose alone — assert the full enumerated set of
  tricky values (71, 77, 81, 91, 97) against their exact token arrays.

## Registry additions

`qa.asr.maxWer.fr` / `qa.asr.maxWer.de` (env `SEG_ASR_MAX_WER_FR` /
`SEG_ASR_MAX_WER_DE`) — byte-identical pattern to the existing `.es`/`.ru`
entries in `registry.ts`: default `0.4`, help text noting the value is
unvalidated until on-box calibration. (This part of `registry.ts` is unrelated
to the `LanguageEntry` layering discussion above — config-knob registration,
not per-language linguistic data.)

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
voice-designed and rendered), then fr/de. In addition to the general
threshold-tuning acceptance criteria, this follow-up explicitly validates the
two residual risks named above: the real-world mismatch rate from gendered
number spellings, and whether Whisper's German output actually matches the
single-fused-token assumption. Comment on #1084 clarifying what shipped in
this round (normalization + fixtures) vs. what remains (the calibration
pass), and link the new follow-up issue. The implementing PR uses
`Refs #1084`, not `Closes #1084`.
