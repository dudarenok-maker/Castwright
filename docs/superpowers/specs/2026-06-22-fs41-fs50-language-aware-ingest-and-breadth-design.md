---
status: active
date: 2026-06-22
topic: fs-41 + fs-50 — language-aware ingest + Latin-script Qwen breadth (one initiative)
issues: >
  fs-41 (#666, Could→Should) auto-detect manuscript language on ingest, filter
  voice library, auto-load engine; fs-50 (#974, Must) language packs end-to-end.
  Folded into ONE initiative per user direction; this spec covers the
  Latin-script Qwen tranche (ES/FR/DE).
depends_on: >
  fs-2 (multi-language Russian, shipped: engine half plan 108, language half plan
  162); fe-16 (library/cast language UX polish, shipped plan 165)
relates_to: >
  fs-25 (per-emotion variants) — EMOTION_INSTRUCT is an English design hardcode
  this spec internationalises; fs-53 (#976) text normalisation; fs-14 (#396) UI
  localization — DISTINCT per-USER axis; fs-38 (#624) standalone/cloned voices
defers: >
  (1) CJK (ZH/JA) → a SEPARATE follow-on sub-spec — it needs a server-side word
  segmenter dependency, per-language prompt examples, and fluent ZH/JA labelers
  (§11.1). (2) The Kokoro-unfilter + Coqui-XTTS per-language engine-eligibility
  relaxation → a SEPARATE gap-fill sub-spec (§11.2).
supersedes_in_part: >
  fs-41 is largely realised by fe-16 except voice-library language filtering;
  this spec completes it and extends the shipped en/ru path to ES/FR/DE
---

# fs-41 + fs-50 — Language-aware ingest + Latin-script Qwen breadth

> **Scope at a glance.** Add **Spanish, French, German** end-to-end through **Qwen
> design only**, keeping the shipped `non-English ⇒ Qwen, fail-loud` invariant
> **unchanged**. Two hard things are split into their own follow-on sub-specs:
> **CJK (ZH/JA)** (§11.1) and the **Kokoro/XTTS engine relaxation** (§11.2). The
> bulk of the build is the **analyze half** (chapter/quote/attribution/token/prompt
> internationalisation), which is engine-independent. Direction validated by two
> adversarial review rounds (2026-06-22); this revision folds in all of round 2.

## 0. The reframe

fs-50's acceptance is **fs-41's three sub-goals (detect / filter / auto-load) plus
a per-language validation gate, applied to more languages**. So **fs-41 is the
mechanism; fs-50 is the breadth through it.** Built N-language from the start; the
packs roll out through it. fs-50 is **Must**, so the fold elevates fs-41's
filtering work.

### 0.0 The north star (the goal all this work serves)
Every language **Qwen** can speak — Qwen is the main, design-baked engine — then,
as separate later initiatives, **CJK** (its own analysis hardness, §11.1) and
**whatever the other engines add that Qwen can't** (Kokoro/XTTS, §11.2). Closing
the "rivals show 1,158 languages, we show 2" gap is a **Qwen-first** programme;
**this spec ships the Latin-script Qwen tranche (ES/FR/DE)** as the first concrete
breadth, on a framework reusable by both follow-ons.

### 0.1 Two scope narrowings (review-driven, deliberate)
- **Qwen-only (no engine relaxation).** Review showed the Kokoro-native "cheapest
  path" is *not* free (its non-English G2P backend — `misaki[ja,zh]`, espeak
  language data — is absent from every requirements file; the only Kokoro tests
  pin the opposite), and relaxing the binary `isNonEnglish` guard reopens
  silent-wrong-language / wrong-identity paths, needs per-language default voices,
  touches four frontend binary sites, and can force a 3-engine 8 GB VRAM spill.
  So we **keep the existing fail-loud `non-English ⇒ Qwen` invariant unchanged**
  and add languages through Qwen design. (Gap-fill deferred — §11.2.)
- **Latin-script only (defer CJK).** Review showed CJK analysis needs a
  **server-side word segmenter** (`Intl.Segmenter` minimum; jieba/fugashi for
  quality — a real dependency the "no new deps" posture denies), **per-language
  prompt examples**, and **fluent ZH/JA labelers** for the attribution gate. That
  is a distinct sub-project (§11.1). ES/FR/DE are Latin-script, lexicon-tractable,
  and desk-verifiable.

### 0.2 Current ground truth (verified across two review rounds — corrects an
earlier draft claim that "synthesis is basically done")
- **The *enforcement* invariant is genuinely language-agnostic.** `isNonEnglish`
  forces every character to a designed Qwen voice; `forbidKokoroFallback` throws
  `MissingDesignedVoiceError`; `clearMismatchedDesignedVoices` drops a reused voice
  whose manifest language ≠ the book's. None of this is en/ru-specific — it works
  for any language word. fe-16's cast banner, Qwen auto-load, and `lockedToQwen`
  stay correct.
- **BUT the Qwen *design path* has multiple English hardcodes the voice actually
  speaks through** (round 2's biggest correction): the **persona/`instruct`** is
  hard-English (`skills/audiobook-voice-style.md:16` ends `- English.`;
  `analyzer/voice-style.ts` never receives book language) and is the *primary*
  identity input to VoiceDesign (`main.py:1553`); the **timbre reference clip**
  uses the hardcoded English `CALIBRATION_TEXT` (`main.py:1509`, not the
  Node-supplied `calibrationText`, which is only the audition); **`EMOTION_INSTRUCT`**
  (`qwen-voice.ts:106`) and **`fill-tone` NUDGES** (`fill-tone.ts:8`) are en/ru
  hardcoded; and **`sidecarLanguageName` silently defaults unknown→`'English'`**
  (`language.ts:34`), which *disarms* the mismatch guard.
- **The analyze half is English/Latin-centric and is the bulk of the work** — and
  its single largest surface is the **prompt skills themselves** (~500 lines of
  English instructions + English few-shot examples in
  `skills/audiobook-character-detection-per-chapter.md` and
  `…sentence-attribution.md`), not just the 3-sentence `languagePreamble`. Plus a
  dozen English/Latin-assuming parser/analyzer primitives (§4).
- **Voice-library language filtering does NOT ship** (`DerivedVoice` carries no
  language; the late clear is a server-side `console.warn` with no frontend
  transport).
- **Things that are already correct — don't re-fix** (review-confirmed):
  `safe-id.ts` is Unicode-`\p{L}\p{N}`; `stage2-coverage.ts` `words()` Cyrillic
  erasure is already fixed; gender/age are model-output fields (no name→gender
  table to internationalise); EPUB chapter boundaries are NCX-structural
  (one-chapter-collapse risk is plaintext/markdown/PDF only).

### 0.3 What this is NOT
- Not CJK (§11.1) and not the Kokoro/XTTS relaxation (§11.2).
- Not UI-localization (fs-14, per-USER axis); not text normalisation (fs-53).
- Not "claim a language we can't read or analyse well" — `supported` flips only
  after the §7 gate (synthesis pronunciation **and** attribution correctness).

## 1. The work surface (three areas)

| Area | What ships here |
|---|---|
| **A. Qwen design-path i18n** (§5) | Thread book-language through the persona generator + drop the `- English.` rule; per-language `ref_text`, `EMOTION_INSTRUCT`, `fill-tone` NUDGES; make `sidecarLanguageName` **throw** for unsupported codes |
| **B. Analyze-half i18n** (§3–§4) | The bulk, engine-independent: detection, chapter split + title normalisation, quote/dialogue + audio-tags, attribution/roster guard (all 4 sites), minor-cast folding, token estimation, **the prompt skills**, front-matter strip, the attribution eval harness |
| **C. Voice-library UX** (§6) | fs-41 filtering + a real early-warning transport |

*Verification owed on-box before sequencing locks:* **Qwen3-TTS's real ES/FR/DE
quality** — `language` is a free-text word passed unvalidated
(`QwenEngine.DEFAULT_LANGUAGE="English"`), so German et al. are assumed. Pin
quality per language before flipping `supported`.

## 2. The language registry (one source of truth)

`server/src/tts/language-registry.ts` replaces the scattered en/ru hardcodes and
carries the analyze-half data. Shape:

```
LanguageEntry {
  code: string            // BCP-47 primary subtag: 'en','ru','es','fr','de'
  sidecarName: string     // Qwen design word + analyzer word: 'Spanish','German'
  whisperCode: string     // ASR/QA-repair hint code (faster-whisper): 'es','de' (≠ word)
  detect: { script: 'latin'|'cyrillic'; iso6393: string[] } // franc → this code
  refText: string         // phonetically-rich line IN THIS LANGUAGE → Qwen ref clip
  charsPerToken: number   // token-estimate divisor (Latin≈4, German≈3.3, Cyrillic≈2.5)
  text: {
    headingLexicon: string[]        // capítulo/chapitre/kapitel + native numerals
    frontMatterLexicon: string[]    // derechos de autor / dédicace / Urheberrecht …
    genericChapterLabel: RegExp     // per-language NCX generic-title match
    quoteChars: { open: string[]; close: string[] } // "" | «» | „"  (NOT CJK here)
    dialogueVerbs: string[]; verbBeforeName: boolean // —dijo Juan inverts
    descriptorNouns: string[]; functionWords: string[]; bucketName: string
    emotionInstruct: Record<Emotion,string> // per-language fs-25 variant clauses
    promptExamples: { roster: string; attribution: string } // few-shot in-language
  }
  supported: boolean      // flipped true ONLY after the §7 gate
}
```

- **`en` + `ru` seeded `supported:true` from day one** (grandfathered — `ru` shipped
  validated under fs-2; a regression test asserts a `ru` book still forces Qwen +
  `forbidKokoroFallback`). No `engines{}` map — non-English is always Qwen (§0.1).
- **Frontend/server sharing seam (specified, not hand-mirrored).** The full registry
  lives server-side. Because detection now runs server-side (§3), the frontend
  runs no detection and needs only two small things, both typed via `openapi.yaml`
  → `api-types.ts`: the per-import result `{ language, languageSupported }` (on the
  import response) and the **supported-list** (`{ code, label }[]`) for the confirm
  selector. No `detect`/`text`/`refText`/lexicon data ever enters the bundle.
  ("Adding a language = one entry" holds.)
- CJK adds the same shape **plus** a segmenter (the §11.1 sub-spec owns it).

## 3. Detection — server-side on ingest (Latin + script pre-pass, fails safe)

**Detection runs on the SERVER during `POST /api/import`** (revised from the
fs-2 client-side seed — review showed the server already holds the registry,
`strip-front-matter.ts`, and the full `sourceText`, and can run `franc` as a Node
dep with **no browser-bundle cost**; import is already the one hop, so this adds
none). The import response carries `{ language, languageSupported }`; the confirm
screen **displays** the result and builds its selector from a server-supplied
supported-list. The client `detect-language.ts` heuristic is **retired**. Mechanics:
- **Script pre-pass is authoritative** (deterministic): Cyrillic⇒ru. Preserves the
  shipped Russian path exactly, never depends on franc. (Han/Kana⇒
  `detected-but-unsupported`; the §11.1 sub-spec turns them into zh/ja.)
- **franc (Node) only disambiguates Latin** (en/es/fr/de), with a **confidence
  floor** below which it falls back to `en`, and an explicit **"English never
  misdetects"** regression test (an English chapter dense with French proper nouns
  stays en). Map franc ISO 639-3 → registry BCP-47 via `detect.iso6393`.
- **Strip front-matter BEFORE detecting** — reuse the server's `strip-front-matter.ts`
  (registry-driven per §4.7) on a body sample, not the raw head — translated
  editions carry English copyright pages that misdetect to `en`.
- **Fail safe — never silent `en`.** A confident detection of a non-`supported`
  language returns `{ language: <code>, languageSupported: false }` → the confirm
  screen shows a **`detected-but-unsupported`** banner and the user must pick a
  supported language (the hard generation block is seam 5's `sidecarLanguageName`
  throw). `en` must never be the silent safe-harbour — `isNonEnglish('en')===false`
  disarms the guard.
- **The confirm selector is BUILT from the server's supported-list, not gated.**
  Today it is a hardcoded 2-item `<select>` (`confirm-metadata.tsx:22`) with
  Russian-specific copy (`:300-312`) — there is no open-text field. Generate the
  options from the supported entries; generalise the "Auto-detected Russian —
  verify" copy + the Qwen note to the detected language. (Updates
  `confirm-metadata.test.tsx`, `e2e/language-detection.spec.ts`; the client
  `detect-language.ts` + `detect-language.test.ts` are **removed/superseded** — see
  §10 test-contract list.)

## 4. Analyze-half i18n (the bulk — engine-independent, Latin)

Each primitive becomes registry-driven. CJK-specific segmentation is **out of scope
here** (§11.1); these all matter for ES/FR/DE.

- **4.1 Chapter splitting + title normalisation.** (a) Build the chapter regex from
  `headingLexicon` (`parsers/text.ts:25`) — else a non-English book collapses to one
  chapter. (b) **Widen `normaliseHeading`** (`text.ts:113,134`) from `[^A-Za-z0-9]`
  to `\p{L}\p{N}` (matching `safe-id.ts`) so `¿Capítulo Tres?` isn't stripped to
  empty; gate `looksLikeTitle`/`findSubtitle` (`:110,222`) per-script. (c) Make
  `FRONT_MATTER_RX` (`parsers/front-matter.ts:11`) + `GENERIC_NCX_RE`
  (`parsers/html-utils.ts:85`, mirrored in `src/lib/chapter-heuristics.ts`)
  registry-driven so translated EPUB front-matter is filtered.
- **4.2 Quote/dialogue + audio-tags.** Drive `isSpokenLine`
  (`analyzer/narrator-default.ts:29`) from `quoteChars` (`«»` for ES/FR, `„"` for
  DE). The parse-time audio-tag detectors (`parsers/audio-tags.ts`) share
  `quoteChars` **and** need the all-caps shout heuristic (`isShoutingRun:33`,
  `denormaliseShouting:46`) moved to Unicode `\p{Lu}/\p{Ll}` — it is `[A-Za-z]`-only
  today, **already silently broken for shipped Russian** (German `„…!"` also misses).
- **4.3 Attribution / roster guard — all FOUR sites.** The `[A-Z][A-Za-z]+ <verb>`
  pattern lives in `roster-coverage.ts:182` **and** `:313`,
  `recover-tagged-lines.ts:85`, and the synced copy in
  `scripts/recover-missing-character.mjs` (drift-tested). Supply `dialogueVerbs` +
  `verbBeforeName` + `quoteChars`; the `[A-Z]` name token needs per-script handling
  (German capitalises every noun → `Haus sagte` false positives). **Known-partial
  bound:** a flat verb list cannot express conjugation/separable verbs/enclitics —
  the shipped Russian code already concedes "nominative singular only." Per language,
  decide **gate-on** (ES/FR/DE: viable with the lexicon) vs **gate-off + document the
  lost net** rather than silently no-op.
- **4.4 Minor-cast folding + diminutives.** `fold-minor-cast.ts` (`GENERIC_ROLE_RU:167`,
  `RU_FUNCTION_WORDS:184`, `BUCKET_NAMES.ru:112`) and the `ru-diminutives.ts`
  subsystem are en/ru-only; add `descriptorNouns`/`functionWords`/`bucketName` to the
  registry (so a Spanish minor cast folds with a Spanish bucket label), or document
  the loss per language. Diminutive merging is a real inflected-language lever — note
  whether ES/FR/DE need it (largely not) vs defer.
- **4.5 Token estimation.** Rewrite `estimateInputTokens` (`gemini.ts:735`) — today a
  fixed Cyrillic-fraction interpolation — to read the book's `charsPerToken`
  (German's compounds tokenise denser than the Latin≈4 assumption).
- **4.6 The prompt skills (the largest English surface).** The stage-1/2 skills are
  ~500 lines of English rules + English few-shot examples; few-shot dominates
  small-model behaviour, so a Spanish book is still pattern-matched against
  `"…," Halloran said`. Inject the registry's in-language `promptExamples` (+
  convention hints) into the **skill body**, and pass `sidecarName` ("Spanish") to
  `languagePreamble` (`gemini.ts:175`) instead of the raw code (`es`).
- **4.7 Front-matter boilerplate strip.** `strip-front-matter.ts` `GLOBAL_BOILERPLATE`
  (`:13`) is en/ru; make it registry-driven (so a Spanish copyright page is stripped
  before detect, feeding 4.1 + §3). (`isNarrativeLine` `length<60` is Latin-char
  reasonable for ES/FR/DE; the CJK fix belongs to §11.1.)
- **4.8 Attribution-correctness eval harness (net-new infra — its own deliverable).**
  No speaker→line labelling/eval exists today (the golden gate is audio-only). Build:
  (a) a labelled-sample schema `{chapterText, lines:[{text, speakerId}]}`, (b) a
  scorer that aligns analyzer output ids to truth (handling alias-merge/id-stability)
  and emits attribution FP/FN, (c) a per-language labelled chapter. The §7 gate
  consumes this — without it, "attribution check" is unverifiable.

## 5. Qwen design-path i18n (synthesis area A)

- **Enforcement invariant unchanged** — the three sites (`generation.ts`,
  `chapter-qa-repair.ts`, `chapter-splice.ts`) gate on `isNonEnglish`, which stays
  correct; **no rewrite**.
- **`sidecarLanguageName` must THROW** for a non-`supported` code (`language.ts:34`),
  caught at the generation/splice sites as a hard block — so an unsupported code can
  never bake an `'English'` manifest and disarm `clearMismatchedDesignedVoices`,
  regardless of how it entered `state.json`.
- **Per-language `refText`** replaces the hardcoded English `CALIBRATION_TEXT` at the
  **reference-clip** assignment (`main.py:1509`) — NOT the Node `calibrationText`
  param (which is only the audition; the Node side already passes an in-language
  evidence quote there).
- **Persona/`instruct` threaded** — pass `sidecarName` into `buildVoiceStylePrompt`
  (`analyzer/voice-style.ts:88`) and drop/condition the `- English.` rule
  (`skills/audiobook-voice-style.md:16`); extend `fill-tone` NUDGES (`fill-tone.ts:8`)
  per language. (On-box: confirm whether Qwen VoiceDesign honours a non-English
  persona at all — part of the §1 verification.)
- **Per-language `EMOTION_INSTRUCT`** (`qwen-voice.ts:106`) for fs-25 variant design,
  from the registry `emotionInstruct`.
- **ASR/QA-repair** passes the registry `whisperCode` (`chapter-qa-repair.ts:149`),
  kept distinct from the Qwen `sidecarName` word; a test asserts they agree per entry.

## 6. Voice-library filtering + early-warning (area C)

- **Filter the reuse picker** (`VoiceLibraryPanel`): in a non-English book, show only
  Qwen voices whose manifest language matches, behind **"N hidden · can't read
  &lt;Language&gt;" + "show all"**. **Global `#/voices` facet:** language tag + filter.
- **Early-warning with a REAL transport** (named, not hand-waved): surface the
  `clearMismatchedDesignedVoices` cleared-voice list on the existing cast/generation
  payload and render via the `notifications` slice (cross-tab via the existing
  `broadcast-middleware`) — so the cast view warns up-front instead of the user
  discovering the silent server-side clear at generation. Net-new UI/state.

## 7. Delivery & rollout

**Decompose Phase 1 into independently-verifiable seams** (it is otherwise one
unmergeable frontend+server+sidecar lump, ~2k LOC). All but the last are
desk-verifiable on synthetic fixtures:

1. **Registry module + en/ru seeding + the frontend/server sharing seam** — no
   behaviour change; `ru` no-regression test.
2. **Server-side detection on `/api/import` + confirm-selector rebuild** — registry
   `detect` field + es/fr/de entries; a server detection module (script pre-pass +
   franc-for-Latin + front-matter strip + clamp/block-unsupported); the import
   response carries `{ language, languageSupported }` + the supported-list; the
   confirm screen consumes them, builds the selector, and shows the
   detected-but-unsupported banner. Retires the client `detect-language.ts`.
3. **Analyze-half primitives** (§4.1–4.7) — server-only, one PR per 1–2 primitives,
   synthetic-ES-fixture-gated; each lists the shipped tests whose contract changes.
4. **Voice filtering + early-warning transport** — frontend+server.
5. **`sidecarLanguageName`-throw + Qwen design-path i18n** (§5) + the **attribution
   eval harness** (§4.8) — server/sidecar; the operator-gated leg.

**`supported` flips only in the operator-gated tail**, in a tiny follow-up PR, once
the on-box dual gate passes — so seams 1–4 land with `es.supported=false` and aren't
held hostage to operator/GPU availability.

**Rollout phases (Latin Qwen):**
- **Phase 1 — framework + Spanish canary.** Seams 1–5; Spanish end-to-end; dual gate
  (operator **audio** listen + **attribution-correctness** eval) → `es.supported`.
- **Phase 2 — German.** Exercises the registry for a second Latin language; German's
  capitalised-noun attribution edge (4.3) + denser token ratio (4.5). Dual gate.
- **Phase 3 — French (+ any further Latin Qwen languages).** Templated repetition.
- **Follow-on sub-projects:** CJK (§11.1), Kokoro/XTTS gap-fill (§11.2).

**Why gated, not one PR:** validation needs the GPU box, real Qwen weights, the
operator's ears, AND the labelled attribution sample — it cannot be desk-verified.

## 8. Settings & cost posture
- No new master flag; the registry's `supported` set + the `detected-but-unsupported`
  block are the only gates. Engine auto-load unchanged (non-English ⇒ Qwen).
- **One new runtime dep for the Latin tranche** — `franc` (a **server-side** Node
  dep, not in the browser bundle); no G2P backend, no word segmenter (that is the
  CJK sub-spec's), no extra VRAM beyond Qwen's existing footprint.

## 9. Reuse (NOT built here)
- fs-2 data-model + Qwen design-time baking + the never-cross-language enforcement
  (`language.ts`, `synthesise-chapter.ts`, `verify-designed-voice-language.ts`,
  `generation.ts`) — reused unchanged.
- fe-16 cast banner, Qwen auto-load, `lockedToQwen` — reused unchanged (correct under
  Qwen-only).
- `DerivedVoice` aggregation, `VoiceLibraryPanel`, `#/voices`, the `notifications`
  slice + `broadcast-middleware`, the analyzer stage-1/2 pipeline.

## 10. Acceptance

**Cross-cutting (every seam):**
- [ ] Registry is the source of truth (replaces `SIDECAR_LANGUAGE_NAMES` + the
      Cyrillic detector) with the §2 shape + the frontend/server sharing seam;
      `en`+`ru` seeded `supported:true`; **`ru` no-regression test** (forces Qwen +
      `forbidKokoroFallback`).
- [ ] **`sidecarLanguageName` throws** for a non-`supported` code; a test proves an
      unsupported code never reaches a synth call (no `'English'` manifest downgrade).
- [ ] **Contract-changing shipped tests enumerated + replaced in the same diff**
      (not silently inverted): `language.test.ts:46` (de→word, no warn),
      `parsers/text.test.ts` (heading lexicon), `narrator-default`/`audio-tags`
      (quote chars + Unicode case), `roster-coverage.test.ts` + the
      `dialogue-verbs` drift test, the client `detect-language.ts` +
      `detect-language.test.ts` **removed** (detection moved server-side; replaced by
      a new server detection test), `confirm-metadata.test.tsx:236` +
      `e2e/language-detection.spec.ts` (server-driven flow + generalised copy).

**Phase 1 — framework + Spanish canary (the build DoD):**
- [ ] Detection runs **server-side on `/api/import`**: script pre-pass authoritative
      (ru preserved); franc-for-Latin with a confidence floor + an
      **English-never-misdetects** test; 639-3→BCP-47 map; front-matter stripped
      before detect (reuses `strip-front-matter.ts`); a confident unsupported language
      returns `languageSupported:false` → confirm shows `detected-but-unsupported`,
      never clamps to `en` (regression test: a French manuscript is not silently `en`).
- [ ] Analyze-half §4.1–4.7 registry-driven; synthetic-ES-fixture tests (chapter
      split + title normalisation, quote/dialogue + audio-tag case, roster guard,
      minor-cast fold, token divisor, prompt examples + `sidecarName` preamble,
      front-matter strip).
- [ ] Qwen design-path i18n (§5): per-language `refText` at the reference clip;
      persona threaded + `- English.` dropped/conditioned; `EMOTION_INSTRUCT` +
      `fill-tone` per language; `whisperCode` wired (agrees-with-word test).
- [ ] Voice filter hides ineligible voices with "N hidden · show all"; `#/voices`
      facet; early-warning via the `notifications` transport (not a server-only warn).
- [ ] **Attribution eval harness built** (schema + scorer + Spanish labelled chapter).
- [ ] Spanish: full analyze→generate→export; on-box Qwen ES quality pinned; dual gate
      (audio FP/FN + attribution FP/FN) recorded; `es.supported=true` only after both.
- [ ] Paired EN/ES manuscript tests (fs-41); e2e detect → filter → cast for Spanish.

**Phase 2 — German / Phase 3 — French (+ further Latin Qwen):**
- [ ] Per language: registry entry + per-language Qwen `refText`/persona/emotion +
      dual gate; German's capitalised-noun attribution edge + token density handled;
      `supported` flips only on pass; result (sample book, audio FP/FN, attribution
      FP/FN, operator verdict) in Ship notes.

## 11. Out of scope (this spec) — the two named follow-on sub-projects

### 11.1 CJK (ZH/JA) — its own sub-spec
Deferred because it needs, beyond this framework: a **server-side word segmenter**
(`Intl.Segmenter` minimum; jieba/fugashi for quality) for sentence/coverage/word-
boundary logic (`stage2-chunk.ts`, `stage2-coverage.ts` `.split(/\s+/)` collapse);
**CJK quote handling** (`「」『』`) in `isSpokenLine`/audio-tags; the **CJK token
divisor** (~1.2); **per-language prompt examples**; **fluent ZH/JA labelers** for the
attribution eval; and `isNarrativeLine`'s `length<60` CJK fix. The registry shape and
gate are reused; the script pre-pass already routes Han/Kana to a block today.

### 11.2 Kokoro-unfilter + Coqui-XTTS engine relaxation — its own sub-spec
The per-engine eligibility model that would let non-English use Kokoro-native /
XTTS instead of forced Qwen. Owns: the Kokoro G2P dependency surface
(`misaki[ja,zh]`, espeak language data), per-language default voices, the 3-engine
8 GB VRAM constraint, Coqui per-synth `xttsLang` threading, and the srv-36
cross-language identity check.

### 11.3 Also out
UI localization (fs-14); text normalisation (fs-53); LLM/hybrid detection beyond the
script+franc v1; languages outside Qwen's verified set; voice cloning (fs-38).

## 12. Backlog reconciliation (do in the Round-0 docs PR)
- Fold **fs-41**'s row into **fs-50** (fs-41 is realised except voice filtering,
  which this spec completes); fs-50 carries the **Latin Qwen lead tranche**.
- File the **CJK sub-project** (§11.1) and the **Kokoro/XTTS gap-fill** (§11.2) as new
  Backlog-item issues + thin BACKLOG rows in the same docs round.

## Ship notes
_(filled per phase on ship: date · commit SHA · seam PRs · registry + sharing seam ·
Qwen verified ES/FR/DE quality · detector accuracy + English-stability · design-path
i18n (refText/persona/emotion) · attribution eval harness · Spanish canary (audio
FP/FN + attribution FP/FN) · then one block per Phase-2/3 language.)_

### Phase 1 — Spanish (`es`) — SHIPPED 2026-06-23

- **`es.supported: true`** in `language-registry.ts` (#1031, `b92a22ab`); `fr`/`de` stay `supported:false` until their own canaries. All seams merged: detection + confirm selector, language-agnostic structure + analyze-half primitives, voice-library language filter + facet + early-warning (#1011/#1013/#1014/#1015/#1020/#1021), seam-5 `sidecarLanguageName` fail-loud (#1022) + per-language Qwen calibration `refText` (#1019).
- **Attribution eval harness** (#1032, `scripts/eval-attribution.mjs`) — pure `scoreAttribution()` + CLI; scored the on-box ES cast **RECALL 13/13 (100%), PRECISION 93%** (sole imprecision = the Dragón/Coalfall entity-split).
- **Spanish canary (audio + attribution):** driven end-to-end against the real stack on a Spanish translation of the canonical book (`samples/the-coalfall-commission/manuscript.es.md`). Full Chapter render (66/66 lines, ~4m27s MP3) with **Spanish-calibrated voices** (manifest `refText` = "El veloz murciélago…"); ASR content-QA **0 flagged segments** (clean Spanish round-trip); **operator listen → accepted.**
- **Follow-ups filed (none blocked the ship):** #1027 per-language sample books (voices are per-language designs → the demo pack needs a per-language sample), #1028 non-English minor-cast protection (the seam-3d `taggedSpeakerIds` gate-off folds minor speakers like Berrin/Ivo), #1029 chapter-assembly stall with the `SEG_SPK` drift gate on (8 GB box), #1030 recycle-storm single-owner guard. Unfiled refinement: the Qwen design `instruct` persona is still English.

_Phase 2/3 (FR/DE, then CJK via fs-59) remain — status stays `active` until they ship._
