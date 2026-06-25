<!--
Draft release notes for the NEXT version (technical register — this IS the
GitHub release body). bump-version.mjs feeds this file verbatim as the
annotated-tag message → release.yml, and now uses it by DEFAULT (no
--notes-file needed). Everything in this HTML comment is invisible in the
rendered release, so it never leaks into the body.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.10.0

DRAFT IN PROGRESS — v1.10.0 is still accumulating (package.json is 1.9.0; not
yet cut). Covers what has merged since v1.9.0 so far; extend as more lands.
-->

**A craft, reach, and trust release.** Castwright gains a third performed language — Spanish, after English and Russian — and recognises a manuscript's language the moment you import it. Performances get more expressive *and* more correct: characters now gasp, sigh and laugh with line-by-line direction, numbers/dates/currency are spoken the way you'd read them aloud, and a new LLM Script Review proposes fixes to who-said-what. See the cast you've carried across a whole series and lift a card worth sharing, and switch on a new acoustic check that catches a voice drifting *out of character* even when the words are right — all on the usual hardened footing.

---

## ✨ Headline features

### 🌍 Spanish — a third performed language (new) — fs-41 / fs-50
Castwright performs Spanish-language books end to end, and recognises a manuscript's language the moment you import it.

- **Spanish books, full-cast** — `es` is now a claimed language: the analyzer reads Spanish (per-language dialogue conventions, copyright-boilerplate stripping), the cast and their descriptions are produced in Spanish, and Qwen designs and performs voices that speak it — validated end-to-end by an on-box Spanish canary (a full Spanish-calibrated chapter render, operator-accepted; cast attribution scored 13/13 recall by a new eval harness) before `es` was switched on (#1011, #1015, #1016, #1019, #1031, #1032).
- **Language detection on import + a confirm-screen selector** — every manuscript is script/`franc`-detected server-side on import; the confirm screen shows the detected language and a "detected but not yet supported" banner for languages Castwright can't perform yet, so there are no mid-pipeline surprises (#1011).
- **Language-agnostic structure** — chapter splitting, Unicode heading normalisation, non-English front-matter / generic-NCX detection, non-English quote + Unicode-case shout audio-tag recognition (incl. German „…"), and the English-only roster/attribution + narrator-flip recovery guards all gated off for non-English books (#1011, #1013, #1014, #1015).
- **The voice library knows the language** — derived voices carry a per-voice `languageCode` from the Qwen manifest; the global voices view gains a language facet, and the cast picker hides language-ineligible voices (hide-with-count + show-all) and warns when a designed voice is cleared for a language mismatch (#1020, #1021).
- **Fail-loud on an unsupported language** — `sidecarLanguageName` now throws for a language the sidecar can't perform instead of silently defaulting to English (#1022).

### 🎬 Series memory — see the cast you've carried (new) — fe-40
The voices you designed, returning book after book, now made visible.

- **Carried-cast chip + consistency sparkline** — a series on your shelf shows a chip (`Your cast · N voices, M books`) and a sparkline of principal-cast consistency across its books. It surfaces only above a ≥3-carried-character / ≥3-confirmed-book / ≥1-designed-voice threshold, so an all-preset shelf stays quiet (#986).
- **Reveal panel** — tapping the chip opens a dialog (full-screen sheet on phone) with the carried roster sorted by voice kind (designed / cloned first), a per-book marker row showing where each character appears, and share / export actions (#986).
- **Shareable cast card + exports** — a portrait social card leads on the designed-voice count and names every carried character (the wordmark + `castwright.ai` always present); fe-43 adds client-side PNG capture (`html-to-image`, lazy-loaded) plus a schema-versioned JSON export of the series, books, and carried cast (#991).
- **"Carried" vocabulary + table-view chip** — the reuse badge now reads **Carried** across the cast and confirm-cast screens (copy-only; the lifecycle "Matched" pill is untouched), and the chip also renders in the library table view (fe-41 / fe-42, #991).

### 🎙️ Acoustic voice-drift detection (new, opt-in) — srv-36 Phase 1
A new ear for a fault the word- and loudness-checks can't hear.

- **Timbre-drift QA gate** — an opt-in check (`SEG_SPK_ENABLED`, default off) that embeds each rendered segment with an ECAPA-TDNN speaker fingerprint and compares it to a hybrid per-character voice centroid, catching lines where a character's voice drifts *out of character* even when the words are correct and the loudness is fine — drift the ASR and audio-QA gates miss (#987).
- **Per-character 3-tier verdict** — severe / inconclusive / voice-match against each character's *own* clean-render thresholds (not a single global cosine), calibrated and pinned on real on-box renders with an operator listen (27/27 extreme-tail flags were real drift, 0 false positives across two series) (#987).
- **Detection free, auto-fix opt-in + gated** — the issues outline is free; the acoustic auto-repair (`qa.speaker.autoRepair`, default off) re-renders a flagged segment and re-embeds with a margin-based accept, and is gated behind Cast Pass entitlement when hosted (#987, #990).

### 🎭 Truer emotion variants + a selectable Quality voice tier (new) — fs-55 / fs-56
Qwen character voices keep their identity when they perform emotion, and a higher-quality tier is a click away.

- **Emotion variants that still sound like the character** — angry / sad / whisper and the rest are now *minted from the character's own voice* (decode the base voice's reference codes → re-derive on the 1.7B model → instruct the emotion → distil back to the fast 0.6B), instead of being independently re-sampled by VoiceDesign. The drift where an emotion variant became a different-sounding voice is gone — measured at **0.014 ECAPA cosine distance** from the base (threshold 0.30), operator-confirmed by ear (#1008, closes fs-55).
- **Selectable 1.7B "Quality" tier per character** — a new `qwen3-tts-1.7b` engine option (cast voice picker → "Higher quality (1.7B)") routes that character's synthesis through the larger, more expressive Qwen model on both the single and batch render paths, with a lazy per-voice prompt cache. The fast 0.6B model stays the default; the 1.7B loads on demand (`PRELOAD_QWEN_BASE17` keeps it warm) and is offloaded under the one-heavy-model-at-a-time VRAM rule (#1008).
- **Tuned emotion variants** — per-emotion instructs, temperatures (1.6 / 1.8), and gain (whisper ×0.45, angry ×1.5) calibrated for the anchored pipeline, with the demo book + voice library re-minted against the locked settings (#1023).
- **1.7B managed from the Model Manager** — the Qwen 1.7B-Base now appears as its own inventory row with load / unload / remove, alongside the 0.6B (#1012).
- **Re-mint existing books** — `scripts/remint-anchored-variants.mjs` re-mints already-designed (drifted) emotion variants through the new anchored pipeline (#1008).

### 🗣️ Non-verbal vocalizations + live, context-aware delivery (new, opt-in) — fs-57
The analysis LLM writes lifelike non-verbal reactions — gasps, sighs, laughter ("Ah!", "Haah…", "Haha!") — directly into a line's text, plus a free-text English `instruct` describing how to deliver it, and that direction becomes audible end-to-end.

- **Non-verbal vocalizations** — a new Stage-3 analysis pass (`audiobook-instruct-annotation`) annotates sentences in-place (strict, non-re-attributing, idempotent, multilingual: vocalization text in the book's language, the instruct in English); the "Detect emotions" button now runs it too (#1095, closes #997).
- **Live expressive delivery (1.7B), per-book toggle (default off)** — routes synthesis through a live per-line ICL+instruct path on the **Qwen 1.7B Base**: one batched `generate` forward carries heterogeneous per-item `instruct_ids`, neutral lines ride the pinned `NEUTRAL_INSTRUCT=""` no-op (measured on-box, C2 gate), with an instruct length cap + raw-`generate` drift guard. A synth-side precedence ladder (`resolveInstructForGroup`) picks the instruct: manual › analyzer instruct › emotion-derived English phrase › neutral (#1095).
- **Additive by design** — a pre-fs-57 analysis loads unchanged; the **0.6B / Kokoro / Coqui audio paths stay byte-identical**; only an opted-in 1.7B book changes. Guardrails: the srv-31 ASR content-QA gate tolerates vocalization tokens (lexical words still fully scored), and fs-58 Script Review preserves vocalization text + instruct (#1095).

### 🔢 Numbers, dates and currency, spoken the way you'd read them (new) — fs-53
Automatic, language-aware text normalisation at the synthesis boundary.

- **Spoken-form expansion** — `$1,200` → "one thousand two hundred dollars", `1999` → "nineteen ninety-nine", `50%` → "fifty percent", `Dr.` → "Doctor" — for English, Spanish and Russian books (the `supported:true` set). French and German engines ship fully implemented and unit-tested but **dormant**, activating the moment their fs-50 `supported` flag flips (#1094, closes #976).
- **Russian raised floor** — years as ordinals in the correct case for the closed set of year-governing prepositions, dates as neuter-ordinal day + genitive month (`3 января` → "третье января"), currency 1/2–4/5+ agreement (рубль/рубля/рублей), a 1/2 gender heuristic (один/одна, два/две) (#1094).
- **Always-on and invisible** — no toggle; the original manuscript text is never mutated, so captions, the manuscript view and quote-audit still show the written form. New `server/src/tts/normalize/` module (`expandForSpeech(text, langCode)` over a shared classifier layer + five per-language engines); the no-`langCode` path is byte-identical to today (#1094).
- **Keeps the ASR content-QA gate aligned (load-bearing)** — the per-sentence WER gate is now fed the same fs-53-normalised spoken form the audio was synthesised from, so expanded numbers no longer trigger false `drift` / wasted re-records / spurious `asrSuspect`, sidestepping the non-English number-WER gap (#1084) by pre-spelling the numbers (#1094).

### 📝 LLM Script Review — fix who-said-what in a click (new) — fs-58 (Unit A)
An operator-triggered, per-chapter, **read-only** LLM pass that proposes annotation repairs and applies the accepted ones **client-side** by dispatching the existing manual-edit reducers (analyzer Ollama/Gemini only — no TTS engine load).

- **Five repair classes (Unit A)** — `strip_tag` (drop a stray attribution tag), `split` (a sentence spanning two speakers), `extract_dialogue` (pull a dialogue span out of a narrator run), `merge` (re-join adjacent same-speaker narration), `fix_emotion` (correct a clearly-wrong per-quote emotion) (#1047, closes #998).
- **Review then accept** — a "Review Script" button (per-chapter, or whole-book with a free-tier RPD warning mirrored from `rate-limit.ts`) streams suggestions over SSE into a `ScriptReviewDiff` modal grouped by class with per-class / per-change toggles; accepted ops apply in the browser and mark the chapter's audio stale via `boundary_move` (#1047).
- **Correctness guards** — anchors resolve client-side at accept time against live sentence text (one-pass index map, TOCTOU-safe; `planApply` re-validates every accepted op), and `merge` leaves a persisted, book-scoped tombstone (`mergedAwayKeys`) so a later re-analysis can't resurrect a merged-away sentence id (#1047). Also folds in **srv-51** — the SSE guard now distinguishes `no_such_chapter` from `no_attribution` (#1045).

---

## ✨ Smaller features & UX

- **Honest streamed voice-design progress (#1089)** — the single-design progress bar now streams **real** per-phase progress from the sidecar (best-effort `report_progress` → a loopback-only `/api/internal/design-progress` relay → the existing SSE → a monotonic Redux phase), replacing a hardcoded ~15 s ETA, an always-firing "GPU may be busy" warning, and fake phases. Opt-in per job: the bulk "Design full cast" and REST design paths send byte-identical sidecar bodies and are unaffected.
- **Per-regenerate model override (#1080)** — the Regenerate modal gains a **Model** picker (Qwen 0.6B / 1.7B), so a chapter can be re-rendered at the 1.7B Quality tier without re-casting every character. The choice threads through (and persists on) the queue entry; absent → the session default, byte-identical to before (closes #1079).
- **Emotion-variant mint fallback when the 1.7B is absent (srv-52, #1096)** — if the Qwen 1.7B-Base is **not installed or corrupt**, the server transparently mints the requested emotion variant via the old `/qwen/design-voice` path (persona + emotion instruct) instead of failing. A transient VRAM **OOM stays a loud failure** (VoiceDesign would OOM identically). Never silent — a server log line, a per-character note on the bulk Design toast, and a durable `mintMethod: "design-voice-fallback"` marker that `remint-anchored-variants.mjs` upgrades once the 1.7B is back (closes #1091).
- **QA issue affordances (#1073)** — issue markers expose their `reasons` on hover (a `title` per amber bar + on the "N issues" caption and the MiniPlayer ⚠ jump buttons), and the preview-player waveform now fills the scrubber (`flex-1` bars) instead of leaving a flat tail (closes #1070, #1071).
- **Manuscript review-session batch + analyzer model pill (#1065)** — Review-Script flyout z-index (`z-50`/`picker-surface`), a dark-mode-readable emotion/confirm popover, an empty-state for a zero-suggestion review, excluded-chapter scoping for Detect-emotions / whole-book Review-Script, and the resolved analyzer model now surfaced as a pill in the Status popover (closes #1059–#1062, #1064).

---

## 🏗️ Under the hood

- **Optional GPU path for the drift embed (srv-47)** — `SPK_DEVICE=cuda` is now *safe* to set: weighted-VRAM-semaphore-gated (like the ASR engine), idle-evicting (default 120 s), with load-time CPU degrade/demote and an `/embed` poison fence that now covers the model load. CPU stays the hard default; a one-time WARN fires if cuda is set under a GPU budget < 2, where the embed would serialise behind synth and run slower than the free CPU path (#1003).
- **UTF-8 request bodies in the sidecar (#1023)** — the sidecar now parses 3-byte UTF-8 JSON request bodies, so a line containing an em dash (or other non-ASCII punctuation) no longer 400s on synthesis.
- **srv-36 Phase-2 measurement harness (#1009, #1018)** — the cross-book voice-consistency evaluator that backs the per-book report: blind-listen harness + synth request-builder, `voice_index` walk/join + inventory probe (voiceUuid via cast join), cross-book metric helpers with pre-registered go/no-go thresholds, a per-axis report assembler, and a `--counts` sizing helper (clean segments per voiceUuid per book). Operator-run measurement, not a render-path change.
- **Design Qwen voices without a Gemini key (srv-48)** — a voice-design *persona* (the natural-language `instruct` that seeds each character's designed voice) can now be generated by a local Ollama model instead of Gemini, via a `local | gemini` provider toggle (`PERSONA_GEN_ENGINE`, default `gemini`; `PERSONA_GEN_LOCAL_MODEL` blank-inherits the analyzer's model), so a fully offline / no-cloud-key install can design its full cast. It mirrors the analyzer's explicit opt-in (no silent cross-provider fallback) and finally wires the previously-disconnected `analyzer.gemini.voiceStyleModel` registry knob. The local path is GPU-coexistence-aware on a constrained card — it evicts the idle sidecar model under a full-budget, fail-closed reverse-evict and falls back to CPU while a render is in flight so it never disturbs a live synthesis — shared across the single-design, generate-all, and bulk "Design full cast" paths (the bulk job gains a local-only persona pre-pass) (#1052).
- **~2× faster QA re-records (#1072)** — the signal-QA (plan 179) and ASR content-QA (srv-31) re-record loops are now **round-based and batched** via a reusable `synthGroupsBatched` helper: each round re-synthesises all still-failing groups in one batched call, keeps the best take, and drops the recovered ones. Recovers the unbatched-re-record RTF regression (~1.9–2.0 → batched-floor target ~1.2 on a KotLC chapter) while preserving best-of-N, the per-group budget, 0.6B/1.7B batch isolation, abort + recycle-recovery, and the no-progress watchdog. The initial body pass is byte-identical (closes #1069).
- **ASR content-QA, fewer false positives (#1086, #1087, #1088)** — compound-word re-tokenisation (`Curvebuster`↔`Curve Buster`, `good bye`↔`goodbye`) and confident Whisper boilerplate hallucinations (`OceansofPDF.com`, "subtitles by…", "thanks for watching") no longer flag `drift`; calibration-pangram bleed (#1074) is now **quarantined** — dropped to brief silence + hard-flagged `suspect`/`quarantined` after the re-record budget fails, instead of shipped to the listener; and the `classifyTranscript` pass is language-aware with per-language `maxWer` knobs scaffolded (`SEG_ASR_MAX_WER_ES`/`_RU`, values owed on-box calibration). English byte-identical (closes #1083, #1085; refs #1074, #1084).
- **Localized minor-cast fold + roster guard for es/ru/fr/de (#1054)** — the descriptor fold (`isDescriptorName`) and the roster-coverage guard (`validateRosterCoverage`/`validateAttributionCoverage`), previously English-only, now recover under-rostered speakers for Spanish/Russian/French/German via a new `descriptor-grammar.ts` + the per-order `tag-grammar.ts` substrate (both-orders detection, Unicode-safe boundaries, a German capitalized-title skip). This is the real fix for the on-box Berrin/Ivo loss (#1028 was rostered-only); English byte-identical. (Note: this localizes the *analyzer heuristics* for fr/de — performing French/German **books** stays gated `supported:false` until their own canaries.) (closes #1050, #1051).
- **fe-40 carried-cast fixes (#1058)** — the carried counter is now **fork-safe**: `deriveSeriesMemory` replaces a directional `matchedFrom` tail-walk with union-find connected components, correctly handling a voice designed in a later book and reused into an earlier one; and the reveal panel adopts the house modal pattern (full-screen sheet on phone, `sm:max-h-[90vh]` + internal scroll on desktop) so a large carried cast no longer pushes the footer off-screen (closes #1055, #1056).
- **Graceful missing-voice failure (#1066)** — synthesising a Qwen voice/variant with no cached `.pt` embedding now returns a clean `409 voice_not_designed` ("design it first, then play the sample") instead of an opaque `500`; the CUDA-poison fence is correctly skipped (a missing `.pt` never poisons the context) (closes #1063).
- **srv-43 voiceUuid `.pt` orphan: heal + prevent (#1067, #1075, #1077, #1081)** — a voice designed before its uuid was stamped kept its `.pt` at the legacy `qwen-<voiceId>` key, so once a uuid landed every resolver pointed at a missing `qwen-<uuid>.pt` → silent Kokoro fallback + a no-op "Design full cast → Emotion variants". `scripts/repair-qwen-voice-uuid-keys.mjs` (group-by-name, fixes even cyclic-reuse voices) re-keys the files (23/26 healed on the live workspace), `scripts/normalise-stale-qwen-voice-names.mjs` makes record names honest, and the **recurrence is gated permanently** — a *variant* design no longer mints a fresh uuid (it reuses the base's), so the orphan can never re-form. `scripts/invalidate-stale-qwen-base-samples.mjs` clears the stranded base voice-sample `.mp3`s, and cast-review "Play 12s" now injects `voiceUuid` for sample-cache-key parity with the profile drawer.
- **srv-50 — shared `loadPostFoldSentencesByChapter` (#1068)** — extracts the helper fs-58 deliberately copied byte-for-byte into the annotate-emotion and script-review routes into `server/src/store/post-fold-sentences.ts` (−88 lines of duplication; pure refactor) so the two routes can't silently drift.
- **Design specs (not yet shipped)** — the #1002 expressive-TTS roadmap has now largely landed (anchored variants + 1.7B Quality tier in #1008; per-line instruct + non-verbal sounds in fs-57/#1095; LLM script review in fs-58/#1047 above), leaving faster rendering via a Qwen Code2Wav `torch.compile` codec path (side-19, #989) and two parked next-gen engine designs still on the drawing board; plus backlog triage, a README claims block, and srv-36 ship-notes / spec housekeeping (#990, #994, #995, #980, #971, #970).

---

**Full changelog:** `v1.9.0...v1.10.0`
