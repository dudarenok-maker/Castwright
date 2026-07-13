---
title: fs-59 — CJK (Chinese / Japanese) language support
status: draft
issue: 1004
supersedes-section: docs/superpowers/specs/2026-06-22-fs41-fs50-language-aware-ingest-and-breadth-design.md §11.1
date: 2026-07-13
---

# fs-59 — CJK (ZH / JA) language support: analysis + synthesis

## 0. One-paragraph summary

Extend the shipped fs-50 language framework (registry + server-side detection +
dual-gate rollout) to **Chinese (`zh`) and Japanese (`ja`)**, end-to-end. CJK is
the §11.1 follow-on that fs-50 deferred because CJK *analysis* is materially
harder than Latin: a spaceless script breaks every whitespace-word heuristic, and
the dialogue/quote/token/length primitives all assume Latin character density.
This spec reuses the fs-50 framework unchanged and adds only the CJK-specific
pieces. CJK renders on **both Qwen and Coqui XTTS** — uniquely among the wider
non-English roadmap, because Qwen (an Alibaba model) natively supports zh/ja, so
CJK is the one slice of fs-70's "XTTS languages beyond Qwen's five" that also has
a Qwen path. Both `supported` flags flip together, only after an on-box dual gate
(operator audio × both engines + attribution FP/FN from a new eval harness).

## 1. Context — what already exists (do not rebuild)

The fs-50 tranche (es/fr/de) **shipped** and left CJK a small delta on top of a
proven framework. Verified against the current tree:

- **Detection is done.** `server/src/tts/detect-language.ts` already runs an
  authoritative script pre-pass: Cyrillic→`ru`, then `(han + kana)/letters ≥ 0.3`
  → `{ language: kana > han ? 'ja' : 'zh', supported: false }` (front-matter
  stripped first, 20 k-char sample). The Han-vs-Kana disambiguation and the
  `detected-but-unsupported` return are already in place. **Adding registry rows
  flips detection to `supported` automatically — no detection code changes.**
- **Fail-loud block is in place.** `sidecarLanguageName()`
  (`server/src/tts/language.ts:34`) throws for any code not in the registry, so
  CJK cannot bake an English manifest today. This stays as the safety net.
