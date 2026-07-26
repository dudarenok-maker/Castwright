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

---

## 🔒 Security & dependencies

- **Sidecar engine deps: kokoro-onnx 0.5.0, a real ONNX Runtime pin, and FastAPI 0.140 via `lifespan`** (#1846).
  Clears the actionable half of the `side-17` umbrella (#893), which an audit found was carrying three
  stale rationales.
  - `kokoro-onnx` `>=0.4.0,<0.5.0` → `>=0.5.0,<0.6.0` across all three overlays. The entire upstream
    delta is `kokoro_onnx/log.py` dropping `colorlog` for stdlib `logging`; `Kokoro.create()`'s signature
    and the private `.sess` attribute are unchanged. Two new contract tests in `test_kokoro.py` run
    against the REAL installed package (the rest of that file stubs `kokoro_onnx` via `sys.modules`) —
    they exist because the indexed-device pin rebuilds `.sess` in a warn-only `try/except`, so an
    upstream rename would silently unpin the device rather than raise.
  - `onnxruntime-gpu` gets an explicit `>=1.27,<1.28` constraint in `scripts/install-ort.mjs`. There was
    no pin before — the swap ran `pip install --force-reinstall --no-deps onnxruntime-gpu` unversioned,
    so the runtime executing Kokoro was whatever was latest on the user's install date. The constraint
    lives in the installer, never the overlays (macOS reads those and has no wheel).
    **Existing installs on 1.28.x will step back to 1.27.x on first upgrade** — both upgrade paths
    (`bootstrap-venv.mjs`, `apply.ts`) re-run the swap.
  - All 12 `@app.on_event` handlers → one `lifespan` context manager (`main.py`), then `fastapi`
    `0.115` → `0.140` and `uvicorn` `0.30` → `0.51` (starlette rides transitively to 1.3.1).
    Startup order preserved exactly; shutdown stays in registration order (FastAPI runs it forwards —
    reversing would be a behaviour change). Teardown is in a `finally`, not after a bare `yield`,
    because `_DefaultLifespan.__aexit__` discards `exc_info` and runs shutdown unconditionally.
    `test_lifespan_order.py` pins both sequences against the actually-wired `lifespan_context`.
  - **Correction to the rationale**: the migration was NOT a hard prerequisite, contrary to what the
    working notes claimed. FastAPI 0.140 re-implements `_DefaultLifespan`, `APIRouter._startup()`,
    `._shutdown()`, `.add_event_handler()` and `.on_event()` locally to preserve backward compatibility
    after Starlette removed them. `on_event` is deprecated on a compat shim carrying its own removal
    TODO — that is the real reason to move, and the comments now say so.
  - Follow-ups folded in: `httpx2` adopted in `requirements-dev.txt` (#1843) so Starlette 1.3.1's
    `testclient` stops warning about the deprecated `httpx` fallback (`httpx` stays — gradio and
    safehttpx still import it); and `install-ort.mjs` now reports the package it actually swapped in
    (#1844) instead of hardcoding `onnxruntime-directml`, which was wrong on every profile that
    reaches the swap.
  - Still upstream-blocked, with corrected reasons in #893: `torch` 2.12/2.13 is blocked because
    **torchaudio's last release is 2.11.0**, NOT by the cu130 driver bump originally recorded;
    `transformers` 5.x and `huggingface_hub` 1.x are both frozen by `qwen-tts==0.1.1`'s exact
    `transformers==4.57.3` pin (#1228).
