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
- _Acceptance:_ Upload an English manuscript → behaviour unchanged from today (regression). Upload a Russian public-domain fixture (Pushkin / Chekhov — NOT the Keefe Story, that's English) → confirm-metadata chip detects Russian + allows override → opening the book auto-loads Qwen3 with the existing analyzer-eviction banner → cast picker shows ONLY Russian voices → preview button speaks a Russian pangram → generated chapter audio is Russian with zero English bleed-through. Cyrillic token estimate within ±10% of actual `usage.input_tokens` on a long chapter. Library `Russian` filter pill ANDs with existing tag filters. Concurrent-multibook invariant holds: starting Russian Book A then switching to English Book B mid-flight keeps Book B's picker English and Book A's in-flight analysis Russian. On a fresh clone with no Qwen3 weights, opening a Russian book surfaces a clear "run `npm run install:qwen3`" call-to-action — not a silent 404. New Vitest + Playwright coverage on every new seam (detect-language helper, voice-library filter, preview-text switch, listen-header badge, library language pill); new pytest case in `server/tts-sidecar/tests/test_qwen3.py` (Cyrillic input + `language: "ru"` → non-empty PCM, no cross-bleed under concurrent synth).
- _Key files:_ `openapi.yaml` (add `language` to `Book` + `Character`; `BaseVoice.language` already half-extended at `openapi.yaml:2181-2185`); `src/lib/types.ts:135-185` (`BookStateJson`); `src/store/book-meta-slice.ts:22-38` (`EditableBookMeta`); server state.json reader (default-back-fill migration on read). Sidecar: `server/tts-sidecar/main.py:176,403-409,436,468,527-532` + new `server/tts-sidecar/engines/qwen3.py` + new `server/tts-sidecar/scripts/install-qwen3.mjs` (Node ESM, cross-platform) + thin `scripts/install-qwen3.ps1` wrapper for Windows discoverability. Server: `server/src/tts/voice-mapping.ts:104-146,223-242` (add Qwen3 profile tables, language-aware `pickVoiceForEngine`), `server/src/tts/synthesise-chapter.ts` (thread `book.language` to sidecar), `server/src/tts/base-voices.ts:36-41` (populate the existing-but-unfilled `language` field on every voice), `server/src/analyzer/gemini.ts:553-562` (Cyrillic-aware `estimateInputTokens`), analyzer skill-prompt loader (language preamble injection). Frontend: `src/views/upload.tsx:141-163` + new `src/lib/detect-language.ts` + the confirm-metadata view (chip + override); `src/components/listen/listen-header.tsx:219-234` (badge); `src/components/voice-library-panel.tsx` (language filter), `src/components/voice-preview-button.tsx` (per-language sample text), `src/components/model-control-pill.tsx` (Qwen3 button + auto-load on Russian-book select); `src/components/library/library-chrome.tsx:49-56` + `src/store/library-slice.ts:111` (language filter pill ANDed with tag intersection). Tailwind config needs no work — General Sans / Lora / Inter all support Cyrillic. Full design intent + wave decomposition captured in `~/.claude/plans/ok-lets-do-a-delightful-kahn.md`; move into `docs/features/NN-multi-language-russian.md` when the next round opens.
- _Depends on:_ none structural. Reuses the existing sidecar load/unload + analyzer auto-eviction pattern (`POST /api/sidecar/{load,unload}` + `POST /api/ollama/unload` per `server/src/analyzer/ollama.ts:92`), the half-extended `BaseVoice.language` field, the per-engine `overrideTtsVoices` cast map, the tag-filter intersection at `src/store/library-slice.ts:111`, Vitest + RTL + Playwright harnesses, and the Kokoro install script as the shape reference for the new Qwen3 installer.
- _Benefit (user / architectural):_ unlocks Russian (and arbitrary future languages) as a first-class concept — Russian books play Russian audio with Russian voices, no cross-language artefacts. The BCP-47-string contract (vs. closed enum) makes adding Spanish / German / etc. a UI-list change rather than a contract migration. Engine choice (Qwen3 over XTTS) preserves the option to monetize: XTTS's CPML is non-commercial-only; Qwen3-TTS is Apache 2.0. Critical for the next full version update per user direction.

---

## Should — important, not blocking ship

### `side-2` — Clean up deployer-facing warnings from the Qwen install + sidecar startup

Source: net-new (2026-05-24). Surfaced running `scripts/install-qwen3.mjs` on a clean Windows box — the install + first model load print several scary-looking-but-mostly-benign warnings that an alpha-tester deployer can't tell apart from real errors. To be fixed in a dedicated cleanup run (user-directed). Sweep ALL such warnings and decide suppress-vs-document for each; today's known ones:

- **HF Hub symlink warning** (`huggingface_hub cache-system uses symlinks … your machine does not support them … degraded version that might require more space`): functionally harmless — the install already localizes the cache to `voices/qwen/hf` via `HF_HOME`/`HF_HUB_CACHE` (`install-qwen3.mjs:83-84`), and with only two models (Base + VoiceDesign), downloaded once, the extra disk is negligible. **Fix:** add `HF_HUB_DISABLE_SYMLINKS_WARNING: '1'` to the install script's `env` object (`install-qwen3.mjs:84`) AND the sidecar's runtime env so it doesn't reappear at model load. Do NOT require enabling Windows Developer Mode. _**NOTE (2026-05-26, surfaced not fixed):** the "localizes the cache to `voices/qwen/hf` via `HF_HOME`" claim above is **stale** — `install-qwen3.mjs` deliberately aligned on the DEFAULT Hugging Face cache (the engine doesn't set `HF_HOME`, so the localized copy was ignored + re-downloaded). The `HF_HUB_DISABLE_SYMLINKS_WARNING` fix still applies; just don't rely on the cache-location detail, and re-check line refs (they drifted after plan 115's `--flash-attn` edit)._
- **`SoX could not be found!`**: a no-op for our pipeline — SoX is an optional audio backend a transitive dep (the coqui/torchaudio stack sharing the venv) probes at import; we do audio I/O via `soundfile` (libsndfile) and encode MP3 via ffmpeg server-side. **Action:** document as benign, or suppress at source if cheap; do NOT install SoX (its own Windows headache for zero benefit).
- **`flash-attn is not installed`**: SDPA is the correct default (plan 112), so flash-attn is NOT required. Plan 115 added an **opt-in** install of a verified prebuilt wheel (`install-qwen3.mjs --flash-attn`) for deployers who want to benchmark FlashAttention-2 — installing it *also* silences this banner. The line itself is benign and is emitted **upstream by transformers' import probe** when FA2 is absent (NOT by `qwen_tts` — verified against the package source). So the remaining `side-2` work here is only to suppress it at its narrowest scope (a `warnings` filter / env at sidecar startup) for the common case of a deployer who skips the wheel.

