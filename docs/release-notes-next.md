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

release-notes-next-version: 1.15.0

Cycle opened 2026-07-24 (v1.14.0 shipped 2026-07-23; first PR of the new
cycle reopens this file per CONTRIBUTING.md "Release notes"). Populated
PR-by-PR as the v1.15.0 cycle progresses — do not reconstruct from git
history at cut time.
-->

## 📝 Script review & manuscript

- Detect emotions can now be scoped to the current chapter — the header button runs the emotion + reaction passes on just the chapter you're viewing, with whole-book still available from its ⌄ menu. (fs-35, #592)

---

## 🎙️ Voices & casting

- **fs-38 Wave 1 — book-independent voice library (`#/voices` restructure + designed-voice
  authoring)** (#1800, refs #624). Ships a first-class, book-independent voice-library store ("My
  voices"), restructuring `#/voices` into three sections — **My voices | In use | Catalogue**.
  Adds standalone designed-voice authoring: create a Qwen voice from a persona with a live
  audition, **redesign-with-compare** (A/B old-vs-new, keep or discard), **promote** a
  character's designed voice into the library (new uuid + byte-copy of the `.pt`), and
  **assign** a library voice to any character — reusable across books and series. A new
  `provenance` dimension (`designed`/`cloned`/`imported`) lands now on the schema (cloned/
  imported are inert until Wave 3 of `fs-38`/#624), and the cross-book voice matcher already
  excludes cloned-provenance voices so a person's voice can't be offered back into a stranger's
  book. Local-only; deleting a library voice runs a usage report and full multi-location
  erasure (manifest + `.pt` + cached samples). This wave alone delivers the folded-in `fs-12`.
  Not in Wave 1: clone-from-a-real-sample, consent/attestation, audio ingest, in-app recording,
  Catalogue rebuild (later waves). Plan:
  `docs/superpowers/plans/2026-07-04-fs38-wave1-voice-library-store.md`.
- **fs-38 Wave 3a — voice-clone ingest, consent & recorder** (Refs #624). Voice cloning
  groundwork: sample ingest, consent, and recorder (behind the voice-library flag). Real ffmpeg
  decode (upload or a new `VoiceRecorder`) → a pure quality gate (fatal <4s/silence, warn
  short/clipping) → 60s cap → a Node-written `master.wav` → Whisper transcript, via `POST
  /api/voice-library/clone-sample` (ephemeral candidate — no entry persisted yet). A write-time
  consent-structure guard on `writeEntry()` plus `POST /:uuid/revoke` (revocation orthogonal to
  the guard); the existing sample-audition route now 403s a revoked/consent-absent cloned voice.
  My voices gains a 'Cloned' badge + Revoke action; a capture/consent panel exists as a phase-1
  wizard building block. **Behind-the-flag, no reachable production caller for the consent
  guard/revoke route/cloned-section UI until 3b1** ships the first real cloned entry — disclosed
  scope, not a gap (spec §1.1). Plan: `docs/features/267-fs38-wave3-voice-clone.md`. Spec:
  `docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`.
- **First voice clone on the Qwen engine.** Capture or upload a sample, attest consent, and
  Castwright distils a reusable cloned voice — auditioned, ECAPA fidelity-checked, and castable
  like a designed one. A cloned voice is never silently substituted: if Qwen is unavailable the
  chapter fails loud instead. (Refs #624)
- **Voice design and audition endpoints stop flattening the sidecar's status to 502.** The
  library `design` / `redesign` / `sample` routes and the character `design-voice` route now map
  the sidecar's own **5xx** through, so a **503** ("no GPU capacity — free VRAM and retry")
  survives as a 503 instead of reading as a broken gateway, and `NoCapacityError` — which carries
  no status at all — maps to 503. A sidecar **4xx** deliberately stays 502: it describes our
  request to the sidecar, not the caller's request to us, and forwarding it would collide with
  the 409 these routes already use for "design run in progress" / `gpu_busy`. The `0` the
  unreachable/cancelled paths carry also clamps to 502. (#1801)
- **`#/voices` no longer strands you on a blank pane when the voice library is turned off**
  (#1802). The view's section state is local; `voices.library.enabled` reading `false` after the
  user had already opened **My voices** unmounted that nav segment and rendered
  `MyVoicesSection` as `null`, leaving the nav strip with nothing beneath it until another
  segment was picked. In practice the reachable trigger is the boot-time race — the config read
  treats an unhydrated knob as enabled-pending, so a click landing before `fetchConfig` resolves
  could strand on a disabled library. The active section is now **derived** rather than reset by
  an effect, so the fallback to `in-use` happens during render and the empty pane is never
  painted at all.

---

## 🎧 Listening & revising

- **fs-10 — chapter-title segment on the Listen timeline** (#412). `ChapterAudio.segments[]`
  gains an optional `kind: 'title'` discriminator and the chapter-audio route stops filtering the
  synthetic title beat out of both `/audio` and `/audio/previous`. The mini-player scrubber paints
  it as a non-interactive labelled band; the Generation view's "Narrative order" strip fills it
  neutrally rather than in the narrator's colour. **Also fixes a latent off-by-one:** because the
  published array was short one leading row, `resolveSegmentForSec`'s index no longer matched the
  on-disk index the splice route addresses, so Listen-view "Fix this line" targeted the line before
  the marked one.

- **Series-memory's hardcoded-dark surfaces no longer borrow the theme's accent** (#1832). The
  three `src/components/series-memory/` surfaces pin a `#1b1714` background that never follows the
  app theme, but their accent resolved through the theme-flipping `--magenta` — `#A43C6C` on light,
  **2.918:1** on that surface, failing WCAG AA as text. New pinned `--color-magenta-on-dark` token
  (the accent counterpart to the existing pinned `--color-cream`), applied to the share card's
  label/glyph/separators/footer, the reveal's carried-badge and section label, and both gradient
  CTAs. The reveal's per-book dots are included because they encode which books a character appears
  in — meaningful graphics under WCAG 1.4.11 (3:1), also missed. Pinning their gradient forced the
  CTA ink off flipping `text-ink` (near-white on light pink under dark) onto the already-pinned
  `text-peach-ink`, 5.3–5.8:1 across the gradient. **Matters more than a normal contrast bug
  because the card is exported as a PNG** — a light-theme user shipped the failing version rather
  than merely seeing it. Regression cases live in Playwright, not vitest (jsdom doesn't resolve
  these tokens) and assert *identity across themes* rather than a literal, since the defect was a
  colour that moved when its surface didn't. Trade-off: the card no longer responds to
  `[data-contrast='high']` — ~11:1 → a fixed 7.6:1 for high-contrast dark, but it also stops
  high-contrast light resolving to a near-invisible `#7A1B49`.

---

## 📱 Companion app

- **Demo library covers for _Saltgrave_ and _The Tidewatcher's Oath_ were swapped** (#1792). The
  committed `apps/android/assets/demo-covers/hollow-tide-2.png` (mapped to _The Tidewatcher's Oath_
  in `demo_data.dart`) held the _Saltgrave_ artwork and vice versa — the filenames were correct, so
  the filename-mapping test could not see it. Swapped both the committed downscaled assets and the
  git-ignored `brand/book-covers/` sources (so regeneration stays correct), and added a SHA-256
  regression guard in `scripts/tests/build-demo-covers.test.mjs` that pins the corrected art.

---

## 📖 Help

- **Mirror the marketing site's local-first privacy FAQ into the app Help view** (#1793). Adds two
  Help topics — `is-my-data-private` (files) and `does-it-work-offline` (analysis) — to
  `src/data/help-topics.ts`, matching the website's corrected copy: analysis is local by default and
  the cloud fallback is opt-out (on by default, switchable off), never framed as opt-in-only or
  "never touches the cloud". Guarded by `src/data/help-topics.test.ts`; item-count assertions bumped
  43 → 45.
