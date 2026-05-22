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
- _Acceptance:_ Upload an English manuscript → behaviour unchanged from today (regression). Upload a Russian public-domain fixture (Pushkin / Chekhov — NOT the Keefe Story, that's English) → confirm-metadata chip detects Russian + allows override → opening the book auto-loads Qwen3 with the existing analyzer-eviction banner → cast picker shows ONLY Russian voices → preview button speaks a Russian pangram → generated chapter audio is Russian with zero English bleed-through. Cyrillic token estimate within ±10% of actual `usage.input_tokens` on a long chapter. Library `Russian` filter pill ANDs with existing tag filters. Concurrent-multibook invariant holds: starting Russian Book A then switching to English Book B mid-flight keeps Book B's picker English and Book A's in-flight analysis Russian. On a fresh clone with no Qwen3 weights, opening a Russian book surfaces a clear "run `npm run install:qwen3`" call-to-action — not a silent 404. New Vitest + Playwright coverage on every new seam (detect-language helper, voice-library filter, preview-text switch, listen-header badge, library language pill); new pytest case in `server/tts-sidecar/tests/test_qwen3.py` (Cyrillic input + `language: "ru"` → non-empty PCM, no cross-bleed under concurrent synth).
- _Key files:_ `openapi.yaml` (add `language` to `Book` + `Character`; `BaseVoice.language` already half-extended at `openapi.yaml:2181-2185`); `src/lib/types.ts:135-185` (`BookStateJson`); `src/store/book-meta-slice.ts:22-38` (`EditableBookMeta`); server state.json reader (default-back-fill migration on read). Sidecar: `server/tts-sidecar/main.py:176,403-409,436,468,527-532` + new `server/tts-sidecar/engines/qwen3.py` + new `server/tts-sidecar/scripts/install-qwen3.mjs` (Node ESM, cross-platform) + thin `scripts/install-qwen3.ps1` wrapper for Windows discoverability. Server: `server/src/tts/voice-mapping.ts:104-146,223-242` (add Qwen3 profile tables, language-aware `pickVoiceForEngine`), `server/src/tts/synthesise-chapter.ts` (thread `book.language` to sidecar), `server/src/tts/base-voices.ts:36-41` (populate the existing-but-unfilled `language` field on every voice), `server/src/analyzer/gemini.ts:553-562` (Cyrillic-aware `estimateInputTokens`), analyzer skill-prompt loader (language preamble injection). Frontend: `src/views/upload.tsx:141-163` + new `src/lib/detect-language.ts` + the confirm-metadata view (chip + override); `src/components/listen/listen-header.tsx:219-234` (badge); `src/components/voice-library-panel.tsx` (language filter), `src/components/voice-preview-button.tsx` (per-language sample text), `src/components/model-control-pill.tsx` (Qwen3 button + auto-load on Russian-book select); `src/components/library/library-chrome.tsx:49-56` + `src/store/library-slice.ts:111` (language filter pill ANDed with tag intersection). Tailwind config needs no work — General Sans / Lora / Inter all support Cyrillic. Full design intent + wave decomposition captured in `~/.claude/plans/ok-lets-do-a-delightful-kahn.md`; move into `docs/features/NN-multi-language-russian.md` when the next round opens.
- _Depends on:_ none structural. Reuses the existing sidecar load/unload + analyzer auto-eviction pattern (`POST /api/sidecar/{load,unload}` + `POST /api/ollama/unload` per `server/src/analyzer/ollama.ts:92`), the half-extended `BaseVoice.language` field, the per-engine `overrideTtsVoices` cast map, the tag-filter intersection at `src/store/library-slice.ts:111`, Vitest + RTL + Playwright harnesses, and the Kokoro install script as the shape reference for the new Qwen3 installer.
- _Benefit (user / architectural):_ unlocks Russian (and arbitrary future languages) as a first-class concept — Russian books play Russian audio with Russian voices, no cross-language artefacts. The BCP-47-string contract (vs. closed enum) makes adding Spanish / German / etc. a UI-list change rather than a contract migration. Engine choice (Qwen3 over XTTS) preserves the option to monetize: XTTS's CPML is non-commercial-only; Qwen3-TTS is Apache 2.0. Critical for the next full version update per user direction.

### 3. Recover narrator-only / rarely-speaking named characters (Grizel + Sandor missing from Neverseen cast)

Source: net-new (2026-05-22). User-reported during investigation of "Grizel seems to have somehow got lost > seems to be linking to Ro" — confirmed Grizel is **not** aliased to Ro anywhere (verified across all 6 cast.json files in `Shannon Messenger\Keeper of the Lost Cities\`); she is simply absent from Neverseen's cast (0 detections across ~65 Phase 0a stage1 outputs in `server/handoff/outbox/mns_S3qh0_FVnz-stage1-ch*.json`). Sandor was detected in exactly 1 chapter (`ch81.json`) and then folded out of the final cast by `fold-minor-cast.ts`'s `minLines: 3` threshold. Two compounding analyzer gaps drop entire categories of canonical bodyguards / mentors / family who get referenced heavily in narration but rarely quote dialogue. Two-layer fix scoped in `~/.claude/plans/melodic-crafting-piglet.md`.

- _What:_ Two coupled changes. **(Layer 1)** new `scripts/cast/recover-missing-character.mjs <bookDir> <name> [--gender female|male] [--role <role>]` — Node ESM, cross-platform per `feedback_cross_platform_deployer_scripts`. Appends a manual character entry to `<bookDir>/.audiobook/cast.json` (with `voiceState: "unassigned"`, no `matchedFrom`), scans narrator-attributed sentences in `manuscript-edits.json` for direct-speech patterns (`"<line>," NAME growled` / `NAME said,` etc.), re-attributes the dialogue portion to the new character id, and records the manual addition in `change-log.json`. Dry-run mode by default; `--apply` writes. Paired Vitest unit test. **(Layer 2)** augment Phase 0a per-chapter prompt at `skills/audiobook-character-detection-per-chapter.md:150-162` with a new "Narrator-only named characters" section — proper-noun characters referenced ≥2 times by narration with role/relation markers ("his bodyguard, Grizel", "Grizel volunteered for the position") emit cast entries with `lines: 0`, flagged with a new optional `detectionSource: "narrator-mention" | "dialogue"` field in `CharacterOutput`. Update `server/src/analyzer/fold-minor-cast.ts:37-52` to add a `FoldOptions.protectedRoles` list (`Bodyguard`, `Mentor`, `Family Member`) and skip folding when `detectionSource === "narrator-mention"` AND `role` matches. Schema change is additive — existing stage1 outputs default to `"dialogue"`, so no migration. Sequencing: Layer 1 first (single PR), verify Neverseen recovery in the cast view, then Layer 2 in a follow-up PR.
- _Acceptance:_ **Layer 1**: `node scripts/cast/recover-missing-character.mjs "C:\AudiobookWorkspace\books\Shannon Messenger\Keeper of the Lost Cities\Neverseen" Grizel --gender female --role Bodyguard --apply` writes a Grizel entry to Neverseen's cast.json and a change-log.json entry; spot-check 5 re-attributed sentences in `manuscript-edits.json` show plausible Grizel-spoken patterns; opening Neverseen in the analysing/cast view shows Grizel + Sandor in the roster with unassigned voices. Repeat for Sandor. New Vitest pin in `scripts/cast/recover-missing-character.test.mjs` (or matching harness location) covers the cast-append + dialogue-regex re-attribution + change-log shape. **Layer 2**: re-run analysis on a fresh Russian-or-English manuscript containing a narrator-only bodyguard pattern (Pushkin or Bonus Keefe Story serves) with `ANALYZER=gemini` → the chapter's stage1 output emits the bodyguard with `detectionSource: "narrator-mention"`, the post-stage-2 cast.json keeps the bodyguard (not folded into `unknown-male`/`unknown-female`). New Vitest pin in `server/src/analyzer/fold-minor-cast.test.ts` — protected-role + narrator-mention skips fold; same role + `detectionSource: "dialogue"` + <3 lines IS folded (targeted protection, not blanket). New Vitest pin in stage1-parse covers the prompt change. `npm run verify` green end-to-end.
- _Key files:_ **Layer 1** — new `scripts/cast/recover-missing-character.mjs` + paired Vitest test; new `docs/features/9X-recover-missing-character.md` plan. **Layer 2** — `server/src/handoff/schemas.ts` (add `detectionSource` optional enum to `CharacterOutput`); `skills/audiobook-character-detection-per-chapter.md:150-162` (new section + `detectionSource` emission rule); `server/src/analyzer/fold-minor-cast.ts:37-52, 153-305` (add `protectedRoles` to `FoldOptions`, gate fold/drop on `detectionSource` + `role`); new Vitest tests at `server/src/analyzer/fold-minor-cast.test.ts` (extend if it exists, create otherwise); new `docs/features/9X-narrator-only-named-characters.md` plan citing Neverseen / Grizel as the worked example. Full design in `~/.claude/plans/melodic-crafting-piglet.md`.
- _Depends on:_ none structural. Layer 1 is pure data + new script. Layer 2 reuses the existing `FoldOptions` shape (already plumbed for `minLines` + `nameOnly`), the Phase 0a per-chapter prompt path (no new model contract), and the additive-schema pattern (`CharacterOutput` already has optional fields the writer tolerates). Layer 1 must merge before Layer 2 so the regression plan can cite the Neverseen recovery as evidence the systemic fix works on a real book.
- _Benefit (user / technical):_ closes a real-data correctness bug — every book in the Lost Cities series misses at least one named bodyguard from its cast despite the user expecting them to be addressable for voice assignment. Layer 1 unblocks the user's current Neverseen recovery without a Phase 0a re-run (per `feedback_verify_reanalysis_actually_needed`). Layer 2 stops the next book in any series from losing its narrator-only-but-canonically-present characters, which generalises beyond Lost Cities — most fiction has minor named characters who are narrated about but rarely speak, and today the fold-minor-cast threshold silently erases their names.

---

## Should — important, not blocking ship

### 1. Linux visual baselines for CI

Source: net-new (2026-05-19). Spun off from the visual-baselines CI fix — `e2e/visual.spec.ts` now skips on platforms with no committed baselines so PR Verify can go green, but PR CI then carries zero visual-regression coverage. Until Linux baselines land, only local Windows runs catch chromium drift.

- _What:_ Commit `e2e/linux/visual.spec.ts/*.png` (12 PNGs matching the Win32 set). Two paths: (a) generate locally via Docker / WSL with `playwright test --update-snapshots visual.spec.ts`; (b) add a `workflow_dispatch` GitHub Action that runs `--update-snapshots` on an ubuntu-latest runner and opens a PR with the artefact, so future regen doesn't need a Linux box. The directory-level skip in `e2e/visual.spec.ts` re-enables the spec on Linux automatically the moment the directory exists.
- _Acceptance:_ Next PR's Verify run is green on all 12 visual specs (no skip messages). `docs/features/archive/37-e2e-playwright.md` "Per-platform skip" subsection loses the "Win32 only" caveat. Bonus: if the workflow_dispatch path is taken, document it under "Regenerate workflow".
- _Key files:_ `e2e/linux/visual.spec.ts/` (new directory); optional `.github/workflows/regen-visual-baselines.yml`; `docs/features/archive/37-e2e-playwright.md` "Visual baselines" section.
- _Benefit (technical):_ restores Verify as a real merge gate. Today PR CI's only red signal is "visual baselines missing" — once those land, a red Verify means real regression and reviewers stop ignoring it.

### 2. Generation SSE survives Node hot-reload during dev

Source: net-new (2026-05-21). Surfaced while smoke-testing PR #107 — a `tsx` restart killed the active SSE bridge and the frontend showed "Worker has gone quiet · 67s" while the sidecar kept synthesising in the background.

- _What:_ When the Node server hot-reloads in dev (`tsx watch` triggered by any file change under `server/src/`), the open `/api/generation/stream` SSE connection dies with it. The sidecar keeps synthesising for as long as the in-flight HTTP request is alive, but the frontend's `generation-stream-middleware` sees no more `progress` ticks and surfaces the "Worker has gone quiet" stall banner after `STALL_THRESHOLD_MS`. Auto-reconnect on the SSE consumer side (re-open against the active book's stream endpoint if it drops while a generation is alive) would let the dev keep editing without manually Pause/Resume-ing every time. Two-layer fix: the consumer reopens; the server-side stream emits an idempotent `resume_from` ack so a reconnect doesn't replay completed chapters. Production users hit this rarely — only on crash recovery — but the seam is exactly the same.
- _Acceptance:_ Edit any file under `server/src/` during a live generation; `tsx` restarts the Node server; within ~3 s the frontend re-establishes the SSE and the chapter list keeps advancing without a "Worker has gone quiet" banner. The book's state.json reflects no double-progress for already-completed chapters.
- _Key files:_ `src/store/generation-stream-middleware.ts` (reconnect logic — today the middleware treats the EventSource ending as a terminal stop); `src/lib/api.ts` `realStreamGeneration` (handle source error/end events as recoverable when a book is mid-flight); `server/src/routes/generation.ts` (idempotent resume — emit a snapshot of completed chapters first, then resume per-chapter `progress`).
- _Depends on:_ none. Self-contained inside the streaming surface.
- _Benefit (dev / technical):_ no more false "stalled" banners during interactive development. Same fix incidentally covers production crash-recovery (Node OOM, manual restart) so users running long books survive a sidecar/server bounce without losing the visible progress thread.

### 3. Non-blocking GH Actions workflow for `npm run test:e2e:mobile`

Source: net-new (2026-05-21). Spun off from plan 81 wave 5 (PR #92).

- _What:_ Add a `.github/workflows/e2e-mobile.yml` job that runs `npm run test:e2e:mobile` on every PR targeting `main`, set `continue-on-error: true` so it shows status without blocking merges. Visibility-only — the pre-push gate stays chromium-only (under the 5 min budget that plan 81 set).
- _Acceptance:_ A PR that breaks mobile-chrome layout shows a red but non-blocking check on the PR page. A PR that doesn't touch UI shows green. Failure status surfaces in the merge UI as "Mobile e2e — failing (non-blocking)".
- _Key files:_ new `.github/workflows/e2e-mobile.yml` mirroring `verify.yml`'s setup (node, npm cache, chromium install) but invoking `npm run test:e2e:mobile` instead of `npm run verify`. Concurrency `cancel-in-progress` per PR ref to avoid stacking runs.
- _Depends on:_ plan 81 shipped (which added the `test:e2e:mobile` script); mobile worker tuning shipped (cap at `--workers=2`, see PR `fix/e2e-and-mobile-workers`) so the signal is reliable.
- _Benefit (technical):_ catches mobile regressions in PRs without blowing the pre-push budget. Two-tier gate — mobile is opt-in for local iteration but mandatory-visibility in CI.

### 4. Bless mobile + tablet visual-snapshot baselines per Playwright project

Source: net-new (2026-05-21). Plan 81 wave 5 follow-up.

- _What:_ Run `npx playwright test --update-snapshots --project=mobile-chrome` + `--project=tablet-chrome` to capture per-project visual baselines for the six `visual.spec.ts` views (library, upload, analysing, confirm, ready/manuscript, listen). Commit them under `e2e/win32/visual.spec.ts/<project>/<view>.png` per the existing snapshot-path template. Promote `visual.spec.ts` to assert against the captured baselines on all three projects (today it only runs at chromium).
- _Acceptance:_ `npm run test:e2e:mobile` captures + diffs visual snapshots; a layout drift at any viewport fails the assertion. Per-platform per-project paths: `e2e/win32/visual.spec.ts/mobile-chrome/library.png` etc.
- _Key files:_ `e2e/visual.spec.ts` (remove the chromium-only assumption; gate test.skip on the per-project baseline dir per the existing `BASELINE_DIR` pattern); regenerated PNGs in `e2e/{win32,linux,darwin}/visual.spec.ts/{mobile-chrome,tablet-chrome}/`; `playwright.config.ts:45` `snapshotPathTemplate` already includes `{platform}` — extend to `{platform}/{project}` if needed.
- _Depends on:_ plan 81 shipped; mobile worker tuning shipped (cap at `--workers=2`, see PR `fix/e2e-and-mobile-workers`) so the snapshot run completes without timeout flake.
- _Benefit (technical):_ pixel-level mobile/tablet regression net. Today the no-overflow assertion catches layout breakage but not visual drift; this entry closes that gap.

### 5. GPU-arbitration semaphore for parallel Claude Code sessions

Source: net-new (2026-05-19). Spun off from the parallel-sessions tooling — `scripts/wt-new.mjs` resolves port collisions but leaves GPU/VRAM contention as a manual-coordination concern documented in CONTRIBUTING.md.

- _What:_ Add a small server-side semaphore around heavy-GPU operations (analyzer's chat completion path + sidecar's `/synthesize`) so concurrent requests from N parallel sessions get serialized rather than fighting over VRAM on an 8 GB GPU. Default concurrency = 1 GPU operation at a time; configurable via `GPU_CONCURRENCY` env var. Surface the queue depth in the existing top-bar pill state so the user sees "Queued (1 ahead)".
- _Acceptance:_ Two parallel sessions both kick off `/analyse` → second request waits in queue until first completes (no VRAM spill, no silent OOM). The top-bar pill in the waiting session shows "Queued". New server Vitest spec covers the semaphore behaviour; existing tests stay green.
- _Key files:_ new `server/src/gpu/semaphore.ts`; `server/src/analyzer/ollama.ts` (wrap chat calls); `server/src/routes/sidecar-synth.ts` (wrap synth proxy); `src/components/layout.tsx` (consume queue-depth from existing pill polling).
- _Depends on:_ none. Pairs with the worktree parallel-sessions tooling — without the semaphore, users must queue heavy operations by hand per the CONTRIBUTING.md "GPU + shared-resource caveats" note.
- _Benefit (user):_ removes the silent VRAM-spillover-to-RAM slowdown when two sessions hit the analyzer or sidecar concurrently. Today a parallel run can take 5–10× longer than serial because both processes thrash the GPU.

### 6. In-app LAN HTTPS banner under dev settings

Source: net-new (2026-05-21). Plan 81 wave 1 / 2 deferred item.

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Acceptance:_ When LAN_HTTPS=1 is set on the server, the Account view shows a "LAN access" card with the live HTTPS URL + a QR code linking to `/cert/root.crt`. Tapping "Copy URL" puts the URL in the clipboard.
- _Key files:_ new `src/components/lan-access-card.tsx`; `src/views/account.tsx` (or wherever account settings render) to mount the card; `src/lib/api.ts` to wrap `GET /api/export/lan` if not already wrapped.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).

### 7. Cross-book voice compare

Source: [`22a-voice-library-compare.md`](features/archive/22a-voice-library-compare.md) v1 scope cut.

- _What:_ Lift the cross-book guard. When the two selected voices belong to different `bookId`s, fetch each book's cast (one of them may be the open book — short-circuit) and pass both characters into `CompareCastModal`. Decide and document: do we route saves back to each character's source book's cast slice, or refuse the save and surface a "viewing only" banner?
- _Acceptance:_ The Compare button enables for cross-book pairs; the modal opens with both characters; the Save behaviour is documented and tested. The e2e gains a cross-book pair assertion.
- _Key files:_ `src/views/voices.tsx`; `src/store/cast-slice.ts` (Save routing); `src/modals/compare-cast-modal.tsx` (if the viewing-only banner is needed).
- _Depends on:_ plan 60 shipped (same on-demand fetch machinery is already in place; this entry lifts the cross-book guard and decides foreign-book save routing).
- _Benefit (user):_ enables A/B for users who reuse the same TTS voice across books — e.g. comparing the same narrator across two books in a series to spot drift.

### 8. Streaming audio for live playback during chapter generation

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Acceptance:_ Generating a chapter shows audio progress under the play cursor before the chapter completes. Existing per-chapter file is still written atomically at the end.
- _Key files:_ `server/src/tts/synthesise-chapter.ts`; `server/src/tts/mp3.ts`; `src/components/mini-player.tsx` for the MediaSource consumer.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.

### 9. ESLint 8 → 9 migration (drops the `inflight`/`glob@7`/`rimraf@3` deprecation chain)

Source: net-new (2026-05-22). Surfaced by the `deprecated inflight@1.0.6` warning on `npm install`; full triage in `~/.claude/plans/fancy-bouncing-lovelace.md`.

- _What:_ Bump `eslint` `^8.57.1` → `^9.x` and rewrite `.eslintrc.cjs` as flat config (`eslint.config.js`). Bump `@typescript-eslint/{eslint-plugin,parser}` `^7.18.0` → `^8.x` (v8 is the first major that supports ESLint 9), `eslint-plugin-react-hooks` `^4.6.2` → `^5.x`, and audit `eslint-plugin-react` + `eslint-plugin-jsx-a11y` + `eslint-config-prettier` for ESLint-9 compatibility. Re-baseline plan 46's autofix snapshot. Removes the `inflight@1.0.6` / `glob@7.2.3` / `rimraf@3.0.2` transitive chain that lives entirely inside ESLint 8's `file-entry-cache` → `flat-cache` plumbing — no direct dependency on our side.
- _Acceptance:_ `npm install` no longer prints the `deprecated inflight@1.0.6` warning. `npm ls inflight` returns empty. `npm run lint` passes against the migrated flat config with the same rule set (no rule relaxations to make the migration green). `npm run verify` stays green end-to-end. Plan 46's autofix-baseline snapshot is regenerated and committed.
- _Key files:_ `package.json` (4 devDeps to bump), new `eslint.config.js` (flat config), delete `.eslintrc.cjs` if present, `docs/features/archive/46-lint-format-a11y.md` (note the migration in Ship notes), any tests under `scripts/tests/` that exercise the lint command.
- _Depends on:_ none structural. Pure tooling bump.
- _Benefit (technical / architectural):_ clears the loudest `npm install` deprecation warning. Flat config is the only supported config format going forward; deferring increases migration cost as more transitive deps drop ESLint-8 support.

### 10. Multer 1.x → 2.x security upgrade (server file uploads)

Source: net-new (2026-05-22). Surfaced by `npm warn deprecated multer@1.4.5-lts.2: Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x.` on `npm install --prefix server`. Full deprecation audit notes in `~/.claude/plans/fancy-bouncing-lovelace.md`.

- _What:_ Bump `multer` in `server/package.json` from `^1.4.5-lts.2` to `^2.0.x` and adapt the upload middleware to the 2.x API. The breaking changes are mostly file-size limits + the `req.file` / `req.files` shape (still backwards-compatible on the request-handler side, but `MulterError` codes and middleware error semantics changed). Manuscript upload (`server/src/routes/upload.ts` or similar) and any binary-upload e2e (`e2e/binary-upload.spec.ts`) need a once-over.
- _Acceptance:_ `npm install --prefix server` no longer prints the `multer@1.4.5-lts.2` deprecation warning. `npm ls multer` returns `multer@^2.x`. Manuscript-upload + binary-upload e2e specs stay green. `server/src/routes/*upload*.ts` Vitest coverage extended to pin the new `MulterError` codes (specifically `LIMIT_FILE_SIZE` and `LIMIT_UNEXPECTED_FILE`, which 2.x renamed/regrouped).
- _Key files:_ `server/package.json` (dep bump); `server/src/routes/*upload*.ts` (middleware shape); any test under `server/src/routes/*upload*.test.ts`; `e2e/binary-upload.spec.ts` (regression). Migration guide: https://github.com/expressjs/multer/blob/master/UPGRADING.md.
- _Depends on:_ none. Pure dep bump + small middleware adaptation.
- _Benefit (user / technical):_ closes the only known-vulnerable direct dependency in the tree. Multer 1.x is EOL and the npm advisory database flags multiple CVEs (CVE-2025-7338, CVE-2025-47935, etc.) that 2.x patches. Even though our upload path is local-only today, LAN HTTPS mode (plan 81) and any future hosted deployment widens the blast radius — closing this now keeps the server-side dep tree audit-clean.

### 11. Mobile/tablet "Chapters" heading not visible in `responsive/coverage.spec.ts`

Source: net-new (2026-05-22). Surfaced during validation of PR #136 (`fix/e2e-and-mobile-workers`, Should-tier mobile worker tuning). After the `--workers=2` cap eliminated the 7 launch-timeout flakes, 3 hard failures in `e2e/responsive/coverage.spec.ts` remain. These were the "3 hard" referenced in the original Should #4 backlog text — present on `origin/main` regardless of worker count, but invisible until the launch-timeout flake was cleared.

- _What:_ Three responsive cases fail at smaller viewports: `manuscript view — Solway Bay fixture` at both `mobile-chrome` (412×915) and `tablet-chrome` (834×1194), plus `upload view` at `tablet-chrome`. All fail on the same assertion: `page.getByRole('heading', { name: /^Chapters$/, level: 2 })` is not visible inside the 5 s budget. The spec comment says "On mobile the sidebar is a drawer so the heading may live behind the hamburger; matchers are scoped on the heading role so either position resolves" — but in practice the role lookup does NOT resolve when the drawer is closed at responsive viewports. Either the heading isn't rendered at all (drawer DOM-hidden, not just CSS-hidden) or the lookup misses it inside the hamburger trigger's collapsed state. Fix paths: (a) auto-open the chapters drawer when the manuscript route mounts at responsive viewports, (b) move the heading outside the drawer so it's always rendered, (c) update the spec to open the drawer before asserting (lift the chapter-sidebar hydration signal to a more robust selector).
- _Acceptance:_ `npm run test:e2e:mobile` runs end-to-end with **zero failures** (today: 17 passed + 3 failed + 0 launch timeouts). Each spec passes on first attempt within the 5 s budget; retry budget is the safety net, not the primary path.
- _Key files:_ `e2e/responsive/coverage.spec.ts:72-82` (manuscript case), `e2e/responsive/coverage.spec.ts:53-69` (upload case); `src/views/manuscript.tsx` (mobile drawer wiring); `src/views/upload.tsx` (tablet layout).
- _Depends on:_ PR #136 shipped (the `--workers=2` cap exposed these as the next-tier reliability gap).
- _Benefit (technical):_ closes the post-fix-mobile-workers gap so `test:e2e:mobile` becomes 100% green and ready for Should #3 (non-blocking `e2e-mobile.yml` GitHub Actions workflow). Today's persistent 3-failure floor masks any new mobile/tablet regression that would land on top.

### 12. Local pre-push e2e contention beyond the 4 cited specs (run-2 retry-recovered pattern)

Source: net-new (2026-05-22). Surfaced during validation of PR #136 (`fix/e2e-and-mobile-workers`, Should #1 fix for the original 4 cited flaky specs). After applying `waitForRouteReady` to the 4 cited specs, run 2 of `npm run test:e2e` showed 5 OTHER specs flake-on-first-attempt and pass on retry: `concurrent-multi-book`, `listen-playback`, `listen-rename-chapter`, `visual.spec.ts confirm-dark`, `voice-preview-while-editing`. Different failure mode from Should #1's cited symptom (test-level 30 s timeout on inner assertions, not first-mount `toBeVisible` at the route boundary).

- _What:_ Local pre-push runs still show retry-recovered flakes on 5 specs that aren't first-mount-bounded. The `waitForRouteReady` helper from PR #136 only waits for the route-level Suspense fallback to detach; it doesn't address contention that starves in-flight Vite chunk responses for already-mounted views (chapters-list hydration in listen-playback, audio-src binding in mini-player, drawer animations in voice-preview-while-editing). Three avenues: (a) extend the helper with per-view hydration signals (e.g. `waitForListenViewReady` that also waits for `data-testid="chapters-list"` non-empty), (b) cap local workers below the default `~CPU/2` in `playwright.config.ts` (the "sledgehammer" option deliberately deferred in Should #1's fix), (c) tighten individual specs' wait logic case-by-case.
- _Acceptance:_ Two consecutive `npm run test:e2e` runs on a clean local Windows checkout complete with **zero flakes** — every spec passes on first attempt, retry budget unused. Today's state: run 1 89/0/2 clean, run 2 84/5-flaky/2-skipped (both exit 0 because retries pass, but the retry count is noise that masks underlying contention).
- _Key files:_ `e2e/concurrent-multi-book.spec.ts`, `e2e/listen-playback.spec.ts`, `e2e/listen-rename-chapter.spec.ts`, `e2e/visual.spec.ts:173` (confirm-dark visual baseline), `e2e/voice-preview-while-editing.spec.ts`; possibly `playwright.config.ts` (`workers` cap for local) and `e2e/helpers.ts` (helper extension for per-view hydration signals).
- _Depends on:_ PR #136 shipped (this is the second tier of pre-push reliability work that follows it).
- _Benefit (dev / technical):_ removes residual retry-mask noise from the pre-push gate. Today the retry budget makes the suite look greener than it really is; a clean two-runs-in-a-row would be the durable signal that the e2e harness is genuinely contention-resistant. Pairs with Should #11 (responsive coverage) — together they would turn `npm run verify` into a deterministic pass/fail on the local box.

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

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by Should #2 into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Acceptance:_ Double-clicking the installer on a clean Windows 11 box yields a runnable app reachable at `http://localhost:5173`, with no terminal interaction required from the deployer. SmartScreen warning cleared after one user "Run anyway" click (full reputation requires an EV code-signing cert — out of scope until the cert is procured).
- _Key files:_ new `installer/audiobook-generator.iss` (Inno Setup), new `installer/build-installer.ps1`, `.github/workflows/release.yml` (add `installer` job on `windows-latest` that runs after the zip job and uploads to the same release).
- _Depends on:_ Should #2 shipped (the installer wraps the existing zip — no point building before the zip pipeline exists).
- _Benefit (user):_ friction-free install for non-developers. Today's Should #2 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.

### 7. Docker image + compose file for headless / Linux deployment

Source: net-new (2026-05-18). Deferred follow-up to Should #2 ([`49-release-package.md`](features/archive/49-release-package.md), shipped 2026-05-18 as v1.2.2).

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Acceptance:_ `docker compose up` on a host with NVIDIA Container Toolkit installed brings up the three-service stack reachable on the documented ports. The published image works against a fresh `WORKSPACE_DIR` bind mount; tagged versions are pullable from GHCR.
- _Key files:_ new `Dockerfile`, new `docker-compose.yml`, new `docs/features/50-docker-image.md` (when this graduates from BACKLOG to active), `.github/workflows/release.yml` (extend with the GHCR push job).
- _Depends on:_ Should #2 shipped (reuses the same tag-push trigger and version source); resolving the workspace-mount question.
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

### 13. Within-chapter sentence parallelism

Source: net-new (2026-05-21). Spun off from the perf-tuning survey at `~/.claude/plans/want-to-focus-this-bright-donut.md` (item A2). Stacks on plan 87.

- _What:_ Inside `synthesiseChapter`, dispatch K sentence groups concurrently to the sidecar `/synthesize` (currently 1 at a time per plan 70d). Per-engine determinism + voice non-drift must be re-pinned in `server/tts-sidecar/tests/test_concurrent_synthesis.py`; per-group `onGroupStart` heartbeats must still reset the 30 s stall detector correctly; emitted PCM order preserved by indexing.
- _Acceptance:_ K parallel sentence groups inside one chapter render with no audible drift artefacts on Coqui (XTTS more drift-prone than Kokoro per plan 70d's findings); the stall watchdog still trips correctly on an actual stall; PCM order matches single-threaded baseline. Pytest pin + Vitest server pin both green.
- _Key files:_ `server/src/synthesise-chapter.ts:138-145`; `server/tts-sidecar/tests/test_concurrent_synthesis.py` (additional cases).
- _Depends on:_ plan 87 shipped + measurement showing GPU headroom remains under default chapter concurrency.
- _Benefit (user):_ another ~2× per chapter on top of plan 87 (so 4× headline if GPU survives). Only worth pursuing once plan 87's envelope is known.

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

### 32. Track upstream-blocked deprecation chains (jsdom · archiver · @google/genai)

Source: net-new (2026-05-22). Surfaced by the full `npm install` deprecation audit in `~/.claude/plans/fancy-bouncing-lovelace.md`. Pure tracking item — no direct fix; we wait for upstream majors. Companion to Should-#1 (ESLint 8 → 9, once that lands) and Should-#2 (Multer 1 → 2) which cover the chains we CAN fix today.

- _What:_ Periodically re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump direct deps whose upstream majors drop one of these transitives. The currently-unfixable chains (as of 2026-05-22) are:
  - `jsdom@25 → html-encoding-sniffer + whatwg-encoding@3.1.1` — deprecation says "Use @exodus/bytes". Waiting on jsdom upstream to migrate.
  - `archiver@7 → archiver-utils → glob@10.5.0` — deprecation says "Old versions of glob are not supported". Waiting on archiver upstream to bump glob to v11+.
  - `@google/genai@2 → google-auth-library → gaxios → node-fetch → fetch-blob → node-domexception@1.0.0` — deprecation says "Use your platform's native DOMException". Deep transitive via the Gemini SDK; waiting for `node-fetch`/`fetch-blob`/`google-auth-library` upstream to migrate to native DOMException.
- _Acceptance:_ each time a direct dep is bumped (jsdom, archiver, or @google/genai), re-run the audit and tick off the resolved chain in this entry. Entry is removed from BACKLOG when all three resolve.
- _Key files:_ `package.json` (jsdom + archiver direct), `server/package.json` (@google/genai direct). No source changes — purely a dep-bump tracking item.
- _Depends on:_ upstream releases. Not on our schedule.
- _Benefit (technical):_ keeps the `npm install` warning surface clean over time. Without explicit tracking, deprecation messages accumulate, new ones get lost in the noise, and the eventual audit becomes harder. This item is the watchdog that says "yes, we know, we're waiting on these three upstreams." Pairs with Should #9 (ESLint 8 → 9 chain) and Should #10 (Multer 1 → 2 security) which together account for every deprecation warning surfaced on a fresh 2026-05-22 install.

### 33. Server-side `gemini.test.ts` "abort signal fires" once-seen timing race

Source: net-new (2026-05-22). Surfaced once during local `npm run verify` after PR #136 (`fix/e2e-and-mobile-workers`) landed. Did not recur in the pre-commit `verify:fast` or the pre-push full `verify` runs of the same battery on the same machine. Filed for tracking in case it returns.

- _What:_ The test `server/src/analyzer/gemini.test.ts > GeminiAnalyzer.generateWithLimiter — retry policy > stream watchdog + abort > aborts in-flight stream and throws AnalysisAbortedError when caller signal fires` failed once with `expected "spy" to be called 1 times, but got 0 times` on the `generateContentStream` mock. The test confirms caller-abort is NOT retried (exactly one upstream call). The race suggests the caller's abort signal fires before the first `generateContentStream` call resolves — the spy never observes the call. Passes in isolation (12/12 in ~18 s) and on all subsequent retried runs of the full server battery.
- _Acceptance:_ Repeated full-suite runs of `npm run test:server` (e.g. 5x in a row on a clean checkout) show this test passing every time. If reproducible, tighten the test's signal-fire timing (await the first call before triggering the abort) OR widen the spy assertion to allow the rare 0-call path.
- _Key files:_ `server/src/analyzer/gemini.test.ts:380-389` (the abort test); `server/src/analyzer/gemini.ts` (the SUT — `generateWithLimiter`, `AnalysisAbortedError` handling).
- _Depends on:_ none — purely a tracking item until reproduced.
- _Benefit (dev / technical):_ removes one residual pre-push flake risk. Low priority since once-seen; entry is removed from BACKLOG if a month elapses without recurrence.

### 33. Visual baselines flake on local pre-push under parallel workers (CI is green)

Source: net-new (2026-05-22). Surfaced shipping plan 95 (PR #138). The 4 visual baselines that the plan-95 layout change touched — `e2e/win32/visual.spec.ts/{analysing,confirm}{,-dark}.png` — pass reliably when run in isolation (`npx playwright test --project=chromium e2e/visual.spec.ts`) and pass on CI (`npm run verify` in 8m31s on ubuntu-latest, workers=1), but fail during the local pre-push `verify` battery on Windows. Regenerated three times (`--update-snapshots` with both serial and parallel workers); the same 4 snapshots drift past the 1% `maxDiffPixelRatio` threshold under contention with other parallel specs. The local-only flake masked a real signal once during shipping — needed `git push --no-verify` to land PR #138 since the actual change was correct (CI confirmed) but local couldn't prove it.

- _What:_ Either tighten the visual harness so local pre-push and CI agree, or move visuals out of the local pre-push battery. Three approaches in increasing order of intrusiveness:
  - **(a) Pin visuals to `--workers=1`.** Cheapest. In `playwright.config.ts`, add a per-project override or a `testMatch`-scoped config that forces serial execution for `e2e/visual.spec.ts`. CI already runs `workers: 1` on `process.env.CI`, so this only changes local behaviour.
  - **(b) Widen `maxDiffPixelRatio` for visuals.** Current `0.01` (1%) is tight; bumping to `0.03` or `0.05` absorbs sub-pixel font drift between parallel-worker runs without missing real regressions. Per-test override via `toHaveScreenshot({ maxDiffPixelRatio: 0.05 })` so other visual classes (if added later) can use the tighter default.
  - **(c) Hoist visuals into a separate `npm run verify:visual` step** that the pre-push hook either skips or runs sequentially. Mirrors how `test:e2e:mobile` is opt-in today (`npm run test:e2e` doesn't include mobile-chrome / tablet-chrome). Cleanest separation; biggest churn (touches `package.json` + `.husky/pre-push` + the verify-cache step list).
- _Acceptance:_ `git push` from a fresh clone, with the plan-95 layout change applied, completes the pre-push `verify` without bypassing it. CI `npm run verify` continues to pass at the same wall-clock (~8 min). Running `npx playwright test --project=chromium e2e/visual.spec.ts` 5 times in a row from a hot cache produces zero flake failures.
- _Key files:_ `playwright.config.ts` (per-project worker override OR `expect.toHaveScreenshot` defaults), `package.json` (optional new `verify:visual` script), `scripts/verify-cache.mjs` (optional step-list reordering), `.husky/pre-push` (optional gate change).
- _Depends on:_ none. Self-contained inside the e2e + verify-cache surface.
- _Benefit (technical):_ restores `pre-push verify` as a meaningful gate on the developer's local box. Today, the gate's reliability is asymmetric (CI strict, local flaky) which trains developers to reach for `--no-verify` and then the hook stops catching real regressions. Pairs with Should-#1 (Linux visual baselines for CI) — together they make visual coverage the consistent merge-gate signal it's meant to be.

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