- _What:_ In a single cleanup pass over the Qwen install + sidecar startup, suppress every benign-but-noisy warning at its source (env var or logging filter) and leave only warnings the deployer must actually act on. Concrete fixes above; also re-run the install on a clean Windows box and triage any warning not yet listed.
- _Acceptance:_ Running `install-qwen3.mjs` + a first Qwen model load on a clean Windows box prints no scary warning that requires no action; any warning that remains is one the deployer genuinely must respond to. SoX + HF-symlink banners gone; the residual `flash-attn is not installed` line (benign, transformers-emitted) suppressed at source for the no-wheel case — note the opt-in FA2 wheel that *also* silences it already shipped in plan 115.
- _Key files:_ `server/tts-sidecar/scripts/install-qwen3.mjs` (env object ~line 84); `server/tts-sidecar/main.py` (sidecar runtime env / startup); `server/tts-sidecar/README.md` (document any warning intentionally left as-is).
- _Depends on:_ plan 108 install script (in flight). Fold the fixes into the cleanup run, not a one-off.
- _Benefit (user / deployer):_ clean first-run output for alpha testers — warnings that survive are actionable, not noise. Matches the multi-model-gap audit + deployer-facing-script hygiene already used elsewhere in the bundle.

### `srv-1` — Merge journal for deterministic alias un-link

