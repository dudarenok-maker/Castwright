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

release-notes-next-version: 1.14.0

DRAFT IN PROGRESS — first PR of the v1.14.0 cycle (v1.13.0 shipped
2026-07-12). Bootstrapped per CONTRIBUTING.md "Release notes": marker bumped
forward, stale v1.13.0 body cleared, this PR's own entry opens the fresh
draft. Diffed against v1.13.0 (the previous public release). Later PRs in
this cycle append to this draft rather than opening a new one.
-->

**In progress.** _(Theme statement written at cut time.)_

---

## 🎙️ Voice design & casting

- **A cast-confirmed book that hasn't started generating now reopens on the Cast view (voice design), not the Generate tab — new `voices_pending` stage + "Cast ready" library badge.** Confirming a cast used to flip a book straight to `generating` status, so reopening it from the library jumped to the Generate tab even before any voice was designed. A new server-derived `voices_pending` `LibraryBookStatus` (`castConfirmed && !generationStarted && not-complete`, where "started" is derived from disk — any rendered audio or any failed chapter, so no `state.json` field and no migration) sits between `cast_pending` and `generating`; such a book now routes to the Cast view, shows a "Cast ready" badge, and counts under "In progress". `isConfirmed` includes the new status (series-memory counting unaffected), and the library status-pill lookup gains a defensive fallback so an unknown server status can never blank-crash the grid. (#1560)

---

**Full changelog:** v1.13.0...v1.14.0
