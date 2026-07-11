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

release-notes-next-version: 1.12.3

DRAFT IN PROGRESS — v1.12.3 fixes the last thing keeping the one-click Pinokio
Install button from firing: the launcher scripts lived in a folder named
`pinokio/`, a name the Pinokio runtime reserves internally, so the
download-screen Install button rendered but never auto-fired install.js on
first activation. Diffed against v1.12.2 (the previous public release). NOTE:
at release-cut this patch is intended to CONSOLIDATE the v1.12.1 and v1.12.2
Pinokio patches (which will be deleted) into one final patch — that
consolidation is gated on the fresh-install acceptance test passing.
-->

**A patch release: the one-click Pinokio Install button now fires on the first click.** On a fresh install, clicking Install rendered the screen but silently never started setup — the launcher lived in a folder named `pinokio/`, a name Pinokio reserves internally. Renamed to `pinokio-scripts/` (and brought the launcher's schema version in line with every shipping Pinokio app), so Install auto-fires the installer immediately.

---

## 🚀 Onboarding

- **The Pinokio Install button now auto-fires the installer on first activation.** Our launcher scripts lived under a folder named `pinokio/` — a name the current Pinokio runtime reserves internally — so the download-screen Install button rendered but never triggered `install.js` (running it by hand from inside the app still worked, which is why installs completed when triggered manually but looked broken to first-time users). Renamed the launcher subtree to `pinokio-scripts/`, bumped its script schema version `1.0` → `7.0` to match every shipping Pinokio app, and added structural tests that load the real launcher and assert the folder isn't a reserved name, the schema version is current, and every menu action resolves to a real script. (#PR)

---

**Full changelog:** v1.12.2...v1.12.3
