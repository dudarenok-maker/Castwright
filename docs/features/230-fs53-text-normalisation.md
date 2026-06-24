---
status: active
shipped: null
owner: null
backlog-id: fs-53
area: fs
issue: 976
---

# fs-53 — Spoken-form text normalisation at the TTS boundary

> Status: active
> Key files: `server/src/tts/normalize/**` (engine + per-language data + classifiers + fixtures), `server/src/tts/text-normalize.ts` (`normaliseForTts` gains optional `langCode`), `server/src/tts/synthesise-chapter.ts` (resolves `langCode` once; threads it into every audio-producing `normaliseForTts` call + the batch-length key + both ASR-QA expected-text args), `server/src/tts/segment-asr-qa.ts` (call site fed the spoken form)
> URL surface: none (server-side, generation pipeline)
> OpenAPI ops: none (additive optional `langCode` arg, no schema change)

## Benefit / Rationale

- **User:** chapter audio speaks `$1,200` as "one thousand two hundred dollars", `1999` as "nineteen ninety-nine", `50%` as "fifty percent", `Dr.` as "Doctor" — instead of the TTS engine guessing or reading raw glyphs. Per-language: a Russian book speaks `1999` declined correctly in `в 1999 году`; a Spanish/German book uses the locale's decimal/thousands separators.
- **Technical:** number/currency/date/abbreviation expansion is centralised at the single TTS boundary (`normaliseForTts`), so the original `sentence.text` is never mutated. The ASR-QA gate is fed the **same** spoken-form string the audio was synthesised from, so expanded numbers can't trip a false-positive `drift`.
- **Architectural:** a per-language engine registry (`normalize/lang/*.ts`) self-gates on `isSupportedLanguage` + a registered engine, mirroring the language-support source of truth in `language-registry.ts`. New languages (fr/de) drop in dormant and activate by flipping their `supported` flag — no call-site change.

## Architectural impact

- **New seams / extension points:** `server/src/tts/normalize/` — `expandForSpeech(text, langCode)` (the gate), `applyPasses` (the pure pass pipeline), per-language engines in `lang/{en,es,ru,fr,de}.ts`, shared `classifiers.ts` (`parseLocaleNumber`, `speakNumber`) + `number-to-words.ts`. `normaliseForTts` gains an **optional** `langCode` arg that runs `expandForSpeech` LAST.
- **Invariants preserved:** the TTS-boundary-only rule (plan 70d / 28 — original `sentence.text` is read-only; expansion happens only inside `normaliseForTts`); the no-langCode call is byte-identical to pre-fs-53 output (English books unchanged).
- **Migration story:** none — additive optional arg, no stored shape changes.
- **Reversibility:** drop the `langCode` arg at the call sites and English/all behaviour reverts to pre-fs-53 byte-for-byte; fr/de stay dormant regardless of code presence until their `supported` flag flips.

## Invariants to preserve

1. **TTS-boundary-only** — the original `sentence.text` is never mutated; spoken-form expansion happens exclusively inside `normaliseForTts` at synth time (`server/src/tts/text-normalize.ts`). The analyzer, store, and persisted `state.json` keep the verbatim text.
2. **No-langCode byte-identity** — `normaliseForTts(text)` with NO `langCode` is byte-identical to pre-fs-53 output. Locked by `server/src/tts/text-normalize.test.ts:205` ("no langCode => byte-identical to today").
3. **ASR-QA fed the spoken form** — the per-sentence ASR-QA gate is fed `normaliseForTts(text, langCode)` — the *same* expanded string the audio was synthesised from — so expanded numbers don't cause a false-positive `drift`. Locked by the call site in `server/src/tts/synthesise-chapter.ts` and `synthesise-chapter-asr.test.ts`.
4. **Per-language separators** — decimal/thousands separators are per-language: en `,`/`.`; de/es `.`/`,`; fr/ru space/`,`. Enforced by `parseLocaleNumber` (`server/src/tts/normalize/classifiers.ts`).
5. **3-digit-group guard** — a non-3-digit group after the thousands separator is NOT treated as thousands: de `1.5` stays 1.5 (not 1500). Locked by `index.test.ts` ("de 1.5 is NOT thousands -> 1.5").
6. **Self-gating activation** — `expandForSpeech` no-ops unless the language passes `isSupportedLanguage` AND has a registered engine. fr/de are registered but `supported:false`, so they no-op end-to-end (`index.test.ts` dormancy + activation gate); an unknown language (`xx`) no-ops; a supported language with an engine (`en`) expands.

## Pass pipeline

`applyPasses` runs ordered passes over the text:

currency → dates → percent/symbols → abbreviations → ordinals → decades → years → numbers

