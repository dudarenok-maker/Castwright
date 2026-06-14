# Project context for Claude Code

Frontend for an audiobook-generation tool. Vite + React 18 + TypeScript +
Redux Toolkit. Mocked API surface today; designed to swap to a real backend
without changing component code.

**Brand:** the product is **Castwright** (`castwright.ai`) — _any book, performed by a full
cast — effortlessly. Even in your own voice._ Brand assets + guidelines live in `brand/`; the
design spec is `docs/superpowers/specs/2026-06-07-castwright-brand-design.md`; the brand story
is `brand/project-narrative.md`. **`brand/` and `mockups/` are local-only (git-ignored)** —
the brand identity is "all rights reserved" and these are working/scratch artifacts. The app
ships the _generated_ assets in `public/` (PNGs rendered from `brand/*.svg` via
`scripts/render-brand-pngs.mjs`), which ARE committed, so the build never depends on the
sources. **`mockups/` is the home for all brand / style / UI exploration work** — put any
future visual concepts or HTML mockups there, not in a new tracked directory.
npm packages: `castwright` (frontend) / `castwright-server`
(backend). GitHub repo: `Castwright`. Release artifact: `castwright-vX.Y.Z.zip`.
**Note: v1.6.0 cannot self-upgrade across the rename — alpha installs reinstall fresh.**
App fonts: **General Sans** (sans) + **Lora** (serif) — self-hosted in
`public/fonts/` (woff2, via `scripts/fetch-self-hosted-fonts.mjs`); no external
font CDN at runtime (#698). Next big
release = voice cloning (`fs-38`, plan `docs/features/194-voice-cloning.md`).

## Working principles

General working style layered on top of the project-specific rules below.
These bias toward caution over speed; for trivial tasks, use judgment.

### Think before coding

Don't assume, don't hide confusion, surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask before implementing.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop, name what's confusing, and ask.

### Simplicity first

Minimum code that solves the problem — nothing speculative. (Reinforces
"Out of scope until told otherwise": the v1 surface area is final.)

- No features beyond what was asked; no abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it. Ask: "would a
  senior engineer call this overcomplicated?" If yes, simplify.

### Surgical changes

Touch only what you must; clean up only your own mess. (Reinforces the
one-branch-one-cohesive-change rule under "Branching workflow".)

- Don't "improve" adjacent code, comments, or formatting; don't refactor
  what isn't broken. Match existing style even if you'd do it differently
  (see "Conventions worth preserving").
- Remove imports/variables/functions that YOUR changes orphaned — but
  leave pre-existing dead code alone; mention it rather than deleting it.
- The test: every changed line traces directly to the user's request.

### Goal-driven execution

Define success criteria, then loop until verified.

- Turn vague tasks into verifiable goals: "fix the bug" → "write a test
  that reproduces it, then make it pass." (Already mandated under
  "Testing discipline.")
