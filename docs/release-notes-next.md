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

- **Admission no longer evicts the model the admitting request itself needs (#4079 follow-up: mint, GPU ASR, GPU SPK).** Three cases still threw away and reloaded their own resident model through the GPU admission ladder. A `mint` with the 1.7B-Base resident now keeps it: the `qwen.base17` step is protected (`_own_resident_tier` returns credit 0), the request is restricted to the card the base is on, and it books the `qwen.1.7b.mint` cold peak minus the resident base's weights (measured at load, fallback 3400 MB) through the new `own_resident_warm_mb` hook, so a refusal reports that reduced `neededMb`. GPU ASR and GPU SPK with their model resident likewise protect their own ladder step, target the resident card for the ladder, the reclaim and the `noCapacity` `deviceKey`, and book the warm amount: `asr.warm` (128 MB, existing) and the new `spk.warm` (128 MB, an unmeasured prior that is not learned, because a resident SPK op's allocator peak already includes the ECAPA weights). On an 8 GB card, minting emotion takes with the 1.7B-Base loaded no longer unloads and reloads it per take, and with `ASR_DEVICE`/`SPK_DEVICE` set to `cuda` a busy card answers `noCapacity` (and the server retries) instead of evicting the check's own model (#4102).

## 🧪 Test gates

- **A version-only `__version__` bump of `server/tts-sidecar/version.py` is now exempt from the sidecar-acceptance gate** (content-checked, fails closed), and the release runbook routes the bump through a PR before the tag push (#4120). The gate's, `verify.yml`'s and `verify-cache`/pre-push's changed-file lists now use `--no-renames`, so a move out of `server/tts-sidecar/**` lists its source path.
