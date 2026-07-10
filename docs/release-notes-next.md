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

release-notes-next-version: 1.12.1

DRAFT IN PROGRESS — v1.12.1 is a small patch release: one real installer fix,
cut same-day as v1.12.0 once it was found during a live on-box Pinokio
acceptance pass. Diffed against v1.12.0 (the previous public release) per
CONTRIBUTING.md "Release notes" — no headline-features section, just the
one themed fix. Docs-archival (#1505) and a backlog-sync tooling fix (#1507)
also landed same-day but have no user/operator-visible effect, so they're
left out per the "What stays out" rule.
-->

**A patch release: the Pinokio one-click install actually completes now.** A structural bug in the installer's own scripts — undiscovered until today's first real on-box run got far enough to hit it — made every install step operate one directory too deep. Fixed; nothing else changed since v1.12.0.

---

## 🚀 Onboarding

- **The Pinokio one-click install no longer fails on its very first step.** Every `pinokio/*.js` launcher script (install/start/stop/update/reset) lives one directory below the app root, but Pinokio runs each script's shell/file-removal steps from that script's own directory by default — none of ours accounted for it, so the very first `conda install` step landed in the wrong place and failed with a cryptic "directory exists, but is not a conda environment" error. This has been silently broken since the Pinokio installer first shipped (2026-06-15); every earlier on-box attempt was blocked by an unrelated bug before ever reaching this step. All five scripts now explicitly target the app root. (#1508, #1509)

---

**Full changelog:** v1.12.0...v1.12.1
