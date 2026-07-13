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
a Qwen path. Each `supported` flag flips independently (per-language gate,
expected to ship together), only after an on-box dual gate (operator audio ×
both engines + attribution FP/FN from a new eval harness).

## 1. Context — what already exists (do not rebuild)

The fs-50 tranche (es/fr/de) **shipped** and left CJK a small delta on top of a
proven framework. Verified against the current tree:

- **Detection routing is done, but the `supported` flag is NOT read-through.**
  `server/src/tts/detect-language.ts` already runs an authoritative script
  pre-pass: Cyrillic→`ru`, then `(han + kana)/letters ≥ 0.3`
  → `{ language: kana > han ? 'ja' : 'zh', supported: false }` (front-matter
  stripped first, 20 k-char sample). The Han-vs-Kana disambiguation and the
  `detected-but-unsupported` return are already in place.
  **CORRECTION (independent plan review):** the earlier claim "adding registry
  rows flips detection automatically — no detection code changes" is FALSE. That
  CJK branch (`:49-52`) returns a **literal** `supported: false`, bypassing the
  `result(code)` registry read the ru/latin branches use — so a W5 registry flip
  would be a no-op end-to-end. The branch MUST be changed to
  `return result(kana > han ? 'ja' : 'zh')` (plan Task 2.1). This is the ONE
  detection code change fs-59 needs.
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
| D1 | **Segmenter = `Intl.Segmenter`** (zero-dep, Node/ICU built-in) | One load-bearing use (§3.1): `granularity:'sentence'` for the CJK sentence-split in `stage2-chunk`. (Word-granularity is NOT used for the coverage guard — §2.1 verified it doesn't move the ratio; the coverage fix is a dup-key floor.) Self-detects script, so no book-language threading. No new dependency (matches the "one dep = franc" precedent). Confirmed available: `node >=20.19.0`, `.nvmrc` 24, full-ICU default. |
| D2 | **ZH + JA flip independently** (per-language gate); expected to ship together but not coupled | The `supported` flip is per-language: a JA audio-gate miss does **not** block ZH's flip. Foundations still land once and one operator/labeler session covers both, so in practice they ship together — but atomicity is not an invariant. (Resolves the earlier D2/Risk-1 tension.) |
| D3 | **Build the full §4.8 attribution eval harness**, as **Wave 1 / its own PR**, language-agnostic | The Latin tranche skipped it and flipped `supported` on operator-audio alone. It is infrastructure every future language needs; building it first, proven on an existing language, de-risks the CJK waves and retro-enables an es/fr/de gate. |
| D4 | **CJK renders on both Qwen and Coqui XTTS** | Qwen natively supports zh/ja; XTTS v2 natively supports `zh-cn`/`ja`; the sidecar has no language allowlist; fs-60's machinery is generic. Honors "it should also work for Coqui." |
| D5 | **fs-59 owns the CJK slice; fs-70 (#1303) keeps the rest** | CJK is uniquely dual-engine (Qwen + Coqui); fs-70's other languages (ko/ar/hi/…) are XTTS-only. Reconcile by reference on both issues; do not silently absorb. |

## 2.1 Empirical validation (2026-07-13 spike)

Two of the assumption-checker's load-bearing risks were settled by running real
CJK text through the actual code + a real Gemini pass (no local VRAM):

- **The coverage guard does NOT infinite-retry on CJK; it has ONE narrow
  CJK-specific gap.** Spikes on verbatim `words()` / `validateStage2Coverage`:
  - *Healthy text:* a faithful attribution of a 5-paragraph JA/ZH chapter scores
    **ratio 1.000 → PASS**; confirmed end-to-end with a live
    `gemini-3.1-flash-lite` stage-2 pass (both ratio 1.0). So the issue's
    "infinite retry" premise is **false** — healthy CJK does not false-positive.
  - *The one genuine CJK bug (dialogue-heavy JA, 40 sentences):* a real
    **repeat-loop** scores `ratio 1.15, dup=false → PASS`. The ratio band can't
    catch a mild loop (English wouldn't either), but English is saved by
    `findDuplicatedBlock`; CJK is **not**, because that detector skips keys
    `key.length < 8` and ~80% of CJK dialogue "sentences" are shorter. **Fix (W2):
    a CJK-aware dup-key floor — that, and only that, is the CJK coverage bug.**
  - *Ruled OUT as CJK bugs (verified, so the plan doesn't chase them):* (a) a 30%
    **truncation** passing at `ratio 0.70` is the guard's *designed* tolerance
    (floor 0.6 admits healthy 0.65–1.0 compression) and is **language-agnostic** —
    English behaves identically; not a CJK defect. (b) `Intl.Segmenter` **word**-
    counting does **not** move the ratio: measured clause-vs-word counts are
    1.150 vs 1.155 (loop) and 0.700 vs 0.670 (truncation) — ratio is
    scale-invariant, so finer tokens change no verdict. Word-granularity is
    therefore **not** part of the coverage fix; it stays load-bearing only for the
    `stage2-chunk` sentence split.
- **The real CJK hard problem is attribution correctness on interrupted quotes.**
  The same live Gemini pass, with the *current* (non-CJK) prompt, attributed JA
  「」 dialogue correctly but **mis-attributed Chinese** where a spoken turn is
  split by a tag: `"小心点，"她轻声说，"下过雨以后…"` → it gave the first spoken
  fragment to the speaker but the **second spoken half to the narrator**. This is
  the concrete defect W1 (eval harness measures it) and W3 (dialogue-structure
  conventions + in-language prompt examples fix it) target — it is now a named
  regression case, not a hypothetical.

The spike scripts were throwaway (not committed); the JA/ZH sample chapters are
recorded here and should seed W2's synthetic fixtures and W1's proving material.

## 3. Architecture — the CJK seams (actual code)

Each item names the real file:symbol and the CJK gap. Grouped by the delivery
wave that owns it (§5).

### 3.1 Analysis foundations (Wave 2 — engine-independent)

- **Coverage guard** — `server/src/analyzer/stage2-coverage.ts`,
  `findDuplicatedBlock` (`~:117`). The issue's "infinite retry" is false (§2.1),
  and — verified — the ratio band and `Intl.Segmenter` word-counting are **not**
  the fix (ratio is scale-invariant; a 30% truncation passing at 0.70 is the
  guard's designed, language-agnostic tolerance). The **one** CJK-specific bug is
  `findDuplicatedBlock`'s `key.length < 8` skip: ~80% of CJK dialogue "sentences"
  have shorter keys, so a CJK repeat-loop evades the dup-detector (measured:
  passes at ratio 1.15, dup=false). **Fix (W2):** a CJK-aware dup-key floor
  (char-based or a lower CJK threshold), script-self-detecting on Han/Kana
  presence — **no book-language threading needed** (like the `isNarrativeLine`
  fix). Goal: a CJK short-dialogue repeat-loop FAILS; a faithful CJK attribution
  still PASSES. `words()` itself needs no change (its `\p{L}\p{N}` normalisation
  already tokenises CJK into clauses correctly for the ratio).
- **Sentence splitting** — `server/src/analyzer/stage2-chunk.ts`,
  `splitParagraphIntoSentences()` (`:122`, split on `/(?<=[.!?]["')\]]?)\s+/`).
  **This is the genuinely-broken CJK seam:** CJK has no whitespace and ends
  sentences with `。！？`, so the adaptive re-split fallback for an over-budget
  CJK paragraph never divides. **Fix:** CJK path uses
  `Intl.Segmenter(lang, { granularity: 'sentence' })` (handles `。！？` + closing
  `」』` natively), self-detecting on per-paragraph Han/Kana presence (this runs
  where the book language may not be threaded). The pre-emptive
  `splitBodyIntoChunks` paragraph split (`\n\n`) is script-independent and stays.
  This is the real home of the D1 `Intl.Segmenter` decision.
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

**Seams the plan's independent review added to §3.1 (not in the original sweep):**
- **CJK chapter-heading split** — the `headingLexicon` does NOT split CJK
  chapters: `parsers/text.ts` `CHAPTER_HEADING_RE` expects `keyword→whitespace→
  number` (Latin), but CJK is the circumfix `第<number>章` (no whitespace, kanji +
  fullwidth numerals). Needs a dedicated, **whole-line-anchored** CJK pattern (a
  naive prefix regex matches `第三章で述べた…`/`第二部隊…` and `parseText` deletes
  that prose as a title). Plan Task 2.6 — acceptance-critical.
- **Import word-count / front-matter miscount** — `routes/import.ts` `countWords`
  splits on whitespace, so a spaceless CJK chapter counts ~40 "words" and is
  pre-ticked `isLikelyFrontMatter` (≤150) → every CJK chapter auto-excluded at
  confirm. Needs a script-aware count. Plan Task 2.7.
- **CJK roster-name tag anchoring** — `dialogue-structure/name-matcher.ts`
  `findRosterName` tokenises on `[^\p{L}]+`, so a CJK tag clause is one token and
  never matches the roster; `tag-name` (highest-precedence) evidence never fires
  for CJK. Needs substring-containment matching. Plan Task 3.5.

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
  0. **Pre-check (blocks the rest of 4b):** confirm XTTS v2's exact language code
     for Chinese — `zh-cn` vs `zh`/`zh_cn` — against the installed `TTS` package's
     accepted set before writing the mapping. The whole path rests on this string
     (unverifiable in-repo; the sidecar has no allowlist).
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
- **W5 labelled-chapter requirement (so the harness measures what matters):** the
  ZH and JA labelled chapters MUST deliberately include (a) **interrupted-quote**
  turns (spoken—tag—spoken across a fullwidth comma, the §2.1 defect) and (b)
  **roster-false-positive** constructions (a name-like token that is not a speaker
  tag — the cases tag-grammar gate-off (§3.2) stops guarding). A clean chapter of
  easy cases would report a passing FP/FN while hiding exactly the CJK errors this
  spec exists to catch.

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
   Registry rows land here (`supported:false`). Fixes: the `stage2-chunk` CJK
   sentence-split (`Intl.Segmenter` sentence granularity), the **coverage-guard
   dup-key floor** (CJK-aware, closing the short-dialogue loop blind spot — §2.1),
   `isNarrativeLine`, and the token divisor. All self-detect script (no language
   threading).
   *Benefit (technical): CJK chapters split + segment correctly; over-budget CJK
   paragraphs re-split instead of truncating; a CJK dialogue repeat-loop is caught
   instead of shipped silently to synthesis.*
3. **Wave 3 — CJK conventions + prompts** (server). §3.2. Targets the §2.1
   interrupted-quote defect directly.
   *Benefit (user): CJK dialogue (「」/“”) — including a spoken turn split by a
   tag — is attributed to the speaker, not silently handed to the narrator.*
4. **Wave 4 — CJK synthesis, both engines** (sidecar + server). §3.3.
   *Benefit (user): CJK voices render on Qwen and Coqui XTTS.*
5. **Wave 5 — Validation + flip** (operator tail, own PR).
   - ZH + JA Coalfall fixtures (**dep: fs-61 / fluent translator**).
   - Label a ZH + JA chapter → run the W1 harness → attribution FP/FN recorded
     (attribution is engine-independent — one pass covers both engines).
   - Operator **audio** gate: Qwen×{zh,ja} **and** Coqui×{zh,ja}.
   - On-box confirm Qwen honours a CJK persona and XTTS `zh-cn`/`ja` quality.
   - Flip `zh.supported` and `ja.supported` **per language** (D2 — independent;
     a JA miss does not hold ZH). Expected in one PR, but either may flip alone.
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
- **W2:** synthetic ZH + JA fixtures — `splitParagraphIntoSentences` splits a CJK
  paragraph on `。！？`; **dup-detector regression** (a CJK short-dialogue
  repeat-loop — the §2.1 `<8`-key blind spot — must FAIL after the CJK-aware
  dup-key floor; a faithful CJK attribution must still PASS; and a characterisation
  test pinning that healthy CJK sits at ratio ≈ 1.0 so the floor change doesn't
  regress it); `isNarrativeLine` accepts a real CJK narrative line and rejects a
  short heading; `estimateInputTokens` uses ~1.2 for CJK-dense input; registry
  lookups for zh/ja.
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
      `supported` on registry rows — W2); a CJK book splits into chapters and
      segments into sentences, over-budget CJK paragraphs re-split via
      `Intl.Segmenter` rather than truncating, AND the dup-detector **catches a
      CJK short-dialogue repeat-loop** (the §2.1 blind spot now FAILS) while a
      faithful CJK attribution still passes (W2). *(Re §2.1: the issue's "infinite
      retry" does not reproduce; the sole CJK coverage bug is the dup-key floor —
      mild truncation passing is by-design and language-agnostic, not chased.)*
- [ ] CJK dialogue (「」/“”) is attributed to the speaker — including a spoken
      turn interrupted by a tag (the §2.1 defect) — not demoted to narrator (W3),
      measured by the W1 eval harness.
- [ ] Qwen **and** Coqui XTTS render ZH/JA at acceptable quality (operator audio
      gate, both engines) AND attribution is validated against a fluent-labelled
      sample with FP/FN recorded (W1 harness + W5 labelled chapters).
- [ ] `supported` flips per language only after that language's dual gate (D2 —
      independent; expected together but not coupled); the never-cross-language
      invariant holds (W5).
- [ ] fs-70 (#1303) reconciled by reference (W5).

## 8. Scope boundaries

**In:** CJK analysis (benefits all engines), CJK synthesis on **Qwen + Coqui
XTTS**, the attribution eval harness, zh + ja → `supported`.

**Out:**
- **Korean (`ko`)** — nominally "CJK", but deliberately **excluded**. Hangul is a
  **spaced** script, so Korean shares *none* of the spaceless-script foundations
  this spec is built on (no segmenter, no sentence-split rewrite, coverage guard
  works as-is, whitespace tokenisation is valid). It also uses a distinct script
  (`\p{Script=Hangul}`, not Han/Kana, so a new detection branch) and Qwen's
  Korean quality is unverified. Korean is a Russian/Latin-shaped "add-a-language"
  job, not CJK-foundation work — it belongs to **fs-70** (#1303), which already
  lists it. (This spec is really "CJ" — Chinese + Japanese, the spaceless pair.)
- **Kokoro-CJK** — Kokoro is English-only with no CJK G2P (misaki[ja,zh]); that is
  fs-69 (#1302) / §11.2, not here. CJK is Qwen+Coqui only in v1.
- **The other XTTS languages** (ko/ar/hi/nl/pl/tr/cs/hu/it/pt) — fs-70 (#1303).
- **Cross-book voice identity check** — fs-71 (#1304).
- **UI localization** — fs-14. **TTS text normalization** (no
  `normalize/lang/{zh,ja}.ts`) — fs-53.
- **Traditional vs Simplified Chinese** — both map to `zh`; Qwen/XTTS handle both.
- **Diminutive/inflection folding** — N/A for CJK.

## 9. Risks & assumptions

1. **Qwen JA quality** — the top on-box unknown (ZH is Qwen's native strength;
   JA less certain). Gated in W5. Per D2 (independent flips), a JA miss lets ZH
   flip alone and JA defers — no coupling to resolve.
2. **XTTS `zh-cn` / `ja` quality** — cross-lingual voice cloning with the generic
   speaker catalog is unverified for CJK; W4b validation may force a curated CJK
   Coqui catalog.
3. **Fluent ZH/JA translator + labeler availability** — gates W5 (fixtures +
   labelled chapters). W1–W4 land regardless; the harness is proven on English
   first.
4. **`Intl.Segmenter` sentence-boundary fidelity** — the one load-bearing use
   (`granularity:'sentence'` in `stage2-chunk`) must segment CJK `。！？「」`
   correctly; a missed boundary truncates loudly (existing single-huge-sentence
   fallback), not silently. (Word-granularity is not used — §2.1 verified it
   doesn't move the coverage ratio.) A native-dep segmenter (jieba/fugashi) stays
   out of scope.
5. **The §2.1 spike is indicative, not exhaustive.** Clean 5-paragraph synthetics
   with dense fullwidth punctuation; real CJK EPUBs mix ASCII punctuation, ruby/
   furigana, U+3000 ideographic spaces, and dashless dialogue. W2's fixtures
   should include at least one messy real-world-shaped chapter.
6. **`detect.script` typing** — the new `'cjk'` tag on the registry
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
