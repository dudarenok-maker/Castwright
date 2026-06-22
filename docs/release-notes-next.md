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

**A craft-and-trust release.** See the cast you've carried across a whole series and lift a card worth sharing, switch on a new acoustic check that catches a voice drifting *out of character* even when the words are right, and — under the hood — the GPU groundwork to scale that check, all on the usual hardened footing.

---

## ✨ Headline features

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

---

## 🏗️ Under the hood

- **Optional GPU path for the drift embed (srv-47)** — `SPK_DEVICE=cuda` is now *safe* to set: weighted-VRAM-semaphore-gated (like the ASR engine), idle-evicting (default 120 s), with load-time CPU degrade/demote and an `/embed` poison fence that now covers the model load. CPU stays the hard default; a one-time WARN fires if cuda is set under a GPU budget < 2, where the embed would serialise behind synth and run slower than the free CPU path (#1003).
- **Design specs (not yet shipped)** — expressive-TTS Qwen instruct tiers (#1002), faster rendering via a Qwen Code2Wav `torch.compile` codec path (side-19, #989), and two parked next-gen engine designs; plus backlog triage, a README claims block, and srv-36 ship-notes / spec housekeeping (#990, #994, #995, #980, #971, #970).

---

**Full changelog:** `v1.9.0...v1.10.0`
