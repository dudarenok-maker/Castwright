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

release-notes-next-version: 1.13.0

DRAFT IN PROGRESS — v1.13.0 reopens the draft: v1.12.2 published as a
same-day patch on 2026-07-11, and this is the first PR of the next cycle.
Diffed against v1.12.2 (the previous public release) per CONTRIBUTING.md
"Release notes". Only one themed entry so far; later PRs in this cycle
append to this draft rather than opening a new one.
-->

**A quality-and-accuracy release, so far.** The v1.13.0 cycle opens with a sharper ASR content-QA gate for non-English books.

---

## 🗣️ Quality & Accuracy

- **ASR content-QA gate: non-English integer-spelling and contraction normalization for es/fr/de/ru (#1084).** Real per-language `maxWer` calibration against rendered audio remains a tracked follow-up.

---

**Full changelog:** v1.12.2...v1.13.0