Source: plan 95 ship (2026-05-22) — Out of scope. PR [#142](https://github.com/dudarenok-maker/AudioBook-Generator/pull/142) shipped editable cast aliases with a Reattribute Lines modal that uses the preserved Phase-0a `chapterCast` as a lineage proxy to narrow the user's manual reattribution from "whole book" to "these N chapters." It works, but it's not deterministic — a chapter shows up if the alias was in its Phase-0a roster, even when the merge that put the alias on the source character happened mid-book and didn't actually rewrite any chapter-1 sentences. The user has to skim and reassign.

- _What:_ At every cast-merge call site (manual merge route, fold-minor-cast post-stage-2 pass), append a record to a per-book journal file `<bookDir>/.audiobook/cast-merges.json` of shape `{ ts, kind: 'manual' | 'fold', sourceId, sourceName, targetId, affectedSentenceIds: number[] }`. The unlink-alias route then reads this journal to compute `impactedChapters.candidateSentenceIds` as the exact sentences originally rewritten by the merge — no `chapterCast` heuristic, no per-chapter listing of sentences that may belong to a third party.
- _Acceptance:_ A book with a single mid-flight merge that touched 12 sentences (all in chapters 7-9) → the unlink-alias modal lists exactly those 12 sentences across chapters 7-9, nothing else. Today's `chapterCast` path would also list chapters 1-6 sentences attributed to the source if the alias name happened to be in their roster too (false positives the user has to skip).
- _Key files:_ `server/src/routes/cast-merge.ts` (write the journal entry alongside the manuscript-edits rewrite), `server/src/analyzer/fold-minor-cast.ts` (caller-side hook so post-stage-2 folds also log), `server/src/routes/cast-aliases.ts` (replace the `chapterCast` derivation with a journal lookup), `server/src/workspace/paths.ts` (new path helper).
- _Migration:_ books that pre-date the journal still get the `chapterCast` fallback (today's behaviour); only newly-merged ones benefit. No backfill — the lineage was lost at the old merges and there's no way to reconstruct it.
- _Benefit (user):_ reattribute modal becomes a precise checklist instead of a scoped review — every row the user sees is provably their merge's work, no third-party sentences to skip over. Big quality-of-life win for series-2-into-1 cleanups where merges pile up.

### `srv-11` — Queue-level failure suppression (replace the removed cross-chapter cascade-kill)

Source: net-new (2026-05-25). Surfaced making the queue dispatcher the sole concurrency authority (one worker = one chapter; the plan-87 within-book worker pool removed). See the "Update — 2026-05-25" note in [`111-queue-worker-pool.md`](features/archive/111-queue-worker-pool.md).

> **Related (shipped 2026-05-26, PR #254):** failed chapters now PERSIST in the queue as `failed` (with their `errorReason`) and carry a per-row Retry control, instead of being silently done-pruned. That gives the user manual visibility + re-run for a repeated failure; this item adds the AUTO circuit-breaker (pause after N consecutive identical failures) on top of that. The per-book `chapter_failed`-tick plumbing the breaker needs already exists in the runner's `chapterFailures` map (`takeChapterFailure`).

- _What:_ Restore a safety net the refactor dropped. Under the old within-book worker pool, a chapter that deterministically poisoned synthesis (bad cast, missing voice, sidecar config error) failed alongside its book's other in-flight chapters via a shared cascade-kill — so a hopeless book stopped fast instead of burning the GPU re-failing every chapter. Now each chapter is its own `${bookId}::${chapterId}` queue job and fails independently, so N hopeless chapters each fail in turn with no circuit-breaker. Add a queue-level breaker: track consecutive identical failures per book (same `errorReason`), and after a threshold (e.g. 3) auto-pause that book's queue entries (or the whole queue) with a toast naming the repeated error, so the user fixes the root cause before the queue keeps draining into the same wall. Per-chapter independent failure stays the default; this only trips on a _repeated identical_ failure pattern.
- _Acceptance:_ Enqueue 5 chapters of a book whose cast references a non-existent voice → the first ~3 fail with the same `errorReason`, then the book's remaining queued entries auto-pause (not silently fail one-by-one) and a toast surfaces the repeated error. A book with a _single_ transient failure (different error, or one-off) keeps draining its siblings — no false trip. New server + dispatcher tests pin the consecutive-identical-failure counter, the threshold trip, and the reset-on-success.
- _Key files:_ `src/store/queue-dispatcher-middleware.ts` (track per-book consecutive failures off the stream's `chapter_failed` ticks; trip → `setQueuePaused` or a per-book pause), `server/src/workspace/queue-io.ts` (a per-book or per-entry failure-count field if the breaker needs persistence across reload), `server/src/routes/queue.ts` (status route if the count is server-tracked), `src/modals/queue-modal.tsx` (surface the tripped/paused state).
- _Depends on:_ the queue-sole-concurrency refactor (shipped — `refactor/server-queue-sole-concurrency`).
- _Benefit (user / technical):_ stops a misconfigured book from quietly burning GPU time re-failing every chapter; the user gets one clear "this keeps failing for reason X" signal instead of N scattered per-chapter failures. Restores the fail-fast property the cascade-kill gave for free, without re-coupling sibling chapters into one job.

### `srv-12` — Reset an orphaned `in_progress` queue entry when its generation SSE disconnects

Source: net-new (2026-05-26). Surfaced fixing the orphaned-`in_progress` stall — PR #245 (`fix/server-queue-orphan-boot-reset`) added a server-boot `in_progress` → `queued` sweep (`server/src/workspace/queue-boot.ts`) that covers the dominant trigger (server restart kills all synthesis, so every `in_progress` at boot is an orphan). This item covers the remaining trigger the boot sweep can't catch. See the "No orphaned `in_progress` entries survive a restart" invariant + the "Related fixes" note in [`110-queue-active-generation-honesty.md`](features/110-queue-active-generation-honesty.md).

> **Related (shipped 2026-05-26, PR #252):** a reload-orphaned `in_progress` entry is now MANUALLY clearable — `DELETE /api/queue/:id?force=true` + a "Remove" control on every in-flight row drops a stuck entry that the dispatcher won't reconcile/re-claim. This item is the remaining AUTO-heal: reset the orphan to `queued` on SSE disconnect so a reload self-recovers without the user clicking Remove. The two are complementary (manual escape hatch vs. automatic recovery), not duplicates.

- _What:_ When the browser reloads/closes **while the server stays up**, that tab's generation SSE drops but the boot sweep never runs, so the entry stays `in_progress` forever — the new page's dispatcher cold-boots with an empty in-memory `inFlight` map, never re-runs it (FILL claims only `queued`) and never reconciles it. The generation route already knows each stream's `queueEntryId` (stored on `RunningJob`) and already fires `req.on('close')` (today it only unsubscribes that observer). Extend the close handler so that when the LAST subscriber of a job backing a `queueEntryId` disconnects without the job having completed (the frontend POSTs `/complete` BEFORE the SSE closes on success, so an entry still `in_progress` at close = abnormal), the server resets that entry `in_progress` → `queued` (new `markQueued` mutator + a small server-driven write) and aborts the now-unwatched synthesis. Must not fight the frontend-owned lifecycle: on normal completion the entry is already gone, so the reset is a no-op for a missing id.
- _Acceptance:_ Start generating a chapter, hard-refresh the browser mid-chapter (server left running) → within a tick the entry flips back to `queued` and the reloaded page's dispatcher re-claims + finishes it, instead of the chapter wedging until the next server restart. Normal completion still drops the entry exactly once (no double-reset, no resurrected done entry). New server test drives an SSE open → client-disconnect → asserts the entry is `queued` again and the job aborted; a completion-then-close case asserts no reset.
- _Key files:_ `server/src/routes/generation.ts` (`req.on('close')` at ~L630–641; reset on last-subscriber-leaves when `job.queueEntryId` is set and the job didn't complete), `server/src/workspace/queue-io.ts` (a `markQueued`/`resetEntryToQueued` mutator mirroring `markInProgress`), `server/src/routes/queue.ts` (or an internal call path so the route can persist the flip), `src/store/queue-dispatcher-middleware.ts` (verify cold-boot re-claim of the re-queued entry).
- _Depends on:_ `srv` boot-reset shipped (PR #245). Conceptually a down-payment on plan 110 Part B (server owning the queue-entry lifecycle); could be folded into that work or shipped standalone.
- _Benefit (user / technical):_ closes the last orphaned-`in_progress` stall path — a browser refresh mid-generation no longer strands a chapter until the user restarts the server. Together with the shipped boot sweep, every orphan trigger (restart, crash, reload) self-heals.

### `srv-13` — Analysis-time cross-book reuse linking (durable continuity)

Source: net-new (2026-05-28), filed from the series-reuse repair session. Full scope in [`126-analysis-time-reuse-linking.md`](features/126-analysis-time-reuse-linking.md) (`deferred`). _Priority is the user's to confirm on their next series-book analysis — they may demote toward `srv-7` (cross-series linking) if it doesn't bite._

- _What:_ Make cross-book "reused" continuity (`matchedFrom` + unified `voiceId` + `voiceState:'reused'` + aliases) **durable**. Today it's established only client-side on the confirm stage (`layout.tsx` useEffect → `applyVoiceMatches`), so a character that never re-hits a fresh confirm page never links; and reparse **deletes `cast.json`** (`book-state.ts:722-723`), wiping any links on re-analysis. Two facets: **(A)** establish links server-side at analysis (after Phase 0b in `analysis.ts`) by matching each character against prior same-series books, reusing `scanSeriesCharactersForBookId` + the `voice-match.ts` name/attribute matchers + `cast-link-prior.ts:appendAliases` (the same end-state `scripts/repair-series-reuse.mjs` produces); **(B)** preserve `matchedFrom`/`voiceId`/`voiceState`/`aliases` across reparse instead of dropping them (the `cast-slice.ts:mergeCharacters` preservation pattern).
- _Acceptance:_ Analysing a later series book auto-links its recurring characters to the prior book (Reused badge, shared designed voice, merge-picker suppression) without manual linking; reparsing that book keeps those links instead of reverting to "Designed"/unlinked. `notLinkedTo` pairs are never auto-linked; the earliest series book gets no links. New server tests pin both facets.
- _Key files:_ `server/src/routes/analysis.ts` (facet A hook after Phase 0b), `server/src/routes/book-state.ts` (reparse preserve, facet B), `server/src/workspace/series-cast-scan.ts`, `server/src/routes/voice-match.ts`, `server/src/routes/cast-link-prior.ts`, `src/store/cast-slice.ts`.
- _Depends on:_ the manual-link persistence fix (shipped, PR #301) + the one-time repair scripts (PR #302) which this makes unnecessary for future analyses.
- _Benefit (user / technical):_ series continuity is automatic and survives re-analysis — no manual per-character linking, no re-running the repair script after every reparse. Closes the durability gap behind today's point-in-time data fixes.

### `fe-8` — Profile-drawer "Possible duplicate of …" chip

Source: net-new (2026-05-22). Deferred from plan 101 — voices-view ⚠ pill + selection-pill swap are the v1 surfaces; this is the per-character drawer-side discoverability fix.

> **Promoted Could → Should (2026-05-26):** the three plan-101 cross-book duplicate-review follow-ups (`fe-8` / `fe-9` / `fs-11`) move up together as one cast-cleanup effort — duplicate detection is only useful if resolving the duplicates is low-friction, and today it's stranded behind a single voices-view surface.

- _What:_ When a character has at least one auto-detected cross-book duplicate candidate (same predicate as `src/lib/cross-book-duplicates.ts`), render a small `⚠ Possible duplicate of "<other.name>" (<other-book-title>) →` chip near the top of `src/modals/profile-drawer.tsx`. Click → opens the same `DuplicateReviewModal` pre-populated with the pair. Layout.tsx computes the candidate at drawer mount and passes it as a new optional prop.
- _Acceptance:_ With the mock unlinked Eliza Gray (ns) + Eliza (sb) pair, open Eliza Gray's profile drawer → chip visible with "Possible duplicate of Eliza (Solway Bay) →". Click → modal opens with both rows. Same modal handles link / variant. After resolving, the chip disappears on the next drawer open.
- _Key files:_ `src/modals/profile-drawer.tsx` (new optional props + chip render), `src/components/layout.tsx` (compute candidate, mount modal alongside drawer), `src/modals/profile-drawer.test.tsx` (paired cases).
- _Depends on:_ plan 101 v1 already merged (this round). No server changes — reuses the v1 transport.
- _Benefit (user):_ closes the cast-side discoverability gap. Today (post-v1) a duplicate is only surfaced on `#/voices`; users who live in the cast view don't see the affordance until they navigate to voices. The chip pulls the same signal into the drawer they're already looking at.

### `fe-9` — Bulk cross-book duplicate review (one modal per series)

Source: net-new (2026-05-22). Deferred from plan 101 — v1 is one-pair-at-a-time; this is the bulk-walkthrough enhancement.

- _What:_ A `Review all duplicates in <Series Name>` button on the voices view (e.g. above the family grid) that opens a single modal walking through every detected pair in that series. User chooses link / variant / skip per pair; "Next" advances. Useful for the post-import case where the analyzer missed a recurring character across 3-4 books in a long series and the user wants to clean up in one sitting.
- _Acceptance:_ With a workspace containing N duplicate candidates across one series, click `Review all duplicates in …` → modal opens at pair 1 of N → choose an action → modal advances to pair 2 → … → final pair → modal closes. Each action persists via the existing v1 routes.
- _Key files:_ `src/modals/bulk-duplicate-review.tsx` (new — wraps `DuplicateReviewModal`'s actions with a queue), `src/views/voices.tsx` (entry button).
- _Depends on:_ plan 101 v1 already merged.
- _Benefit (user):_ reduces the cost of cleaning up an N-book series from N modal opens to 1. Useful exactly once per series after the user enables auto-detection or imports a long backlog of books.

### `fs-11` — Undo for "different on purpose" decisions

Source: net-new (2026-05-22). Deferred from plan 101 — the variant decision is currently durable but lacks a reverse path.

- _What:_ When the user accidentally marks a pair as "Different on purpose" and wants to re-surface the duplicate-candidate suggestion, today there's no UI to remove the `notLinkedTo` entry. Add a "Show ignored duplicate suggestions" toggle on the voices view that surfaces every previously-variant-marked pair with an "Unmark" action. Server route gains `DELETE` semantics (or `{ remove: true }` in the body) for symmetric pair-removal.
- _Acceptance:_ Mark a pair as variant. Click the new toggle → variant-marked pair appears in an "Ignored" section with an Unmark button. Click Unmark → the pair re-appears as a duplicate-candidate on its family card.
- _Key files:_ `server/src/routes/cast-not-linked-to.ts` (extend with DELETE), `src/views/voices.tsx` (toggle + ignored section), paired tests.
- _Depends on:_ plan 101 v1 already merged.
- _Benefit (user):_ reversibility. The variant decision should be as easy to undo as to set — without this, a misclick is permanent until the user opens cast.json by hand.

---

## Could — nice to have, low-cost wins

Organised into thematic sub-groups (audio & playback, revisions & history, cast &
voice, engine & sidecar, workflow & power-user, ops & distribution, listener-app
handoffs). Sub-groups and the items within them are ranked top = highest priority.

### Audio & playback

#### `fs-9` — Configurable chapter-title silence durations

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Acceptance:_ Editing a book's silence durations and regenerating one chapter produces an MP3 whose leading + post-title silence matches the new setting (ffprobe / spectrogram). Default for legacy books stays 1.5 + 1.5. Existing chapter-audio-format paired tests stay green.
- _Key files:_ `server/src/tts/synthesise-chapter.ts` (params); `server/src/routes/generation.ts` (forward); `server/src/workspace/scan.ts` (state-json field); `src/components/listen/listen-header.tsx` or sibling metadata editor (UI); `openapi.yaml` (book-state shape).
- _Depends on:_ none.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.

#### `fs-10` — Render the chapter-title segment on the Listen view timeline

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-up — net-new (2026-05-21). Deferred from PR #101 (`fix/server-voiced-chapter-titles-and-pauses`).

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

Source: [`28-chapter-audio-format.md`](features/28-chapter-audio-format.md) follow-ups.

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

#### `side-6` — Qwen batch length-bucketing: measure the RTF win (mechanism shipped)

Plan: [`128-qwen-batch-length-bucketing.md`](features/128-qwen-batch-length-bucketing.md) — `active`.

- _Done (plan 128, 2026-05-29):_ the `synthesise-chapter.ts` sort (`QWEN_BATCH_BUCKET`, default ON, kill-switch `=0`), the byte-identity + spread + kill-switch vitest coverage, and the `bench-tts.py --bucket` A/B harness all shipped. Output-preserving (per-item prompts + scatter-back by `group.index`), proven byte-identical by test.
- _Remaining:_ run the bucketed-vs-unbucketed batch-16 measurement on a live sidecar (reboot first per the perf-baseline practice) and record the row in `docs/tts-performance.md`; then flip plan 128 to `stable` and archive it. Expected ~10–30% off per-chapter RTF on high-variance chapters; the dispatch-bound ceiling remains.

#### `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated)

Plan: [`129-qwen-decode-cuda-graph-spike.md`](features/129-qwen-decode-cuda-graph-spike.md). The blocked "open lever 5" in `docs/tts-performance.md`, now scoped. Source: net-new (2026-05-29), filed from the v1.5.0 generation-perf session.

- _What:_ Two cheap probes gate a possible static-cache fork — do NOT fork on a hunch. **Probe 1** (~1–2 h): profile the batch-16 decode loop (`torch.profiler` / `nvidia-smi dmon`) to settle whether the BATCHED forward is still launch-bound (CUDA graphs would help) or already ~compute-bound (graphs are a dead end — `QWEN_BATCH_SIZE=16` already amortizes per-launch overhead 16×, which is why the clean bench hits RTF 0.80). **Probe 2** (only if launch-bound): audit the nested per-step `code_predictor.generate()` in `qwen_tts` for fixed-vs-variable token count + CPU sync points (`.item()`/`.cpu()`/python branches → graph-breaks). Only if BOTH green: fork `qwen_tts` for a static KV cache + `torch.compile(mode="reduce-overhead")`, behind an env kill-switch + a byte-identical-audio regression test.
- _Acceptance:_ Probe 1 records a kernel/CPU/idle-gap split + a go/no-go line in `docs/tts-performance.md`; if compute-bound the item closes with that note (we're at the model's floor). If the fork ever lands: byte-identical PCM compiled vs un-compiled (pytest), kill-switch reverts to the un-compiled path, `_synth_lock` serialisation preserved.
- _Key files:_ `server/tts-sidecar/main.py` (`QwenEngine` synth + `synthesize_batch`), the installed `qwen_tts` package (read-only — `generate_voice_clone` + nested `code_predictor.generate()`), `server/tts-sidecar/scripts/bench-tts.py`, `docs/tts-performance.md` (open lever 5).
- _Depends on:_ length-bucketing (`side-6`) banked first — this is the fallback past it once the cheaper output-preserving lever is exhausted. Last resort.
- _Benefit (user / technical):_ the only path past the dispatch-bound ~1–2 RTF floor toward sub-1 (Kokoro-class) Qwen speed; the probe gate means the 2–5-day, correctness-risky, maintenance-heavy fork is only attempted if a measurement proves it can actually pay off — not on the serial-path hunch.

#### `fe-4` — Single-poll TTS lifecycle for a third consumer (tracking)

Source: [`30-global-model-control.md`](features/30-global-model-control.md) "When to extend the pattern".

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

#### `fe-5` — Broad hover-affordance audit with `coarse-pointer:` Tailwind variant

Source: net-new (2026-05-21). Plan 81 wave 4 deferred item.

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Acceptance:_ All action-revealing hover patterns in cast, manuscript, voices, listen, generation views get a `coarse-pointer:opacity-100` (or appropriate) fallback. A test confirms `(pointer: coarse)` simulation reveals the same buttons hover would.
- _Key files:_ grep `src/**/*.tsx` for `group-hover:` / `peer-hover:` / `hover:opacity-0`; apply per-component judgement.
- _Depends on:_ plan 81 shipped.
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.

### Ops, CI & distribution

#### `ops-3` — Serialize the `regen-visual-baselines.yml` 3-leg matrix

Source: net-new (2026-05-23). Surfaced during the plan-103 CI cost audit.

- _What:_ `regen-visual-baselines.yml` fans out across three Playwright projects (chromium / mobile-chrome / tablet-chrome) as a parallel matrix, paying a full cold-start (checkout + npm ci + Playwright install) per leg. Collapse into a single job that runs all three `--update-snapshots` passes sequentially, so the setup tax is paid once. Only fires on `workflow_dispatch` (~2 runs/month), so the saving is bursty rather than steady.
- _Acceptance:_ A single `workflow_dispatch` run regenerates all 42 PNGs (14 per project × 3) in one job and still opens the auto-PR. Billed minutes for a regen drop from ~3× cold-start to ~1×.
- _Key files:_ `.github/workflows/regen-visual-baselines.yml` (collapse `strategy.matrix.project` into a sequential step loop; consolidate the artifact upload).
- _Depends on:_ none.
- _Benefit (technical):_ ~60 billed min/month freed on regen days; tidier workflow.

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

Source: [`32-audiobook-export.md`](features/32-audiobook-export.md) follow-ups.

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

- _Why parked (2026-05-26):_ the perf problem that motivated it is solved — after the plan-113 batching + the concurrent-batch race fix, end-to-end Qwen chapters run at **~RTF 1.15** (a ~10 h novel ≈ overnight). That's acceptable, so trading the bespoke-voice identity-consistency this feature exists to guarantee for a marginal further speedup isn't worth it this round.
- _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost) AND a listen-test shows x-vector-only holds identity acceptably.

### `ops-4` — Auto-install Ollama / auto-pull models

Source: [`29-analyzer-ollama-local.md`](features/29-analyzer-ollama-local.md).

- _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract.
- _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

### `srv-8` — Multi-model fan-out for Gemini analyzer

Source: [`06-analyzer-gemini.md`](features/06-analyzer-gemini.md).

- _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs.
- _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

### `fe-11` — Multi-tab catch-up race resilience

Source: [`32-sticky-analysis.md`](features/32-sticky-analysis.md).

- _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus.
- _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `srv-10` — both wake under the same trigger.

### `srv-9` — Multi-book parallel generation

Source: [`16-generation-stream.md`](features/16-generation-stream.md).

- _Why parked:_ single 8 GB GPU can't hold two XTTS/Kokoro instances; the generation queue is serial per workspace by design.
- _Wake when:_ either cloud TTS becomes the dominant generation path so VRAM is no longer the bottleneck, or the user adds a dedicated per-book GPU. Neither is on the v1 roadmap.

### `fs-12` — Voice creation from scratch

Source: [`22-voice-library.md`](features/22-voice-library.md); _What_ revised 2026-05-26 for the Qwen voice-design engine.

- _What (revised 2026-05-26):_ Qwen3-TTS (plan 108) already authors a bespoke per-character voice from a text persona (design → clone → cache the embedding → reuse for consistency), so "create a voice that exists in no catalog" is no longer hypothetical — it ships, scoped to a cast member. What's still missing is a _standalone_ library-voice authoring surface: design a voice from a persona (or a reference clip) as a first-class library entry not tied to one character, name + tag + pin it, reuse it across books, plus optional fine-tuning of an already-designed voice.
- _Why parked:_ the per-character Qwen design flow covers the dominant need (give this character a distinct voice). A general-purpose voice-authoring studio (standalone named library entries, reference-clip cloning UI, fine-tune controls) is its own product surface beyond today's read-mostly library.
- _Wake when:_ users want to design + curate voices as reusable library assets independent of a single character — e.g. building a personal stable of named narrators to assign across the catalogue. Pairs with `fe-12` (bulk library ops): a from-scratch author flow is what grows the library big enough to need them.

### `fe-12` — Bulk pin / bulk delete in voice library

Source: [`22-voice-library.md`](features/22-voice-library.md); revised 2026-05-26 for Qwen custom voices.

- _Why parked (under review 2026-05-26):_ the original "fewer than 50 entries (28 Kokoro + ~12 Coqui defaults), per-voice click is fast enough" premise is weakening. Qwen3-TTS (plan 108) designs a bespoke voice per character, so a heavy multi-book user accumulates many cached custom voices in the library — quickly past the ~50-entry comfort threshold. At that point bulk pin / bulk delete stops being a nicety and becomes the only sane way to curate. **Flagged to move up to Could (or Should) after a review of real library sizes once a few books have been (re)generated under Qwen.**
- _Wake when:_ a real workspace's library crosses ~50 entries from accumulated Qwen-designed voices and per-voice curation gets painful — likely soon given the catalogue-wide Qwen regen, so review proactively rather than waiting for a complaint. No longer blocked on `fs-12`: Qwen's per-character design flow already produces the bulk-worthy entries.

### `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI

Source: [`23-mock-toggle.md`](features/23-mock-toggle.md).

- _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object).
- _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

### `srv-10` — Conflict resolution for two simultaneous `state.json` writers

Source: [`27-book-state-persistence.md`](features/27-book-state-persistence.md).

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
