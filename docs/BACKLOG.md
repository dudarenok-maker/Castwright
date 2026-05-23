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

Ranking within each bucket = top is highest priority. Item numbers are
sequential per bucket and renumber every time an item ships (see the
"Update rule" above) — don't cite a Could-#N from outside `BACKLOG.md`
without re-reading the current list.


---

## Must — blocks v1 ship or hurts existing users

### 1. In-app upgrade pathway — package-drop install with data migration

Source: net-new (2026-05-22). Captured during planning of the cross-version upgrade flow; user-flagged as MUST #1 priority for the next round of work, ahead of multi-language. Full design captured in `~/.claude/plans/as-we-are-now-refactored-cupcake.md` — move into `docs/features/NN-in-app-upgrade.md` when the round opens.

- _What:_ Turn cross-version upgrades into a one-click Account-tab flow for hand-delivered alpha bundles (no GitHub polling — explicit user direction). Three coupled pieces. **(a) Foundation** — new `GET /api/info` endpoint reporting `{ appVersion, sidecarVersion, schemas, lastSeenAppVersion, showWhatsNew }`; schema-version stamping on `cast.json` / `manuscript-edits.json` / `revisions.json` / `listen-progress.json` / `voices.json` / `user-settings.json` mirroring the existing `state-migrate.ts` pattern (absence-means-v1 back-compat, refuses future schemas, identity migrations at v1); version pill in top-bar sourced from a `useAppInfo()` hook; sidecar exposes `__version__` in `/health`; `bump-version.mjs` extended to rewrite a new `server/tts-sidecar/version.py` in lockstep with the two `package.json`s. Boot-time `upgrade-coordinator.ts` walks every book on `lastSeenAppVersion ≠ appVersion`, snapshots all `.audiobook/*.json` + `voices.json` + `user-settings.json` to `<WORKSPACE_DIR>/.upgrade-backups/from-<old>-to-<new>-<iso>/` before re-stamping any stale-schema files. **(b) Upload + swap** — `POST /api/admin/upgrade/{stage,apply,abort}` + `GET /api/admin/upgrade/state` accept multipart zip upload, validate `audiobook-generator-vX.Y.Z/` root + embedded `package.json` + manifest sanity + SHA-256, refuse concurrent in-flight generation/analysis (409 with busy-book list) and unconfirmed downgrades (412), write `<WORKSPACE_DIR>/.upgrade-pending.json` and spawn a detached restarter via inline `child_process.spawn('node', ['-e', '<...>'], { detached: true })` (inline string so the swap can't delete its own supervisor mid-flight). `scripts/start-app-prod.mjs` detects the marker on boot and performs a preserve-list swap — **preserve** `server/user-settings.json` / `server/.env` / `server/tts-sidecar/.venv/` / `server/tts-sidecar/voices/kokoro/` / `audiobook-workspace/` / `logs/` / `.run/`; **swap** `dist/` / `server/dist/` / `server/tts-sidecar/*.py` / both `package.json`s + lockfiles. Run `npm ci` root + server; re-run `pip install -r requirements.txt` only when its hash changed; rename-aside `repoRoot.bak-<ts>/` until swap completes so any failure during steps 5–9 rolls back atomically; append every attempt (ok / failed) to `<WORKSPACE_DIR>/.upgrade-log.json`. Cross-platform Node ESM (Win + macOS + Linux per the alpha-tester spread), no PowerShell. **(c) UX** — Account view gets a top `Application updates` FormCard with a file-picker that POSTs multipart to `/stage`, a confirmation dialog showing v-from → v-to + short SHA-256 + bundled `RELEASE_NOTES.md` + data-safety blurb, and a full-screen `UpgradingScreen` overlay during apply that polls `/state` every 2s and `/api/info` every 2s; the overlay dismisses when `appVersion` flips, success toast fires, and a "What's new in vX.Y.Z" banner renders at the top of every view until dismissed (driven by the `showWhatsNew` flag clearing via `POST /api/info/dismiss-whats-new`). `scripts/build-release-zip.mjs` extended to bake `RELEASE_NOTES.md` (from the annotated tag body that `bump-version.mjs --notes-file` already captures) into the zip root and include it in MANIFEST.
- _Acceptance:_ Cut v1.4→v1.5 locally via `bump-version.mjs + build-release-zip.mjs` (with `--notes-file`); from a running v1.4, upload the v1.5 zip in Account tab → confirm dialog shows the version delta + correct SHA-256 + release notes → click Apply → overlay progresses through "Server restarting" / "Installing dependencies" / "Migrating book data" → within 90 s the version pill flips to v1.5, the What's-new banner appears, success toast fires. After upgrade: `.audiobook/state.json` + `cast.json` + `revisions.json` parse with stamped schemas; `audiobook-workspace/` intact; `server/user-settings.json` retains the user's Gemini key + theme + analyzer-model overrides; `server/.env` untouched; Kokoro voices still selectable. Failure-path coverage: with one in-flight generation, Apply returns 409 with the busy-book list and the dialog refuses to proceed; a corrupted zip returns 400 with a precise reason and no state change; a deliberately broken zip mid-swap triggers atomic rollback via `repoRoot.bak-<ts>/` with the old version booting back up. `<WORKSPACE_DIR>/.upgrade-backups/` contains a timestamped snapshot for the v1.4→v1.5 jump and `.upgrade-log.json` has an `ok` entry. Repeat the happy path on a macOS box (alpha-tester platform spread). New paired tests: Vitest pins per `*-migrate.ts` + `upgrade-coordinator` + `zip-validate` + `staging` + `upgrade-slice`; new Pester or Vitest harness drives `start-app-prod.mjs` against a temp dir for the marker-detection + swap + rollback paths; new pytest asserts sidecar `__version__` lands in `/health`; new Playwright e2e (`e2e/upgrade-flow.spec.ts`) drives stage→apply→banner against mocked endpoints + crosses router/redux/layout seams per CLAUDE.md's e2e rule.
- _Key files:_ **Foundation** — new `server/src/routes/info.ts`; new `server/src/workspace/{cast,manuscript-edits,revisions,listen-progress,voices-meta}-migrate.ts` (each mirrors the existing `server/src/workspace/state-migrate.ts:33-100` shape: `CURRENT_XXX_SCHEMA` + `migrateXxxJson` + `stampXxxSchema` + `UnsupportedXxxSchemaError`); new `server/src/workspace/upgrade-coordinator.ts` (called from `server/src/index.ts` after workspace mount, before serving); `server/src/workspace/user-settings.ts` (add `lastSeenAppVersion` + `schemaVersion` additive fields to the zod schema, no schema bump); `server/tts-sidecar/main.py` (new `__version__` constant, return in `/health` envelope) + new tiny `server/tts-sidecar/version.py`; `scripts/bump-version.mjs:142-198` (extend lockstep pre-flight to include the sidecar version file); new `src/lib/use-app-info.ts`; `src/components/top-bar.tsx` (small version pill near avatar); `openapi.yaml` (new `/api/info` shape). **Upload + swap** — new `server/src/routes/upgrade.ts` (four routes); new `server/src/upgrade/zip-validate.ts` + `server/src/upgrade/staging.ts` (busy-book probe must reuse existing analysis/generation state — locate + reuse, do not duplicate, per `feedback_verify_reanalysis_actually_needed`); `scripts/start-app-prod.mjs:18-80` (extend with marker detection + `safeRm()` preserve-list + extract + rollback before existing `probePort`/spawn logic); `openapi.yaml` (upgrade endpoints). **UX** — new `src/components/upgrade-card.tsx` (FormCard component); new `src/store/upgrade-slice.ts` (thunks + selectors, plays into `notifications-slice` for the success toast via `pushToast`); `src/views/account.tsx:248-260` (mount `<UpgradeCard />` as the FIRST FormCard above Profile); new `src/components/whats-new-banner.tsx`; `src/components/layout.tsx` (mount banner at top of every view when `showWhatsNew`); `scripts/build-release-zip.mjs:20-122` (bake `RELEASE_NOTES.md` from annotated tag body, add to MANIFEST.include). Full design + branching/wave decomposition + rebase notes in `~/.claude/plans/as-we-are-now-refactored-cupcake.md`.
- _Depends on:_ none structural. Reuses the schema-version pattern from `server/src/workspace/state-migrate.ts`, the existing `notifications-slice` `pushToast` shape, the user-settings zod schema in `server/src/workspace/user-settings.ts`, the existing analysis + generation state (busy-book probe), the existing `taskkill /T /F` sidecar teardown on Windows, the `writeJsonAtomic` + rotation contract from `state-io.ts`, the annotated-tag-body release-notes contract from plan 49, and the existing `release.yml` tag-triggered CI pipeline. The release zip's exclude list at `scripts/build-release-zip.mjs:62-91` already keeps the preserved paths (`.venv`, `voices/kokoro`, `.env`, `audiobook-workspace`) out of the bundle, so the swap script's preserve list aligns naturally with what the zip doesn't carry. Pairs structurally with Must #2 (multi-language) — Must #2's `language` field on `BookStateJson` is the first real test of the migration coordinator built here.
- _Benefit (user / architectural):_ removes the manual upgrade rite (download zip → extract → `npm ci` → restart) every alpha tester walks through every release; replaces it with a single click in the Account tab, with auto-backup-before-migrate as the data-integrity contract. Surfaces the version delta + release notes inline so testers always know what changed. Atomic rollback path when an upgrade goes sideways means the user never wakes up to a half-applied state. Architecturally: establishes the per-file schema-version pattern across the rest of the workspace (today only `state.json` has it), so Must #2's `language` field — and every future non-additive shape change — has a tested migration seam instead of a one-shot ad-hoc script. Foundation work also enables future BACKLOG items Could #10 (Windows installer) and Could #11 (Docker image) to share the same `RELEASE_NOTES.md` + `/api/info` plumbing.

### 2. Multi-language support — same-language audio for same-language books (Russian first)

Source: net-new (2026-05-20). Captured during planning of the next full version update; user-flagged as critical for the next full version update.

- _What:_ Lift the implicit English-only assumption across the stack. Add `language` (BCP-47 string, default `"en"`) to `BookStateJson` and the OpenAPI `Book` + `Character` schemas. Add **Qwen3-TTS 0.6B** as a third sidecar engine (Alibaba, Apache 2.0, ~2.5 GB on disk, 4–6 GB VRAM during synth — fits the existing analyzer-eviction pattern) with its own cross-platform install script. Pipe `book.language` through to every sidecar `/synthesize` call. Auto-detect language on manuscript drop (≥30% Cyrillic codepoints → `"ru"`) with a chip + override on the confirm-metadata view. Filter the voice library panel by `voice.language === book.language` and auto-load Qwen3 when a Russian book becomes active. Fix the Gemini analyzer's Latin-only chars/4 token estimator for Cyrillic. Inject a language preamble into analyzer skill prompts for non-English manuscripts. Listen-header language badge + dedicated library language filter pill (separate from free-text tags). **Hard invariant: never cross-language** — Russian voices never read English text, English voices never read Russian text.
- _Acceptance:_ Upload an English manuscript → behaviour unchanged from today (regression). Upload a Russian public-domain fixture (Pushkin / Chekhov — NOT the Marlow Story, that's English) → confirm-metadata chip detects Russian + allows override → opening the book auto-loads Qwen3 with the existing analyzer-eviction banner → cast picker shows ONLY Russian voices → preview button speaks a Russian pangram → generated chapter audio is Russian with zero English bleed-through. Cyrillic token estimate within ±10% of actual `usage.input_tokens` on a long chapter. Library `Russian` filter pill ANDs with existing tag filters. Concurrent-multibook invariant holds: starting Russian Book A then switching to English Book B mid-flight keeps Book B's picker English and Book A's in-flight analysis Russian. On a fresh clone with no Qwen3 weights, opening a Russian book surfaces a clear "run `npm run install:qwen3`" call-to-action — not a silent 404. New Vitest + Playwright coverage on every new seam (detect-language helper, voice-library filter, preview-text switch, listen-header badge, library language pill); new pytest case in `server/tts-sidecar/tests/test_qwen3.py` (Cyrillic input + `language: "ru"` → non-empty PCM, no cross-bleed under concurrent synth).
- _Key files:_ `openapi.yaml` (add `language` to `Book` + `Character`; `BaseVoice.language` already half-extended at `openapi.yaml:2181-2185`); `src/lib/types.ts:135-185` (`BookStateJson`); `src/store/book-meta-slice.ts:22-38` (`EditableBookMeta`); server state.json reader (default-back-fill migration on read). Sidecar: `server/tts-sidecar/main.py:176,403-409,436,468,527-532` + new `server/tts-sidecar/engines/qwen3.py` + new `server/tts-sidecar/scripts/install-qwen3.mjs` (Node ESM, cross-platform) + thin `scripts/install-qwen3.ps1` wrapper for Windows discoverability. Server: `server/src/tts/voice-mapping.ts:104-146,223-242` (add Qwen3 profile tables, language-aware `pickVoiceForEngine`), `server/src/tts/synthesise-chapter.ts` (thread `book.language` to sidecar), `server/src/tts/base-voices.ts:36-41` (populate the existing-but-unfilled `language` field on every voice), `server/src/analyzer/gemini.ts:553-562` (Cyrillic-aware `estimateInputTokens`), analyzer skill-prompt loader (language preamble injection). Frontend: `src/views/upload.tsx:141-163` + new `src/lib/detect-language.ts` + the confirm-metadata view (chip + override); `src/components/listen/listen-header.tsx:219-234` (badge); `src/components/voice-library-panel.tsx` (language filter), `src/components/voice-preview-button.tsx` (per-language sample text), `src/components/model-control-pill.tsx` (Qwen3 button + auto-load on Russian-book select); `src/components/library/library-chrome.tsx:49-56` + `src/store/library-slice.ts:111` (language filter pill ANDed with tag intersection). Tailwind config needs no work — General Sans / Lora / Inter all support Cyrillic. Full design intent + wave decomposition captured in `~/.claude/plans/ok-lets-do-a-delightful-kahn.md`; move into `docs/features/NN-multi-language-russian.md` when the next round opens.
- _Depends on:_ none structural. Reuses the existing sidecar load/unload + analyzer auto-eviction pattern (`POST /api/sidecar/{load,unload}` + `POST /api/ollama/unload` per `server/src/analyzer/ollama.ts:92`), the half-extended `BaseVoice.language` field, the per-engine `overrideTtsVoices` cast map, the tag-filter intersection at `src/store/library-slice.ts:111`, Vitest + RTL + Playwright harnesses, and the Kokoro install script as the shape reference for the new Qwen3 installer.
- _Benefit (user / architectural):_ unlocks Russian (and arbitrary future languages) as a first-class concept — Russian books play Russian audio with Russian voices, no cross-language artefacts. The BCP-47-string contract (vs. closed enum) makes adding Spanish / German / etc. a UI-list change rather than a contract migration. Engine choice (Qwen3 over XTTS) preserves the option to monetize: XTTS's CPML is non-commercial-only; Qwen3-TTS is Apache 2.0. Critical for the next full version update per user direction.

---

## Should — important, not blocking ship

### 1. In-app LAN HTTPS banner under dev settings

Source: net-new (2026-05-21). Plan 81 wave 1 / 2 deferred item.

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Acceptance:_ When LAN_HTTPS=1 is set on the server, the Account view shows a "LAN access" card with the live HTTPS URL + a QR code linking to `/cert/root.crt`. Tapping "Copy URL" puts the URL in the clipboard.
- _Key files:_ new `src/components/lan-access-card.tsx`; `src/views/account.tsx` (or wherever account settings render) to mount the card; `src/lib/api.ts` to wrap `GET /api/export/lan` if not already wrapped.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).

### 2. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 3. Merge journal for deterministic alias un-link

Source: plan 95 ship (2026-05-22) — Out of scope. PR [#142](https://github.com/dudarenok-maker/AudioBook-Generator/pull/142) shipped editable cast aliases with a Reattribute Lines modal that uses the preserved Phase-0a `chapterCast` as a lineage proxy to narrow the user's manual reattribution from "whole book" to "these N chapters." It works, but it's not deterministic — a chapter shows up if the alias was in its Phase-0a roster, even when the merge that put the alias on the source character happened mid-book and didn't actually rewrite any chapter-1 sentences. The user has to skim and reassign.

- _What:_ At every cast-merge call site (manual merge route, fold-minor-cast post-stage-2 pass), append a record to a per-book journal file `<bookDir>/.audiobook/cast-merges.json` of shape `{ ts, kind: 'manual' | 'fold', sourceId, sourceName, targetId, affectedSentenceIds: number[] }`. The unlink-alias route then reads this journal to compute `impactedChapters.candidateSentenceIds` as the exact sentences originally rewritten by the merge — no `chapterCast` heuristic, no per-chapter listing of sentences that may belong to a third party.
- _Acceptance:_ A book with a single mid-flight merge that touched 12 sentences (all in chapters 7-9) → the unlink-alias modal lists exactly those 12 sentences across chapters 7-9, nothing else. Today's `chapterCast` path would also list chapters 1-6 sentences attributed to the source if the alias name happened to be in their roster too (false positives the user has to skip).
- _Key files:_ `server/src/routes/cast-merge.ts` (write the journal entry alongside the manuscript-edits rewrite), `server/src/analyzer/fold-minor-cast.ts` (caller-side hook so post-stage-2 folds also log), `server/src/routes/cast-aliases.ts` (replace the `chapterCast` derivation with a journal lookup), `server/src/workspace/paths.ts` (new path helper).
- _Migration:_ books that pre-date the journal still get the `chapterCast` fallback (today's behaviour); only newly-merged ones benefit. No backfill — the lineage was lost at the old merges and there's no way to reconstruct it.
- _Benefit (user):_ reattribute modal becomes a precise checklist instead of a scoped review — every row the user sees is provably their merge's work, no third-party sentences to skip over. Big quality-of-life win for series-2-into-1 cleanups where merges pile up.

### 4. Strip chapters-slice generation control fields (plan 102 cleanup)

Source: plan 102 ship (2026-05-23) — Out of scope for the v1 ship. The dispatcher relies on the existing `generation-stream-middleware`'s `pendingRegen` consumption path — when the dispatcher fires `chaptersActions.regenerateChapter`, the slice sets `pendingRegen` + bumps `regenEpoch`, and the existing middleware reconciles by opening the SSE. Stripping those fields prematurely would break the slice→middleware handshake the dispatcher relies on.

- _What:_ Rewrite `generation-stream-middleware` to consume queue state directly instead of reading `pendingRegen` off the slice. Then drop `pendingRegen` + `regenEpoch` + `paused` from `chapters-slice` (the `paused` field is duplicated with `queue.paused`; the queue version is canonical now). Touch every slice test that pins those fields. Remove the `REGEN_TYPES` branch in the existing middleware that closes the handle on `regenerateChapter` — the queue path already serialises so the close-and-restart logic is dead code. The dispatcher's local `inFlightEntryId` trick becomes unnecessary too — the middleware's open state IS the source of truth.
- _Acceptance:_ `chapters-slice.ts` no longer carries `pendingRegen`, `regenEpoch`, or `paused`. `generation-stream-middleware.ts` reads `queue.entries.find(e => e.status === 'in_progress')` (or equivalent) instead of `chapters.pendingRegen`. All existing tests pass after fixture updates. Dispatcher no longer tracks `inFlightEntryId` locally. `src/views/generation.tsx` reads `queue.paused` for the row's "Paused" pill instead of `chapters.paused`.
- _Key files:_ `src/store/chapters-slice.ts` (strip 3 fields + paired reducers + types); `src/store/generation-stream-middleware.ts` (rewire open-side gate to read queue state); `src/store/queue-dispatcher-middleware.ts` (simplify — no local entry tracking); `src/store/chapters-slice.test.ts` + every test fixture that pins `pendingRegen` (~5-10 places); `src/views/generation.tsx` (`paused` selector flip).
- _Depends on:_ Should #6 (cross-book dispatcher) shipping first is recommended — once the dispatcher owns the entire open-side path the slice strip is more obviously correct. Could also ship independently if pinned carefully.
- _Benefit (technical / architectural):_ removes 3 redundant fields from the slice that exist only because of the v1 same-slice-owns-generation contract. The queue slice + dispatcher are the new owners. Reduces the slice→middleware handshake to one direction (queue is authoritative). Cleans up ~60 lines of dead reconcile code in the existing middleware.

---

## Could — nice to have, low-cost wins

Ordered roughly: audio-quality magic → multibook invariants → workflow stubs → cast/revisions → voice library → ops & CI → distribution → listener-app handoffs → passive tracking.

### 1. Per-segment regen consumer for `revisions.acceptedSelections`

Source: plan 20 close-out (2026-05-18). The `revisions.acceptedSelections` map is persisted by `revisionsActions.acceptRevision` but no in-app code reads it back — per-segment splicing of accepted takes was explicitly "Out of scope" for plan 20 v1, and remains so in the v1 close-out.

- _What:_ Add a per-segment regen path that consumes `acceptedSelections[revisionId]` to re-render only the segments the user flipped to 'B' (the new take) while preserving 'A' (the original) segments verbatim. This requires (a) a server endpoint that accepts `{ revisionId, segmentSelections }` and dispatches per-segment synth, (b) a segments-manifest merge step that interleaves the two takes on disk, (c) a frontend trigger from the revision-diff player's "Commit selection" action.
- _Acceptance:_ Open a pending revision, toggle segments 3 + 7 to 'B' (others 'A'), click "Commit selection" → the chapter MP3 is rewritten with segments 3 + 7 re-rendered from the new take, all other segments byte-identical to the preserved (A) take. Server Vitest covers the manifest merge + per-segment synth; frontend Vitest covers the action dispatch shape; e2e covers the audition-then-commit flow.
- _Key files:_ new `server/src/routes/revisions-commit-segments.ts`; `server/src/tts/synthesise-chapter.ts` (extend for per-segment paths); `src/views/revision-diff.tsx` (dispatch through the new endpoint); `src/store/revisions-slice.ts` (mark the revision as committed once the segment-level synth completes).
- _Depends on:_ plan 20 shipped (acceptedSelections persistence is already on disk). Pairs with Could #2 (multi-step rollback / snapshot-per-entry) — the timeline becomes meaningful once per-segment commits land separately from full regens.
- _Benefit (user):_ true segment-level revision control. Today accept/reject is whole-revision swap — if the user likes 9 of 10 segments in the new take but wants segment 7 from the original, they have to regenerate the whole chapter under different prompts to recover that one segment. This closes the loop the slice has been quietly capturing since plan 20 v1.

### 2. Multi-step rollback / snapshot-per-entry (revision history)

Source: net-new (2026-05-19). Spun off from plan 55 ship — v1.3.0 plan 55 ships the read-only history view; this entry covers the multi-step rollback that needs snapshot-per-entry storage.

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Acceptance:_ Generate chapter, regenerate twice, accept both. Open History → 2 active entries each `reversible: true`. Click Rollback on entry 1 → chapter audio reverts to entry-1's state; entry 2 marked `rolled-back-from`. New rollback can target a still-reversible entry; double-rollback → 409.
- _Key files:_ `server/src/workspace/preserve-previous-audio.ts` (extend filename pattern); new `server/src/routes/revisions-rollback.ts`; `src/components/revision-timeline-modal.tsx` (enable Rollback button on reversible entries); slice already plumbed (plan 55's `rolledBack` reducer + `reversible` field).
- _Depends on:_ plan 55 shipped (slice plumbing already on disk).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.

### 3. Batch voice-replace across all books

Source: net-new (2026-05-18).

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Acceptance:_ Three books each use voice `am_michael` for one character → batch replace `am_michael` → `am_eric` shows 3 affected pairs, confirm rewrites all three cast.json files, audio marked stale. Vitest covers the dry-run preview + write logic; e2e covers the modal flow.
- _Key files:_ new `src/modals/batch-voice-replace.tsx`; `src/views/voices.tsx` (entry point); `server/src/routes/voices.ts` (cross-book write endpoint); new `server/src/audio/invalidate.ts` (multi-book audio invalidation).
- _Depends on:_ none.
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.

### 4. Auto-backup scheduling for `state.json`

Source: net-new (2026-05-18).

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Acceptance:_ Set daily backups → 14 daily snapshots accumulate in `.backups/`, oldest auto-pruned. Restore from snapshot → state.json reverted to that point; library view refreshes. New server Vitest spec covers the cron-like cadence + prune.
- _Key files:_ new `server/src/workspace/auto-backup.ts`; `server/src/workspace/scan.ts` (initial trigger on server start); new settings affordance under Could #5 power-user panel (or inline in `src/views/library.tsx` if shipped first).
- _Depends on:_ none.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.

### 5. Keyboard shortcuts / power-user tuning panel

Source: net-new (2026-05-18).

- _What:_ Add a settings panel (under a gear icon in the top-bar) for power-user tuning: keyboard-shortcut overrides (e.g. spacebar = play/pause), runtime knobs (SSE chunk size, TTS concurrency cap, debounce values for autosave), accessibility toggles (high-contrast theme, larger text). Settings persist in localStorage and apply on next render.
- _Acceptance:_ Open settings, change autosave debounce from 500ms to 2000ms → next edit waits 2s before write. Override "play/pause" shortcut to "K" → keyboard "K" toggles mini-player. Vitest covers the persistence + shortcut binding.
- _Key files:_ new `src/views/settings.tsx`; new `src/lib/keybindings.ts`; new `src/store/settings-slice.ts`; `src/components/layout.tsx` (gear icon entry point).
- _Depends on:_ none.
- _Benefit (technical / accessibility):_ power-user tuning surfaces today's hardcoded values; keyboard navigation closes an accessibility gap.

### 6. Windows installer (Inno Setup or NSIS) wrapping the release zip

Source: net-new (2026-05-18). Deferred follow-up to the release-package work ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ plan 49 release package shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 7. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to the release-package work ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ plan 49 release package shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.

### 8. Apple Books (iOS / macOS) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Acceptance:_ Click tile → modal shows platform-detected instructions. Vitest covers the UA detection branching.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`.
- _Depends on:_ plan 18b shipped.
- _Benefit (user):_ closes one more "Coming soon" tile.

### 9. Plex (self-hosted media server) handoff modal

Source: plan 18 follow-up (2026-05-18). Deferred from plan 18b scope.

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Acceptance:_ Click tile → modal shows manual upload steps. If a Plex token is configured, an "Upload directly" button hits the Plex API. Vitest covers both modes.
- _Key files:_ `src/components/app-handoff-modal.tsx`; `src/data/listener-apps.ts`; `src/views/settings.tsx` (Plex token field — see Could #5 power-user panel); new `server/src/export/plex.ts` for the optional upload path.
- _Depends on:_ plan 18b shipped; ideally Could #5 (power-user panel) for the token storage.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.

### 10. PocketBook Cloud direct upload OR `@pbsync.com` email gateway

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Acceptance:_ A working prototype for one of the two paths; new tile on the export modal; documented size limits + caveats.
- _Key files:_ new tile config in `src/data/listener-apps.ts`; `src/modals/export-audiobook.tsx`; `server/src/export/` for any new transport.
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.

### 11. Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) drives today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. Per the 2026-05-21 Kokoro-Stop-pill change, the hook now fans out per engine: it returns `{ coqui, kokoro, evictionNotice, loadErrorNotice, dismissNotices }` from a single /health probe. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Acceptance:_ The new surface reads `ttsLifecycle` from `useOutletContext<LayoutContext>()` (pattern from `generation.tsx`), picks the per-engine slot it cares about (`ttsLifecycle.coqui` / `ttsLifecycle.kokoro`), and renders the right pill via `ModelControlPill` with the matching `engineLabel`. No new `setInterval`, no new `/health` poll, no duplicated `evictionNotice` / `loadErrorNotice` state.
- _Key files:_ `src/lib/use-tts-lifecycle.ts` (no changes expected — the per-engine fan-out is already in place); `src/components/layout.tsx` (no changes — already exposes the context and the `selectEnginesInUse` mounting pattern); `src/store/engines-in-use-selector.ts` (extend only if the new surface needs a different "is this engine relevant" predicate); the new surface's component file.
- _Depends on:_ an actual third surface materialising. Product-driven, not architecture-driven — the seam is ready, the trigger isn't.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.

### 12. Broad hover-affordance audit with `coarse-pointer:` Tailwind variant

Source: net-new (2026-05-21). Plan 81 wave 4 deferred item.

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Acceptance:_ All action-revealing hover patterns in cast, manuscript, voices, listen, generation views get a `coarse-pointer:opacity-100` (or appropriate) fallback. A test confirms `(pointer: coarse)` simulation reveals the same buttons hover would.
- _Key files:_ grep `src/**/*.tsx` for `group-hover:` / `peer-hover:` / `hover:opacity-0`; apply per-component judgement.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.

### 14. Both TTS engines resident (Kokoro + XTTS)

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item A3).

- _What:_ Drop the eviction wiring between Kokoro and XTTS; keep both engines loaded. Per-character voice profiles already carry `overrideTtsVoices: { coqui?, kokoro? }` per CLAUDE.md — pick at synth time. VRAM math (Kokoro 1 GB + XTTS 3 GB + Ollama analyzer ~7 GB = 11 GB on an 8 GB GPU) requires Ollama auto-eviction during generation, with the existing "TTS / Analyzer unloaded to free VRAM" banner.
- _Acceptance:_ A mixed-engine book (Coqui voice on character A, Kokoro on character B) renders without engine-swap latency between sentences. First XTTS use no longer pays the ~30 s cold-load. Ollama auto-eviction surfaces a clear banner during generation; re-loads on analysis trigger.
- _Key files:_ `server/tts-sidecar/main.py` (eviction wiring removal); `src/components/model-control-pill.tsx`; analyzer eviction at `server/src/analyzer/ollama.ts:92`.
- _Depends on:_ none structural. Speed gain conditional on mixed-engine casts.
- _Benefit (user):_ eliminates the 30 s XTTS cold-load on first use for mixed-engine books; enables fluid engine mixing per character.

### 15. Per-call local→Gemini analyzer overflow

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item B4).

- _What:_ Extend `FallbackAnalyzer` (`server/src/analyzer/index.ts:159-210`) to route partial load to Gemini when local Ollama is slow (not just unreachable). Different from plan 88's per-phase split — this is per-call. Roster names + attribution patterns must normalise across the mixed-analyzer run to avoid duplicate characters.
- _Acceptance:_ With both local Ollama and Gemini configured, long-book analysis bursts overflow to Gemini under local slowness; the final roster contains no duplicates from cross-analyzer name variants.
- _Key files:_ `server/src/analyzer/index.ts:159-210`; `server/src/analyzer/select-analyzer.ts`.
- _Depends on:_ plan 88 shipped (its per-phase plumbing is the seam this builds on).
- _Benefit (user):_ uses idle Gemini quota when local is the bottleneck. Lower priority than plan 88's bucketed split.

### 16. Waveform memoisation

Source: net-new (2026-05-21). Spun off from the perf-tuning survey (item C6).

- _What:_ In `src/components/waveform.tsx`, stabilise the 48-bar `useMemo` (memo key invariant against re-mount) and lift the animation interval to the parent so it ticks once per listen-view mount (not per waveform instance).
- _Acceptance:_ Listen view with N visible waveforms ticks on one shared interval (not N intervals); the rendered output is visually unchanged from today.
- _Key files:_ `src/components/waveform.tsx`; parent in `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none.
- _Benefit (technical):_ avoids 480+ DOM mutations per 800 ms when many waveforms are visible simultaneously. Low real-world impact today (rare to see >3 waveforms at once).

### 17. Configurable chapter-title silence durations

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Acceptance:_ Editing a book's silence durations and regenerating one chapter produces an MP3 whose leading + post-title silence matches the new setting (ffprobe / spectrogram). Default for legacy books stays 1.5 + 1.5. Existing chapter-audio-format paired tests stay green.
- _Key files:_ `server/src/tts/synthesise-chapter.ts` (params); `server/src/routes/generation.ts` (forward); `server/src/workspace/scan.ts` (state-json field); `src/components/listen/listen-header.tsx` or sibling metadata editor (UI); `openapi.yaml` (book-state shape).
- _Depends on:_ none.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.

### 18. Render the chapter-title segment on the Listen view timeline

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Acceptance:_ The listen view's chapter timeline shows a short "TITLE" pill at the head of each chapter rendered after this lands. Clicking it seeks to t=0. Pre-existing chapters whose `segments.json` has no title-kind row degrade gracefully (no title pill — same as today).
- _Key files:_ `openapi.yaml` (ChapterAudio segments shape); `src/lib/api-types.ts` (regenerated); `server/src/routes/chapter-audio.ts` (drop the filter, pass kind through); `src/components/listen/listen-player-region.tsx`.
- _Depends on:_ none (the on-disk segment shape already carries `kind: 'title'` since PR #101).
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.

### 32. Track upstream-blocked deprecation chains (~~jsdom~~ · ~~archiver~~ · @google/genai)

Source: net-new (2026-05-22). Surfaced by the full `npm install` deprecation audit in `~/.claude/plans/fancy-bouncing-lovelace.md`. Pure tracking item — no direct fix; we wait for upstream majors. Companion to the now-shipped ESLint 8 → 9 migration (plan 104) and the Multer 1 → 2 upgrade which cover the chains we could fix immediately.

- _What:_ Periodically re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump direct deps whose upstream majors drop one of these transitives. Status of the three tracked chains:
  - ✅ **RESOLVED 2026-05-23 (plan 104):** `jsdom@25 → html-encoding-sniffer + whatwg-encoding@3.1.1`. Bumped jsdom `^25 → ^29` (29.1.1); the `whatwg-encoding` deprecation warning is gone from the audit. One frontend spec (`src/views/listen.test.tsx` cover-gradient) needed adapting because jsdom 29 canonicalises hex CSS colours to `rgb()` in the CSSOM.
  - ✅ **RESOLVED 2026-05-23 (plan 104):** `archiver@7 → archiver-utils → glob@10.5.0`. Bumped archiver `^7 → ^8` (8.0.0); the `glob` deprecation warning is gone. archiver 8 is pure ESM and dropped the v7 callable factory, so `scripts/build-release-zip.mjs` now constructs `new ZipArchive(opts)` (pinned by `scripts/tests/archiver-zip.test.mjs`).
  - ⏳ **STILL TRACKED:** `@google/genai@2 → google-auth-library → gaxios → node-fetch → fetch-blob → node-domexception@1.0.0` — deprecation says "Use your platform's native DOMException". Deep transitive via the Gemini SDK; `@google/genai` is still on major 2 (no v3), so this stays blocked. Waiting for `node-fetch`/`fetch-blob`/`google-auth-library` upstream to migrate to native DOMException, OR for a `@google/genai` v3 that drops the `node-fetch` chain.
- _Acceptance:_ each time a direct dep is bumped (jsdom, archiver, or @google/genai), re-run the audit and tick off the resolved chain in this entry. Entry is removed from BACKLOG when all three resolve — two of three are now done; only the `@google/genai` chain remains.
- _Key files:_ `server/package.json` (`@google/genai` direct). The jsdom + archiver bumps already landed in root `package.json` (plan 104). No source changes for the remaining chain — purely a dep-bump tracking item.
- _Depends on:_ upstream releases (`@google/genai` v3 or a native-DOMException migration in its `node-fetch` chain). Not on our schedule.
- _Benefit (technical):_ keeps the `npm install` warning surface clean over time. Without explicit tracking, deprecation messages accumulate, new ones get lost in the noise, and the eventual audit becomes harder. This item is the watchdog. As of 2026-05-23 a fresh `npm install` at root prints ZERO deprecation warnings (ESLint 9 + jsdom 29 + archiver 8 all cleared); the only remaining deprecation in the monorepo is the `@google/genai` `node-domexception` chain on the server side.

### 33. Per-voice row sample-preview button inside `<VoiceOverridePicker>`

Source: net-new (2026-05-22). Deferred from the picker-autocomplete bundle — the model-voice override picker now uses the shared `<SearchablePicker>` primitive but renders each voice row as just `name`. The original plan reserved a tiny `▶` slot on each row for in-list auditioning so the user can preview a voice without committing the override; v1 ships with the row label only, matching the legacy `<select>` parity.

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Acceptance:_ Open the Profile Drawer's voice-override picker on the Kokoro tab. Click the `▶` next to a voice → that voice's sample plays without changing the current override. Pick the voice → override commits. Concurrent rapid clicks across rows fire one synth at a time.
- _Key files:_ `src/components/voice-override-picker.tsx` (renderItem extension), `src/lib/play-sample-with-auto-load.ts` (reuse as-is), no test churn beyond a new wrapper test for the play affordance.
- _Depends on:_ none.
- _Benefit (user):_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.

### 34. Profile-drawer "Possible duplicate of …" chip

Source: net-new (2026-05-22). Deferred from plan 101 — voices-view ⚠ pill + selection-pill swap are the v1 surfaces; this is the per-character drawer-side discoverability fix.

- _What:_ When a character has at least one auto-detected cross-book duplicate candidate (same predicate as `src/lib/cross-book-duplicates.ts`), render a small `⚠ Possible duplicate of "<other.name>" (<other-book-title>) →` chip near the top of `src/modals/profile-drawer.tsx`. Click → opens the same `DuplicateReviewModal` pre-populated with the pair. Layout.tsx computes the candidate at drawer mount and passes it as a new optional prop.
- _Acceptance:_ With the mock unlinked Eliza Gray (ns) + Eliza (sb) pair, open Eliza Gray's profile drawer → chip visible with "Possible duplicate of Eliza (Solway Bay) →". Click → modal opens with both rows. Same modal handles link / variant. After resolving, the chip disappears on the next drawer open.
- _Key files:_ `src/modals/profile-drawer.tsx` (new optional props + chip render), `src/components/layout.tsx` (compute candidate, mount modal alongside drawer), `src/modals/profile-drawer.test.tsx` (paired cases).
- _Depends on:_ plan 101 v1 already merged (this round). No server changes — reuses the v1 transport.
- _Benefit (user):_ closes the cast-side discoverability gap. Today (post-v1) a duplicate is only surfaced on `#/voices`; users who live in the cast view don't see the affordance until they navigate to voices. The chip pulls the same signal into the drawer they're already looking at.

### 35. Bulk cross-book duplicate review (one modal per series)

Source: net-new (2026-05-22). Deferred from plan 101 — v1 is one-pair-at-a-time; this is the bulk-walkthrough enhancement.

- _What:_ A `Review all duplicates in <Series Name>` button on the voices view (e.g. above the family grid) that opens a single modal walking through every detected pair in that series. User chooses link / variant / skip per pair; "Next" advances. Useful for the post-import case where the analyzer missed a recurring character across 3-4 books in a long series and the user wants to clean up in one sitting.
- _Acceptance:_ With a workspace containing N duplicate candidates across one series, click `Review all duplicates in …` → modal opens at pair 1 of N → choose an action → modal advances to pair 2 → … → final pair → modal closes. Each action persists via the existing v1 routes.
- _Key files:_ `src/modals/bulk-duplicate-review.tsx` (new — wraps `DuplicateReviewModal`'s actions with a queue), `src/views/voices.tsx` (entry button).
- _Depends on:_ plan 101 v1 already merged.
- _Benefit (user):_ reduces the cost of cleaning up an N-book series from N modal opens to 1. Useful exactly once per series after the user enables auto-detection or imports a long backlog of books.

### 36. Undo for "different on purpose" decisions

Source: net-new (2026-05-22). Deferred from plan 101 — the variant decision is currently durable but lacks a reverse path.

- _What:_ When the user accidentally marks a pair as "Different on purpose" and wants to re-surface the duplicate-candidate suggestion, today there's no UI to remove the `notLinkedTo` entry. Add a "Show ignored duplicate suggestions" toggle on the voices view that surfaces every previously-variant-marked pair with an "Unmark" action. Server route gains `DELETE` semantics (or `{ remove: true }` in the body) for symmetric pair-removal.
- _Acceptance:_ Mark a pair as variant. Click the new toggle → variant-marked pair appears in an "Ignored" section with an Unmark button. Click Unmark → the pair re-appears as a duplicate-candidate on its family card.
- _Key files:_ `server/src/routes/cast-not-linked-to.ts` (extend with DELETE), `src/views/voices.tsx` (toggle + ignored section), paired tests.
- _Depends on:_ plan 101 v1 already merged.
- _Benefit (user):_ reversibility. The variant decision should be as easy to undo as to set — without this, a misclick is permanent until the user opens cast.json by hand.

### 37. Serialize the `regen-visual-baselines.yml` 3-leg matrix

Source: net-new (2026-05-23). Surfaced during the plan-103 CI cost audit.

- _What:_ `regen-visual-baselines.yml` fans out across three Playwright projects (chromium / mobile-chrome / tablet-chrome) as a parallel matrix, paying a full cold-start (checkout + npm ci + Playwright install) per leg. Collapse into a single job that runs all three `--update-snapshots` passes sequentially, so the setup tax is paid once. Only fires on `workflow_dispatch` (~2 runs/month), so the saving is bursty rather than steady.
- _Acceptance:_ A single `workflow_dispatch` run regenerates all 42 PNGs (14 per project × 3) in one job and still opens the auto-PR. Billed minutes for a regen drop from ~3× cold-start to ~1×.
- _Key files:_ `.github/workflows/regen-visual-baselines.yml` (collapse `strategy.matrix.project` into a sequential step loop; consolidate the artifact upload).
- _Depends on:_ none.
- _Benefit (technical):_ ~60 billed min/month freed on regen days; tidier workflow.

### 38. Pre-seed pending-revision stubs for cross-book character regens

Source: plan 102 Should #6 ship (2026-05-23) — known limitation called out in the cross-book dispatcher PR. When the dispatcher opens a CROSS-book entry whose scope is `character`, it does not enqueue a pending-revision stub the way the same-book path does (`generation-stream-middleware`'s regen observer keys off the `regenerateCharacter` action, which the cross-book path deliberately does not dispatch — it would mutate the viewed book's rows). The revision still renders once the user opens that book and its revisions hydrate from disk; only the eager in-session stub is missing.

- _What:_ When the dispatcher's cross-book branch opens a `character`-scoped entry, enqueue the pending-revision stub directly from the queue entry's `{ bookId, chapterId, characterId }` rather than from the viewed book's `Chapter`/`Character` objects (which aren't in the slice while a different book is viewed). Requires either teaching `buildPendingRevisionStub` to accept the minimal id triple, or hydrating the other book's chapter/character names from the library/cast caches.
- _Acceptance:_ Enqueue a character-scoped regen for Book B while viewing Book A; without navigating to B, a pending revision stub for that (chapter, character) exists in `revisions.pending` (playable=false), and flips to playable on the cross-book stream's `chapter_complete`.
- _Key files:_ `src/store/queue-dispatcher-middleware.ts` (cross-book branch), `src/lib/build-pending-revision.ts` (accept minimal input), `src/store/revisions-slice.ts`.
- _Depends on:_ Should #6 (cross-book dispatcher) shipped.
- _Benefit (user):_ the diff player's pending-revision list is complete for cross-book character regens without requiring a navigate-to-book round-trip first. Low priority — the revision is recoverable on book open today.

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

### 1. Auto-install Ollama / auto-pull models

Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md).

- _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract.
- _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

### 2. Multi-model fan-out for Gemini analyzer

Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md).

- _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs.
- _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

### 3. Multi-tab catch-up race resilience

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md).

