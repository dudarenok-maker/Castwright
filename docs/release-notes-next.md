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

release-notes-next-version: 1.12.2

DRAFT IN PROGRESS — v1.12.2 is a same-day follow-on patch to v1.12.1. The
v1.12.1 Pinokio shell-cwd fix let Install run for the first time, which
surfaced a SECOND, distinct installer bug on Start (server ran but ignored
server/.env). Diffed against v1.12.1 (the previous public release) per
CONTRIBUTING.md "Release notes" — one themed fix, no headline-features
section.
-->

**A patch release: the Pinokio-installed server now reads its own settings.** v1.12.1 got the Pinokio install running for the first time — which immediately surfaced a second bug the first one had been hiding: the server started, but from the wrong directory, so it silently ignored its own configuration. Fixed; a clean Pinokio Install → Start now comes up fully configured.

---

## 🚀 Onboarding

- **A Pinokio-launched server no longer boots on bare defaults.** After the v1.12.1 fix let the one-click install actually run, the very next step exposed this: the launcher started the server from the app's top folder instead of its `server/` folder, so the server couldn't find its own `.env` — the file that carries your workspace location, worker counts, GPU memory budget, and analyzer settings — and quietly fell back to defaults. It now launches from the right place (matching how the desktop app has always started it), so a Pinokio install comes up with its real settings from the first run. (#1513, #1514)

---

**Full changelog:** v1.12.1...v1.12.2
