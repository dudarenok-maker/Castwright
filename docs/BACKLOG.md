# Backlog (MoSCoW)

The live backlog. Every outstanding item from `docs/features/*.md` plan bodies,
CLAUDE.md "Suggested follow-ups", deferred sections, KNOWN-scaffolded plans,
and untested territory.

**Update rule:** Future rounds of planned work pull from this list. Bugs are
out-of-band (the user files them as they hit them; they don't queue here).
When an item ships:

1. Remove its bullet here.
2. Update the source plan's `status:` / fill its **Ship notes** section.
3. If the plan is now `stable`, move it to `docs/features/archive/` per
   [`archive/README.md`](features/archive/README.md).

When you discover a new outstanding item (a new "Suggested follow-up" added
to a plan, a TODO landed in code, a flaky test quarantined), add it here in
the same PR — the backlog is only useful while it stays current.

**Each item carries:**

- **_What_**: one-sentence concrete description so the work is actionable from this bullet alone.
- **_Acceptance_**: observable criteria for "done", so future-you knows when to remove the bullet.
- **_Key files_**: starting points so the next pick-up doesn't spend an hour spelunking.
- **_Depends on_**: (optional) — listed only when there's a real prerequisite.
- **_Benefit (axis)_**: the _why_ (user / technical / architectural).

**Item IDs are permanent.** Each item carries a `<prefix>-<n>` ID: the prefix is
its dominant area — `fe` (frontend), `srv` (server), `side` (TTS sidecar), `ops`
(CI / build / dev-tooling), or `fs` (full-stack) — and `<n>` is sequential within
that prefix. IDs are assigned once and **never reused or renumbered**: a shipped
item's ID is retired, not recycled, and gaps are expected. Cite an item by its ID
from code or docs and the reference won't rot.

**Priority = position.** Top of a bucket — and top of a sub-group within a bucket —
is highest priority. Reprioritising is pure reordering; it never changes an item's
ID. The MoSCoW bucket is shown by its section heading; an item that moves buckets
keeps its ID.

---

## Must — blocks v1 ship or hurts existing users

### `fs-1` — In-app upgrade pathway (package-drop install with data migration)

Source: net-new (2026-05-22). Captured during planning of the cross-version upgrade flow; user-flagged as the top-priority Must for the next round of work, ahead of multi-language. Full design captured in `~/.claude/plans/as-we-are-now-refactored-cupcake.md` — move into `docs/features/NN-in-app-upgrade.md` when the round opens.

- _What:_ Turn cross-version upgrades into a one-click Account-tab flow for hand-delivered alpha bundles (no GitHub polling — explicit user direction). Three coupled pieces. **(a) Foundation** — new `GET /api/info` endpoint reporting `{ appVersion, sidecarVersion, schemas, lastSeenAppVersion, showWhatsNew }`; schema-version stamping on `cast.json` / `manuscript-edits.json` / `revisions.json` / `listen-progress.json` / `voices.json` / `user-settings.json` mirroring the existing `state-migrate.ts` pattern (absence-means-v1 back-compat, refuses future schemas, identity migrations at v1); version pill in top-bar sourced from a `useAppInfo()` hook; sidecar exposes `__version__` in `/health`; `bump-version.mjs` extended to rewrite a new `server/tts-sidecar/version.py` in lockstep with the two `package.json`s. Boot-time `upgrade-coordinator.ts` walks every book on `lastSeenAppVersion ≠ appVersion`, snapshots all `.audiobook/*.json` + `voices.json` + `user-settings.json` to `<WORKSPACE_DIR>/.upgrade-backups/from-<old>-to-<new>-<iso>/` before re-stamping any stale-schema files. **(b) Upload + swap** — `POST /api/admin/upgrade/{stage,apply,abort}` + `GET /api/admin/upgrade/state` accept multipart zip upload, validate `audiobook-generator-vX.Y.Z/` root + embedded `package.json` + manifest sanity + SHA-256, refuse concurrent in-flight generation/analysis (409 with busy-book list) and unconfirmed downgrades (412), write `<WORKSPACE_DIR>/.upgrade-pending.json` and spawn a detached restarter via inline `child_process.spawn('node', ['-e', '<...>'], { detached: true })` (inline string so the swap can't delete its own supervisor mid-flight). `scripts/start-app-prod.mjs` detects the marker on boot and performs a preserve-list swap — **preserve** `server/user-settings.json` / `server/.env` / `server/tts-sidecar/.venv/` / `server/tts-sidecar/voices/kokoro/` / `audiobook-workspace/` / `logs/` / `.run/`; **swap** `dist/` / `server/dist/` / `server/tts-sidecar/*.py` / both `package.json`s + lockfiles. Run `npm ci` root + server; re-run `pip install -r requirements.txt` only when its hash changed; rename-aside `repoRoot.bak-<ts>/` until swap completes so any failure during steps 5–9 rolls back atomically; append every attempt (ok / failed) to `<WORKSPACE_DIR>/.upgrade-log.json`. Cross-platform Node ESM (Win + macOS + Linux per the alpha-tester spread), no PowerShell. **(c) UX** — Account view gets a top `Application updates` FormCard with a file-picker that POSTs multipart to `/stage`, a confirmation dialog showing v-from → v-to + short SHA-256 + bundled `RELEASE_NOTES.md` + data-safety blurb, and a full-screen `UpgradingScreen` overlay during apply that polls `/state` every 2s and `/api/info` every 2s; the overlay dismisses when `appVersion` flips, success toast fires, and a "What's new in vX.Y.Z" banner renders at the top of every view until dismissed (driven by the `showWhatsNew` flag clearing via `POST /api/info/dismiss-whats-new`). `scripts/build-release-zip.mjs` extended to bake `RELEASE_NOTES.md` (from the annotated tag body that `bump-version.mjs --notes-file` already captures) into the zip root and include it in MANIFEST.
- _Acceptance:_ Cut v1.4→v1.5 locally via `bump-version.mjs + build-release-zip.mjs` (with `--notes-file`); from a running v1.4, upload the v1.5 zip in Account tab → confirm dialog shows the version delta + correct SHA-256 + release notes → click Apply → overlay progresses through "Server restarting" / "Installing dependencies" / "Migrating book data" → within 90 s the version pill flips to v1.5, the What's-new banner appears, success toast fires. After upgrade: `.audiobook/state.json` + `cast.json` + `revisions.json` parse with stamped schemas; `audiobook-workspace/` intact; `server/user-settings.json` retains the user's Gemini key + theme + analyzer-model overrides; `server/.env` untouched; Kokoro voices still selectable. Failure-path coverage: with one in-flight generation, Apply returns 409 with the busy-book list and the dialog refuses to proceed; a corrupted zip returns 400 with a precise reason and no state change; a deliberately broken zip mid-swap triggers atomic rollback via `repoRoot.bak-<ts>/` with the old version booting back up. `<WORKSPACE_DIR>/.upgrade-backups/` contains a timestamped snapshot for the v1.4→v1.5 jump and `.upgrade-log.json` has an `ok` entry. Repeat the happy path on a macOS box (alpha-tester platform spread). New paired tests: Vitest pins per `*-migrate.ts` + `upgrade-coordinator` + `zip-validate` + `staging` + `upgrade-slice`; new Pester or Vitest harness drives `start-app-prod.mjs` against a temp dir for the marker-detection + swap + rollback paths; new pytest asserts sidecar `__version__` lands in `/health`; new Playwright e2e (`e2e/upgrade-flow.spec.ts`) drives stage→apply→banner against mocked endpoints + crosses router/redux/layout seams per CLAUDE.md's e2e rule.
- _Key files:_ **Foundation** — new `server/src/routes/info.ts`; new `server/src/workspace/{cast,manuscript-edits,revisions,listen-progress,voices-meta}-migrate.ts` (each mirrors the existing `server/src/workspace/state-migrate.ts:33-100` shape: `CURRENT_XXX_SCHEMA` + `migrateXxxJson` + `stampXxxSchema` + `UnsupportedXxxSchemaError`); new `server/src/workspace/upgrade-coordinator.ts` (called from `server/src/index.ts` after workspace mount, before serving); `server/src/workspace/user-settings.ts` (add `lastSeenAppVersion` + `schemaVersion` additive fields to the zod schema, no schema bump); `server/tts-sidecar/main.py` (new `__version__` constant, return in `/health` envelope) + new tiny `server/tts-sidecar/version.py`; `scripts/bump-version.mjs:142-198` (extend lockstep pre-flight to include the sidecar version file); new `src/lib/use-app-info.ts`; `src/components/top-bar.tsx` (small version pill near avatar); `openapi.yaml` (new `/api/info` shape). **Upload + swap** — new `server/src/routes/upgrade.ts` (four routes); new `server/src/upgrade/zip-validate.ts` + `server/src/upgrade/staging.ts` (busy-book probe must reuse existing analysis/generation state — locate + reuse, do not duplicate, per `feedback_verify_reanalysis_actually_needed`); `scripts/start-app-prod.mjs:18-80` (extend with marker detection + `safeRm()` preserve-list + extract + rollback before existing `probePort`/spawn logic); `openapi.yaml` (upgrade endpoints). **UX** — new `src/components/upgrade-card.tsx` (FormCard component); new `src/store/upgrade-slice.ts` (thunks + selectors, plays into `notifications-slice` for the success toast via `pushToast`); `src/views/account.tsx:248-260` (mount `<UpgradeCard />` as the FIRST FormCard above Profile); new `src/components/whats-new-banner.tsx`; `src/components/layout.tsx` (mount banner at top of every view when `showWhatsNew`); `scripts/build-release-zip.mjs:20-122` (bake `RELEASE_NOTES.md` from annotated tag body, add to MANIFEST.include). Full design + branching/wave decomposition + rebase notes in `~/.claude/plans/as-we-are-now-refactored-cupcake.md`.
- _Depends on:_ none structural. Reuses the schema-version pattern from `server/src/workspace/state-migrate.ts`, the existing `notifications-slice` `pushToast` shape, the user-settings zod schema in `server/src/workspace/user-settings.ts`, the existing analysis + generation state (busy-book probe), the existing `taskkill /T /F` sidecar teardown on Windows, the `writeJsonAtomic` + rotation contract from `state-io.ts`, the annotated-tag-body release-notes contract from plan 49, and the existing `release.yml` tag-triggered CI pipeline. The release zip's exclude list at `scripts/build-release-zip.mjs:62-91` already keeps the preserved paths (`.venv`, `voices/kokoro`, `.env`, `audiobook-workspace`) out of the bundle, so the swap script's preserve list aligns naturally with what the zip doesn't carry. Pairs structurally with `fs-2` (multi-language) — `fs-2`'s `language` field on `BookStateJson` is the first real test of the migration coordinator built here.
- _Benefit (user / architectural):_ removes the manual upgrade rite (download zip → extract → `npm ci` → restart) every alpha tester walks through every release; replaces it with a single click in the Account tab, with auto-backup-before-migrate as the data-integrity contract. Surfaces the version delta + release notes inline so testers always know what changed. Atomic rollback path when an upgrade goes sideways means the user never wakes up to a half-applied state. Architecturally: establishes the per-file schema-version pattern across the rest of the workspace (today only `state.json` has it), so `fs-2`'s `language` field — and every future non-additive shape change — has a tested migration seam instead of a one-shot ad-hoc script. Foundation work also enables future BACKLOG items `ops-1` (Windows installer) and `ops-2` (Docker image) to share the same `RELEASE_NOTES.md` + `/api/info` plumbing.

### `fs-2` — Multi-language support — same-language audio for same-language books (Russian first)

Source: net-new (2026-05-20). Captured during planning of the next full version update; user-flagged as critical for the next full version update.

> **Scope note (2026-05-24):** the **engine** half of this item — adding Qwen3-TTS 0.6B as a coexisting sidecar engine + per-engine voice plumbing + cross-platform install script — is being delivered by [plan 108](features/108-qwen-coexistence.md) (Kokoro + Qwen coexistence, English). What remains HERE is the **language** half: the BCP-47 `language` field on `BookStateJson`/`Book`/`Character`, Cyrillic auto-detection + confirm-metadata override, voice-library `language` filtering + auto-load on Russian-book select, the Cyrillic-aware Gemini token estimator, the analyzer language preamble, and the never-cross-language invariant. Re-scope the _What_/_Key files_ below to the language work when this item opens; the Qwen engine, `overrideTtsVoices` map, and install-script shape will already exist.

- _What:_ Lift the implicit English-only assumption across the stack. Add `language` (BCP-47 string, default `"en"`) to `BookStateJson` and the OpenAPI `Book` + `Character` schemas. Add **Qwen3-TTS 0.6B** as a third sidecar engine (Alibaba, Apache 2.0, ~2.5 GB on disk, 4–6 GB VRAM during synth — fits the existing analyzer-eviction pattern) with its own cross-platform install script. Pipe `book.language` through to every sidecar `/synthesize` call. Auto-detect language on manuscript drop (≥30% Cyrillic codepoints → `"ru"`) with a chip + override on the confirm-metadata view. Filter the voice library panel by `voice.language === book.language` and auto-load Qwen3 when a Russian book becomes active. Fix the Gemini analyzer's Latin-only chars/4 token estimator for Cyrillic. Inject a language preamble into analyzer skill prompts for non-English manuscripts. Listen-header language badge + dedicated library language filter pill (separate from free-text tags). **Hard invariant: never cross-language** — Russian voices never read English text, English voices never read Russian text.
- _Acceptance:_ Upload an English manuscript → behaviour unchanged from today (regression). Upload a Russian public-domain fixture (Pushkin / Chekhov — NOT the Marlow Story, that's English) → confirm-metadata chip detects Russian + allows override → opening the book auto-loads Qwen3 with the existing analyzer-eviction banner → cast picker shows ONLY Russian voices → preview button speaks a Russian pangram → generated chapter audio is Russian with zero English bleed-through. Cyrillic token estimate within ±10% of actual `usage.input_tokens` on a long chapter. Library `Russian` filter pill ANDs with existing tag filters. Concurrent-multibook invariant holds: starting Russian Book A then switching to English Book B mid-flight keeps Book B's picker English and Book A's in-flight analysis Russian. On a fresh clone with no Qwen3 weights, opening a Russian book surfaces a clear "run `npm run install:qwen3`" call-to-action — not a silent 404. New Vitest + Playwright coverage on every new seam (detect-language helper, voice-library filter, preview-text switch, listen-header badge, library language pill); new pytest case in `server/tts-sidecar/tests/test_qwen3.py` (Cyrillic input + `language: "ru"` → non-empty PCM, no cross-bleed under concurrent synth).
- _Key files:_ `openapi.yaml` (add `language` to `Book` + `Character`; `BaseVoice.language` already half-extended at `openapi.yaml:2181-2185`); `src/lib/types.ts:135-185` (`BookStateJson`); `src/store/book-meta-slice.ts:22-38` (`EditableBookMeta`); server state.json reader (default-back-fill migration on read). Sidecar: `server/tts-sidecar/main.py:176,403-409,436,468,527-532` + new `server/tts-sidecar/engines/qwen3.py` + new `server/tts-sidecar/scripts/install-qwen3.mjs` (Node ESM, cross-platform) + thin `scripts/install-qwen3.ps1` wrapper for Windows discoverability. Server: `server/src/tts/voice-mapping.ts:104-146,223-242` (add Qwen3 profile tables, language-aware `pickVoiceForEngine`), `server/src/tts/synthesise-chapter.ts` (thread `book.language` to sidecar), `server/src/tts/base-voices.ts:36-41` (populate the existing-but-unfilled `language` field on every voice), `server/src/analyzer/gemini.ts:553-562` (Cyrillic-aware `estimateInputTokens`), analyzer skill-prompt loader (language preamble injection). Frontend: `src/views/upload.tsx:141-163` + new `src/lib/detect-language.ts` + the confirm-metadata view (chip + override); `src/components/listen/listen-header.tsx:219-234` (badge); `src/components/voice-library-panel.tsx` (language filter), `src/components/voice-preview-button.tsx` (per-language sample text), `src/components/model-control-pill.tsx` (Qwen3 button + auto-load on Russian-book select); `src/components/library/library-chrome.tsx:49-56` + `src/store/library-slice.ts:111` (language filter pill ANDed with tag intersection). Tailwind config needs no work — General Sans / Lora / Inter all support Cyrillic. Full design intent + wave decomposition captured in `~/.claude/plans/ok-lets-do-a-delightful-kahn.md`; move into `docs/features/NN-multi-language-russian.md` when the next round opens.
- _Depends on:_ none structural. Reuses the existing sidecar load/unload + analyzer auto-eviction pattern (`POST /api/sidecar/{load,unload}` + `POST /api/ollama/unload` per `server/src/analyzer/ollama.ts:92`), the half-extended `BaseVoice.language` field, the per-engine `overrideTtsVoices` cast map, the tag-filter intersection at `src/store/library-slice.ts:111`, Vitest + RTL + Playwright harnesses, and the Kokoro install script as the shape reference for the new Qwen3 installer.
- _Benefit (user / architectural):_ unlocks Russian (and arbitrary future languages) as a first-class concept — Russian books play Russian audio with Russian voices, no cross-language artefacts. The BCP-47-string contract (vs. closed enum) makes adding Spanish / German / etc. a UI-list change rather than a contract migration. Engine choice (Qwen3 over XTTS) preserves the option to monetize: XTTS's CPML is non-commercial-only; Qwen3-TTS is Apache 2.0. Critical for the next full version update per user direction.

---

## Should — important, not blocking ship

### `srv-1` — Merge journal for deterministic alias un-link

Source: plan 95 ship (2026-05-22) — Out of scope. PR [#142](https://github.com/dudarenok-maker/AudioBook-Generator/pull/142) shipped editable cast aliases with a Reattribute Lines modal that uses the preserved Phase-0a `chapterCast` as a lineage proxy to narrow the user's manual reattribution from "whole book" to "these N chapters." It works, but it's not deterministic — a chapter shows up if the alias was in its Phase-0a roster, even when the merge that put the alias on the source character happened mid-book and didn't actually rewrite any chapter-1 sentences. The user has to skim and reassign.

- _What:_ At every cast-merge call site (manual merge route, fold-minor-cast post-stage-2 pass), append a record to a per-book journal file `<bookDir>/.audiobook/cast-merges.json` of shape `{ ts, kind: 'manual' | 'fold', sourceId, sourceName, targetId, affectedSentenceIds: number[] }`. The unlink-alias route then reads this journal to compute `impactedChapters.candidateSentenceIds` as the exact sentences originally rewritten by the merge — no `chapterCast` heuristic, no per-chapter listing of sentences that may belong to a third party.
- _Acceptance:_ A book with a single mid-flight merge that touched 12 sentences (all in chapters 7-9) → the unlink-alias modal lists exactly those 12 sentences across chapters 7-9, nothing else. Today's `chapterCast` path would also list chapters 1-6 sentences attributed to the source if the alias name happened to be in their roster too (false positives the user has to skip).
- _Key files:_ `server/src/routes/cast-merge.ts` (write the journal entry alongside the manuscript-edits rewrite), `server/src/analyzer/fold-minor-cast.ts` (caller-side hook so post-stage-2 folds also log), `server/src/routes/cast-aliases.ts` (replace the `chapterCast` derivation with a journal lookup), `server/src/workspace/paths.ts` (new path helper).
- _Migration:_ books that pre-date the journal still get the `chapterCast` fallback (today's behaviour); only newly-merged ones benefit. No backfill — the lineage was lost at the old merges and there's no way to reconstruct it.
- _Benefit (user):_ reattribute modal becomes a precise checklist instead of a scoped review — every row the user sees is provably their merge's work, no third-party sentences to skip over. Big quality-of-life win for series-2-into-1 cleanups where merges pile up.

### `srv-13` — Analysis-time cross-book reuse linking — Facet B (reparse preservation)

Source: net-new (2026-05-28), filed from the series-reuse repair session. Full scope in [`126-analysis-time-reuse-linking.md`](features/126-analysis-time-reuse-linking.md). **Facet A (auto-link at analysis) + the `srv-14` denormalisation it builds on shipped 2026-05-30** (this round, `feat/server-analysis-reuse-linking` — commits `cb65724` srv-14, `33cc87a` Facet A). What remains is Facet B below.

- _What:_ Preserve cross-book "reused" continuity (`matchedFrom` + unified `voiceId` + `voiceState:'reused'` + aliases) **across reparse**. Today reparse **deletes `cast.json`** (`book-state.ts:722-723`), so the links Facet A establishes evaporate on the next re-analysis. Read the existing cast before deleting and carry forward per-character `matchedFrom`/`voiceId`/`voiceState`/`aliases` for surviving characters (match by id, then name/alias), mirroring the `cast-slice.ts:mergeCharacters` preservation pattern (which already preserves tuned/locked voices). Facet A is unaffected — it re-establishes links on a full `/analysis/stream`; Facet B stops a reparse from silently dropping them in between.
- _Acceptance:_ Reparsing a series book whose recurring characters were auto-linked keeps the Reused badges + shared designed voice instead of reverting to "Designed"/unlinked. User-tuned/locked voices still survive. New `book-state.test.ts` reparse-preservation cases.
- _Key files:_ `server/src/routes/book-state.ts` (reparse preserve — the cast.json delete site ~L722-723), `src/store/cast-slice.ts` (`mergeCharacters` reference pattern).
- _Depends on:_ Facet A (shipped this round).
- _Benefit (user / technical):_ series continuity survives re-analysis — no re-running a repair after every reparse. Closes the remaining durability gap left after Facet A.
- _Also remaining (follow-up, surfaced this round):_ a SECOND Phase-0b finalise site in `analysis.ts` — the failed-chapter retry/resume `runChapterCastSubset` path (~L3508, writing cast.json ~L3712) — does NOT run Facet A's link pass, so a book completed exclusively via the chapter-retry path persists an unlinked cast.json until the next full `/analysis/stream`. Belt-and-suspenders; fold into Facet B or a tiny standalone fix.

### `srv-17` — ~~Root-cause the silent server-child death~~ → RESOLVED as a startup port collision (2026-05-31)

Source: net-new (2026-05-30). **Resolved 2026-05-31** (branch `fix/server-listen-eaddrinuse`). Plan 145's handlers captured the crash, and it was **not** the hypothesised mid-run silent death: both `[server] FATAL uncaughtException` lines (08:34 + 14:55, `logs/server.err.log`) were `listen EADDRINUSE: address already in use :::8080` at **startup** — a double-start while a prior instance still held the port. The server never logged a mid-run FATAL across the whole run; the perceived "death" was a *stuck* server (the 14:19–14:21 recycle-drain cascade + a handled 600 s ch29 timeout — sidecar instability, see `side-11` / the recycle-drain-cascade) plus a restart that collided on `:8080`.

- _What (done):_ `app.listen` had no `'error'` handler, so the bind failure bubbled to the plan-145 `uncaughtException` handler as a cryptic stack. Added `attachListenErrorHandler(server, port)` (`server/src/crash-logging.ts`) on both the HTTP and HTTPS listeners in `index.ts`: EADDRINUSE → actionable *"Port N is already in use — another server instance is likely already running…"* + clean `exit(1)`; any other bind error → generic FATAL + stack. EADDRINUSE no longer reaches the uncaughtException path.
- _Acceptance (met):_ paired `crash-logging.test.ts` cases pin `formatListenError` (EADDRINUSE hint vs generic FATAL) and `attachListenErrorHandler` (logs + `exit(1)`). Manual: a second `npm run dev` against an occupied `:8080` prints the actionable line, not a raw stack. Regression: `docs/features/145-server-crash-diagnostics.md` "srv-17 follow-up" section.
- _Residual watch:_ the mid-run silent-death hypothesis was never reproduced; the plan-145 `uncaughtException`/`unhandledRejection` handlers stay armed as the ongoing watch. The run-instability that *looked* like a death is tracked under `side-11` (eliminate the host-memory leak so the sidecar stops recycling mid-run), not here.

### `side-11` — Eliminate the variable-input-shape host-memory leak (so recycling isn't needed)

Source: net-new (2026-05-30), from the live leak investigation (plan 143 + the user-supplied Qwen-leak research report). **Promoted Could → Should 2026-05-31** — the overnight full-book run confirmed RTF is solved (~1.04, ~realtime), so the next end-to-end win is no longer speed; it's removing the recycle interruptions this leak forces. The Qwen generation forward leaks host RAM monotonically because every sentence is a different length → a new native per-shape workspace that's never freed (RSS climbs, CUDA flat — pytorch/pytorch #32596; confirmed: fixed-shape batches hold flat, variable-shape generation climbs). Plan 143's process-recycle (RSS-ceiling self-restart via srv-15) is the safety net, but on the 2026-05-31 run it fired ~every 10 chapters and each recycle dropped the in-flight chapter to a failed state (`srv-17c`) until retried. Eliminating the leak means a full book runs on one warm sidecar with **no recycles, no dropped chapters**.

- _What (candidates, test cheapest first):_ (1) `torch.backends.mkldnn.enabled = False` — if the per-shape workspace is CPU MKLDNN (speech_tokenizer / Code2Wav decode on variable-length inputs), this kills it at a small CPU-op cost; one-line, env-gated, test with a variable-shape repro. **LANDED ([plan 153](features/153-sidecar-variable-shape-host-leak.md)): env-gated `SIDECAR_DISABLE_MKLDNN` (default OFF) in the shared `_apply_torch_perf_flags` hook + the leak-slope instrument `bench-tts.py --mem-sample` (seeded variable-shape batch loop sampling `/debug/memory`'s new `committed_mb`, prints the committed-private slope MB/batch) + paired pytest. AWAITING the live reboot→A/B (flag OFF vs ON); PASS = ON slope ≈ flat → flip the default ON.** (2) **Pad batches to a small set of fixed shapes** (fixed width + fixed max-len buckets) so shape variety collapses → workspace reuse; trades padding-RTF for leak-freedom (re-tune plan 128 bucketing + a python-side pad in `synthesize_batch` — the Node packer alone can't set the tensor shape). **Fallback — build only if candidate 1 fails the A/B.** (3) ~~`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`~~ — **SHIPPED in plan 144** (default in the sidecar spawn env), but that was for the *separate* CUDA-fragmentation VRAM OOM (the 2026-05-30 mid-run `CUDA error: out of memory`), NOT this host leak; left here only to note it's done. (4) Try a known-good torch/transformers combo (avoid torch 2.0.1's variable-shape leak; transformers ≥4.40 DynamicCache lifecycle). (5) If a clean minimal repro persists, file upstream `QwenLM/Qwen3-TTS` (the `--mem-sample` bench is that minimal repro).
- _Diagnostic already in place:_ `GET /debug/memory` (now also exposing `committed_mb`, the recycle's own metric) + the `sidecar memory:` watchdog log give the RSS/private/CUDA curve; `bench-tts.py --mem-sample` is the controlled variable-length repro + slope verdict. **Keep this item open until the candidate-1 A/B + a full-book run confirm a flat committed floor with zero recycles; on a pass, note "recycle now a safety net, not load-bearing" and close.**
- _Key files:_ `server/tts-sidecar/main.py` (model load / mkldnn flag), `server/src/tts/synthesise-chapter.ts` (batch shaping / bucketing), `server/src/tts/spawn-sidecar.ts` (env injection like `PYTORCH_CUDA_ALLOC_CONF`).
- _Benefit (user / technical):_ no mid-run recycle interruptions or dropped in-flight chapters (`srv-17c`) on long books — the cleanest end-to-end improvement now that RTF is acceptable. Pairs with `srv-17c` (drain/requeue the in-flight chapter): fixing the leak removes the recycle that triggers it. The `docs/tts-performance.md` "open levers" list points here as the next thing to play with.
- _2026-05-31 update (the Hollow Tide CH24, see [plan 154](features/154-false-gemini-rate-limit-misclassify.md)):_ live `/debug/memory` with **zero models loaded** still showed `cuda.allocated_mb ≈ 9889` / `reserved_mb ≈ 13117` (host `rss ≈ 17 GB`, `committed ≈ 28 GB`) — i.e. **orphaned CUDA tensors** surviving `gc.collect()` + `empty_cache()`, a VRAM-side facet distinct from (but compounding) the committed-host slope above. **Root-caused + FIXED this round ([plan 155](features/155-qwen-load-failure-reclaim.md)):** `QwenEngine._load_qwen_model` had no reclaim on its failure path, so a load that materialised weights then raised on `inner.to(device)` (a CUDA OOM partway through the move when the card is already pressured) orphaned the partial model — `nn.Module` cycles keep its tensors alive past the failing frame and `_ensure_*_loaded` never assigned them, so repeated failed reloads accumulated VRAM. The load now mirrors `unload()`: drop the partial + `_reclaim_host_and_vram()` before re-raising (paired `test_qwen_load_reclaim.py`).
- _Next round (in priority order — all still open):_
  1. **Run the plan-153 MKLDNN A/B** — needs a clean reboot, then `bench-tts.py --mem-sample` with `SIDECAR_DISABLE_MKLDNN` OFF vs ON; PASS = ON slope ≈ flat → flip the default ON. This is the cheapest shot at the *committed-host* slope (the leak that actually forces recycles). **Measurement, not new code.**
  2. **Recycle-at-chapter-boundary (#4)** — make a recycle never land mid-chapter: sidecar surfaces a `recycle_pending` signal in `/health` (set when committed crosses a SOFT threshold below the hard ceiling) WITHOUT exiting; the server's generation worker checks it at a chapter boundary and triggers a clean recycle (`POST /recycle` → drain → respawn → readiness gate) before starting the next chapter. The existing HARD watchdog self-exit stays as the untouched backstop. Blast-radius mitigation even if the leak persists; cross-cutting (server + sidecar) so it's its own branch. Needs a live GPU run to tune the soft threshold.
  3. **Fixed-shape batch padding** (candidate 2 above) — only if the MKLDNN A/B fails; collapses shape variety so the native per-shape workspace is reused.
  4. **Known-good torch/transformers combo** (candidate 4) / **upstream `QwenLM/Qwen3-TTS` report** (candidate 5) — if a clean `--mem-sample` repro still climbs after the above.
- _Keep this item open_ until a full-book run holds a flat committed floor with zero recycles; on a pass, note "recycle now a safety net, not load-bearing" and close.

### `srv-19` — Default-bind the server to loopback; require an explicit opt-in to expose all interfaces

Source: net-new (2026-05-31), from the [security review](security/2026-05-31-security-review.md) (findings #1 + #2). The default HTTP dev mode (`app.listen(PORT)` with no host) binds `0.0.0.0`, so on a shared/untrusted network every unauthenticated route — including the `/workspace` static mount that serves all manuscripts + audio + `state.json`/`cast.json` — is reachable by any LAN peer. The opt-in `LAN_HTTPS` mobile flow is *meant* to be reachable; the default dev mode is not.

- _What:_ pass an explicit host to the HTTP `app.listen` so the default bind is `127.0.0.1`, and only bind `0.0.0.0` when LAN mode is on (the existing `isLanHttpsEnabled()` already gates the HTTPS listener — reuse it, plus a `BIND_HOST`/`HOST` env override for power users). The LAN HTTPS path keeps binding all interfaces (unchanged). No new abstraction — one host argument threaded through the existing `listenerCallback` wiring.
- _Acceptance:_ with no env flags, `npm start` is reachable at `http://127.0.0.1:8080` but NOT from another machine on the LAN (connection refused). `npm run start:lan` (LAN_HTTPS=1) stays reachable on the LAN exactly as today. A `BIND_HOST=0.0.0.0` (or equivalent) escape hatch restores all-interface HTTP for users who want it. New server vitest pins the host argument selection for {default, LAN, override}; the existing LAN-mode tests stay green.
- _Key files:_ `server/src/index.ts` (the `PORT`/`LAN_HTTPS_PORT` listen block ~L360-362 + `listenerCallback`; reuse `isLanHttpsEnabled()`).
- _Depends on:_ none.
- _Benefit (user / technical):_ removes the "any device on the Wi-Fi can read all your books and burn your Gemini quota" exposure in the default mode, at the cost of one host argument — the cheapest meaningful hardening from the review. The deliberate mobile flow is untouched.

---

## Could — nice to have, low-cost wins

Organised into thematic sub-groups (audio & playback, revisions & history, cast &
voice, engine & sidecar, workflow & power-user, ops & distribution, listener-app
handoffs). Sub-groups and the items within them are ranked top = highest priority.

### Audio & playback

#### `fs-9` — Configurable chapter-title silence durations

Source: [`28-chapter-audio-format.md`](features/archive/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Acceptance:_ Editing a book's silence durations and regenerating one chapter produces an MP3 whose leading + post-title silence matches the new setting (ffprobe / spectrogram). Default for legacy books stays 1.5 + 1.5. Existing chapter-audio-format paired tests stay green.
- _Key files:_ `server/src/tts/synthesise-chapter.ts` (params); `server/src/routes/generation.ts` (forward); `server/src/workspace/scan.ts` (state-json field); `src/components/listen/listen-header.tsx` or sibling metadata editor (UI); `openapi.yaml` (book-state shape).
- _Depends on:_ none.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.

#### `fs-10` — Render the chapter-title segment on the Listen view timeline

Source: [`28-chapter-audio-format.md`](features/archive/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Acceptance:_ The listen view's chapter timeline shows a short "TITLE" pill at the head of each chapter rendered after this lands. Clicking it seeks to t=0. Pre-existing chapters whose `segments.json` has no title-kind row degrade gracefully (no title pill — same as today).
- _Key files:_ `openapi.yaml` (ChapterAudio segments shape); `src/lib/api-types.ts` (regenerated); `server/src/routes/chapter-audio.ts` (drop the filter, pass kind through); `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none (the on-disk segment shape already carries `kind: 'title'` since PR #101).
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.

#### `fe-6` — Waveform memoisation

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item C6).

- _What:_ In `src/components/waveform.tsx`, stabilise the 48-bar `useMemo` (memo key invariant against re-mount) and lift the animation interval to the parent so it ticks once per listen-view mount (not per waveform instance).
- _Acceptance:_ Listen view with N visible waveforms ticks on one shared interval (not N intervals); the rendered output is visually unchanged from today.
- _Key files:_ `src/components/waveform.tsx`; parent in `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none.
- _Benefit (technical):_ avoids 480+ DOM mutations per 800 ms when many waveforms are visible simultaneously. Low real-world impact today (rare to see >3 waveforms at once).

#### `fs-3` — Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/archive/28-chapter-audio-format.md) follow-ups.

> **Re-prioritised Should → Could (2026-05-26):** generation now runs close to real-time speech speed (Qwen end-to-end ~RTF 1.15, Kokoro faster), so the wait a streaming player would hide is small — a chapter finishes about as fast as you could start listening to it stream. Worth doing for the "listen as it generates" polish, not for throughput.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### Revisions & history

#### `fs-5` — Multi-step rollback / snapshot-per-entry (revision history)

Source: net-new (2026-05-19). Spun off from plan 55 ship — v1.3.0 plan 55 ships the read-only history view; this entry covers the multi-step rollback that needs snapshot-per-entry storage.

> **Standalone value (2026-05-26):** kept in Could on its own merits after `fs-4` (per-segment commits) was retired — this is _chapter-level_ non-linear undo (whole-entry rollback), not segment-level, and plan 55's slice plumbing (`rolledBack` reducer + `reversible` field) is already on disk, so it's a self-contained feature, not gated on segment-level revision.

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Acceptance:_ Generate chapter, regenerate twice, accept both. Open History → 2 active entries each `reversible: true`. Click Rollback on entry 1 → chapter audio reverts to entry-1's state; entry 2 marked `rolled-back-from`. New rollback can target a still-reversible entry; double-rollback → 409.
- _Key files:_ `server/src/workspace/preserve-previous-audio.ts` (extend filename pattern); new `server/src/routes/revisions-rollback.ts`; `src/components/revision-timeline-modal.tsx` (enable Rollback button on reversible entries); slice already plumbed (plan 55's `rolledBack` reducer + `reversible` field).
- _Depends on:_ plan 55 shipped (slice plumbing already on disk).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.

#### `fe-15` — Mock-mode chapters hydration so the revision A/B player opens in e2e

Source: plan 114 ship (2026-05-26). The profile-regen preview gate's full click-through (Preview → A/B → Approve fans out / Reject reverts) can't be e2e'd today because mock mode doesn't hydrate `chapters` from the library payload (`state.json` hydration throws under mocks), so `RevisionDiffPlayer` returns null when the fixture chapterId doesn't resolve. Same gap `e2e/revision-diff.spec.ts` documents — that spec asserts only the toolbar pill and never opens the player. (Supersedes the removed `fe-10`, whose cross-book `regenerateCharacter` stub premise went away with plan 114.)

- _What:_ Seed the chapters slice in mock mode (a mock `getBookState`/`state.json` that hydrates `chapters[]` for the canned complete book, OR a null-safe `RevisionDiffPlayer` fallback that renders from the revision stub alone when the chapter isn't in the slice). Then add `e2e/profile-regen-preview.spec.ts`: change a voice → Regenerate this character → Preview → A/B opens → Approve queues the rest / Reject reverts.
- _Acceptance:_ `RevisionDiffPlayer` opens under `VITE_USE_MOCKS=true` with a populated chapter; the new e2e drives the preview→approve and preview→reject paths green in chromium.
- _Key files:_ `src/mocks/*` (chapters/state seed), `src/views/revision-diff.tsx` (optional null-safe fallback), new `e2e/profile-regen-preview.spec.ts`.
- _Depends on:_ plan 114 shipped (the preview flow + its unit coverage are in; this closes the browser-level seam).
- _Benefit (technical):_ unblocks browser-level coverage of the preview gate's redux/layout/timing seam (auto-open on `chapter_complete`) that jsdom can lie about; also unblocks the long-deferred revision-diff player e2e.

### Cast, voice & duplicates

#### `fe-7` — Per-voice row sample-preview button inside `<VoiceOverridePicker>`

Source: net-new (2026-05-22).

> **Scope note (2026-05-24):** [plan 108](features/108-qwen-coexistence.md) surfaces `<VoiceOverridePicker>` for every character (not just library-matched ones) and reuses `playSampleWithAutoLoad` for current-vs-proposed audition in the rebaseline modal — so the in-row `▶` affordance described here is a natural add inside the same picker work. Land it as part of plan 108's Wave 4 per-character picker, or keep as a standalone follow-up. Deferred from the picker-autocomplete bundle — the model-voice override picker now uses the shared `<SearchablePicker>` primitive but renders each voice row as just `name`. The original plan reserved a tiny `▶` slot on each row for in-list auditioning so the user can preview a voice without committing the override; v1 ships with the row label only, matching the legacy `<select>` parity.

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Acceptance:_ Open the Profile Drawer's voice-override picker on the Kokoro tab. Click the `▶` next to a voice → that voice's sample plays without changing the current override. Pick the voice → override commits. Concurrent rapid clicks across rows fire one synth at a time.
- _Key files:_ `src/components/voice-override-picker.tsx` (renderItem extension), `src/lib/play-sample-with-auto-load.ts` (reuse as-is), no test churn beyond a new wrapper test for the play affordance.
- _Depends on:_ none.
- _Benefit (user):_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.

#### `fs-6` — Batch voice-replace across all books

Source: net-new (2026-05-18).

> **Re-scoped (2026-05-24, plan 108 shipped):** the _series-scoped_ per-character re-map is now delivered by [plan 108](features/108-qwen-coexistence.md)'s "Rebaseline the series" modal + `PUT /api/voices/:voiceId/override?scope=series` (re-map a character's engine + base voice across a series with current-vs-proposed audition). This item now covers ONLY what remains: the _library-level, workspace-wide_ "pick voice A → replace with voice B everywhere across ALL books (not just one series)" bulk affordance + multi-book audio invalidation.

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Acceptance:_ Three books each use voice `am_michael` for one character → batch replace `am_michael` → `am_eric` shows 3 affected pairs, confirm rewrites all three cast.json files, audio marked stale. Vitest covers the dry-run preview + write logic; e2e covers the modal flow.
- _Key files:_ new `src/modals/batch-voice-replace.tsx`; `src/views/voices.tsx` (entry point); `server/src/routes/voices.ts` (cross-book write endpoint); new `server/src/audio/invalidate.ts` (multi-book audio invalidation).
- _Depends on:_ none.
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.

#### `srv-7` — Cross-series voice linking

Source: net-new (2026-05-24). Surfaced during [plan 108](features/108-qwen-coexistence.md) planning — series scoping stops at the `(author, series)` boundary.

- _What:_ Plan 108's per-character engine + voice changes propagate across one series via `findAuthorSeriesForBookId`. A character who recurs across DIFFERENT series by the same author (or a shared-universe crossover) is not covered — the rebaseline / per-character write stops at the series boundary by design. Add an explicit cross-series link affordance (extend `Character.aliases` / a new link record) so a deliberate "this is the same voice across series X and Y" decision propagates voice + engine across both.
- _Acceptance:_ Link character A in series X to character B in series Y; a voice/engine change on A also writes B's cast.json. No implicit cross-series propagation without an explicit link (preserves the current series-boundary default).
- _Key files:_ `server/src/workspace/series-cast-scan.ts`; `server/src/routes/voices.ts` (cross-series write path); a new link record on `Character`.
- _Depends on:_ plan 108 (series-scoped write) shipped.
- _Benefit (user):_ recurring narrators / crossover characters stay consistent across an author's whole catalogue, not just within one series.

### Engine, sidecar & analyzer

#### `fe-4` — Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/archive/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) drives today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. Per the 2026-05-21 Kokoro-Stop-pill change, the hook now fans out per engine: it returns `{ coqui, kokoro, evictionNotice, loadErrorNotice, dismissNotices }` from a single /health probe. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`), picks the per-engine slot it cares about (`ttsLifecycle.coqui` / `ttsLifecycle.kokoro`), and renders the right pill via `ModelControlPill` with the matching `engineLabel`. No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — the per-engine fan-out is already in place); `src/components/layout.tsx` (no changes — already exposes the context and the `selectEnginesInUse` mounting pattern); `src/store/engines-in-use-selector.ts` (extend only if the new surface needs a different "is this engine relevant" predicate); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

#### `side-5` — Silence the benign Qwen `code_predictor` config-default log

Source: [`108-qwen-coexistence.md`](features/108-qwen-coexistence.md) post-ship `fix/sidecar-qwen-design-ref-text`.

- _What:_ The sidecar logs `code_predictor_config is None. Initializing code_predictor model with default values` around Qwen model load. **The perf question is resolved** (post-ship `fix/sidecar-qwen-design-ref-text`): the line originates in `qwen_tts`'s `Qwen3TTSTalkerConfig.__init__` (`configuration_qwen3_tts.py`) — HuggingFace config-defaulting at `from_pretrained`, NOT a per-sentence recompute. The design slowness that drew the eye was generation-length-bound (the calibration text voiced twice at RTF ~10 on the 1.7B model), fixed by the reference-text split. What remains is purely cosmetic: it's benign log noise that still reads as alarming.
- _Acceptance:_ Either suppress the line (raise the `qwen_tts` config logger level around the `from_pretrained` call) or add a one-line note in `server/tts-sidecar/README.md` documenting it as benign.
- _Key files:_ `server/tts-sidecar/main.py` (`QwenEngine._load_qwen_model`); the installed `qwen_tts` package (read-only — the log originates there).
- _Depends on:_ nothing.
- _Benefit (technical):_ stops a benign config log masquerading as a problem (it drew the eye during both the plan-108 OOM debugging and the design-timeout debugging).

#### `fs-13` — Exact per-character progress under parallel synthesis

Source: net-new (2026-05-28). Surfaced shipping the generation progress-bounce fix (PR #308, `fix/server-generation-progress-bounce`). That fix made the chapter "line N of M" counter monotonic by deriving it from a shared `completed` GROUP COUNT (plan 107 invariant 6) instead of each in-flight group's narrative position. Side effect: the per-character mini-bars in the Generate view (`linesDoneAt(positions, chapter.currentLine)`) now read `currentLine` as a COUNT, not a narrative watermark — so under genuinely out-of-order completion (`GPU_VRAM_BUDGET`/poolWidth > 1 + Qwen batching) a character whose lines cluster late/early in the chapter can read slightly low/high until the count catches up. Strictly better than the prior backward bounce, but no longer an exact per-character tally.

- _What:_ Carry per-character completion in the generation SSE tick so the Generate view renders an exact per-character "X / Y done" rather than deriving an approximation from one chapter-wide `currentLine` count. Likely shape: each completed-group tick includes the completed sentence id(s) (or a per-character done tally), and the frontend tracks the SET of completed positions per character instead of `linesDoneAt(positions, currentLine)`. Keep the chapter-level `currentLine`/`progress` as the monotonic count it is today — that part is correct.
- _Acceptance:_ Generate a multi-character chapter at `GPU_VRAM_BUDGET=2` + `QWEN_BATCH_SIZE=8` (forces out-of-order completion). Each character's mini-bar reflects exactly that character's synthesised lines at all times — never reads ahead of or behind its true done count — while the chapter-level counter stays monotonic. New paired test pins per-character accuracy under forced out-of-order completion.
- _Key files:_ `server/src/routes/generation.ts` (tick payload — emit completed sentence id / per-character tally; `onGroupComplete` already knows the group's `characterId` + `sentenceIds`), `server/src/tts/synthesise-chapter.ts` (`fireComplete`), `openapi.yaml` + `src/lib/api-types.ts` (`GenerationTick` shape), `src/lib/generation-progress.ts` (`linesDoneAt` → set-based), `src/store/chapters-slice.ts` (track completed positions per character), `src/views/generation.tsx` (per-character bar source).
- _Depends on:_ the progress-bounce fix shipped (PR #308) — builds on the same `completed`-count plumbing.
- _Benefit (user):_ per-character progress bars become exact under parallel synthesis, not a monotonic approximation. Low urgency — the bars are already monotonic and directionally right; this only bites if a user watches a single character's bar closely during a heavily-parallel run.

### Workflow, power-user & dev settings

#### `srv-2` — Auto-backup scheduling for `state.json`

Source: net-new (2026-05-18).

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Acceptance:_ Set daily backups → 14 daily snapshots accumulate in `.backups/`, oldest auto-pruned. Restore from snapshot → state.json reverted to that point; library view refreshes. New server Vitest spec covers the cron-like cadence + prune.
- _Key files:_ new `server/src/workspace/auto-backup.ts`; `server/src/workspace/scan.ts` (initial trigger on server start); new settings affordance under `fe-2` power-user panel (or inline in `src/views/library.tsx` if shipped first).
- _Depends on:_ none.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.

#### `fe-2` — Keyboard shortcuts / power-user tuning panel

Source: net-new (2026-05-18).

- _What:_ Add a settings panel (under a gear icon in the top-bar) for power-user tuning: keyboard-shortcut overrides (e.g. spacebar = play/pause), runtime knobs (SSE chunk size, TTS concurrency cap, debounce values for autosave), accessibility toggles (high-contrast theme, larger text). Settings persist in localStorage and apply on next render.
- _Acceptance:_ Open settings, change autosave debounce from 500ms to 2000ms → next edit waits 2s before write. Override "play/pause" shortcut to "K" → keyboard "K" toggles mini-player. Vitest covers the persistence + shortcut binding.
- _Key files:_ new `src/views/settings.tsx`; new `src/lib/keybindings.ts`; new `src/store/settings-slice.ts`; `src/components/layout.tsx` (gear icon entry point).
- _Depends on:_ none.
- _Benefit (technical / accessibility):_ power-user tuning surfaces today's hardcoded values; keyboard navigation closes an accessibility gap.

#### `fe-1` — In-app LAN HTTPS banner under dev settings

Source: net-new (2026-05-21). Plan 81 wave 1 / 2 deferred item.

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Acceptance:_ When LAN_HTTPS=1 is set on the server, the Account view shows a "LAN access" card with the live HTTPS URL + a QR code linking to `/cert/root.crt`. Tapping "Copy URL" puts the URL in the clipboard.
- _Key files:_ new `src/components/lan-access-card.tsx`; `src/views/account.tsx` (or wherever account settings render) to mount the card; `src/lib/api.ts` to wrap `GET /api/export/lan` if not already wrapped.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).

#### `fe-17` — "Resume generation" button on the Generate view

Source: net-new (2026-05-29). Plan 137 deferred follow-up.

- _What:_ Plan 137 made auto-enqueue fire ONLY on the explicit "Approve cast & start generating" CTA, so opening / re-opening a book never restarts generation. That leaves no in-view affordance to deliberately continue a book whose run was interrupted (queue drained server-side, some chapters still `queued`). Add a "Resume generation" button on the Generate view that dispatches the same `uiActions.requestStartGeneration()` intent, so a user can restart with one click without round-tripping back to the manuscript CTA. Show it only when the viewed book has `queued` chapters and nothing is currently in flight.
- _Acceptance:_ Open a book with some unfinished (`queued`) chapters and no live run on the Generate view → a "Resume generation" button appears; clicking it enqueues the remaining chapters and generation begins. While a run is live (or all chapters done) the button is hidden. Opening the book still never auto-starts (plan 137 invariant holds). New Vitest asserts the button dispatches `requestStartGeneration`; a Playwright case covers the resume click.
- _Key files:_ `src/views/generation.tsx` (the button + visibility predicate off `chapters` state); `src/store/ui-slice.ts` (reuse `requestStartGeneration`, no new action).
- _Depends on:_ plan 137 shipped.
- _Benefit (user):_ a deliberate one-click recovery path for interrupted runs, without re-auto-starting on every open — keeps the plan-137 "never auto-start" guarantee while restoring an explicit resume.

#### `fe-5` — Broad hover-affordance audit with `coarse-pointer:` Tailwind variant

Source: net-new (2026-05-21). Plan 81 wave 4 deferred item.

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Acceptance:_ All action-revealing hover patterns in cast, manuscript, voices, listen, generation views get a `coarse-pointer:opacity-100` (or appropriate) fallback. A test confirms `(pointer: coarse)` simulation reveals the same buttons hover would.
- _Key files:_ grep `src/**/*.tsx` for `group-hover:` / `peer-hover:` / `hover:opacity-0`; apply per-component judgement.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.

### Security & hardening

Source for the whole sub-group: the [2026-05-31 security review](security/2026-05-31-security-review.md). All are scoped to the **opt-in LAN exposure surface** (`npm run start:lan`) or local-only defense-in-depth — the app is single-user/local-first by design, so these harden the hostile-LAN and local-write threat models rather than fixing an exploited-today hole. `srv-19` (Should) is the partner default-bind fix.

#### `srv-20` — Optional shared-secret token for the LAN flow

Source: net-new (2026-05-31), security review findings #1–#4 (hostile-LAN scope). `srv-19` closes the default mode by binding loopback; the *deliberate* mobile flow still needs the LAN to reach it, and today does so with zero auth — so any peer on the same Wi-Fi has full unauthenticated API access while the phone/tablet is in use.

- _What:_ a single shared-secret token (env-configured, surfaced in the LAN URL / QR alongside the existing cert flow) checked by a small Express middleware on `/api/*` and the `/workspace` mount when LAN mode is on. Loopback requests bypass the check (so `npm start` is unaffected). Reuse the existing LAN-URL/QR plumbing (`GET /api/export/lan`, `npm run install:cert-mobile`) to carry the token.
- _Acceptance:_ with LAN_HTTPS=1 + a token set, a LAN request without the token gets 401; the printed LAN URL/QR embeds the token so the phone authenticates transparently; loopback requests need no token. New server vitest covers the middleware's {loopback-bypass, missing-token, valid-token} branches.
- _Key files:_ new `server/src/middleware/lan-auth.ts`; `server/src/index.ts` (mount before routers + the `/workspace` static); `server/src/routes/export-lan.ts` (embed token in the LAN URL); `scripts/install-cert-mobile.*` (show token in QR).
- _Depends on:_ `srv-19` (loopback-default) — the token only matters once LAN exposure is the explicit, narrowed surface.
- _Benefit (user):_ the mobile flow stops being "open to everyone on the network" without re-introducing friction — the token rides the URL the user already scans.

#### `srv-21` — Validate `sidecarUrl` (scheme + private-host allowlist) before fetch

Source: net-new (2026-05-31), security review finding #3 (SSRF). `sidecarUrl` from user-settings is validated only as `z.string().min(1).max(2000)`, then fetched directly (`sidecar-health.ts` + `/load`/`/unload`). Normally self-set, but reachable via the unauthenticated settings PUT over LAN (#1), so a peer could point it at an internal service and read probe responses.

- _What:_ tighten the zod validator (or a dedicated `assertSafeSidecarUrl`) to require `http`/`https` and a loopback/private-range host before any outbound fetch; reject otherwise with a clear 400 on the settings PUT.
- _Acceptance:_ setting `sidecarUrl` to a non-http scheme or a public host is rejected at PUT time; localhost / 127.0.0.1 / LAN-private hosts still accepted; sidecar health/load/unload behave unchanged for valid URLs. New vitest covers the allow/deny matrix.
- _Key files:_ `server/src/workspace/user-settings.ts` (the `sidecarUrl` zod field), `server/src/tts/sidecar-url.ts` or the resolver behind `getResolvedSidecarUrl()`, `server/src/routes/sidecar-health.ts`.
- _Depends on:_ none (independent of `srv-19`/`srv-20`, but lower-risk once those land).
- _Benefit (technical):_ closes the SSRF primitive; makes the sidecar-URL contract explicit instead of "any string we'll fetch".

#### `srv-22` — Constrain / document the `sync-folder/test` write-probe path

Source: net-new (2026-05-31), security review finding #4. `POST /api/user/settings/sync-folder/test` does `mkdir(recursive)` + `writeFile('ok')` + `unlink` on an arbitrary body-supplied `path` (validated as `z.string().max(2000)` only) — an arbitrary-mkdir / limited-clobber primitive reachable unauth over LAN.

- _What:_ the probe is a legitimate "is this folder writable" UX check, so the fix is proportionate: keep the feature but (a) refuse obviously-dangerous targets (system roots), and/or (b) document the trust boundary explicitly and lean on `srv-19`/`srv-20` to remove the unauth-LAN reachability. Decide between hard-constraint vs. document-and-gate when the item opens.
- _Acceptance:_ the probe still reports writability for a normal user-chosen sync folder; a system-root or traversal-y target is refused (if the hard-constraint path is chosen) or the reachability is closed by the bind/auth items; behaviour documented inline. New vitest pins the accept/refuse cases.
- _Key files:_ `server/src/routes/user-settings.ts:128-152` (the probe handler).
- _Depends on:_ pairs with `srv-19`/`srv-20` (which remove the unauth-LAN reach); standalone-fixable too.
- _Benefit (technical):_ removes a small unauthenticated filesystem-touch primitive without breaking the Test button.

#### `side-12` — Load Qwen voice `.pt` prompts with `weights_only=True` (or a safe format)

Source: net-new (2026-05-31), security review finding #5. `main.py:1251` does `torch.load(pt_path, weights_only=False)` on cached voice prompts in `QWEN_VOICES_DIR`. The file is app-written and the sidecar binds loopback, so it's not network-reachable — but `weights_only=False` deserialises arbitrary pickled objects, so anyone who can drop a `.pt` into the voices dir gets RCE in the sidecar process.

- _What:_ switch the voice-prompt load to `weights_only=True`; if the saved payload isn't a pure tensor/state-dict, migrate the design-time save (`design_voice`) to a safe container (safetensors, or JSON sidecar + tensors) so the load no longer needs arbitrary unpickling. One-time read-compat shim for already-cached `.pt` files (re-derive or one-shot re-save).
- _Acceptance:_ a freshly designed voice round-trips (design → cache → reuse) with `weights_only=True`; a crafted malicious `.pt` no longer executes code on load (raises instead); existing cached voices still work (via shim or re-save). New pytest in the sidecar suite covers the safe-load path + the rejection.
- _Key files:_ `server/tts-sidecar/main.py` (the `torch.load` at ~L1251 + the `design_voice` save site that writes the `.pt`); `server/tts-sidecar/tests/` (new case).
- _Depends on:_ none.
- _Benefit (technical):_ removes a local RCE-on-untrusted-file footgun; aligns with torch's `weights_only` default direction.

### Ops, CI & distribution

#### `ops-7` — Pin SHA256 for model + wheel downloads

Source: net-new (2026-05-31), security review finding #6 (supply-chain). `scripts/install-kokoro.ps1` downloads GitHub-release `.onnx`/`.bin` and `server/tts-sidecar/scripts/install-qwen3.mjs` runs `pip install -U qwen-tts` plus a third-party community FlashAttention wheel from `huggingface.co/lldacing/…`. All over HTTPS (wire-MITM covered) but with **no integrity pin** — a compromised upstream account or registry package serves trojaned binaries that execute at load/install time. Matters most because these scripts run on alpha-tester machines from the release bundle.

- _What:_ pin a known-good SHA256 for each downloaded artifact and verify after download (refuse + delete on mismatch): the kokoro `.onnx`/`.bin` release assets, and the FlashAttention wheel URL. For the pip installs, evaluate `pip install --require-hashes` against a pinned requirements set for the opt-in Qwen/FA2 deps (or at minimum pin exact versions). Surface a clear failure message pointing at the expected hash.
- _Acceptance:_ a tampered/partial download fails the hash check with an actionable error and leaves nothing installed; an untampered install succeeds unchanged; the FA2 wheel install verifies its hash before `pip install`. New Pester case for the PowerShell hash check; the `install-qwen3.mjs` hash check exercised in its existing test harness.
- _Key files:_ `scripts/install-kokoro.ps1` (post-download `Get-FileHash` compare), `server/tts-sidecar/scripts/install-qwen3.mjs` (`FLASH_ATTN_WHEEL_URL` verify + pip pinning), `scripts/lib/` if a shared verify helper is warranted, `scripts/tests/`.
- _Depends on:_ none.
- _Benefit (user / technical):_ closes the supply-chain gap on the binaries that run with the user's privileges on install — the sharpest of these is the single-maintainer community FA2 wheel. Cheap relative to the RCE blast radius.

#### `srv-4` — Track upstream-blocked deprecation chains (~~jsdom~~ · ~~archiver~~ · @google/genai)

Source: net-new (2026-05-22). Surfaced by the full `npm install` deprecation audit in `~/.claude/plans/fancy-bouncing-lovelace.md`. Pure tracking item — no direct fix; we wait for upstream majors. Companion to the now-shipped ESLint 8 → 9 migration (plan 104) and the Multer 1 → 2 upgrade which cover the chains we could fix immediately.

- _What:_ Periodically re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump direct deps whose upstream majors drop one of these transitives. Status of the three tracked chains:
  - ✅ **RESOLVED 2026-05-23 (plan 104):** `jsdom@25 → html-encoding-sniffer + whatwg-encoding@3.1.1`. Bumped jsdom `^25 → ^29` (29.1.1); the `whatwg-encoding` deprecation warning is gone from the audit. One frontend spec (`src/views/listen.test.tsx` cover-gradient) needed adapting because jsdom 29 canonicalises hex CSS colours to `rgb()` in the CSSOM.
  - ✅ **RESOLVED 2026-05-23 (plan 104):** `archiver@7 → archiver-utils → glob@10.5.0`. Bumped archiver `^7 → ^8` (8.0.0); the `glob` deprecation warning is gone. archiver 8 is pure ESM and dropped the v7 callable factory, so `scripts/build-release-zip.mjs` now constructs `new ZipArchive(opts)` (pinned by `scripts/tests/archiver-zip.test.mjs`).
  - ⏳ **STILL TRACKED:** `@google/genai@2 → google-auth-library → gaxios → node-fetch → fetch-blob → node-domexception@1.0.0` — deprecation says "Use your platform's native DOMException". Deep transitive via the Gemini SDK; `@google/genai` is still on major 2 (no v3), so this stays blocked. Waiting for `node-fetch`/`fetch-blob`/`google-auth-library` upstream to migrate to native DOMException, OR for a `@google/genai` v3 that drops the `node-fetch` chain.
- _Acceptance:_ each time a direct dep is bumped (jsdom, archiver, or @google/genai), re-run the audit and tick off the resolved chain in this entry. Entry is removed from BACKLOG when all three resolve — two of three are now done; only the `@google/genai` chain remains.
- _Key files:_ `server/package.json` (`@google/genai` direct). The jsdom + archiver bumps already landed in root `package.json` (plan 104). No source changes for the remaining chain — purely a dep-bump tracking item.
- _Depends on:_ upstream releases (`@google/genai` v3 or a native-DOMException migration in its `node-fetch` chain). Not on our schedule.
- _Benefit (technical):_ keeps the `npm install` warning surface clean over time. Without explicit tracking, deprecation messages accumulate, new ones get lost in the noise, and the eventual audit becomes harder. This item is the watchdog. As of 2026-05-23 a fresh `npm install` at root prints ZERO deprecation warnings (ESLint 9 + jsdom 29 + archiver 8 all cleared); the only remaining deprecation in the monorepo is the `@google/genai` `node-domexception` chain on the server side.

#### `ops-1` — Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to the release-package work ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ plan 49 release package shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

#### `ops-2` — Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to the release-package work ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ plan 49 release package shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

### Listener-app handoffs

#### `fe-3` — Apple Books (iOS / macOS) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Acceptance:_ Click tile → modal shows platform-detected instructions. Vitest covers the UA detection branching.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`.
- _Depends on:_ plan 18b shipped.
- _Benefit (user):_ closes one more "Coming soon" tile.

#### `fs-7` — Plex (self-hosted media server) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Acceptance:_ Click tile → modal shows manual upload steps. If a Plex token is configured, an "Upload directly" button hits the Plex API. Vitest covers both modes.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`; `src/views/settings.tsx` (Plex token field — see `fe-2` power-user panel); new `server/src/export/plex.ts` for the optional upload path.
- _Depends on:_ plan 18b shipped; ideally `fe-2` (power-user panel) for the token storage.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.

#### `fs-8` — PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/archive/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

### `ops-5` — Trim `build` / `e2e` out of the per-PR `verify.yml`

Source: net-new (2026-05-27), considered and declined during CI cost round 2 ([`118-ci-cost-round-2.md`](features/118-ci-cost-round-2.md)).

- _Why parked (2026-05-27):_ would shave ~1–3 min off each frontend/server PR run, but the dev box is Windows (case-insensitive FS) and CI is Linux (case-sensitive) — a build break like a wrong-case import would slip past PR CI and only surface in `release.yml` / `cross-os.yml`. Round 2 chose the safer cost levers (draft-by-default, integration-PR batching, `vitest --changed`, timeout caps) that don't reduce what a green PR has actually proven. e2e is also the suite most likely to catch a router/redux/layout regression a unit test misses, so dropping it from the merge gate trades real safety for a small saving.
- _Wake when:_ the safer round-2 levers prove insufficient AND a Linux-build / e2e signal moves earlier in the pipeline (e.g. a fast pre-merge Linux build smoke, or merge-queue checks) so dropping it from per-PR no longer leaves a coverage hole.

### `side-4` — A/B Qwen `x_vector_only_mode=True` (speed vs. fidelity)

Source: net-new (2026-05-26), plan 112. ICL mode drags the reference clip's codec tokens through context every decode step; `x_vector_only_mode=True` drops that for shorter/faster steps, at a fidelity/consistency cost.

- _Why parked (2026-05-26; confirmed 2026-05-31):_ the perf problem that motivated it is solved — after the plan-113 batching + the concurrent-batch race fix, end-to-end Qwen chapters run at **~RTF 1.15**, and the **2026-05-31 overnight full-book run held aggregate RTF ≈ 1.04 across 25 real multi-voice chapters** (range 0.91–1.26, ~realtime — the target). The perf goal is decisively met, so trading the bespoke-voice identity-consistency this feature exists to guarantee for a marginal further speedup isn't worth it. Closed, not just deferred.
- _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost) AND a listen-test shows x-vector-only holds identity acceptably.

### `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated)

Source: net-new (2026-05-29), plan [`129-qwen-decode-cuda-graph-spike.md`](features/129-qwen-decode-cuda-graph-spike.md); **moved Could → Won't 2026-05-31**. Was the blocked "open lever 5" in `docs/tts-performance.md` — the only path past the dispatch-bound ~1–2 RTF floor toward sub-1, but a 2–5-day, correctness-risky fork of `qwen_tts` (it ships `_supports_static_cache=False` + a growing `DynamicCache` + a nested per-step `code_predictor.generate()`) we'd then maintain against upstream.

- _Why parked (2026-05-31):_ the perf goal is met. The 2026-05-31 overnight full-book run rendered 25 real multi-voice chapters at aggregate **RTF ≈ 1.04** (range 0.91–1.26) on the adopted 32/3600 + single-worker config — ~realtime, the target. The remaining gap to sub-1 (Kokoro-class) isn't worth a risky talker fork; Kokoro stays the book-length workhorse and Qwen bespoke is already an acceptable overnight render. Even the cheap Probe 1 isn't worth running while the floor is acceptable.
- _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost). Then run plan-129 Probe 1 first; only fork if it proves still launch-bound.

### `side-10` — Coalesce consecutive same-speaker short lines before batching

Source: net-new (2026-05-29), from the plan-136 A/B; **moved Could → Won't 2026-05-31**. Was the one lever left for the dialogue **padding floor** — a batch decodes to its longest item, so a bucket of ultra-short same-speaker lines (avg ~12–30 chars) wastes most decode steps for little audio (measured RTF ~3 even at cap 64); length-bucketing/token-budget can't fix inherently tiny items. The idea: merge runs of consecutive same-character short sentences into one synth item.

- _Why parked (2026-05-31):_ two reasons. (1) **Perf goal met** — the 2026-05-31 overnight full-book run held aggregate RTF ~1.04 even on multi-voice/dialogue-dense chapters, so the dialogue floor isn't worth chasing. (2) **It degrades audit / caption quality** — merging sentences into one synth item is NOT output-equivalent: prosody across a merged boundary differs from separate synth+concat, and sentence-level segment boundaries (→ `sentenceIds`) get coarser, so quote-audit and per-sentence captions/timing lose fidelity. Trading audit fidelity for a dialogue speedup we no longer need isn't a good deal.
- _Wake when:_ Qwen synthesis becomes a real bottleneck again specifically on dialogue-dense books AND a captions/timing-preservation design + a quality A/B prove the merge doesn't hurt quote-audit fidelity.

### `ops-4` — Auto-install Ollama / auto-pull models

Source: [`29-analyzer-ollama-local.md`](features/archive/29-analyzer-ollama-local.md).

- _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract.
- _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

### `srv-8` — Multi-model fan-out for Gemini analyzer

Source: [`06-analyzer-gemini.md`](features/archive/06-analyzer-gemini.md).

- _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs.
- _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

### `fe-11` — Multi-tab catch-up race resilience

Source: [`32-sticky-analysis.md`](features/archive/32-sticky-analysis.md).

- _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `srv-10` — both wake under the same trigger.

### `srv-9` — Multi-book parallel generation

Source: [`16-generation-stream.md`](features/archive/16-generation-stream.md).

- _Why parked:_ single 8 GB GPU can't hold two XTTS/Kokoro instances; the generation queue is serial per workspace by design.
- _Wake when:_ either cloud TTS becomes the dominant generation path so VRAM is no longer the bottleneck, or the user adds a dedicated per-book GPU. Neither is on the v1 roadmap.

### `fs-12` — Voice creation from scratch

Source: [`22-voice-library.md`](features/archive/22-voice-library.md); _What_ revised 2026-05-26 for the Qwen voice-design engine.

- _What (revised 2026-05-26):_ Qwen3-TTS (plan 108) already authors a bespoke per-character voice from a text persona (design → clone → cache the embedding → reuse for consistency), so "create a voice that exists in no catalog" is no longer hypothetical — it ships, scoped to a cast member. What's still missing is a _standalone_ library-voice authoring surface: design a voice from a persona (or a reference clip) as a first-class library entry not tied to one character, name + tag + pin it, reuse it across books, plus optional fine-tuning of an already-designed voice.
- _Why parked:_ the per-character Qwen design flow covers the dominant need (give this character a distinct voice). A general-purpose voice-authoring studio (standalone named library entries, reference-clip cloning UI, fine-tune controls) is its own product surface beyond today's read-mostly library.
- _Wake when:_ users want to design + curate voices as reusable library assets independent of a single character — e.g. building a personal stable of named narrators to assign across the catalogue. Pairs with `fe-12` (bulk library ops): a from-scratch author flow is what grows the library big enough to need them.

### `fe-12` — Bulk pin / bulk delete in voice library

Source: [`22-voice-library.md`](features/archive/22-voice-library.md); revised 2026-05-26 for Qwen custom voices.

- _Why parked (under review 2026-05-26):_ the original "fewer than 50 entries (28 Kokoro + ~12 Coqui defaults), per-voice click is fast enough" premise is weakening. Qwen3-TTS (plan 108) designs a bespoke voice per character, so a heavy multi-book user accumulates many cached custom voices in the library — quickly past the ~50-entry comfort threshold. At that point bulk pin / bulk delete stops being a nicety and becomes the only sane way to curate. **Flagged to move up to Could (or Should) after a review of real library sizes once a few books have been (re)generated under Qwen.**
- _Wake when:_ a real workspace's library crosses ~50 entries from accumulated Qwen-designed voices and per-voice curation gets painful — likely soon given the catalogue-wide Qwen regen, so review proactively rather than waiting for a complaint. No longer blocked on `fs-12`: Qwen's per-character design flow already produces the bulk-worthy entries.

### `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI

Source: [`23-mock-toggle.md`](features/archive/23-mock-toggle.md).

- _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object).
- _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

### `srv-10` — Conflict resolution for two simultaneous `state.json` writers

Source: [`27-book-state-persistence.md`](features/archive/27-book-state-persistence.md).

- _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `fe-11` — both wake under the same trigger.

### `srv-6` — Engine-drift factor polish + `resolvedVoiceName` backfill

Source: net-new (2026-05-24), spun off from [plan 108](features/108-qwen-coexistence.md)'s R5 drift fix; moved Could → Won't 2026-05-26. Would add a one-shot backfill (mirror `scripts/relufs-existing.mjs`) recomputing `resolvedVoiceName` on legacy `segments.json` so chapters rendered before plan 108 participate in override-drift detection.

- _Why parked (2026-05-26):_ the user is regenerating the whole catalogue with Qwen, so every book will get a fresh post-plan-108 `resolvedVoiceName` snapshot at render time — there are no stranded legacy chapters left for the backfill to rescue.
- _Wake when:_ a corpus of pre-plan-108 chapters that will _not_ be regenerated needs drift detection after all (e.g. an imported back-catalogue from another deployer). Until then the regen sweep makes the backfill moot.

### `srv-5` — Tune per-engine VRAM cost map against real hardware

Source: net-new (2026-05-24), spun off from [plan 108](features/108-qwen-coexistence.md); moved Could → Won't 2026-05-26. The `ENGINE_VRAM_COST` map (`server/src/tts/engine-vram-cost.ts`) + default `GPU_VRAM_BUDGET` shipped as estimates; this item was to measure actual peak VRAM per engine on the 8 GB GPU and correct the constants.

- _Why parked (2026-05-26):_ most of the original scope dissolved under the Qwen tuning work. The plan-113 fix serialises the Qwen forward per-engine (it isn't thread-safe), so `GPU_VRAM_BUDGET>1` gives **no same-engine Qwen parallelism** — the cost map now matters only for **cross-engine** packing (Kokoro 1 + Qwen 1, vs Coqui 3 / analyzer 4). Empirically `GPU_VRAM_BUDGET=2` + `QWEN_BATCH_SIZE=8` ran an end-to-end Qwen chapter (~RTF 1.15) with no VRAM trouble on the 4070, so the provisional constants are good enough in practice. The only unmeasured residual — true per-engine _peak_ VRAM for the cross-engine case — isn't worth a dedicated tuning pass while the empirical config holds.
- _Wake when:_ cross-engine packing actually thrashes (spill-to-RAM slowdown, `nvidia-smi` near the card ceiling) on real hardware, or a different/smaller GPU changes the headroom math. Then measure peak-per-engine and correct `ENGINE_VRAM_COST`.

### `srv-3` — Per-call local→Gemini analyzer overflow

Source: net-new (2026-05-21), spun off from the perf-tuning survey (item B4); moved Could → Won't 2026-05-26. Would extend `FallbackAnalyzer` (`server/src/analyzer/index.ts:159-210`) to route partial load to Gemini when local Ollama is _slow_ (not just unreachable), with cross-analyzer roster-name normalisation to avoid duplicate characters.

- _Why parked (2026-05-26):_ Gemini is already the strong performer in the analyzer mix, so the marginal value of overflowing to it per-call is low — and the overflow round-trip (mid-run analyzer switch + name reconciliation) would be slow in comparison while adding duplicate-character risk for no reliable latency win. Plan 88's per-phase bucketed split already covers the deliberate "use Gemini for these phases" case.
- _Wake when:_ a workload appears where local Ollama is the genuine bottleneck AND idle Gemini quota would finish the burst faster — measured, not assumed. Plan 88's per-phase plumbing is the seam to build on.

---

## Retired numbering

The old per-bucket `Could #N` / `Should #N` numbering was retired on 2026-05-25 in
favour of the permanent `<prefix>-<n>` IDs above (it renumbered on every ship, so
external references rotted). Any code comment or plan doc still citing a bare
`Could/Should/Must #N` is either (a) a stale pre-2026-05-25 reference — resolve it by
matching the comment's described feature to an item above or to its shipping plan —
or (b) **plan-internal** numbering of the form `plan <NN> Should #M`, which is frozen
and correct. Don't reintroduce bare-number backlog references.