- For multi-step tasks, state a brief plan with a verify check per step.
- Strong success criteria let you loop independently; weak ones ("make it
  work") force constant clarification.

## Commands

- `npm start` — frontend + server + TTS sidecar in one shot (plan 43). Server owns the sidecar child-process lifecycle (per-user `autoStartSidecar` preference, default on); Ctrl+C tears the sidecar down via `taskkill /T /F` on Windows.
- `npm run dev` — Vite dev server (HMR) on `http://localhost:5173`.
- `npm run typecheck` — `tsc --noEmit` (frontend + server).
- `npm test` — Vitest single-run for the frontend.
- `npm run test:server` — Vitest single-run for the server (parallel, excludes the 6 hot files routed to `test:server-slow`).
- `npm run test:server-slow` — Vitest single-run for 6 timeout-prone server test files (analyzer/gemini + 5 routes test files), pinned to one fork via `server/vitest.config.slow.ts`. Runs in pre-push `verify` after `test:server`; not in `verify:fast` pre-commit. See `docs/features/archive/45-vitest-pool-tuning.md` for the rationale.
- `npm run test:scripts` — Pester 5 single-run for `scripts/lib/` PowerShell helpers
  (log rotation/pruning). Requires Pester >= 5.0; install once with
  `Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck`.
- `npm run test:sidecar` — pytest single-run for `server/tts-sidecar/tests/`.
  Uses the sidecar venv at `server/tts-sidecar/.venv\Scripts\python.exe`; emits
  a SKIP banner and exits 0 when the venv isn't bootstrapped yet (fresh clone).
  Runs `-m "not golden"` so the opt-in golden-audio tier never loads a model here.
- `npm run test:golden-audio` — **opt-in** golden-audio regression gate (ops-11,
  plan 185). NOT in `test:all` / `verify` — run on demand. Two layers: **Suite B**
  (`:assembly`, GPU-free) feeds a committed recorded-PCM fixture through the real
  `synthesiseChapter` + ffmpeg loudnorm; **Suite A** (`:sidecar`, real Kokoro)
  asserts each fixture line's length vs `kokoro-baseline.json` within tolerance —
  triple-gated (venv / pytest / Kokoro weights), SKIP+exit-0 when absent. Partials:
  `npm run test:golden-audio:assembly` (Node-side audio changes, runs anywhere) and
  `npm run test:golden-audio:sidecar` (engine changes, box with weights). Flags via
  the full runner: `--assembly-only`, `--sidecar-only`, `--engine=<kokoro|coqui|qwen>`,
  and `--bless` (re-records `kokoro-baseline.json` after a fixture/model change;
  re-capture the Suite B fixture with `server/tts-sidecar/tests/golden/capture_assembly_fixture.py`).
  Cross-engine sanity needs `GOLDEN_COQUI=1` / `GOLDEN_QWEN_VOICE=<id>`.
- `npm run test:e2e` — Playwright (chromium) against Vite in mock mode on port 5174.
  Requires one-time `npx playwright install chromium`. Excludes the visual baselines (run via `test:e2e:visual` separately). See `docs/features/archive/37-e2e-playwright.md`.
- `npm run test:e2e:visual` — Playwright visual-snapshot specs at `e2e/responsive/visual.spec.ts`, chromium-only, `--workers=1` so per-snapshot Windows font-hinting drift can't race against the parallel `test:e2e` battery. Lands in pre-push `verify`.
- `npm run test:fast` — frontend + server only (matches the pre-commit hook).
- `npm run test:all` — frontend + server + server-slow + PowerShell-scripts + sidecar tests (no e2e).
- `npm run verify` — full battery: typecheck + all tests + e2e + build (matches the pre-push hook).
- `npm run verify:quick` — all tests (no e2e, no typecheck, no build) — alias for `test:all`.
- `npm run verify:fast` — fast tests only (alias for `test:fast`) — pre-commit gate.
- `npm run build` — production build into `dist/`.
- `npm run openapi:types` — regenerate `src/lib/api-types.ts` from `openapi.yaml`.
- `cd server && npm run dev` — local analysis backend on `:8080`. Reads `server/.env`
  (Node 20.6+ native `process.loadEnvFile`, no dotenv dep).
  - `ANALYZER=local` (default) — calls a local Ollama model (with Gemini as an
    automatic fallback when `GEMINI_API_KEY` is set and the daemon is unreachable).
  - `ANALYZER=gemini` + `GEMINI_API_KEY=…` — calls the free-tier Gemini API
    directly. Optional `GEMINI_MODEL` (default `gemma-4-31b-it` — separate
    free-tier bucket from `gemini-*` and 1,500 RPD; flip to
    `gemini-3.1-flash-lite` etc. via env). Every outbound call (primary
    AND retry) is gated through a per-model RPM/TPM/RPD limiter
    (`server/src/analyzer/rate-limit.ts`) so retries can't compound into
    429/500 storms. See `server/.env.example` for `GEMINI_RPM_*` /
    `GEMINI_TPM_*` / `GEMINI_RPD_*` overrides and
    [docs/features/archive/06-analyzer-gemini.md](docs/features/archive/06-analyzer-gemini.md)
    for the limits table.

## Layout

- `src/main.tsx` — entry; mounts `<App/>` inside `<Provider>`.
- `src/App.tsx` — root component; selects off the discriminated-union `ui.stage`
  and renders the matching view + any active modals.
- `src/lib/` — `icons.tsx`, `time.ts`, `colors.ts`, `router.ts`, `api.ts`,
  `types.ts`, generated `api-types.ts`.
- `src/data/` — design fixtures (characters, chapters, voices, books, etc.).
- `src/store/` — RTK slices (`ui`, `cast`, `chapters`, `revisions`, `manuscript`, `book-meta`, `notifications`) + `broadcast-middleware.ts` (cross-tab `BroadcastChannel` sync since plan 63)
  - `index.ts` (configureStore, typed `useAppDispatch`/`useAppSelector`, router
    install).
- `src/components/`, `src/modals/`, `src/views/` — UI. Since plan 60, `src/views/listen.tsx` is a thin orchestrator (~319 lines) over three region sub-components under `src/components/listen/` — `listen-header.tsx` (cover + title + book-meta + Notes card), `listen-player-region.tsx` (markers + chapter list + Share-clip button), `listen-download-section.tsx` (download tiles + export queue). New listen-view features should land in the relevant sub-component, not the orchestrator.
- `src/mocks/canned-data.ts` + `src/mocks/manuscripts/` — mock API payloads.
- `openapi.yaml` (root) — **API contract**, source of truth for backend shapes.

## Conventions worth preserving

- **Discriminated-union `ui.stage`** (`src/store/ui-slice.ts`) — `{ kind: 'books'
| 'upload' | 'analysing' | 'confirm' | 'ready' }`, with `view`/`currentChapterId`/
  `openProfileId` living _inside_ the `ready` variant. Don't flatten.
- **Hash router grammar** (`src/lib/router.ts`) — pure `parseHash`/`stageToHash`,
  installed against the store via the `RouterStore` adapter so the router stays
  decoupled. Same URL grammar as the original prototype.
- **OpenAPI is the type source of truth** — `Character`/`Chapter`/`Sentence` etc.
  come from `src/lib/api-types.ts` (generated). Don't hand-write them.
- **Design tokens are CSS custom properties** — `src/styles.css` declares
  `--peach`, `--ink`, `--magenta`, etc.; `tailwind.config.ts` references those
  vars. No hex literals in component code.
- **Mocks behind `VITE_USE_MOCKS`** — `src/lib/api.ts` exports
  `api = USE_MOCKS ? mock : real`. Components only ever import from `api.*`;
  they never know which is which. `.env.development` sets the flag on.
- **RTK immer** — slice reducers mutate via Immer drafts. Don't rewrite to spreads.

## Testing discipline (REQUIRED for every change)

Every PR MUST improve automated coverage on top of updating its regression
plan. Regression plans under `docs/features/*.md` document invariants and
manual acceptance walkthroughs — they complement automated tests, they do
not replace them.

- New behaviour → ship paired automated test(s).
- Bug fix → ship a regression test that fails before the fix and passes after.
- Refactor → existing tests stay green; add coverage for any previously-uncovered seam you touched.
- Never delete or `.skip` a test without an explicit replacement or follow-up plan item.
- If a change lands in untested territory (e.g. the Python sidecar still has no pytest), the test scaffold itself is part of the work — do not ship code without it.
- **UI-visible behaviour SHOULD land an e2e test** when the change crosses
  router/redux/layout seams (Vitest+jsdom can lie about layout, focus, and
  hashchange timing). One Playwright spec per feature surface is the bar.

Harnesses (five tiers):

- Frontend: `npm run test` (Vitest + jsdom + React Testing Library). Tests live next to the unit (`*.test.ts(x)`).
- Server: `cd server && npm run test` (Vitest + node env, real-ffmpeg integration where relevant). Same colocation.
- Sidecar (`server/tts-sidecar/`): pytest harness at `server/tts-sidecar/tests/`,
  invoked via `server/tts-sidecar/run-tests.ps1` or `npm run test:sidecar`.
  Any new sidecar code MUST add cases here.
- PowerShell helpers (`scripts/lib/`): Pester 5 tests in `scripts/tests/`, invoked via `scripts/tests/run.ps1` or `npm run test:scripts`.
- **E2E (`e2e/`)**: Playwright + chromium against Vite in mock mode on port 5174,
  invoked via `npm run test:e2e`. Browser-level golden paths + on-ramp for
  visual regression (`toHaveScreenshot()`). See `docs/features/37-e2e-playwright.md`.
- Top-level `npm run test:all` runs the four unit/integration harnesses.
  `npm run verify` adds typecheck + e2e + build on top (pre-push gate).

Canonical end-to-end manuscript for full-pipeline regression:
`server/src/__fixtures__/the-coalfall-commission.md` — _The Coalfall Commission_,
a Castwright-owned original (committed; safe to use freely). A Russian variant of
Chapter One lives alongside it at `the-coalfall-commission.ru.md` for the
language-detection fixtures. Cite these from any regression plan that needs an
e2e run rather than inventing fresh fixtures. See
`docs/features/archive/28-chapter-audio-format.md` for the canonical recipe.

## The backlog

`docs/BACKLOG.md` is the thin, MoSCoW-bucketed **prioritized planning view**.
Each item maps to exactly one GitHub issue (title `<prefix>-<n> — <what>`),
which is the **canonical detail home** — What / Acceptance / Key files /
Depends on / Benefit live in the issue, not in BACKLOG.md. The `<prefix>-<n>`
ID stays the durable cross-reference for code/commits/plans; the issue `#NN`
is the GitHub-native auto-close hook. **Bugs are GitHub issues with the `bug`
label and stay off `docs/BACKLOG.md`** (still out-of-band — the user files
them as they hit them). The label taxonomy, issue forms, and the full
convention live in [CONTRIBUTING.md "Issues"](CONTRIBUTING.md#issues); plan
[166](docs/features/166-github-issues-backlog-integration.md) is the rationale.

When you ship a backlog item:

1. Close its issue — or let the delivering PR auto-close it via `Closes #NN`
   in the PR body (`Refs #NN` for a partial / multi-wave delivery).
2. Remove (or, for a Won't item, collapse) its row in `docs/BACKLOG.md`.
3. Update the source plan's `status:` and/or fill its **Ship notes**; if the
   plan is now `stable`, move it to `docs/features/archive/`.

When you discover a new outstanding item (e.g. a "Suggested follow-up"
added to a plan), file a Backlog-item issue (it gets `area:`/`moscow:`/`type:`
labels) **and** add the thin row to `docs/BACKLOG.md` linking it, in the same
round — the backlog is only useful while it stays current.

## Planning-mode behaviour

When in planning mode, or when asked "what's outstanding?" / "what's left?" / "summarise what we'd do":

- **List ALL items, in priority order.** No top-N truncation, no "and a few more" hand-waves. If there are 12 things, write 12. The user reads the whole list and re-prioritises if needed — collapsing it to "top 3" forces them to ask follow-ups.
- **Each item carries a one-line benefit.** Tag it `*Benefit (user / technical / architectural):*` so the _why_ is visible at a glance. An item without a benefit line is a TODO masquerading as a plan — write the benefit or drop the item.
- **Priority is explicit.** Number the list (1, 2, 3 …) — do not present a flat unordered set. If two items are genuinely tied, group them under one number and say so.
- **Distinguish "must do" from "nice to have."** When the plan has a natural break (e.g. v1 vs. follow-up), call it out with a heading rather than burying it in adjectives.
- **Do not narrate work already done in the summary section.** Past tense belongs in a separate "Done in this session" line, NOT mixed into the outstanding list.

This applies to BOTH formal plans (ExitPlanMode) AND informal end-of-turn summaries when the user is mid-planning.

## Before-shipping checklist

Run this before declaring any non-trivial task "done." Skipping a step is fine when the step genuinely does not apply (e.g. a doc-only change has no test plan) — but say so explicitly rather than silently omitting.

1. **Update or create the regression plan** under `docs/features/` — _for substantial/cross-cutting work._ New feature → new file from `TEMPLATE.md` (and tag the issue `needs-plan`). Changed behaviour cited in an existing plan → update that plan in the same diff. Use frontmatter `status:` (`draft` / `active` / `stable` / `scaffolded` / `deferred`). Small/localized items skip the plan doc — the issue body + paired test is the spec.
2. **Land paired automated test(s).** New behaviour → new test. Bug fix → regression test (fails before, passes after). UI-visible behaviour crossing router/redux/layout seams → Playwright e2e spec under `e2e/`.
3. **Update `docs/features/INDEX.md`** if the plan is new or moved (new entry under its area, or move to `## Shipped (archive)` per `archive/README.md` when shipping a plan).
4. **Close or advance the linked issue.** Put `Closes #NN` in the PR body for a full delivery (`Refs #NN` for a partial), and confirm the issue's `area:`/`moscow:` labels still reflect reality. Bugs link their `bug` issue with `Closes #NN` too.
5. **Run `npm run verify`** locally — same battery as pre-push. Catches typecheck + all tests + e2e + build in one shot.
6. **If shipping a plan** (status → `stable`): fill its **Ship notes** section with the shipped date and the commit SHA, then `git mv` it under `docs/features/archive/` and re-link any active plan that pointed at it.
7. **Surface what changed** in the end-of-turn summary in 1–2 sentences. Do not narrate the diff — point at the user-visible delta and the test that locks it.

## Out of scope until told otherwise

- New features. Surface area is final for v1.
- Visual redesign. Reproduce the existing look pixel-for-pixel.
- Backend work. This repo is the frontend that will call the OpenAPI spec.

## Mobile testing protocol (plan 81)

The app drives on phone + tablet over LAN HTTPS (plan 81 archive: `docs/features/archive/81-mobile-tablet-support.md`). When working on any view, verify it stays responsive at three viewports:

| Viewport | Tailwind prefix | Target devices | Layout rule |
|---|---|---|---|
| `<640px` | (default) | portrait phones | single-column, drawers + bottom sheets, modals full-screen, hamburger menus |
| `640–1024px` | `sm:` and `md:` | tablets, landscape phones | two-column where appropriate, modals as dialog, secondary panes as right drawer |
| `≥1024px` | `lg:` and `xl:` | desktop, tablet landscape | three-pane layouts, full top bar |

**Touch-equivalence rule:** every desktop drag/hover affordance ships its tap replacement. Examples already in the codebase:
- Cast voice library: drag-and-drop voice card → cast row OR tap "Assign" pill → tap row (`src/views/cast.tsx`).
- Manuscript paragraph boundary: PointerEvent handler covers mouse + touch + pen in one path (`src/views/manuscript.tsx`).
- Hover-reveal labels: `coarse-pointer:opacity-60` keeps them faintly visible on touch devices (`src/views/manuscript.tsx` boundary handle).

**Touch targets:** every interactive control ≥44×44 px on phone per WCAG 2.5.5. Use `min-h-[44px] sm:min-h-0` so phones get the touch target without changing desktop sizing.

**LAN access for real-device testing:**

1. One-time per dev box: install `mkcert` (`scoop install mkcert` / `brew install mkcert` / `apt install mkcert`), then `mkcert -install`.
2. `npm run install:cert-mobile` — prints LAN URL + QR code + per-OS root-cert install steps.
3. Install the root CA on each mobile device once (iOS: Settings → Profile downloaded → Install → trust; Android: Settings → Security → Install certificate).
4. Run the server in LAN HTTPS mode: `npm run dev:lan` (HMR-capable Vite + Node both at `https://0.0.0.0:5173`/`:8443`) OR `npm run build && npm run start:lan` (production bundle at `https://0.0.0.0:8443`).
5. Open the printed LAN URL on the device — lock icon, no warning.

**Automated regression net:**

- `npm run test:e2e` (pre-push gate, ~90s): `playwright test --project=chromium`. Runs every spec + the chromium project of the responsive specs (`e2e/responsive/*.spec.ts`).
- `npm run test:e2e:mobile` (opt-in, ~10-15min): `playwright test --project=mobile-chrome --project=tablet-chrome`. Runs only `e2e/responsive/*.spec.ts` at phone (Pixel 7) + tablet (iPad Pro 11) viewports.
- `npm run test:e2e:all` (opt-in, ~17min): everything across all 3 projects.

Adding a new view? Append a case to `e2e/responsive/coverage.spec.ts` — it auto-runs at every project.

## Suggested follow-ups (not requirements)

- **Model lifecycle is split between eager and button-driven** —
  - **Kokoro v1 (default, new in 2026-05)**: eagerly loaded at sidecar
    startup, ~1 s cold load, ~1 GB VRAM. Permanently resident alongside
    the analyzer Ollama on an 8 GB GPU. NO Load/Stop pill — it's just
    always available once `scripts/install-kokoro.ps1` has dropped the
    weights into `server/tts-sidecar/voices/kokoro/`. Voice catalog
    filtered to English-only (28 voices: `af_*`, `am_*`, `bf_*`, `bm_*`).
  - **Coqui XTTS v2 (alternate)**: button-driven via `ModelControlPill`
    (`src/components/`). The TTS sidecar defaults `PRELOAD_COQUI=0`
    (`server/tts-sidecar/main.py`) so XTTS only loads on demand. Loading
    XTTS auto-evicts the analyzer Ollama and vice versa (with an inline
    "TTS / Analyzer unloaded to free VRAM" banner). Endpoints:
    `POST /api/sidecar/{load,unload}` (60 s / 2 s budgets),
    `POST /api/ollama/{load,unload}` (uses Ollama's `keep_alive` idiom,
    see `server/src/analyzer/ollama.ts:92` for the equivalent in-band
    evict on real chat calls).
  - **Qwen has TWO models with split lifecycles** (`QwenEngine`,
    `server/tts-sidecar/main.py`): the **Base 0.6B** synth model is the
    resident one (button-driven `/load`, like Coqui; not eager unless
    `PRELOAD_QWEN=1`). The **VoiceDesign 1.7B** model is loaded transiently
    during `design_voice` and kept WARM across a cast-review session so
    back-to-back designs don't reload it — then freed (reclaiming ~4–5 GB)
    by a startup idle watchdog once it idles past `QWEN_DESIGN_IDLE_TTL`
    (default 120 s), or immediately at the first real `/synthesize` (leaving
    design mode for generation). On an 8 GB GPU Base + VoiceDesign are
    co-resident only DURING a design; don't add a third heavy model
    (e.g. an accidental Coqui `/load`) on top — that was the plan-108
    OOM (108 post-ship `fix/sidecar-qwen-design-vram`).
  - **Per-character voice profiles are per-engine**: each cast member
    carries an `overrideTtsVoices: { coqui?: {name}, kokoro?: {name},
gemini?: {name} }` map. Engine switches preserve cast assignments;
    no re-cast needed when toggling Coqui ↔ Kokoro. Legacy single-field
    `overrideTtsVoice` is migrated lazily at cast.json read time.
  - **Whisper ASR is a 4th sidecar engine (srv-31 / plan 186)** — audio→text,
    NOT in the synth `ENGINES` map (`WhisperEngine` + `POST /transcribe`). Used
    by the per-sentence content-QA gate to catch "fluent but wrong words"
    generations. **CPU-first by default** (`ASR_DEVICE=cpu` → zero VRAM, never
    competes with synth); `ASR_DEVICE=cuda` opts into the GPU with a tiny/base
    int8 model (~150–400 MB) gated by the weighted VRAM semaphore (`asr:1`) plus
    an idle-evict watchdog (`ASR_IDLE_TTL`, mirrors the Qwen VoiceDesign one).
    ASR and Qwen VoiceDesign never co-reside (design = cast-review, ASR =
    generation/repair). OFF unless `SEG_ASR_ENABLED`; needs `pip install
    faster-whisper` in the sidecar venv.

## Commit gate

Three-tier automated gate, enforced by husky hooks in `.husky/`:

- **commit-msg** (`.husky/commit-msg`): runs `scripts/validate-commit-msg.mjs`
  on the subject line. Rejects commits that don't match the
  `<type>(<scope>): <subject>` convention (with `chore: <subject>` as the
  no-scope catch-all). Merge / Revert / fixup! / squash! commits are exempt.
  Full spec lives in [CONTRIBUTING.md](CONTRIBUTING.md); regression plan is
  [docs/features/archive/38-branching-and-commit-convention.md](docs/features/archive/38-branching-and-commit-convention.md).
- **pre-commit** (`.husky/pre-commit`): runs `npm run verify:fast:scoped` —
  validator unit tests + frontend + server tests, but **scope-filtered against
  the staged diff** (plan 156): a leg whose scope the staged change never
  touched is skipped (`[skip] … (out of scope)`), so a sidecar-only or
  docs-only commit runs none of them. Sub-5s on a warm cache. Refuses the
  commit if any in-scope spec is red. Sidecar (pytest), Pester scripts,
  Playwright e2e, and typecheck are NOT in pre-commit — they live in
  pre-push so commits stay snappy. If a co-running GPU generation is detected
  (nvidia-smi), the runner warns and throttles test concurrency
  (`LOW_CONCURRENCY=1`); `SKIP_CONTENTION_CHECK=1` disables the probe.
  `npm run verify:fast` (no scope filter) remains for a manual full fast run.
- **pre-push** (`.husky/pre-push`): first runs `scripts/guard-protected-push.mjs`,
  which refuses a force-push or deletion of a protected branch (`main`) before
  the battery even starts (a local guard; since 2026-06-14 `main` ALSO has
  server-side branch protection — a GitHub ruleset blocking force-push +
  deletion, enabled after the Pro upgrade per `com-4` — so this hook is now
  belt-and-suspenders; see
  [docs/features/163-protected-push-guard.md](docs/features/163-protected-push-guard.md);
  bypass the local hook intentionally with `git push --no-verify`). Then runs `npm run verify`
  — typecheck + all tests + e2e + build. Refuses the push if any step fails.

`npm run verify` is cache-aware (see
[docs/features/archive/50-verify-cache.md](docs/features/archive/50-verify-cache.md)):
each step skips with `[cached]` when its input hash matches the last
green run. Pass `npm run verify -- --no-cache` to force a full re-run.

`npm run verify` also prepends `lint` (ESLint + Prettier via
`eslint-config-prettier`) and includes `test:a11y` (axe-core on the four
core views) — see [docs/features/archive/46-lint-format-a11y.md](docs/features/archive/46-lint-format-a11y.md)
for the rulesets, the autofix-baseline shape, and the rationale for each
relaxed rule.

**GitHub CI is OPT-IN (plan 215)**: the `verify.yml` battery does **not** run
automatically on PRs. The local pre-push hook already runs the FULL `npm run
verify` battery on every push, so a per-PR cloud run is redundant spend on
Actions minutes. Push freely — every PR push bills **0 CI minutes** by default.
Run the cloud battery on demand when you want a clean-room check: add the
**`run-ci`** label to the PR (fires one run; re-runs on each new push while the
label is on), or dispatch it manually (Actions tab → Verify → Run workflow, or
`gh workflow run verify.yml --ref <branch>`). A manual dispatch runs the full
battery; a labeled PR runs only the **scope-filtered** legs the diff touched
(plan 103 — `git diff` against the PR base; a frontend-only PR skips server
tests, a server-only PR skips Playwright e2e + the frontend unit suite, a root
`package.json`/`package-lock.json` change runs every leg).

What still runs automatically: `pr-title-lint.yml` on every PR, `app.yml` on
`apps/android/**` changes (the only automated coverage for the Flutter
companion — no local hook runs `flutter analyze`/`test`), `release.yml` on a
`vX.Y.Z` tag, and `cross-os.yml` on its weekly Sunday cron. Cross-OS verify
(macOS + Windows) + mobile/tablet e2e live on `cross-os.yml` (`workflow_dispatch`
+ weekly cron on `main`) — **fire it manually before announcing any release
that ships a zip to alpha testers** (deployer spread is still Windows + macOS +
Linux). `release.yml` verifies Ubuntu-only before publish. The doc-only
`paths-ignore` fast-path (plan 101) is a second layer — a `run-ci`-labeled PR
whose files are all docs still won't spin up the battery.
See [docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md),
[103](docs/features/103-ci-cost-reduction.md), and
[archive/101](docs/features/archive/101-docs-only-ci-skip.md).

Branching model and the full commit convention (allowed types, allowed scopes,
multi-scope syntax, worktrees for parallel agent work) are documented in
[CONTRIBUTING.md](CONTRIBUTING.md). Read this before opening a branch.

## Branching workflow (REQUIRED for every non-trivial change)

Before starting any non-trivial work — new feature, bug fix, refactor, plan
implementation — cut a branch from `main` rather than committing directly:

1. **Cut the branch first.** `git switch -c <type>/<scope>-<slug>` off the
   latest `main`. `<type>` and `<scope>` come from the
   [commit-convention vocabulary](CONTRIBUTING.md#commit-convention). Examples:
   `feat/server-batch-retry`, `fix/frontend-voice-swatch-click`,
   `docs/docs-plan-39`.
2. **Land all commits for that piece of work on the branch.** Do not mix
   unrelated work on the same branch — one branch = one cohesive change.
3. **Surface the branch name in your end-of-turn summary**, along with the
   commit SHAs, so the user can review the diff and decide when to merge.
4. **Direct-to-`main` is only for trivial, immediately-shipped fixes** (typo,
   dead-comment removal, single-line doc tweak). Even then, call out the
   shortcut explicitly in the end-of-turn summary so the user can redirect
   to a branch if they disagree.

### Opening the PR

Every non-trivial change merges via a GitHub PR. The PR title MUST match the
[commit-convention subject format](CONTRIBUTING.md#commit-convention) — a
GitHub Actions workflow rejects malformed titles. GitHub pre-fills the body
from [.github/pull_request_template.md](.github/pull_request_template.md);
keep the `## Summary` and `## Test plan` sections, fill them in, and link
the regression plan under `docs/features/` when one applies. Merges use the
"Create a merge commit" button (squash / rebase merge are disabled at the
repo level) and the head branch is auto-deleted on merge. Full spec:
[CONTRIBUTING.md "Pull requests"](CONTRIBUTING.md#pull-requests). Regression
plan: [docs/features/archive/44-pr-hygiene.md](docs/features/archive/44-pr-hygiene.md).

**Requesting a CI run on a PR (plan 215).** CI is opt-in (see "Commit gate"
above): push freely — drafts and ready PRs alike bill **0 Actions minutes**.
The local pre-push hook is the real gate and runs the full `npm run verify`
battery on every push. When you want a clean-room cloud check (typically right
before merge, or to confirm something you couldn't verify locally), add the
**`run-ci`** label to the PR or dispatch `verify.yml` manually — the labeled
run is insurance, not the gate. (Draft status no longer affects CI cost, so the
old draft-by-default dance is unnecessary; still open as draft if you simply
want to signal work-in-progress.) Rationale + measurements:
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md)
and [215](docs/features/215-ci-label-gated-verify.md).

### Parallel agents

When spawning implementation agents via the Agent tool for work that can run
in parallel:

- Use `isolation: "worktree"` so each agent gets its own working tree off the
  shared `.git`. Two agents on the same checkout will trip over each other.
- Give each agent a non-overlapping scope per the [scope discipline table](CONTRIBUTING.md#scope-discipline--merge-magic).
  Two agents in `frontend/src/components/` will collide; one in `frontend` +
  one in `sidecar` will not.
- The Agent tool auto-names the temporary branch (`claude/wt-…`). When the
  agent finishes, rename the branch to the proper `<type>/<scope>-<slug>`
  shape before merge — or pre-create the branch with `git switch -c
feat/server-foo` and tell the agent in its prompt to check it out as its
  first step.
- **Default disposition for a round of parallel agent work: one integration PR,
  verified once — not N separate PRs.** Reconcile the branches via the
  [`integration/<date>` pattern](CONTRIBUTING.md#reconciliation-pattern): fresh
  branch off `main`, merge each agent branch one at a time, run `npm run verify`
  between merges. Open that integration branch as a **draft** PR and only
  `gh pr ready` once the whole reconciliation is locally green — so the round
  bills ONE verify run instead of one (or several) per agent branch. This is the
  largest CI-cost lever alongside draft-by-default; see
  [docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md).

### Planning agents

Plan agents (`subagent_type: "Plan"`) design strategies but don't write code,
so they don't need their own branch. But the implementation work that follows
a plan does — when you act on a plan, step 1 is cutting the branch named after
the plan number (e.g. `feat/frontend-plan-38`).

Hooks activate automatically after `npm install` via the `prepare` script
(husky v9.1 — sets `core.hooksPath` to `.husky/_`, the dir holding the
shebang'd wrapper scripts that source `.husky/<hook>`). Do NOT set it to
`.husky/` — those user hooks are shebang-less, so git can't spawn them
directly (`cannot spawn .husky/pre-commit: Exec format error`). If hooks ever
stop firing, run `npm install` (or `npx husky`) to reset the path. On a fresh
clone, run `npm install` once and you're done.

Additional one-time setup:

- **Pester >= 5.0** for the PowerShell-scripts harness (Windows-bundled Pester 3.4 isn't API-compatible). Install once per user:

      Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck

  `scripts/tests/run.ps1` prints this same hint if it can't find Pester 5+.

- **Playwright chromium** for the e2e harness:

      npx playwright install chromium

  One ~100 MB download, cached in `%LOCALAPPDATA%\ms-playwright`. `npm run test:e2e` errors with a clear hint if chromium is missing.

Working practice:

- Before committing anything non-trivial, run `npm run verify` — same battery
  as pre-push. Catching failures in the same turn beats catching them at
  push time.
- `npm run verify:fast` matches pre-commit; `npm run verify:quick` is `test:all` without typecheck/build/e2e.
- **Do not use `--no-verify` to bypass.** If a hook fails:
  1. **Triage first.** Categorise the failure as **related to my change** vs. **pre-existing** (i.e. the same test would fail on `main`). A `git stash && git checkout main && <run the failing test>` round-trip settles it in 30 seconds.
  2. **Related → fix it.** Update the code, the regression doc, and the paired test in the same commit. Then retry.
  3. **Pre-existing → surface to the user before doing anything else.** Do NOT silently fix unrelated test breakage in the same commit (couples scope; muddies blame). Do NOT bypass with `--no-verify`. Ask whether to land a separate fix PR first, or to scope a follow-up.
  4. **Flake suspicion → run the failing test in isolation once.** If it passes alone, name the flake explicitly to the user and propose either a retry-loop or a quarantine — never bypass on a hunch.
- Sidecar pytest coverage lives at `server/tts-sidecar/tests/` —
  `test_smoke.py`, `test_synthesize.py`, `test_runtime_wiring.py`,
  `test_kokoro.py`, `test_logging_format.py`,
  `test_concurrent_synthesis.py`. `test_runtime_wiring.py` pins the
  CUDA+DeepSpeed+fp16 primary path: DeepSpeed init reaches the model
  and runs before `tts.to(device)`, init failure is swallowed, fp16
  autocast wraps the synth call, `_float_audio_to_int16_le` handles
  clipping / stereo downmix / list input, and speaker-manifest
  enumeration tolerates API drift. `test_concurrent_synthesis.py` pins
  the thread-pool saturation contract: N parallel `/synthesize` calls
  run in parallel (asyncio.to_thread offload intact), each response
  carries its own PCM (no cross-request bleed), and the sample-rate
  header is per-response — Coqui and Kokoro covered separately. Wired
  into `npm run test:all` via `npm run test:sidecar` (skips with a
  banner on an unbootstrapped venv).
