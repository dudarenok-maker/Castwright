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

DRAFT IN PROGRESS — first PR of the v1.13.0 cycle (v1.12.3 shipped as the
consolidated Pinokio-installer patch, superseding v1.12.1/v1.12.2).
Bootstrapped per CONTRIBUTING.md "Release notes": marker bumped forward,
stale v1.12.3 body cleared, this PR's own entry opens the fresh draft.
Diffed against v1.12.3 (the previous public release).
-->

**Ongoing hardening.** *(placeholder theme — refine at cut time once the full v1.13.0 scope is known.)*

---

## 🎙️ Voice design & casting

- **"Design full cast" no longer silently grinds through GPU contention.** If another job was using the GPU while a bulk cast design was running, every remaining character used to fail identically, one after another, with the progress pill misleadingly climbing toward 100% the whole time (even reading "0/16 · 94%" — zero characters designed, but nearly "complete"). The sidecar now recognizes this specific contention and triggers its existing self-recovery restart (matching how it already handles other transient failures); the job rides out a brief pause before halting with a clear message naming the cause and how far it got, instead of grinding through every remaining character. The progress pill's percent no longer counts failures as progress, and now shows the failure count inline while the job is still running. (#1533)

---

**Full changelog:** v1.12.3...v1.13.0
