Released 2026-07-10. [View on GitHub](https://github.com/dudarenok-maker/Castwright/releases/tag/v1.12.0).

---

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

release-notes-next-version: 1.12.0

DRAFT IN PROGRESS — v1.12.0 is accumulating (package.json is 1.11.0; not yet
cut). Reopened 2026-07-10 (the v1.11.0 cut on 2026-07-08 never got its
post-cut bootstrap — several PRs had been appending onto the stale v1.11.0
draft since; those entries are folded in below). Covers what has merged since
the v1.11.0 cut so far; extend as more lands. **FS-52 (caption/SRT export)
has landed** (see the headline section below) — the prior cut-blocker note
is resolved.
-->

**A more honest transcript, twice over.** A new deterministic evidence pass now catches and corrects tag-proven speaker mistakes before you ever see them, replacing the analyzer's own inflated self-reported confidence with an honest, derived one — and Script Review's findings, like your cast's own state, now survive a reload instead of evaporating the moment you look away. A couple of reliability fixes round out the polish: a stuck Qwen voice design now recovers on its own, and the Pinokio one-click installer — broken by an incomplete first fix — actually installs now.

---

## ✨ Headline features

### 🗣️ Deterministic dialogue-structure attribution (new) — srv-59
A structure-evidence pass now corrects tag-proven speaker mistakes before you ever see them, and replaces the model's own inflated self-reported confidence with an honest, derived value.

- **A new pure-code `server/src/analyzer/dialogue-structure/` module family** (per-language convention tables for en/es/fr/de/ru) slots into `attributeChapterStage2`: a structure parser derives `tag-name`/`tag-pronoun`/`alternation`/`unanchored` speaker evidence per paragraph, an aligner matches it against the stage-2 model output (tolerant of glyph/whitespace drift), and a cross-examiner replays every sentence against that evidence with confidence values drawn from one `CONFIDENCE` constants block instead of the model's own — measured on a 14,065-sentence Russian book, every sentence self-reported confidence ≥ 0.8, so the existing `< 0.75` low-confidence triage view never fired despite heaps of real ambiguity.
- **Two hard invariants:** a `tag-name` attribution is never overridden by anything, including the new default-on `'local'` escalation pass over unresolved conversation windows (`analyzer.structure.escalation`); a dash-continuation sentence inside a speech span is exempt from the narrator-default demotion, closing a bug in the shipped plan-221 Wave A heuristic this engine absorbs.
- **Engine-off (`analyzer.structure.enabled`, default on), an unsupported book language, or a chapter's alignment rate falling below its floor** all degrade to byte-identical pre-engine output. Two new additive `state.json` fields (`analysisProvenance`: engine/model/timestamp; a per-run structure-engine report: aligned%/confirmed/corrected/flagged/escalated) close a forensics gap — nothing previously recorded which analyzer produced a given analysis.
- New Castwright-owned dash-dialogue Russian fixture plus full unit/integration coverage across parser/aligner/cross-examiner/escalation/ windows. On-box acceptance against the full _Ночной дозор_ book is owed post-merge. See [plan 247](features/247-dialogue-structure-attribution.md) (#1482, srv-59, Closes #1471).

### 💾 Script Review results now persist (new) — fs-58
Findings from a script review used to live only in the moment — reload the page, close the tab, or click away, and they were gone, whether you'd acted on them or not. They now survive across a reload, and closing the results modal can never silently discard them.

- **The server checkpoints each chapter's findings into a per-book on-disk ledger** as a review runs — a mid-review reload reattaches to the same server-side job instead of losing it.
- **The modal's close paths now dispatch a non-destructive hide**; only an explicit, confirmation-gated "Dismiss all" discards findings. A badge + re-run confirm gate also stop a fresh review from starting blind over a chapter with unresolved findings already sitting untouched.
- **Fixed a data-loss bug found while shipping this:** a single-chapter (or partial) review run could silently wipe OTHER chapters' still-unresolved findings out of the in-memory bucket, and mount-time hydration could force-reopen a modal the user had explicitly hidden. `setReview` now merges by chapter instead of a whole-bucket replace; `hydrateBucket` preserves an existing bucket's `visible` flag. See [`docs/features/INDEX.md`'s fs-58 entry](features/INDEX.md) for the full design (#1479).

### 🎬 Caption/SRT export (new) — fs-52
Any finished book can now export `.srt`/`.vtt` captions — line, sentence, or word granularity, whole-book or per-chapter — as a new `captions` `BookExportJob` format (fs-52, #PR).

- **Line and sentence captions are pure metadata reconstructions** over `segments.json` + `manuscript-edits.json` (`server/src/export/build-captions.ts`, `caption-cues.ts`, `manuscript-sentences.ts`) — no new render-time data, no synthesis-path change. Line cues cap at 7s / 200 chars and always close on a speaker change; sentence text is always read from the live manuscript edits, never the (potentially stale) analysis cache.
- **Word captions add a new sidecar capability**: `/transcribe` accepts an `X-Word-Timestamps` header that requests faster-whisper's per-word alignment and switches on `condition_on_previous_text` for cross-window coherence — a distinct decode profile from the existing ASR content-QA caller, which never sets it, so that path is untouched. Always one whole-chapter Whisper call, run at export time only (never during synthesis).
- **De-dupe and filenames are now caption-variant-aware**: the export queue's same-format revocation and filename derivation key on `captionFileFormat`/`captionGranularity`/`captionScope`, not just `format`, so the 12 caption variants (2 file formats × 3 granularities × 2 scopes) no longer collide.
- **A staleness guard protects against captions drifting from the audio.** A segment whose `textHash` no longer matches its current manuscript text fails the export outright with a "regenerate this chapter" error; a segment rendered before `textHash` existed (pre-#1105) instead sets a non-fatal, persisted job `warning` surfaced as an amber caption on the export-queue row — captions still ship, but flagged as unverifiable rather than silently trusted.
- New Captions tile on the Listen view's "Or download a file" section (`src/modals/export-audiobook.tsx`, `src/components/listen/listen-download-section.tsx`). See [plan `2026-07-10-fs52-caption-srt-export.md`](features/2026-07-10-fs52-caption-srt-export.md) (fs-52, Closes #975).

---

## 🔊 Generation quality & reliability

- **A Qwen voice design could intermittently fail with a blank "Internal error."** `_load_qwen_model` (`server/tts-sidecar/main.py`) has hit a recurring, intermittent `NotImplementedError: Cannot copy out of meta tensor` when moving a freshly loaded VoiceDesign model onto the GPU since 2026-05-26 (86 occurrences) — some submodule the checkpoint doesn't cover lands on the `meta` device, and every reload attempt in the same sidecar process keeps failing identically; only a fresh process has been observed to load cleanly. The load failure now schedules a sidecar self-recycle on a dedicated exit code (`_MODEL_LOAD_FAULT_EXIT_CODE = 44`, deliberately distinct from the memory-watchdog's restart code so it can't trip the Node supervisor's unrelated "device too small" streak-trip) — the failing request still surfaces its real error, but the next design attempt hits a clean process instead of failing forever. This is a mitigation, not a root-cause fix; the underlying `transformers`/`qwen_tts` interaction is tracked in #1469 (#1470).

## 🏗️ Under the hood

- **Script Review's in-flight jobs can now be cancelled, and a reload can no longer silently start a duplicate re-review.** Two narrow, deliberately-accepted gaps in the persistence work above (#1479) are closed. A new book-level `POST .../script-review/cancel` reuses each running job's existing `AbortController`; a mid-chapter cancel now skips the checkpoint for the in-flight chapter entirely rather than persisting a partial result the ledger couldn't distinguish from a fully-reviewed one, and the SSE stream now ends with a terminal `cancelled` event instead of hanging with no terminal event at all. A new join-only `POST .../script-review/attach` closes a TOCTOU race in the reattach-on-reload path: if the job finished in the gap between the client's `GET /state` and its join, the route now 404s instead of falling through to create a fresh job, and the client falls back to a plain ledger re-read instead of silently re-running the whole review. `attachToRunningReview` deliberately still never dispatches the shared `clear` action itself, preserving the persistence work's own concurrent-reattach fix (#1481).
- **The off-roster reattribute confirm form could leak a field across a multi-op batch.** `CreateCharacterForm`'s name/gender/ageRange fields are seeded via `useState(initial ...)`, which only runs on first mount; `ScriptReviewDiff`'s confirm-queue overlay (`src/components/script-review-diff.tsx`) rendered the same JSX element across every `confirm.index` advance with no `key`, so React reused the instance and a field typed for op N could survive into op N+1's own form — and, if unedited, reach op N+1's create/reassign call. The form is now keyed on the op's own identity (`opKey`) so it remounts, and its state resets, on every confirm-queue advance (#1480).
- **The Pinokio one-click installer's menu was fundamentally broken, across two attempts to fix it.** First surfaced during on-box acceptance (#822): root `pinokio.js` used CommonJS syntax (`require`/`__dirname`/`module.exports`) under the root `package.json`'s `"type": "module"`, throwing a `ReferenceError` (bug #1458) — "fixed" by rewriting it as genuine ESM (`import`/`export default`), on the assumption that Pinokio's runtime dynamically `import()`s app scripts. That assumption was itself wrong (bug #1484): Pinokio's kernel (`pinokiocomputer/pinokiod`, `kernel/loader.js`, `requireJS()`) actually loads scripts with a plain synchronous `require(filepath)`, which cannot load an ES module at all — so the install screen still never loaded, for a different reason. Root `pinokio.js` is now genuine CommonJS again, matching every other `pinokio/**` script, and the root `package.json` is `"type": "commonjs"` (was `"module"`) to make that load correctly; `eslint.config.js` — the only other bare `.js` file at the repo root relying on ESM syntax — is renamed to `eslint.config.mjs` to keep working under the new default. The regression test now `require()`s the entry via `createRequire` instead of dynamically `import()`ing it, so it actually reproduces Pinokio's real loading path (#1458, #1484, #1485).
- **FlashAttention-2 detection is no longer Windows-only, and the stale Windows pin is no longer the only path.** `install-qwen3.mjs --flash-attn` now checks whether `flash_attn` is already importable in the sidecar venv on ANY platform/accelerator profile first — if so, it just reports how to activate it (`QWEN_ATTN_IMPL=flash_attention_2`) rather than attempting a reinstall. On Linux, when it isn't already present and the standalone NVIDIA CUDA Toolkit (`nvcc`) is on PATH, the installer now attempts an unpinned `pip install flash-attn --no-build-isolation` build; without the toolkit it skips cleanly instead of burning a doomed compile. The Windows pinned-wheel path (still cp311-only; the cp312/torch2.11/cu128 real-stack fix is tracked on side-22, #1001) is unchanged. (side-21, #1000)
- **The library welcome subhead no longer hardcodes "book seven."** `LibraryChrome` (`src/components/library/library-chrome.tsx`) claimed a character "carries through to book seven" regardless of how many books are actually in the library — now reads "book after book," which holds true at any count (#1493, Closes #1461).

---

**Full changelog:** v1.11.0...v1.12.0
