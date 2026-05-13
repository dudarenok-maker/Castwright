# Feature regression plans

Living specs for every feature shipped in v1. Each plan combines **invariants to preserve** (structural rules a refactor must not break) and an **acceptance walkthrough** (manual click-through with expected URL hashes, redux state, and network calls). Partial features are documented as-is with a `KNOWN: scaffolded` banner so reviewers do not mistake "documented current behavior" for "fully working."

PRs that change behavior cited in a plan MUST update the relevant plan in the same diff — that is the regression discipline the plans buy.

## How to run a plan

1. Pick a plan from the index.
2. Read the **Invariants** section first; if any cited file/line has moved, the plan is stale — fix it before validating behavior.
3. Walk the **Acceptance** steps against a running app (`npm run dev`, plus `cd server && npm run dev` and the TTS sidecar if the plan covers audio).
4. Any drift → update the plan in the same PR as the code change.

## Plans by area

### A. Stage machine & routing
- [00 — Stage machine](00-stage-machine.md) — `ui.stage` discriminated union and reducer-guarded transitions.
- [01 — Hash router](01-hash-router.md) — URL ↔ stage two-way sync, URL grammar.

### B. Upload & import
- [02 — Upload (paste or file)](02-upload-paste-or-file.md) — `.md/.txt/.epub/.pdf` upload + paste flow.
- [03 — Import & confirm metadata](03-import-confirm-metadata.md) — Parse-only import then confirm-write to disk.

### C. Analysis pipeline
- [04 — Analysing view & SSE progress](04-analysing-view-progress.md) — Stream rendering, live ETA, model selection, "Start fresh."
- [05 — Manual handoff analyzer](05-analyzer-manual-handoff.md) — `ANALYZER=manual` file-drop cowork loop.
- [06 — Gemini analyzer](06-analyzer-gemini.md) — `ANALYZER=gemini` direct-API mode.
- [07 — Audio tag vocabulary](07-audio-tag-vocabulary.md) — `[tag]` vocabulary UI ↔ parser sync.
- [08 — Audio tag auto-detection](08-audio-tag-auto-detection.md) — Server-side auto-tagging from punctuation/markdown/HTML.

### D. Voice matching & cast
- [09 — Voice match pipeline](09-voice-match-pipeline.md) — Post-analysis library matching.
- [10 — Profile drawer](10-profile-drawer.md) — Character edit drawer + sample preview + evidence toggle.
- [11 — Batch character regenerate](11-batch-character-regenerate.md) — Multi-select character → chapter-range regen.

### E. Manuscript editing
- [12 — Manuscript view](12-manuscript-view.md) — Sentence list, low-confidence flagging, speaker reassignment.

### F. TTS
- [13 — TTS engine picker](13-tts-engine-picker.md) — Two-tier engine + model selector.
- [14 — Coqui XTTS sidecar](14-tts-sidecar-coqui.md) — Local sidecar default.
- [15 — Gemini cloud TTS](15-tts-gemini-cloud.md) — Cloud opt-in.

### G. Generation
- [16 — Generation stream](16-generation-stream.md) — Chapter audio SSE stream. Cross-links to plan 28 for the on-disk format.
- [17 — Regenerate this/forward](17-regenerate-this-or-forward.md) — Per-chapter + per-character regen.
- [28 — Chapter audio format](28-chapter-audio-format.md) — MP3 VBR V2 via ffmpeg; legacy `.wav` fallback; ffmpeg preflight in `start-app.ps1`.

### H. Playback & listen
- [18 — Listen view](18-listen-view.md) — Cover, chapter list, mini-player, handoff queue.
- [19 — Listener preview](19-preview-listener.md) — Listener-POV full-screen preview.

### I. Revisions & drift
- [20 — Revisions & drift](20-revisions-and-drift.md) — Pending drafts + drift events + dismissal.

### J. Library & workspace
- [21 — Book library](21-book-library.md) — Workspace scan + status derivation.
- [22 — Voice library](22-voice-library.md) — Cross-book voices view + pinning.

### K. Cross-cutting invariants
- [23 — Mock toggle](23-mock-toggle.md) — `VITE_USE_MOCKS` flips real ↔ mock; components stay neutral.
- [24 — OpenAPI source of truth](24-openapi-source-of-truth.md) — Types come from generated `api-types.ts`.
- [25 — Design tokens](25-design-tokens.md) — Colours via CSS variables only.
- [26 — RTK Immer drafts](26-rtk-immer.md) — Reducers mutate, never spread.

### L. Book state persistence
- [27 — Book state persistence](27-book-state-persistence.md) — `.audiobook/state.json` hydration + slice PUT patches.

## Status legend

- **stable** — feature is end-to-end functional; assert real behavior.
- **KNOWN: scaffolded** — UI/contract is in place but parts are mocked or partial; assert only the documented behavior.
- **KNOWN: backend-pending** — frontend done, backend stub returns empty/canned data; mock mode exercises the UI, real mode is intentionally a no-op.
- **KNOWN: operational dependency** — works but requires a sibling process the user must start (TTS sidecar).