- _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #9 — both wake under the same trigger.

### 4. Multi-book parallel generation

Source: [`16-generation-stream.md`](features/16-generation-stream.md).

- _Why parked:_ single 8 GB GPU can't hold two XTTS/Kokoro instances; the generation queue is serial per workspace by design.
- _Wake when:_ either cloud TTS becomes the dominant generation path so VRAM is no longer the bottleneck, or the user adds a dedicated per-book GPU. Neither is on the v1 roadmap.

### 5. Voice creation from scratch

Source: [`22-voice-library.md`](features/22-voice-library.md).

- _Why parked:_ the library is a read-only view over the sidecar's voice catalog (28 Kokoro + Coqui's bundled set). Authoring a voice means a separate Coqui voice-cloning UI that's its own product surface.
- _Wake when:_ user wants to author / fine-tune voices in-app rather than dropping pre-made reference `.wav`s into the sidecar's `voices/` folder. Likely depends on a much bigger Coqui training pipeline first.

### 6. Bulk pin / bulk delete in voice library

Source: [`22-voice-library.md`](features/22-voice-library.md).

- _Why parked:_ v1 voice library has fewer than 50 entries (28 Kokoro + ~12 Coqui defaults); per-voice click is fast enough.
- _Wake when:_ user-created voices push the library past ~50 entries and per-voice clicking becomes painful (track via user complaint, not preemptive). Pairs with Won't #5 — without an author flow there's nothing to bulk-operate on.

### 7. Live `VITE_USE_MOCKS` toggle in running UI

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object).
- _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

### 8. Partial mock mode (some endpoints mocked, others real)

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- _Why parked:_ all-or-nothing keeps the type contract clean — every component imports from `api.*` without knowing which side it's hitting.
- _Wake when:_ a specific endpoint needs mock-while-rest-real (e.g. mocking a flaky third-party while testing everything else live). The cheapest path then is likely a per-endpoint override in the mock layer, not the architecture change above.

### 9. Conflict resolution for two simultaneous `state.json` writers

Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md).

- _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with Won't #3 — both wake under the same trigger.
