<!--
Release notes for the NEXT version (technical register — this IS the GitHub
release body). bump-version.mjs feeds this file verbatim as the annotated-tag
message → release.yml, and uses it by DEFAULT (no --notes-file needed).
Everything in this HTML comment is invisible in the rendered release, so it
never leaks into the body.

TWO-FILE SHAPE (v1.15.0 onward when a cycle outgrows the limit): GitHub rejects
a release body over 125,000 characters, so a large cycle keeps the complete
technical changelog in docs/release-notes/vX.Y.Z-full.md (linked from the foot
of this file by an absolute URL pinned to the tag) and this file carries the
condensed body: keep it well under ~60,000 characters. A cycle that fits simply
keeps its full text here and needs no archive. Bug fixes belong in the notes
only if the bug could have affected the previously published version; a fix to
something introduced this cycle is folded into that feature's description.

Keep it current for each release:
  1. Update the version marker below.
  2. Rewrite the body (theme paragraph → ## ✨ Headline features with
     ### … (new) subsections → emoji-themed sections → bold-lead bullets with
     (#PR) refs → **Full changelog:** vPREV...vNEW footer). v1.7.0 is the
     canonical example; see CONTRIBUTING.md "Release notes".

The marker is what bump-version checks: if it doesn't match the version being
cut, the bump refuses (so a stale file can't ship as the body). The
user-facing, brand-voice notes live separately in RELEASE_NOTES.md (#/release-notes).

release-notes-next-version: 1.16.0

Cycle opened 2026-11-13 (v1.15.0 shipped 2026-11-13; first PR of the new
cycle reopens this file per CONTRIBUTING.md "Release notes"). Populated
PR-by-PR as the v1.16.0 cycle progresses — do not reconstruct from git
history at cut time.
-->

## 🔊 Generation quality & engine health

- **A chapter render that fails after its audio was encoded no longer leaves a chapter-sized temp file in the book's audio folder.** `finalizeChapterAudioWrite` wrote `<slug>.<ext>.tmp-<pid>-<ts>` before its fallible steps and only renamed it at the end, so any throw in between (embeddings or segments write, preserve, rename) leaked the file. The exported function is now a wrapper that removes the temp file on any exit before a successful rename, logs and swallows a failed removal, and rethrows the original error. Covered by `finalize-chapter-write.tmp-cleanup.test.ts`. Temp files leaked by earlier failures are not swept; that is #3456's boot sweep, not this fix (#4167).

## 🧪 Test gates

- **A version-only `__version__` bump of `server/tts-sidecar/version.py` is now exempt from the sidecar-acceptance gate** (content-checked, fails closed), and the release runbook routes the bump through a PR before the tag push (#4120). The gate's, `verify.yml`'s and `verify-cache`/pre-push's changed-file lists now use `--no-renames`, so a move out of `server/tts-sidecar/**` lists its source path.