- **The engine-eligibility model exists (fs-60, #1005).**
  `resolveEligibleEngines(bookLanguage, installedEngines)`
  (`language.ts:59`) is a pure filter over
  `ENGINE_LANGUAGE_SUPPORT` (`voice-mapping.ts:39`):
  `qwen: '*'`, `coqui: ['en','ru','es','fr','de']`, others `['en']`. Coqui
  already renders non-English (ru/es/fr/de) with per-request language threading,
  a Qwen→Coqui fallback branch (`applyQwenFallback`,
  `synthesise-chapter.ts:922`), mixed-engine serialization, cast banners, the
  `eligibleTtsEngines` API field, and a "Fallback (Coqui)" pill — **all shipped**.
- **The dialogue-structure subsystem replaced `isSpokenLine`.** Per-language
  `LanguageConventions` tables live in
  `server/src/analyzer/dialogue-structure/lang/{en,ru,es,fr,de}.ts`, registered in
  `lang/index.ts`, dispatched by `conventionsFor(language)`. CJK adds `zh.ts` +
  `ja.ts` here.
- **The per-engine cast data model already supports CJK.**
  `overrideTtsVoices?: Partial<Record<TtsEngine, { name }>>`
  (`voice-mapping.ts`) is per-engine and not language-gated — a Coqui voice slot
  for a zh/ja character is already representable.

**Divergence note:** the fs-50 *implementation* did not build the monolithic
`text{}` registry block the fs-50 spec §2 sketched. This spec targets the
**actual** shipped seams (below), not that idealized shape.

## 2. Decisions (locked with the requester)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Segmenter = `Intl.Segmenter`** (zero-dep, Node/ICU built-in) | Pays off twice: `granularity:'word'` gives real CJK word counts for the coverage guard; `granularity:'sentence'` gives native CJK sentence boundaries for the chunker. No new dependency (matches the "one dep = franc" Latin precedent). |
| D2 | **ZH + JA validated together**, one combined go/no-go; both `supported` flip in the same tail PR | Shared foundations land once; both languages exercise them; a single operator/labeler session covers both. |
| D3 | **Build the full §4.8 attribution eval harness**, as **Wave 1 / its own PR**, language-agnostic | The Latin tranche skipped it and flipped `supported` on operator-audio alone. It is infrastructure every future language needs; building it first, proven on an existing language, de-risks the CJK waves and retro-enables an es/fr/de gate. |
| D4 | **CJK renders on both Qwen and Coqui XTTS** | Qwen natively supports zh/ja; XTTS v2 natively supports `zh-cn`/`ja`; the sidecar has no language allowlist; fs-60's machinery is generic. Honors "it should also work for Coqui." |
| D5 | **fs-59 owns the CJK slice; fs-70 (#1303) keeps the rest** | CJK is uniquely dual-engine (Qwen + Coqui); fs-70's other languages (ko/ar/hi/…) are XTTS-only. Reconcile by reference on both issues; do not silently absorb. |

## 3. Architecture — the CJK seams (actual code)

Each item names the real file:symbol and the CJK gap. Grouped by the delivery
wave that owns it (§5).

### 3.1 Analysis foundations (Wave 2 — engine-independent)

- **Coverage guard** — `server/src/analyzer/stage2-coverage.ts`, `words()`
  (`~:88-97`, `.split(/\s+/)`). A spaceless CJK sentence collapses to one "word",
  so the attributed÷source coverage ratio is meaningless and
  `runStage2WithCoverageGuard()` (`~:236`) burns every retry (the "infinite
  retry" in the issue). **Fix:** when the book is CJK, count words via
  `Intl.Segmenter(lang, { granularity: 'word' })` filtered to `isWordLike`
  segments. The ratio stays self-consistent (both sides counted identically);
  `endingTailWords` becomes ending-tail *segments*. The letter-class Unicode
  work (`\p{L}\p{N}`) already done for Russian is preserved.
- **Sentence splitting** — `server/src/analyzer/stage2-chunk.ts`,
  `splitParagraphIntoSentences()` (`:122`, split on `/(?<=[.!?]["')\]]?)\s+/`).
  CJK has no whitespace and ends sentences with `。！？`. **Fix:** CJK path uses
  `Intl.Segmenter(lang, { granularity: 'sentence' })` (handles `。！？` + closing
  `」』` natively). The pre-emptive `splitBodyIntoChunks` paragraph split
  (`\n\n`) is script-independent and stays.
- **`isNarrativeLine`** — `server/src/analyzer/strip-front-matter.ts:32`.
  Two CJK gaps: (a) `line.length < 60` assumes Latin density — a CJK line reaches
  equivalent information at far fewer chars; (b) `/\p{Ll}/u` (lowercase test)
  never matches Han/Kana (no case), so a real CJK narrative line can never pass.
  **Fix:** a CJK branch with a lower char threshold and a Han/Kana +
  `。！？…` test replacing the lowercase check.
- **Token estimator** — `server/src/analyzer/gemini.ts`, `estimateInputTokens()`
  (`~:862-899`). Today interpolates between `LATIN_CHARS_PER_TOKEN = 4` and
  `CYRILLIC_CHARS_PER_TOKEN = 2.5` by measuring the Cyrillic fraction. **Fix:**
  add `HAN_KANA_CHARS_PER_TOKEN ≈ 1.2` and a CJK-fraction measurement mirroring
  `countCyrillic`; a CJK-dense prompt uses the ~1.2 divisor. (The flat
  `prompt.length/4` in `rate-limit.ts:209` is a secondary estimator — extend or
  leave, noted as low-risk.)
- **Registry rows** — `server/src/tts/language-registry.ts`. Add `zh` and `ja`
  entries, `supported: false`, `detect.script: 'cjk'` (a single new tag for both;
  the registry's `detect.script` only gates the *franc Latin* filter in
  detect-language.ts — any non-`latin` value excludes CJK from it — while the
  han-vs-kana `zh`/`ja` tiebreak stays the hardcoded script pre-pass, so one
  `'cjk'` value suffices for both rows); `sidecarName: 'Chinese' | 'Japanese'`;
  CJK `headingLexicon`
  (第一章 / 第1話 / 序章 / 終章 …) and `frontMatterKeywords` (目次 / 著作権 /
  献辞 · 目录 / 版权 / 致谢). Number-word lexicons are largely N/A for CJK
  (digits are used directly) — document, don't force.

### 3.2 Dialogue conventions + prompts (Wave 3 — engine-independent)

- **`LanguageConventions` for CJK** — new
  `server/src/analyzer/dialogue-structure/lang/zh.ts` + `ja.ts`, registered in
  `lang/index.ts`. Shape (per `types.ts`):
  - `quotePairs`: `ja` = `[['「','」'], ['『','』']]`; `zh` =
    `[['「','」'], ['『','』'], ['“','”']]` (Simplified Chinese commonly uses
    fullwidth `“”`; Traditional/JA use corner brackets — include both for `zh`).
  - `dialogueOpen`: `null` (CJK does not use dash-dialogue).
  - `speechVerbStems`: substring-matched (no inflection). `zh`: 说 / 道 / 问 /
    答 / 喊 / 叫 / 问道 / 说道 / 回答 / 喃喃 …; `ja`: 言 / 話 / 答 / 尋 / 叫 /
    呟 / 囁 / 続け … (kanji stems tolerate okurigana variation).
  - `beatVerbStems`: `zh` 点头 / 笑 / 皱眉 …; `ja` 頷 / 笑 / 頬 …
  - `nameStemmer`: identity (no case endings); `minStemLength`: 1 (CJK names run
    1–3 Han chars).
  - `pronouns`: `zh` 我 / 你 / 他 / 她; `ja` 私 / 僕 / 俺 / 彼 / 彼女 / あなた.
- **Audio-tag + roster quote sets** — add corner-bracket pairs to
  `server/src/parsers/audio-tags.ts` (`QUOTE_OPENS`/`QUOTE_CLOSES`, `~:22`) and to
  `roster-coverage.ts` `QUOTE_CHARS_WIDE` (`~:171`). The all-caps shout heuristic
  is inert on caseless CJK — leave as-is (no CJK shout signal in v1).
- **Prompt few-shot** — `server/src/analyzer/gemini.ts` `languagePreamble()`
  (`~:207-234`). Add CJK convention hints (「」quote marking, no dash-dialogue,
  name-order note) to the `conventions` string, and inject **in-language
  few-shot examples** (few-shot dominates small-model behaviour). This requires a
  new `promptExamples` field on `LanguageEntry` (roster + attribution snippets in
  ZH/JA) — the field the fs-50 spec named but never added. `sidecarName`
  ('Chinese'/'Japanese') already flows into the preamble `where` string.
- **tag-grammar: gate-OFF for CJK.** `server/src/analyzer/tag-grammar.ts`
  `TAG_GRAMMARS` — leave `zh`/`ja` unmapped so `grammarFor()` returns `null`
  (caller stays gated, a no-op). Rationale: its `nameCapture` is `[A-Z]` /
  `\p{Lu}` — CJK has no case, so the `<Name> <verb>` roster-false-positive guard
  is structurally inapplicable. Primary attribution comes from the
  dialogue-structure conventions + the Wave-1 eval harness; document the
  lost-net (same "gate-on vs gate-off + document" discipline fs-50 §4.3 used).

### 3.3 Synthesis (Wave 4 — both engines)

- **Qwen (4a).** `server/tts-sidecar/main.py`, `CALIBRATION_TEXTS` dict
  (`~:1888-1905`) has es/fr/de/ru but **no Chinese/Japanese** — a CJK designed
  voice silently falls back to the English pangram (wrong phoneme set). **Fix:**
  add phonetically-rich `Chinese` + `Japanese` calibration/ref-text rows keyed by
  sidecar language word. Qwen's synth path already ignores the request-level
  `language` and reads the manifest baked at `design_voice` time — so the ref-text
  is the load-bearing input. Thread CJK into `EMOTION_INSTRUCT`
  (`qwen-voice.ts`) + `fill-tone` NUDGES or explicitly document deferral.
- **Coqui XTTS (4b).** Net-new is small:
  1. Add `'zh','ja'` to `ENGINE_LANGUAGE_SUPPORT.coqui` (`voice-mapping.ts:41`).
  2. A `zh` → `zh-cn` language-code map at the Coqui synth call
     (`normaliseBookLanguage` collapses `zh-CN`→`zh`; XTTS wants `zh-cn`; `ja` is
     `ja`). A small per-engine `coquiLanguageCode()` helper; identity for all
     other languages.
  3. Confirm the existing `COQUI_PROFILE_VOICES` (engine-generic XTTS speakers)
     produce acceptable CJK output via XTTS cross-lingual voice cloning — no new
     catalog unless quality demands it; this is a validation item, not
     necessarily code.
  4. No new UI: fs-60's fallback / serialization / banner / pill / readiness-gate
     machinery is generic and already keys off `eligibleTtsEngines`.
  - The `cast.tsx:165` `!qwenOnly ⇒ Coqui-eligible` assumption **holds for CJK**
    (both engines eligible, so `!qwenOnly` is correctly true); the fragility it
    was flagged for bites only XTTS-only languages, which are fs-70's, not here.

### 3.4 Attribution eval harness (Wave 1 — language-agnostic)

No speaker→line labelling/eval exists today (the golden gate is audio-only).
Build, in its own PR, independent of CJK:

- **Schema** — a labelled sample `{ chapterText, lines: [{ text, speakerId }] }`.
- **Scorer** — aligns analyzer-output character ids to truth (handling
  alias-merge and id-stability across re-analysis) and emits attribution
  **FP / FN** (and precision/recall).
- **Proving fixture** — one labelled **English** Coalfall chapter + unit tests,
  so the harness is validated without a fluent CJK labeler.
- The §7 dual gate consumes this for every language going forward; ZH/JA labelled
  chapters are added in Wave 5.

## 4. Data / control flow (unchanged framework)

Import → `detectManuscriptLanguage` (already returns zh/ja) → registry lookup →
`languageSupported` on the import response → confirm screen (selector already
built from `supportedLanguages()`; once zh/ja flip, they appear) → analysis
(stage-1/2 with CJK conventions + preamble + segmenter-based guards) →
cast/design (Qwen manifest baked with CJK ref-text; Coqui slot per-engine) →
generation (`resolveEligibleEngines('zh'|'ja', …)` now returns `['qwen','coqui']`;
force-to-Qwen honours an eligible Coqui manual choice; Coqui call maps `zh`→
`zh-cn`) → export. The never-cross-language invariant
(`verify-designed-voice-language.ts`) and `sidecarLanguageName`-throw are reused
unchanged.

## 5. Delivery — 5 waves

W1 and W5 are their own PRs; W2–W4 are server/sidecar and land `supported:false`,
desk/synthetic-verifiable.

1. **Wave 1 — Attribution eval harness** (language-agnostic, own PR). §3.4.
   *Benefit (architectural): the supported-flip gate every future language needs.*
2. **Wave 2 — CJK analyze foundations** (server). §3.1. Synthetic ZH/JA fixtures.
   Registry rows land here (`supported:false`).
   *Benefit (technical): kills the coverage-guard infinite-retry; CJK chapters
   split + segment correctly.*
3. **Wave 3 — CJK conventions + prompts** (server). §3.2.
   *Benefit (user): CJK dialogue (「」) is recognised as spoken, not demoted to
   narrator; attribution is CJK-aware.*
4. **Wave 4 — CJK synthesis, both engines** (sidecar + server). §3.3.
   *Benefit (user): CJK voices render on Qwen and Coqui XTTS.*
5. **Wave 5 — Validation + flip** (operator tail, own PR).
   - ZH + JA Coalfall fixtures (**dep: fs-61 / fluent translator**).
   - Label a ZH + JA chapter → run the W1 harness → attribution FP/FN recorded
     (attribution is engine-independent — one pass covers both engines).
   - Operator **audio** gate: Qwen×{zh,ja} **and** Coqui×{zh,ja}.
   - On-box confirm Qwen honours a CJK persona and XTTS `zh-cn`/`ja` quality.
   - Flip `zh.supported` + `ja.supported` together (tiny PR).
   - **Reconcile fs-70 (#1303):** mark its zh-cn/ja bullets done-by-fs-59; narrow
     its charter to the remaining XTTS-only languages (ko/ar/hi/nl/pl/tr/cs/hu/
     it/pt). Note the reconciliation on #1004 and #1303.
   *Benefit (strategic): zh + ja reach `supported`, the two highest-population
   CJK languages.*

**Why gated:** W5 needs the GPU box, real Qwen/XTTS weights, the operator's ears,
AND a fluent-labelled ZH/JA sample — it cannot be desk-verified. W1–W4 are not
held hostage to that.

## 6. Testing

Per-wave, paired with the change (project rule: every PR improves automated
coverage):

- **W1:** scorer unit tests (FP/FN math, alias-merge, id-stability) against the
  labelled English fixture; a deliberately-wrong analyzer output asserts non-zero
  FP/FN.
- **W2:** synthetic ZH + JA fixtures — coverage-guard ratio in-band on healthy CJK
  text and the retry loop terminates (regression for the infinite-retry);
  `splitParagraphIntoSentences` splits a CJK paragraph on `。！？`;
  `isNarrativeLine` accepts a real CJK narrative line and rejects a short heading;
  `estimateInputTokens` uses ~1.2 for CJK-dense input; registry lookups for zh/ja.
- **W3:** `dialogue-structure` recognises 「」 dialogue as spoken and attributes a
  tagged CJK line to its speaker, not the narrator (the issue's core acceptance);
  audio-tag + roster quote-set coverage; `languagePreamble('zh'|'ja')` contains
  CJK hints + examples; `grammarFor('zh')` is `null` (gate-off asserted).
- **W4:** sidecar `CALIBRATION_TEXTS` has Chinese/Japanese rows (no English-pangram
  fallback for CJK); `resolveEligibleEngines('zh', ALL)` → `['qwen','coqui']`;
  the `zh`→`zh-cn` map round-trips; a Coqui zh synth call carries `language:'zh-cn'`.
- **W5:** on-box audio + attribution FP/FN recorded in Ship notes (manual gate);
  an e2e detect→confirm→cast path for a CJK book once `supported`.

Canonical fixture: ZH + JA translations of *The Coalfall Commission* (produced
under fs-61), mirroring the existing en/de/es/fr/ru samples.

## 7. Acceptance (from #1004, mapped to waves)

- [ ] ZH and JA each: detection routes correctly (already true; flips to
      `supported` on registry rows — W2) and a CJK book splits into chapters,
      segments into sentences, and **does not trip the coverage-guard infinite
      retry** (W2).
- [ ] CJK dialogue (「」) is recognised as spoken, not demoted to narrator (W3).
- [ ] Qwen **and** Coqui XTTS render ZH/JA at acceptable quality (operator audio
      gate, both engines) AND attribution is validated against a fluent-labelled
      sample with FP/FN recorded (W1 harness + W5 labelled chapters).
- [ ] `supported` flips per language only after the dual gate; both flip together;
      the never-cross-language invariant holds (W5).
- [ ] fs-70 (#1303) reconciled by reference (W5).

## 8. Scope boundaries

**In:** CJK analysis (benefits all engines), CJK synthesis on **Qwen + Coqui
XTTS**, the attribution eval harness, zh + ja → `supported`.

**Out:**
- **Kokoro-CJK** — Kokoro is English-only with no CJK G2P (misaki[ja,zh]); that is
  fs-69 (#1302) / §11.2, not here. CJK is Qwen+Coqui only in v1.
- **The other 10 XTTS languages** (ko/ar/hi/nl/pl/tr/cs/hu/it/pt) — fs-70 (#1303).
- **Cross-book voice identity check** — fs-71 (#1304).
- **UI localization** — fs-14. **TTS text normalization** (no
  `normalize/lang/{zh,ja}.ts`) — fs-53.
- **Traditional vs Simplified Chinese** — both map to `zh`; Qwen/XTTS handle both.
- **Diminutive/inflection folding** — N/A for CJK.

## 9. Risks & assumptions

1. **Qwen JA quality** — the top on-box unknown (ZH is Qwen's native strength;
   JA less certain). Gated in W5; if JA fails the audio gate, ZH can still flip
   and JA defers — but D2 (flip together) means a JA miss holds ZH's flip; call
   this out at the W5 gate and let the operator decide split-vs-hold.
2. **XTTS `zh-cn` / `ja` quality** — cross-lingual voice cloning with the generic
   speaker catalog is unverified for CJK; W4b validation may force a curated CJK
   Coqui catalog.
3. **Fluent ZH/JA translator + labeler availability** — gates W5 (fixtures +
   labelled chapters). W1–W4 land regardless; the harness is proven on English
   first.
4. **`Intl.Segmenter` fidelity** — assumed "good enough for a ratio guard." If it
   is not, the fallback is character-count (still self-consistent), **not** a
   native-dep segmenter (jieba/fugashi) — that stays out of scope.
5. **`detect.script` typing** — the new `'cjk'` tag on the registry
   `detect: { script }` union is decoupled from the hardcoded han/kana tiebreak,
   but the TypeScript union and any exhaustive `switch` over script classes must
   be widened in the same change, or the build breaks / a script class is
   silently unhandled.

## 10. Reuse (not built here)

fs-2 data-model + never-cross-language enforcement (`language.ts`,
`synthesise-chapter.ts`, `verify-designed-voice-language.ts`); fs-60's entire
engine-eligibility + Coqui-fallback + mixed-engine-serialization + UI machinery;
the dialogue-structure pipeline; the `notifications` slice; the confirm-screen
server-driven selector; `detect-language.ts` (zh/ja routing already present).

## Ship notes

_(filled at ship time: shipped date, commit SHAs per wave, W5 operator verdict,
attribution FP/FN for ZH + JA, audio-gate result per engine × language, fs-70
reconciliation link.)_
