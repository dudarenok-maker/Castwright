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

DRAFT IN PROGRESS — v1.12.3 is the single, consolidated Pinokio-installer
patch. It supersedes the v1.12.1 and v1.12.2 patches, which are DELETED at
cut (releases + tags), so the changelog base is v1.12.0 (v1.12.0...v1.12.3)
and the body below rolls up all three fixes: reserved-folder-name + schema
version (this release), the installer shell-cwd fix (was v1.12.1), and the
server .env-cwd fix (was v1.12.2). Authored consolidated per CONTRIBUTING.md
"Release notes"; the delist→relist itself is gated on the fresh-install
acceptance test passing.
-->

**A patch release: the one-click Pinokio install now works end to end.** v1.12.3 consolidates the run of installer fixes since v1.12.0 — it supersedes and replaces the v1.12.1 and v1.12.2 patches. A fresh Pinokio Download → Install → Start now goes all the way through: the Install button fires the installer, every setup step runs from the right directory, and the server starts fully configured from its own `server/.env`.

---

## 🚀 Onboarding

- **The Pinokio Install button now auto-fires the installer on first activation.** The launcher scripts lived under a folder named `pinokio/` — a name the current Pinokio runtime reserves internally — so the download-screen Install button rendered but never triggered `install.js` (running it by hand from inside the app still worked, which is why installs completed when triggered manually but looked broken to first-time users). Renamed the launcher subtree to `pinokio-scripts/`, bumped its script schema version `1.0` → `7.0` to match every shipping Pinokio app, and added structural tests that load the real launcher and assert the folder isn't a reserved name, the schema version is current, and every menu action resolves to a real script. (#1529)
- **The installer's own setup steps now run from the app root, not the launcher folder** _(was v1.12.1)._ Every `shell.run`/`fs.rm` step defaulted its working directory to the script's own launcher folder rather than the app root, so the very first setup step (the conda env) resolved one directory too deep and failed before anything installed. Each step now sets `path: '..'` to reach the app root. (#1508, #1509)
- **A Pinokio-launched server no longer boots on bare defaults** _(was v1.12.2)._ Once install ran, Start launched the server from the app's top folder instead of its `server/` folder, so it couldn't find its own `.env` — workspace location, worker counts, GPU memory budget, analyzer settings — and quietly fell back to defaults. It now launches from `server/` (matching how the desktop app has always started it), so a Pinokio install comes up with its real settings from the first run. (#1513, #1514)

---

**Full changelog:** v1.12.0...v1.12.3