**Ordering note:** abbreviations run **before** the digit-consuming passes (ordinals / decades / years / numbers) so the `No. <digit>` guard works — `No. 5` must expand the abbreviation before the bare digit is consumed by the number pass. This was a deliberate ordering fix made during implementation.

## Per-language coverage

| Lang | `supported` | Engine | Decimal / thousands | Notes |
|---|---|---|---|---|
| en | true | yes | `.` / `,` | currency, percent, abbreviations, ordinals, decades, years, numbers |
| es | true | yes | `,` / `.` | as en; gender floor masculine before feminine nouns |
| ru | true | yes | `,` / space | **raised floor** — see below |
| fr | **false** (dormant) | yes | `,` / space | engine works (exercised via `applyPasses`); gated off end-to-end until `supported` flips |
| de | **false** (dormant) | yes | `,` / `.` | engine works; gated off end-to-end until `supported` flips |

### Russian raised floor

- **Years as ordinals** with the closed preposition set — `в`/`во`, `с`/`до`/`от`/`после`, `к` — declined into the correct oblique case (e.g. `в 1999 году` → ordinal genitive).
- **Genitive-month neuter-ordinal dates** — date day reads as a neuter ordinal in the genitive.
- **Currency agreement** — 1 / 2–4 / 5+ unit-noun agreement (рубль / рубля / рублей).
- **1/2 gender heuristic** — adjusts один/одна, два/две before the counted noun.

## Known limitations (documented, accepted for v1)

1. Year heuristic mis-reads non-year 4-digit frames in 1100–2099 (`Room 1999`).
2. `St.` left untouched outside the title-case-before-capital frame (model guesses Saint/Street).
3. Russian numeral declension only resolved for the **closed year-preposition set** (`в`/`во`, `с`/`до`/`от`/`после`, `к`) and for currency units; any other oblique numeral stays nominative.
4. Russian 1/2 gender heuristic mis-genders soft-sign and irregular (paucal) nouns.
5. Spanish/French gender floor renders bare counts masculine before feminine nouns.
6. Numeric-only dates (`3/1/2026`) are not expanded as dates (M/D vs D/M ambiguity).
7. Apostrophe-elided decades (`'90s`) left alone (ambiguous century); only the full `1990s` form is expanded.
8. Clock times (`3:30`), ratios (`2:1`), and numeric ranges (`10–20`) read via the plain-number pass — acceptable but not idiomatic. Not specially handled.
9. Currency ISO codes (`USD`/`EUR`) not handled (symbols only); the all-caps fold pre-alters them regardless.
10. Signed/minus numbers: the sign is dropped (read as the bare magnitude).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/normalize/**/*.test.ts`) — the normalize module suite (~156 tests: 154 engine/classifier/fixture cases plus the 2 activation-gate assertions). Covers `parseLocaleNumber` (3-digit-group guard), `speakNumber` NaN guard, the fr/de dormancy no-op, and the activation gate (`xx` no-ops; `en` expands `$5` → "five dollars").
- Vitest server (`server/src/tts/normalize/fixtures.test.ts` + `server/src/tts/normalize/__fixtures__/{en,es,ru,fr,de}.txt`) — per-language golden input→spoken-form fixtures.
- Vitest server (`server/src/tts/text-normalize.test.ts:205`) — the **no-langCode byte-identical guard** (`normaliseForTts(text)` unchanged from pre-fs-53) plus the with-langCode expansion path.
- Vitest server (`server/src/tts/synthesise-chapter-asr.test.ts`) — the **ASR-QA alignment** test: the gate is fed the same `normaliseForTts(text, langCode)` spoken form the audio used, so expanded numbers don't raise a spurious `asrSuspect` / `drift`.

### Manual acceptance walkthrough

Real backend + sidecar (not mock mode — this is server-side synth).

1. Seed a Coalfall chapter (`server/src/__fixtures__/the-coalfall-commission.md`) with a line containing `$1,200`, `1999`, `50%`, and `Dr.`.
2. Run a full English render of that chapter through generation.
3. **Listen** — confirm the audio speaks: "one thousand two hundred dollars", "nineteen ninety-nine", "fifty percent", "Doctor".
4. **Confirm no spurious flag** — the Generate-row waveform shows **no** `asrSuspect` issue band on the seeded sentences (the ASR-QA gate compared the spoken transcript against the same expanded text, so the expansion is not seen as drift).

## Out of scope

- French / German activation — their engines ship dormant (`supported:false`); flipping them is the per-language operator-gate work tracked alongside the fs-50 Latin-Qwen tranche (plan 229).
- Frontend display of expanded text — fs-53 deliberately drops the "frontend half" of the original Full-stack label; the verbatim `sentence.text` stays on screen.
- Numeric-only date parsing, clock times, ratios, ranges, ISO currency codes — see Known limitations.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any behaviour delta vs. the original spec.)
