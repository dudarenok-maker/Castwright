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

**A craft, reach, and trust release.** Castwright gains a third performed language — Spanish, after English and Russian — and recognises a manuscript's language the moment you import it. See the cast you've carried across a whole series and lift a card worth sharing, switch on a new acoustic check that catches a voice drifting *out of character* even when the words are right, and — under the hood — the GPU groundwork to scale that check, all on the usual hardened footing.

---

## ✨ Headline features

### 🌍 Spanish — a third performed language (new) — fs-41 / fs-50
Castwright performs Spanish-language books end to end, and recognises a manuscript's language the moment you import it.

- **Spanish books, full-cast** — `es` is now a claimed language: the analyzer reads Spanish (per-language dialogue conventions, copyright-boilerplate stripping), the cast and their descriptions are produced in Spanish, and Qwen designs and performs voices that speak it (#1011, #1015, #1016, #1019).
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

---

## 🏗️ Under the hood

- **Optional GPU path for the drift embed (srv-47)** — `SPK_DEVICE=cuda` is now *safe* to set: weighted-VRAM-semaphore-gated (like the ASR engine), idle-evicting (default 120 s), with load-time CPU degrade/demote and an `/embed` poison fence that now covers the model load. CPU stays the hard default; a one-time WARN fires if cuda is set under a GPU budget < 2, where the embed would serialise behind synth and run slower than the free CPU path (#1003).
- **UTF-8 request bodies in the sidecar (#1023)** — the sidecar now parses 3-byte UTF-8 JSON request bodies, so a line containing an em dash (or other non-ASCII punctuation) no longer 400s on synthesis.
- **srv-36 Phase-2 measurement harness (#1009, #1018)** — the cross-book voice-consistency evaluator that backs the per-book report: blind-listen harness + synth request-builder, `voice_index` walk/join + inventory probe (voiceUuid via cast join), cross-book metric helpers with pre-registered go/no-go thresholds, a per-axis report assembler, and a `--counts` sizing helper (clean segments per voiceUuid per book). Operator-run measurement, not a render-path change.
- **Design specs (not yet shipped)** — the remaining expressive-TTS tiers (per-line instruct, non-verbal sounds, LLM script review; specced in #1002 — the anchored-variant fix + 1.7B Quality tier from that spec shipped above in #1008), faster rendering via a Qwen Code2Wav `torch.compile` codec path (side-19, #989), and two parked next-gen engine designs; plus backlog triage, a README claims block, and srv-36 ship-notes / spec housekeeping (#990, #994, #995, #980, #971, #970).

---

**Full changelog:** `v1.9.0...v1.10.0`
