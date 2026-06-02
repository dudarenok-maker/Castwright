# Backlog (MoSCoW)

The prioritized planning view. Each item maps to exactly one GitHub issue — the
**canonical detail home** (What / Acceptance / Key files / Depends on / Benefit).
This file stays the single MoSCoW-bucketed, position-prioritized list; the issue
holds the detail and the delivery history. Bugs are GitHub issues with the `bug`
label and stay **off** this list (they're out-of-band — filed as the user hits
them). See [CONTRIBUTING.md "Issues"](../CONTRIBUTING.md#issues).

**Item IDs are permanent.** Each item carries a `<prefix>-<n>` ID — `fe` (frontend),
`srv` (server), `side` (TTS sidecar), `ops` (CI / build / dev-tooling), or `fs`
(full-stack). IDs are assigned once and **never reused or renumbered**; gaps are
expected. Cite an item by its ID from code or docs and the reference won't rot.
The issue title leads with the same ID; the issue `#NN` is the GitHub-native
auto-close hook (`Closes #NN` on the delivering PR).

**Priority = position.** Top of a bucket — and of a sub-group within it — is
highest priority. Reprioritising is pure reordering; it never changes an ID.

**Update rule:** when an item ships, close its issue (or let the PR auto-close it
via `Closes #NN`) and remove its row here; update the source plan's `status:` /
Ship notes and archive it if `stable`. When you discover a new item, file a
Backlog-item issue AND add the thin row here linking it, in the same round.

---

## Must — blocks v1 ship or hurts existing users

### `fs-1` — In-app upgrade pathway (package-drop install with data migration) ([#395](https://github.com/dudarenok-maker/AudioBook-Generator/issues/395))

- _What:_ Turn cross-version upgrades into a one-click Account-tab flow for hand-delivered alpha bundles (no GitHub polling — explicit user direction). Three coupled pieces. **(a) Foundation** — new `GET /api/info` endpoint reporting `{ appVersion, sidecarVersion, schemas, lastSeenAppVersion, showWhatsNew }`; schema-version stamping on `cast.json` / `manuscript-edits.json` / `revisions.json` / `listen-progress.json` / `voices.json` / `user-settings.json` mirroring the existing `state-migrate.ts` pattern (absence-means-v1 back-compat, refuses future schemas, identity migrations at v1); version pill in top-bar sourced from a `useAppInfo()` hook; sidecar exposes `__version__` in `/health`; `bump-version.mjs` extended to rewrite a new `server/tts-sidecar/version.py` in lockstep with the two `package.json`s. Boot-time `upgrade-coordinator.ts` walks every book on `lastSeenAppVersion ≠ appVersion`, snapshots all `.audiobook/*.json` + `voices.json` + `user-settings.json` to `<WORKSPACE_DIR>/.upgrade-backups/from-<old>-to-<new>-<iso>/` before re-stamping any stale-schema files. **(b) Upload + swap** — `POST /api/admin/upgrade/{stage,apply,abort}` + `GET /api/admin/upgrade/state` accept multipart zip upload, validate `audiobook-generator-vX.Y.Z/` root + embedded `package.json` + manifest sanity + SHA-256, refuse concurrent in-flight generation/analysis (409 with busy-book list) and unconfirmed downgrades (412), write `<WORKSPACE_DIR>/.upgrade-pending.json` and spawn a detached restarter via inline `child_process.spawn('node', ['-e', '<...>'], { detached: true })` (inline string so the swap can't delete its own supervisor mid-flight). `scripts/start-app-prod.mjs` detects the marker on boot and performs a preserve-list swap — **preserve** `server/user-settings.json` / `server/.env` / `server/tts-sidecar/.venv/` / `server/tts-sidecar/voices/kokoro/` / `audiobook-workspace/` / `logs/` / `.run/`; **swap** `dist/` / `server/dist/` / `server/tts-sidecar/*.py` / both `package.json`s + lockfiles. Run `npm ci` root + server; re-run `pip install -r requirements.txt` only when its hash changed; rename-aside `repoRoot.bak-<ts>/` until swap completes so any failure during steps 5–9 rolls back atomically; append every attempt (ok / failed) to `<WORKSPACE_DIR>/.upgrade-log.json`. Cross-platform Node ESM (Win + macOS + Linux per the alpha-tester spread), no PowerShell. **(c) UX** — Account view gets a top `Application updates` FormCard with a file-picker that POSTs multipart to `/stage`, a confirmation dialog showing v-from → v-to + short SHA-256 + bundled `RELEASE_NOTES.md` + data-safety blurb, and a full-screen `UpgradingScreen` overlay during apply that polls `/state` every 2s and `/api/info` every 2s; the overlay dismisses when `appVersion` flips, success toast fires, and a "What's new in vX.Y.Z" banner renders at the top of every view until dismissed (driven by the `showWhatsNew` flag clearing via `POST /api/info/dismiss-whats-new`). `scripts/build-release-zip.mjs` extended to bake `RELEASE_NOTES.md` (from the annotated tag body that `bump-version.mjs --notes-file` already captures) into the zip root and include it in MANIFEST.
- _Benefit (user / architectural):_ removes the manual upgrade rite (download zip → extract → `npm ci` → restart) every alpha tester walks through every release; replaces it with a single click in the Account tab, with auto-backup-before-migrate as the data-integrity contract. Surfaces the version delta + release notes inline so testers always know what changed. Atomic rollback path when an upgrade goes sideways means the user never wakes up to a half-applied state. Architecturally: establishes the per-file schema-version pattern across the rest of the workspace (today only `state.json` has it), so `fs-2`'s `language` field — and every future non-additive shape change — has a tested migration seam instead of a one-shot ad-hoc script. Foundation work also enables future BACKLOG items `ops-1` (Windows installer) and `ops-2` (Docker image) to share the same `RELEASE_NOTES.md` + `/api/info` plumbing.
_Full detail + acceptance:_ [#395](https://github.com/dudarenok-maker/AudioBook-Generator/issues/395).

_`fs-2` (multi-language, Russian first) shipped — the engine half via
[plan 108](features/108-qwen-coexistence.md), the language half via
[plan 162](features/162-fs2-multilanguage.md); the library/cast language UX
polish (`fe-16`) shipped via [plan 165](features/165-fe-15-16-language-and-revision-e2e.md).
The remaining deferred follow-up is `fs-14` (Russian UI localization) below._

---

## Should — important, not blocking ship

### `fs-14` — Russian UI localization (interface strings, react-i18next) ([#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396))

- _What:_ Localize the application interface to Russian. Stand up an i18n framework (**react-i18next** — user-confirmed choice) + a per-user `UserSettings.uiLanguage` preference with a language switcher in Account management, then translate the high-traffic surfaces first (top nav, account, upload/confirm, listen, cast) and grow coverage incrementally. Ground truth at capture: **no i18n library today**, ~1,500 hardcoded user-facing strings across ~82 components (densest: `account.tsx` ~92, `profile-drawer.tsx` ~79, `voices.tsx` ~68, `analysing.tsx` ~59, `cast.tsx` ~58, `export-audiobook.tsx` ~52). Centralisable copy already lives in `src/data/{walkthroughs,analysis-phases,regen-reasons,match-factors,listener-apps}.ts`. Locale-sensitive formatting is minimal (`src/lib/time.ts` durations only; no currency/date pickers).
- _Benefit (user / architectural):_ a fully Russian-speaking user gets a Russian app, not just Russian audio. The i18n framework makes every future language an incremental translation-file add rather than a code change. Pairs with fs-2 to make Russian a first-class end-to-end experience.
_Full detail + acceptance:_ [#396](https://github.com/dudarenok-maker/AudioBook-Generator/issues/396).

### `srv-1` — Merge journal for deterministic alias un-link ([#397](https://github.com/dudarenok-maker/AudioBook-Generator/issues/397))

- _What:_ At every cast-merge call site (manual merge route, fold-minor-cast post-stage-2 pass), append a record to a per-book journal file `<bookDir>/.audiobook/cast-merges.json` of shape `{ ts, kind: 'manual' | 'fold', sourceId, sourceName, targetId, affectedSentenceIds: number[] }`. The unlink-alias route then reads this journal to compute `impactedChapters.candidateSentenceIds` as the exact sentences originally rewritten by the merge — no `chapterCast` heuristic, no per-chapter listing of sentences that may belong to a third party.
- _Benefit (user):_ reattribute modal becomes a precise checklist instead of a scoped review — every row the user sees is provably their merge's work, no third-party sentences to skip over. Big quality-of-life win for series-2-into-1 cleanups where merges pile up.
_Full detail + acceptance:_ [#397](https://github.com/dudarenok-maker/AudioBook-Generator/issues/397).

### `srv-13` — Analysis-time cross-book reuse linking — Facet B (reparse preservation) ([#398](https://github.com/dudarenok-maker/AudioBook-Generator/issues/398))

- _What:_ Preserve cross-book "reused" continuity (`matchedFrom` + unified `voiceId` + `voiceState:'reused'` + aliases) **across reparse**. Today reparse **deletes `cast.json`** (`book-state.ts:722-723`), so the links Facet A establishes evaporate on the next re-analysis. Read the existing cast before deleting and carry forward per-character `matchedFrom`/`voiceId`/`voiceState`/`aliases` for surviving characters (match by id, then name/alias), mirroring the `cast-slice.ts:mergeCharacters` preservation pattern (which already preserves tuned/locked voices). Facet A is unaffected — it re-establishes links on a full `/analysis/stream`; Facet B stops a reparse from silently dropping them in between.
- _Benefit (user / technical):_ series continuity survives re-analysis — no re-running a repair after every reparse. Closes the remaining durability gap left after Facet A.
_Full detail + acceptance:_ [#398](https://github.com/dudarenok-maker/AudioBook-Generator/issues/398).

### `side-11` — Eliminate the variable-input-shape host-memory leak (so recycling isn't needed) ([#399](https://github.com/dudarenok-maker/AudioBook-Generator/issues/399))

- _What:_ The Qwen generation forward leaks committed host RAM monotonically (a new never-freed native workspace per sentence length; ~1,150 MB/batch), forcing plan-143 process-recycles every ~10 chapters. Goal: a full book on one warm sidecar with no recycles and no dropped chapters, now that RTF is solved (~1.04). Open levers: fixed-shape batch padding, chapter-boundary recycle, torch/transformers version pin.
- _Benefit (user / technical):_ removes mid-run recycle interruptions + dropped chapters (`srv-17c`) on long books — the cleanest end-to-end win now that RTF is solved.
_Full detail + acceptance:_ [#399](https://github.com/dudarenok-maker/AudioBook-Generator/issues/399).

### `fe-1` — In-app LAN HTTPS banner under dev settings ([#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401))

- _What:_ Account settings card showing the current LAN HTTPS URL (from `GET /api/export/lan` when LAN_HTTPS=1) with one-click "Copy URL" + "Install cert on phone" links. The latter opens a doc / route that shows the QR code that `npm run install:cert-mobile` prints to the terminal today. Dev-mode only — hidden in production single-user environments.
- _Benefit (user):_ surfaces the LAN access flow inside the app instead of requiring the user to read terminal output. Especially valuable for users who first installed via the alpha release zip (no terminal interaction expected).
_Full detail + acceptance:_ [#401](https://github.com/dudarenok-maker/AudioBook-Generator/issues/401).

### `fe-5` — Broad hover-affordance audit with `coarse-pointer:` Tailwind variant ([#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402))

- _What:_ Plan 81 wave 4 shipped a `coarse-pointer:` Tailwind variant (matches `@media (pointer: coarse)`) for touch devices that don't expose hover. First consumer is the manuscript boundary handle label. Sweep `src/` for all uses of `group-hover:` / `peer-hover:` / `hover:opacity-0` and apply the variant where the hover-revealed content is functional (e.g. action buttons), not purely decorative (e.g. card lift transitions).
- _Benefit (user):_ touch users get every action that mouse users do, without needing to discover hidden affordances.
_Full detail + acceptance:_ [#402](https://github.com/dudarenok-maker/AudioBook-Generator/issues/402).

### Dependency major upgrades

Source: net-new (2026-06-01), from the [plan 164](features/164-deps-ci-hygiene.md) dependency audit. The audit cleared the deadline-driven CI-action bump (`ops-8`) + the genuinely-safe minor bumps (TypeScript → latest 5.x, `@google/genai` → 2.7, Node-floor pin) inline, and filed every framework **major** that is now behind here — each researched to "pickup-ready" (current → target, breaking-change surface, blast radius, automated migration path if any, risk). None blocks ship; pick up when time allows. Ordered foundational/low-risk → broad/high-risk. **Shipped 2026-06-02** — the React cluster (`fe-19` Vite **8** + Vitest **4**, `fe-18` React 19, `fe-21` react-router 7) + `ops-10` (TypeScript 6) landed together via [plan 167](features/167-fe-react-cluster-upgrade.md). Targets moved past the original research: latest majors are now Vite 8 (Rolldown) / Vitest 4, taken over the conservative Vite 7 / Vitest 3. `fe-18` and `fe-21` proved **coupled** — react-router 6 isn't React-19-compatible — so they shipped as one commit.

#### `srv-25` — Zod 3 → 4 (and drop `zod-to-json-schema`) ([#405](https://github.com/dudarenok-maker/AudioBook-Generator/issues/405))

- _What:_ bump `zod ^3.23.8 → 4.x`. Zod 4 ships **native `z.toJSONSchema()`**, so the `zod-to-json-schema` dependency can be **removed** entirely (today it builds the Gemini/Ollama structured-output schemas). Breaking surface: string-format validators moved to top-level (`z.string().email()` → `z.email()`, `.uuid()`, `.url()`), unified error-customization param. Affected: `server/src/analyzer/{ollama,gemini}.ts`, `server/src/handoff/schemas.ts`, `server/src/workspace/user-settings.ts`, `server/src/routes/{user-settings,cast-series-patch}.ts` (8 files). Migration: `npx @zod/codemod --transform v3-to-v4`.
- _Benefit (technical / architectural):_ large parse/compile perf win, smaller bundle, **deletes a whole dependency**. _Risk: medium (verify the generated schema still satisfies the structured-output contract)._
_Full detail + acceptance:_ [#405](https://github.com/dudarenok-maker/AudioBook-Generator/issues/405).

#### `srv-24` — Express 4 → 5 ([#406](https://github.com/dudarenok-maker/AudioBook-Generator/issues/406))

- _What:_ bump `express ^4.19.2 → 5.x` (GA). Breaking surface: `path-to-regexp` v8 route syntax (`*` → named `/*splat`, optional `:param?` → `{/:param}`), removed legacy signatures (`app.del`, `res.json(status, body)`, `res.send(status)`), rejected-promise propagation in middleware, `req.query` is now a getter. Audit every route under `server/src/routes/` for wildcard/optional params + the removed signatures.
- _Benefit (technical):_ supported GA major; async-error handling improvements. _Risk: medium (route-syntax migration is the main hazard)._
_Full detail + acceptance:_ [#406](https://github.com/dudarenok-maker/AudioBook-Generator/issues/406).

#### `fe-20` — Tailwind 3 → 4 ([#409](https://github.com/dudarenok-maker/AudioBook-Generator/issues/409))

- _What:_ bump `tailwindcss ^3.4.10 → 4.x` + add `@tailwindcss/postcss`. v4 is CSS-first: `@import "tailwindcss"` replaces the `@tailwind` directives; theme moves into `@theme` (the JS `tailwind.config.ts` still works via the `@config` directive for back-compat). **Our setup is unusually well-aligned** — `src/styles.css` already declares design tokens as CSS custom properties (`--peach`, `--ink`, …) and `tailwind.config.ts` references them, which is exactly v4's "every token is a CSS var" model. Run `npx @tailwindcss/upgrade` (automates ~90% incl. class renames). v4 drops the need for `autoprefixer`/`postcss-import` boilerplate.
- _Benefit (technical):_ faster engine, runtime theme switching, simpler toolchain. _Risk: medium — visual-regression baselines shift; needs a snapshot re-bake._
_Full detail + acceptance:_ [#409](https://github.com/dudarenok-maker/AudioBook-Generator/issues/409).

#### `srv-26` — pdfjs-dist 4 → 5 ([#410](https://github.com/dudarenok-maker/AudioBook-Generator/issues/410))

- _What:_ bump `pdfjs-dist ^4.10.38 → 5.x`. ESM-only, Node 20+, worker-setup changes. Single consumer (PDF manuscript parse). Verify the worker wiring + the parse path still resolve under the v5 ESM layout.
- _Benefit (technical):_ supported major + security fixes. _Risk: low-medium._
_Full detail + acceptance:_ [#410](https://github.com/dudarenok-maker/AudioBook-Generator/issues/410).

_`ops-8` (bump GitHub Actions off the deprecated Node-20 runtime) **shipped 2026-06-01** via
[plan 164](features/164-deps-ci-hygiene.md) — all workflows now pin the latest Node-24 action
majors (`checkout@v6`, `setup-node@v6`, `cache@v5`, `upload-artifact@v7`). Acceptance is the
PR's own annotation-free CI run._

### 2026-06-02 brainstorm round — net-new, **pending priority pass**

These 29 items were filed in one brainstorm pass on 2026-06-02 across five lenses
(Listener experience · Reliability & quality · Distribution & onboarding · Net-new
capabilities · Voice & cast sharing). They are labelled `moscow:should` as a
**placeholder only** — they have NOT yet been ranked against the rest of the backlog.
The next whole-backlog priority pass will re-bucket them (several of the S-sized
listener / quick-win items are really `could`; a few may be `must`). Grouped by lens
below; full What / Acceptance / Key files / Benefit live in each issue. Size key:
S ≈ ½–1 day · M ≈ one PR · L ≈ its own plan.

#### Listener experience

- `fe-23` — Auto-advance / continuous playback (S) ([#458](https://github.com/dudarenok-maker/AudioBook-Generator/issues/458)). _Mini-player `onEnded` stops dead at every chapter; add hands-free advance behind a default-on toggle._ _Benefit (user):_ the biggest everyday-listening gap.
- `fe-24` — Skip forward/back buttons (±15s / ±30s) (S) ([#459](https://github.com/dudarenok-maker/AudioBook-Generator/issues/459)). _Prev/next jump whole chapters only; add intra-chapter seek + key bindings._ _Benefit (user):_ the most-used audiobook control, currently absent.
- `fe-25` — Wire (or remove) the mini-player volume control (S) ([#460](https://github.com/dudarenok-maker/AudioBook-Generator/issues/460)). _The `IconVolume` button has no `onClick` — a dead placeholder._ _Benefit (user):_ finish/remove a broken affordance.
- `fe-26` — Marker export + shareable notes (S) ([#461](https://github.com/dudarenok-maker/AudioBook-Generator/issues/461)). _Export per-book markers (note + re-record) to a file._ _Benefit (user):_ makes re-record markers actionable outside the app.
- `fs-15` — Continue listening: global cross-book resume (M) ([#462](https://github.com/dudarenok-maker/AudioBook-Generator/issues/462)). _Aggregate per-book resume bookmarks into a one-tap "most recent across any book" surface._ _Benefit (user):_ one-tap re-entry; rewards the multi-book workflow.
- `fs-16` — Listening-stats dashboard (M) ([#463](https://github.com/dudarenok-maker/AudioBook-Generator/issues/463)). _Total hours, books finished, per-book completion %, streak — from existing progress records._ _Benefit (user):_ engagement / progress sense.
- `fs-17` — Read-along: sentence highlight synced to audio (L) ([#464](https://github.com/dudarenok-maker/AudioBook-Generator/issues/464)). _Highlight the current sentence as audio plays, off existing per-segment timing._ _Benefit (user):_ immersion / accessibility; differentiating.

#### Reliability & quality

- `srv-27` — Post-synthesis audio QA gate (M) ([#465](https://github.com/dudarenok-maker/AudioBook-Generator/issues/465)). _Validate duration / silence / clipping / truncation before a chapter flips to `done`._ _Benefit (user):_ catches bad renders before the listener hits them.
- `srv-28` — Pre-flight disk-space guard (S) ([#466](https://github.com/dudarenok-maker/AudioBook-Generator/issues/466)). _Warn before a run/export when free space is tight._ _Benefit (user):_ avoids deep-run failures.
- `ops-11` — Golden-audio regression harness (M) ([#467](https://github.com/dudarenok-maker/AudioBook-Generator/issues/467)). _Deterministic fixture book asserted on duration/hash to catch engine/sidecar drift._ _Benefit (technical):_ locks the audio-output contract.
- `fs-18` — One-click diagnostics / health board (M) ([#468](https://github.com/dudarenok-maker/AudioBook-Generator/issues/468)). _Green/red board: GPU/VRAM, sidecar + models, analyzer, ffmpeg, disk._ _Benefit (user / technical):_ glanceable "why is it broken?" surface.
- `fs-19` — Structured failure taxonomy + plain-language remediation (M) ([#469](https://github.com/dudarenok-maker/AudioBook-Generator/issues/469)). _Map recurring failure modes to human messages + "what to do" lines._ _Benefit (user):_ self-service recovery.
- `fs-20` — Per-run resource telemetry log + trend view (M) ([#470](https://github.com/dudarenok-maker/AudioBook-Generator/issues/470)). _Persist RTF / VRAM / host-RAM / wall-time per chapter and chart it._ _Benefit (technical):_ perf-regression visibility.

#### Distribution & onboarding

- `fe-27` — In-app update notifier (S) ([#471](https://github.com/dudarenok-maker/AudioBook-Generator/issues/471)). _Surface "vX available" + changelog when behind; complements `fs-1`'s upgrade mechanism._ _Benefit (user):_ closes the distribution loop.
- `fe-28` — Onboarding empty states + first-run checklist (S) ([#472](https://github.com/dudarenok-maker/AudioBook-Generator/issues/472)). _Guided empty library + four-step checklist._ _Benefit (user):_ reduces first-session bounce.
- `fe-29` — In-app help / troubleshooting panel (S) ([#473](https://github.com/dudarenok-maker/AudioBook-Generator/issues/473)). _Offline help: workflows, shortcuts, common-failure remediations (shares copy with `fs-19`)._ _Benefit (user):_ support deflection.
- `fs-21` — First-run setup wizard (L) ([#474](https://github.com/dudarenok-maker/AudioBook-Generator/issues/474)). _GPU check → model install → defaults → one-sentence smoke synth._ _Benefit (user):_ biggest adoption lever for non-technical deployers.
- `fs-22` — Bundled demo book, real / generate-able (S) ([#475](https://github.com/dudarenok-maker/AudioBook-Generator/issues/475)). _A tiny public-domain manuscript that runs the real pipeline._ _Benefit (user):_ instant "wow" + end-to-end smoke test.
- `fs-23` — In-app model manager (M) ([#476](https://github.com/dudarenok-maker/AudioBook-Generator/issues/476)). _One home for installed models: sizes, disk, install/remove/update (+ `ops-7` integrity)._ _Benefit (user):_ demystifies the engine zoo.

#### Net-new capabilities

- `fe-30` — Voice-actor (multi-narrator) view (M) ([#477](https://github.com/dudarenok-maker/AudioBook-Generator/issues/477)). _Group characters by assigned voice + bulk reassign; the inverse axis of the cast view._ _Benefit (user):_ manage a cast at the voice level.
- `fs-24` — Per-character pronunciation lexicon (M) ([#478](https://github.com/dudarenok-maker/AudioBook-Generator/issues/478)). _Per-book pronunciation overrides for invented names, applied at synth._ _Benefit (user):_ fixes the #1 fiction narration complaint.
- `fs-25` — Per-quote expressive / emotion synthesis (L) ([#479](https://github.com/dudarenok-maker/AudioBook-Generator/issues/479)). _Per-line emotion tags driving synthesis — the deferred Qwen "per-quote emotion."_ _Benefit (user):_ step-change in expressiveness.
- `fs-26` — Line-level re-record / splice (L) ([#480](https://github.com/dudarenok-maker/AudioBook-Generator/issues/480)). _Re-synth one sentence and splice it in, vs a whole-chapter regen (consumes the `rerecord` marker)._ _Benefit (user):_ surgical fixes, big time/VRAM saver.
- `fs-27` — Chapter recaps / "previously…" summaries (M) ([#481](https://github.com/dudarenok-maker/AudioBook-Generator/issues/481)). _LLM recap per chapter, optionally spoken, on resume after a gap._ _Benefit (user):_ graceful re-entry into long books.

#### Voice & cast sharing

Build bottom-up: `side-13` gates everything; `fs-28` is the format the rest build on. Scoped to **synthetic/designed** voices with a consent/licensing note throughout.

- `fs-28` — Voice export/import bundle (M) ([#482](https://github.com/dudarenok-maker/AudioBook-Generator/issues/482)). _Portable bundle (embedding + persona + provenance); the sharing **foundation**._ _Benefit (user):_ share a voice + back up the library. _Depends on `side-13`; blocks `fs-29`/`fs-30`/`fs-31`._
- `fs-29` — Cast/profile pack sharing (M) ([#483](https://github.com/dudarenok-maker/AudioBook-Generator/issues/483)). _Export/import a book's full cast (personas + assignments)._ _Benefit (user):_ reuse a curated cast. _Depends on `fs-28`._
- `fs-30` — Whole voice-library export/import (M) ([#484](https://github.com/dudarenok-maker/AudioBook-Generator/issues/484)). _Bulk archive for backup/migration/sharing._ _Benefit (user / technical):_ portability + disaster recovery. _Depends on `fs-28`._
- `side-13` — Import safety + provenance for shared voice artifacts (M) ([#485](https://github.com/dudarenok-maker/AudioBook-Generator/issues/485)). _`weights_only` safe-load + provenance for **untrusted** `.pt`; extends `side-12`._ _Benefit (technical / security):_ makes the whole sharing theme safe. _Gates `fs-28`/`fs-29`/`fs-30`/`fs-31`._
- `fs-31` — Community voice registry / share-by-link (L) ([#486](https://github.com/dudarenok-maker/AudioBook-Generator/issues/486)). _Publish/pull voices by link — the flagship, externally-facing version._ _Benefit (user):_ a community library. _Needs a hosting + licensing/abuse design; after `fs-28` + `side-13`._

---

## Could — nice to have, low-cost wins

Organised into thematic sub-groups (audio & playback, revisions & history, cast &
voice, engine & sidecar, workflow & power-user, ops & distribution, listener-app
handoffs). Sub-groups and the items within them are ranked top = highest priority.

### Audio & playback

#### `fs-9` — Configurable chapter-title silence durations ([#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411))

- _What:_ Promote the two hard-coded constants `CHAPTER_LEAD_SILENCE_SEC = 1.5` and `CHAPTER_POST_TITLE_SILENCE_SEC = 1.5` in `server/src/tts/synthesise-chapter.ts` to a per-book setting on `state.json`. Surface in the Listen view's metadata editor (the same panel that already edits narratorCredit / genre / etc.) as a "Chapter break duration" slider with a small preset list (e.g. 0.5/1/1.5/2/3 s) for the leading + post-title legs. Generation route reads the per-book values and forwards into `synthesiseChapter` opts.
- _Benefit (user):_ lets the user pace chapter breaks to match book length / mood (a tight 0.5 s for a short kids' book, a longer 3 s for a slow-burn novel) without code changes. Today the 3.0 s default is "audiobook-standard" but not universally right.
_Full detail + acceptance:_ [#411](https://github.com/dudarenok-maker/AudioBook-Generator/issues/411).

#### `fs-10` — Render the chapter-title segment on the Listen view timeline ([#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412))

- _What:_ The new title segment in `segments.json` (kind: `'title'`, empty `sentenceIds[]`) is currently filtered out at the `ChapterAudio` API boundary in `server/src/routes/chapter-audio.ts` because the wire contract types `sentenceId` as a required integer. To surface the title on the listen-view timeline (a labelled "TITLE" pill anchored at the start of the chapter, ~3 s wide including silence), widen the API segment shape so `sentenceId` is optional and add an optional `kind?: 'title' | 'sentence'` discriminator, regenerate `src/lib/api-types.ts`, then teach `src/components/listen/listen-player-region.tsx` to render title-kind segments differently from sentence-kind segments.
- _Benefit (user):_ visual cue that matches the audible cue — listener sees "you're hearing the title now" before the body segments start. Today the title beat is audible-only.
_Full detail + acceptance:_ [#412](https://github.com/dudarenok-maker/AudioBook-Generator/issues/412).

#### `fe-6` — Waveform memoisation ([#413](https://github.com/dudarenok-maker/AudioBook-Generator/issues/413))

- _What:_ In `src/components/waveform.tsx`, stabilise the 48-bar `useMemo` (memo key invariant against re-mount) and lift the animation interval to the parent so it ticks once per listen-view mount (not per waveform instance).
- _Benefit (technical):_ avoids 480+ DOM mutations per 800 ms when many waveforms are visible simultaneously. Low real-world impact today (rare to see >3 waveforms at once).
_Full detail + acceptance:_ [#413](https://github.com/dudarenok-maker/AudioBook-Generator/issues/413).

#### `fs-3` — Streaming audio for live playback during chapter generation ([#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414))

- _What:_ Change the chapter audio pipeline from "encode the full chapter, then signal complete" to "emit MP3 frames as ffmpeg produces them, signal each chunk via SSE, frontend appends to a MediaSource". Magic moment: listen as it generates.
- _Benefit (user):_ "listen as it generates" is the magic moment audiobook tools sell on.
_Full detail + acceptance:_ [#414](https://github.com/dudarenok-maker/AudioBook-Generator/issues/414).

### Revisions & history

#### `fs-5` — Multi-step rollback / snapshot-per-entry (revision history) ([#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415))

- _What:_ Extend plan 20's `preserveExistingAsPrevious` to write `.previous.<entryId>.<slug>.mp3` per timeline entry (not just one `.previous.<slug>.mp3` per chapter). Wire a server `POST /api/books/:bookId/revisions/:entryId/rollback` endpoint that restores a specific timeline entry's audio + flips subsequent entries to `rolled-back-from`. Add a GC pass that prunes oldest snapshots after the user commits (or when disk pressure exceeds a cap, e.g. 10 entries / chapter).
- _Benefit (user):_ closes the centerpiece feature from plan 55 — true non-linear undo per chapter. Today the timeline modal is read-only; the user has to walk through accept/reject in the A/B player.
_Full detail + acceptance:_ [#415](https://github.com/dudarenok-maker/AudioBook-Generator/issues/415).

### Cast, voice & duplicates

#### `fe-7` — Per-voice row sample-preview button inside `<VoiceOverridePicker>` ([#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416))

- _What:_ Add a per-row Play button that routes through `playSampleWithAutoLoad` (same helper the existing "Preview voice" / cast-row swatch use). Hover/focus reveals the icon on pointer devices; `coarse-pointer:opacity-60` keeps it faintly visible on touch. Sample text comes from the same drawer-level `previewText` the candidate-preview block uses. Single-row in-flight gate (the helper already coalesces concurrent clicks).
- _Benefit (user):_ shortens the "scrolled past 40 Kokoro voices, want to hear three before committing" flow from "pick → close → preview from drawer → pick another" to "▶ in-row, ▶ in-row, pick the one I like." Pairs with the autocomplete added in this bundle — search narrows the list, in-row preview judges the few remaining options.
_Full detail + acceptance:_ [#416](https://github.com/dudarenok-maker/AudioBook-Generator/issues/416).

#### `fs-6` — Batch voice-replace across all books ([#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417))

- _What:_ Add a "Replace voice everywhere" affordance in the voice library: pick a current voice, pick a replacement, see a preview of all (book, character) pairs that would be affected, confirm. Affected books' cast slices are mutated; audio is invalidated (regen prompt per book).
- _Benefit (user):_ cross-book voice consistency without per-book re-casting. Common need when switching a recurring narrator across a series.
_Full detail + acceptance:_ [#417](https://github.com/dudarenok-maker/AudioBook-Generator/issues/417).

#### `srv-7` — Cross-series voice linking ([#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418))

- _What:_ Plan 108's per-character engine + voice changes propagate across one series via `findAuthorSeriesForBookId`. A character who recurs across DIFFERENT series by the same author (or a shared-universe crossover) is not covered — the rebaseline / per-character write stops at the series boundary by design. Add an explicit cross-series link affordance (extend `Character.aliases` / a new link record) so a deliberate "this is the same voice across series X and Y" decision propagates voice + engine across both.
- _Benefit (user):_ recurring narrators / crossover characters stay consistent across an author's whole catalogue, not just within one series.
_Full detail + acceptance:_ [#418](https://github.com/dudarenok-maker/AudioBook-Generator/issues/418).

#### `fs-12` — Standalone library-voice authoring (a voice not tied to one character) ([#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419))

- _What:_ A standalone library-voice authoring surface on top of the per-character Qwen design flow (plan 108, which already designs → clones → caches → reuses a bespoke voice scoped to a cast member). Add first-class library entries not tied to a single character: design a voice from a persona (or a reference clip), name + tag + pin it, reuse it across books, with optional fine-tuning of an already-designed voice.
- _Benefit (user):_ build a personal stable of named narrators to assign across the catalogue, independent of any single character. Pairs with `fe-12` (bulk library ops): a from-scratch author flow is what grows the library big enough to need them.
_Full detail + acceptance:_ [#419](https://github.com/dudarenok-maker/AudioBook-Generator/issues/419).

#### `fe-12` — Bulk pin / bulk delete in voice library ([#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420))

- _What:_ Multi-select in the voice library with bulk actions — pin/unpin and delete across the selection (with a confirm + count). Deletion respects in-use voices (warn or block when a voice is assigned to a character in any book).
- _Benefit (user):_ curating a large accumulated voice library stops being a per-voice click-fest.
_Full detail + acceptance:_ [#420](https://github.com/dudarenok-maker/AudioBook-Generator/issues/420).

### Engine, sidecar & analyzer

#### `fe-4` — Single-poll TTS lifecycle for a third consumer (tracking) ([#421](https://github.com/dudarenok-maker/AudioBook-Generator/issues/421))

- _What:_ Tracking item. The consolidated `useTtsLifecycle()` hook (`src/lib/use-tts-lifecycle.ts`) drives today's pill surfaces — top-bar (`src/components/layout.tsx`) and Generation view (`src/views/generation.tsx`) — from one `setInterval` via `LayoutContext`. Per the 2026-05-21 Kokoro-Stop-pill change, the hook now fans out per engine: it returns `{ coqui, kokoro, evictionNotice, loadErrorNotice, dismissNotices }` from a single /health probe. **Wake this item when a JIT-warmed surface graduates to pill-driven UI.** Concrete triggers: Profile Drawer Play, Cast row Play, or the per-character "regenerate this voice across the book" button — whichever first stops using `playSampleWithAutoLoad` and starts wanting an always-on Load/Stop affordance.
- _Benefit (architectural):_ prevents the duplicated-poll explosion that motivated plan 30 G1 in the first place.
_Full detail + acceptance:_ [#421](https://github.com/dudarenok-maker/AudioBook-Generator/issues/421).

#### `fs-13` — Exact per-character progress under parallel synthesis ([#422](https://github.com/dudarenok-maker/AudioBook-Generator/issues/422))

- _What:_ Carry per-character completion in the generation SSE tick so the Generate view renders an exact per-character "X / Y done" rather than deriving an approximation from one chapter-wide `currentLine` count. Likely shape: each completed-group tick includes the completed sentence id(s) (or a per-character done tally), and the frontend tracks the SET of completed positions per character instead of `linesDoneAt(positions, currentLine)`. Keep the chapter-level `currentLine`/`progress` as the monotonic count it is today — that part is correct.
- _Benefit (user):_ per-character progress bars become exact under parallel synthesis, not a monotonic approximation. Low urgency — the bars are already monotonic and directionally right; this only bites if a user watches a single character's bar closely during a heavily-parallel run.
_Full detail + acceptance:_ [#422](https://github.com/dudarenok-maker/AudioBook-Generator/issues/422).

#### `srv-23` — Opt-in "refresh personas + re-design voices" sweep for existing books ([#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423))

- _What:_ a per-book opt-in action that re-runs `generate-all` voice-style then re-designs every Qwen voice from the refreshed personas, so an existing book can adopt the improved format in one click. Must NOT clobber hand-edited personas without confirmation, and must surface the Gemini-quota + GPU-time cost up front.
- _Benefit (user):_ existing libraries can adopt the better voice-design format without re-casting by hand. Low urgency — costly (quota + GPU) and only matters for books a user wants to re-render.
_Full detail + acceptance:_ [#423](https://github.com/dudarenok-maker/AudioBook-Generator/issues/423).

### Workflow, power-user & dev settings

#### `srv-2` — Auto-backup scheduling for `state.json` ([#424](https://github.com/dudarenok-maker/AudioBook-Generator/issues/424))

- _What:_ Add a background backup job that on configurable cadence (daily / weekly) writes a snapshot of `<workspace>/<bookId>/.audiobook/state.json` to `<workspace>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json`. Keep last N (configurable, default 14). Manual "Restore from backup" affordance in workspace settings.
- _Benefit (user):_ disaster recovery without manual intervention. Particularly valuable on Windows where OneDrive sync conflicts can occasionally corrupt `state.json` mid-write.
_Full detail + acceptance:_ [#424](https://github.com/dudarenok-maker/AudioBook-Generator/issues/424).

### Security & hardening

Source for the whole sub-group: the [2026-05-31 security review](security/2026-05-31-security-review.md). All are scoped to the **opt-in LAN exposure surface** (`npm run start:lan`) or local-only defense-in-depth — the app is single-user/local-first by design, so these harden the hostile-LAN and local-write threat models rather than fixing an exploited-today hole. `srv-19` (Should) is the partner default-bind fix.

#### `srv-20` — Optional shared-secret token for the LAN flow ([#425](https://github.com/dudarenok-maker/AudioBook-Generator/issues/425))

- _What:_ a single shared-secret token (env-configured, surfaced in the LAN URL / QR alongside the existing cert flow) checked by a small Express middleware on `/api/*` and the `/workspace` mount when LAN mode is on. Loopback requests bypass the check (so `npm start` is unaffected). Reuse the existing LAN-URL/QR plumbing (`GET /api/export/lan`, `npm run install:cert-mobile`) to carry the token.
- _Benefit (user):_ the mobile flow stops being "open to everyone on the network" without re-introducing friction — the token rides the URL the user already scans.
_Full detail + acceptance:_ [#425](https://github.com/dudarenok-maker/AudioBook-Generator/issues/425).

#### `srv-21` — Validate `sidecarUrl` (scheme + private-host allowlist) before fetch ([#426](https://github.com/dudarenok-maker/AudioBook-Generator/issues/426))

- _What:_ tighten the zod validator (or a dedicated `assertSafeSidecarUrl`) to require `http`/`https` and a loopback/private-range host before any outbound fetch; reject otherwise with a clear 400 on the settings PUT.
- _Benefit (technical):_ closes the SSRF primitive; makes the sidecar-URL contract explicit instead of "any string we'll fetch".
_Full detail + acceptance:_ [#426](https://github.com/dudarenok-maker/AudioBook-Generator/issues/426).

#### `srv-22` — Constrain / document the `sync-folder/test` write-probe path ([#427](https://github.com/dudarenok-maker/AudioBook-Generator/issues/427))

- _What:_ the probe is a legitimate "is this folder writable" UX check, so the fix is proportionate: keep the feature but (a) refuse obviously-dangerous targets (system roots), and/or (b) document the trust boundary explicitly and lean on `srv-19`/`srv-20` to remove the unauth-LAN reachability. Decide between hard-constraint vs. document-and-gate when the item opens.
- _Benefit (technical):_ removes a small unauthenticated filesystem-touch primitive without breaking the Test button.
_Full detail + acceptance:_ [#427](https://github.com/dudarenok-maker/AudioBook-Generator/issues/427).

#### `side-12` — Load Qwen voice `.pt` prompts with `weights_only=True` (or a safe format) ([#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428))

- _What:_ switch the voice-prompt load to `weights_only=True`; if the saved payload isn't a pure tensor/state-dict, migrate the design-time save (`design_voice`) to a safe container (safetensors, or JSON sidecar + tensors) so the load no longer needs arbitrary unpickling. One-time read-compat shim for already-cached `.pt` files (re-derive or one-shot re-save).
- _Benefit (technical):_ removes a local RCE-on-untrusted-file footgun; aligns with torch's `weights_only` default direction.
_Full detail + acceptance:_ [#428](https://github.com/dudarenok-maker/AudioBook-Generator/issues/428).

### Ops, CI & distribution

#### `ops-9` — Enable server-side branch protection on `main` (when Pro/public) ([#429](https://github.com/dudarenok-maker/AudioBook-Generator/issues/429))

- _What:_ create an active ruleset on the default branch blocking deletion + non-fast-forward (force) pushes. Ready command:
- _Benefit (technical):_ server-side enforcement that no `--no-verify` local bypass or fresh clone can sidestep; the local guard (plan 163) becomes belt-and-suspenders. Required status checks deliberately excluded (would deadlock doc-only PRs that skip `verify.yml`).
_Full detail + acceptance:_ [#429](https://github.com/dudarenok-maker/AudioBook-Generator/issues/429).

#### `ops-7` — Pin SHA256 for model + wheel downloads ([#430](https://github.com/dudarenok-maker/AudioBook-Generator/issues/430))

- _What:_ pin a known-good SHA256 for each downloaded artifact and verify after download (refuse + delete on mismatch): the kokoro `.onnx`/`.bin` release assets, and the FlashAttention wheel URL. For the pip installs, evaluate `pip install --require-hashes` against a pinned requirements set for the opt-in Qwen/FA2 deps (or at minimum pin exact versions). Surface a clear failure message pointing at the expected hash.
- _Benefit (user / technical):_ closes the supply-chain gap on the binaries that run with the user's privileges on install — the sharpest of these is the single-maintainer community FA2 wheel. Cheap relative to the RCE blast radius.
_Full detail + acceptance:_ [#430](https://github.com/dudarenok-maker/AudioBook-Generator/issues/430).

#### `srv-4` — Track upstream-blocked deprecation chains (jsdom · archiver · @google/genai) ([#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431))

- _What:_ Periodically re-run the deprecation audit (`npm install` at root + `npm install --prefix server` on a fresh clone, grep `npm warn deprecated`) and bump direct deps whose upstream majors drop one of these transitives. Status of the three tracked chains:
- _Benefit (technical):_ keeps the `npm install` warning surface clean over time. Without explicit tracking, deprecation messages accumulate, new ones get lost in the noise, and the eventual audit becomes harder. This item is the watchdog. As of 2026-06-01 a fresh root `npm install` prints ZERO deprecation warnings (ESLint 9 + jsdom 29 + archiver 8 all cleared); the only remaining deprecation in the monorepo is the `@google/genai` `node-domexception` chain on the server side.
_Full detail + acceptance:_ [#431](https://github.com/dudarenok-maker/AudioBook-Generator/issues/431).

#### `ops-1` — Windows installer (Inno Setup or NSIS) wrapping the release zip ([#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432))

- _What:_ Add an Inno Setup (or NSIS) script that wraps the `audiobook-generator-vX.Y.Z.zip` produced by the release-package pipeline (plan 49) into a signed `.exe` installer. Installer extracts to `%LocalAppData%\AudiobookGenerator`, drops a Start Menu entry, runs prerequisite checks (Node 20.6+, Python 3.11, ffmpeg on PATH) with download links shown for any missing dep, and offers to run `install-kokoro.ps1` post-install. Extend `release.yml` with a follow-on job that builds the installer (on a Windows runner) and uploads it as a second release asset.
- _Benefit (user):_ friction-free install for non-developers. Today's plan-49 deployer must read INSTALL.md and run PowerShell commands by hand; the installer reduces that to a click.
_Full detail + acceptance:_ [#432](https://github.com/dudarenok-maker/AudioBook-Generator/issues/432).

#### `ops-2` — Docker image + compose file for headless / Linux deployment ([#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433))

- _What:_ Add a multi-stage `Dockerfile` (frontend build → node runtime stage → sidecar Python stage) and a `docker-compose.yml` that wires the three services on `:5173 / :8080 / :9000`. Document the NVIDIA Container Toolkit GPU-passthrough prereq. Resolve whether `WORKSPACE_DIR` is bind-mounted from the host or held in a named volume (host-bind recommended — keeps per-book `.audiobook/state.json` portable across container rebuilds). Extend `release.yml` with `docker/build-push-action` to publish the image to `ghcr.io/dudarenok-maker/audiobook-generator:vX.Y.Z` on tag push.
- _Benefit (user):_ enables hosting on a Linux box with a GPU (home server, single-tenant VPS) — the Windows-only PowerShell orchestration is the current ceiling for that use case.
_Full detail + acceptance:_ [#433](https://github.com/dudarenok-maker/AudioBook-Generator/issues/433).

### Listener-app handoffs

#### `fe-3` — Apple Books (iOS / macOS) handoff modal ([#434](https://github.com/dudarenok-maker/AudioBook-Generator/issues/434))

- _What:_ Wire Apple Books tile with the appropriate handoff: macOS supports drag-into-Books; iOS supports AirDrop or sync via Files. Modal shows the platform-specific flow (detect Mac vs other UA, default to "iOS via AirDrop"). Copy-and-instructions only — no direct integration with Apple Books library API (which is restricted).
- _Benefit (user):_ closes one more "Coming soon" tile.
_Full detail + acceptance:_ [#434](https://github.com/dudarenok-maker/AudioBook-Generator/issues/434).

#### `fs-7` — Plex (self-hosted media server) handoff modal ([#435](https://github.com/dudarenok-maker/AudioBook-Generator/issues/435))

- _What:_ Wire Plex tile with two paths: (a) instructions for manual upload to a Plex server library, (b) optional direct upload via the Plex API if the user has provided a Plex token (settings field). Path (b) is the most-complex of the four — Plex auth + library scan trigger.
- _Benefit (user):_ closes one more "Coming soon" tile; opens the door to direct upload integration.
_Full detail + acceptance:_ [#435](https://github.com/dudarenok-maker/AudioBook-Generator/issues/435).

#### `fs-8` — PocketBook Cloud direct upload OR `@pbsync.com` email gateway ([#436](https://github.com/dudarenok-maker/AudioBook-Generator/issues/436))

- _What:_ Research and prototype either (a) PocketBook Cloud upload (protocol is closed — needs reverse-engineering or vendor contact) or (b) sending the exported file as an attachment to `<user>@pbsync.com` (officially marketed for ebooks; audiobook size limits undocumented).
- _Benefit (user):_ true sideload-free path. Low priority because LAN download + sync folder already work.
_Full detail + acceptance:_ [#436](https://github.com/dudarenok-maker/AudioBook-Generator/issues/436).

---

## Won't (this round) — explicitly parked

Specific items someone might reasonably re-propose. Each carries a _Why parked_ (the v1 design or operational constraint) and a _Wake when_ (the trigger that makes us reopen). The broad "v1 scope freeze" and "no visual redesign" are covered by CLAUDE.md "Out of scope" and don't need restating here — this list is for tracked-specific decisions only.

- `ops-5` — Trim `build` / `e2e` out of the per-PR `verify.yml` ([#437](https://github.com/dudarenok-maker/AudioBook-Generator/issues/437)). _Why parked:_ would shave ~1–3 min off each frontend/server PR run, but the dev box is Windows (case-insensitive FS) and CI is Linux (case-sensitive) — a build break like a wrong-case import would slip past PR CI and only surface in ` … _Wake when:_ the safer round-2 levers prove insufficient AND a Linux-build / e2e signal moves earlier in the pipeline (e.g. …

- `side-4` — A/B Qwen `x_vector_only_mode=True` (speed vs. fidelity) ([#438](https://github.com/dudarenok-maker/AudioBook-Generator/issues/438)). _Why parked:_ the perf problem that motivated it is solved — after the plan-113 batching + the concurrent-batch race fix, end-to-end Qwen chapters run at **~RTF 1.15**, and the **2026-05-31 overnight full-book run held aggregate RTF ≈ … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost) AND a listen-test shows x-vector-only holds identity acceptably.

- `side-7` — Qwen decode CUDA-graph / static-cache spike (probe-gated) ([#439](https://github.com/dudarenok-maker/AudioBook-Generator/issues/439)). _Why parked:_ the perf goal is met. The 2026-05-31 overnight full-book run rendered 25 real multi-voice chapters at aggregate **RTF ≈ 1.04** (range 0.91–1.26) on the adopted 32/3600 + single-worker config — ~realtime, the target. … _Wake when:_ Qwen synthesis becomes a real bottleneck again (much longer books, a slower GPU, or a per-quote-emotion feature that inflates decode cost). Then run plan-129 Probe 1 first; only fork if it proves still launch-bound.

- `side-10` — Coalesce consecutive same-speaker short lines before batching ([#440](https://github.com/dudarenok-maker/AudioBook-Generator/issues/440)). _Why parked:_ two reasons. (1) **Perf goal met** — the 2026-05-31 overnight full-book run held aggregate RTF ~1.04 even on multi-voice/dialogue-dense chapters, so the dialogue floor isn't worth chasing. … _Wake when:_ Qwen synthesis becomes a real bottleneck again specifically on dialogue-dense books AND a captions/timing-preservation design + a quality A/B prove the merge doesn't hurt quote-audit fidelity.

- `ops-4` — Auto-install Ollama / auto-pull models ([#441](https://github.com/dudarenok-maker/AudioBook-Generator/issues/441)). _Why parked:_ installer + `ollama pull` are platform-specific and fragile under the OneDrive workspace path; the README addendum + explicit user opt-in is the v1 contract. _Wake when:_ Ollama upstream ships a stable cross-platform headless installer, OR a CI / dev-container path needs one-command bring-up. Likely two separate items then.

- `srv-8` — Multi-model fan-out for Gemini analyzer ([#442](https://github.com/dudarenok-maker/AudioBook-Generator/issues/442)). _Why parked:_ one model per run keeps cost predictable and the SSE stream simple; A/B comparison today is two sequential runs. _Wake when:_ a real product use case for "render the same chapter under two models side-by-side in one view" emerges. The audio-layer a/b audition (plan 20) covers the listening-side intent today.

- `fe-11` — Multi-tab catch-up race resilience ([#443](https://github.com/dudarenok-maker/AudioBook-Generator/issues/443)). _Why parked:_ disk `state.json` is authoritative + single-user-per-workspace, so two tabs on the same book never compete on writes. Tab B catches up by re-reading state on focus. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `srv-10` — both wake under the same trigger.

- `fe-13` — Live `VITE_USE_MOCKS` toggle in running UI ([#444](https://github.com/dudarenok-maker/AudioBook-Generator/issues/444)). _Why parked:_ the mock layer swaps the entire `api` module at module-load via the env flag; flipping at runtime would need a different architecture (e.g. mock middleware around the api object). _Wake when:_ demo / QA flow requires mid-session real↔mock flipping. Today rebuilding with `VITE_USE_MOCKS=true` takes 5 s — building the runtime toggle would cost more than the friction it removes.

- `srv-10` — Conflict resolution for two simultaneous `state.json` writers ([#445](https://github.com/dudarenok-maker/AudioBook-Generator/issues/445)). _Why parked:_ single-user-per-workspace assumption; file locking is advisory at best on Windows network shares. _Wake when:_ multi-user collab on a shared workspace becomes a real use case. Pairs with `fe-11` — both wake under the same trigger.

- `srv-6` — Engine-drift factor polish + `resolvedVoiceName` backfill ([#446](https://github.com/dudarenok-maker/AudioBook-Generator/issues/446)). _Why parked:_ the user is regenerating the whole catalogue with Qwen, so every book will get a fresh post-plan-108 `resolvedVoiceName` snapshot at render time — there are no stranded legacy chapters left for the backfill to rescue. _Wake when:_ a corpus of pre-plan-108 chapters that will _not_ be regenerated needs drift detection after all (e.g. an imported back-catalogue from another deployer). Until then the regen sweep makes the backfill moot.

- `srv-5` — Tune per-engine VRAM cost map against real hardware ([#447](https://github.com/dudarenok-maker/AudioBook-Generator/issues/447)). _Why parked:_ most of the original scope dissolved under the Qwen tuning work. The plan-113 fix serialises the Qwen forward per-engine (it isn't thread-safe), so `GPU_VRAM_BUDGET>1` gives **no same-engine Qwen parallelism** — the cost … _Wake when:_ cross-engine packing actually thrashes (spill-to-RAM slowdown, `nvidia-smi` near the card ceiling) on real hardware, or a different/smaller GPU changes the headroom math. …

---

## Retired numbering

The old per-bucket `Could #N` / `Should #N` numbering was retired on 2026-05-25 in
favour of the permanent `<prefix>-<n>` IDs above (it renumbered on every ship, so
external references rotted). Any code comment or plan doc still citing a bare
`Could/Should/Must #N` is either (a) a stale pre-2026-05-25 reference — resolve it by
matching the comment's described feature to an item above or to its shipping plan —
or (b) **plan-internal** numbering of the form `plan <NN> Should #M`, which is frozen
and correct. Don't reintroduce bare-number backlog references.

