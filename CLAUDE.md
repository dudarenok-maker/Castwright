# Project context for Claude Code

Frontend for an audiobook-generation tool. Vite + React 18 + TypeScript +
Redux Toolkit. Mocked API surface today; designed to swap to a real backend
without changing component code.

## Commands
- `npm run dev` — Vite dev server (HMR) on `http://localhost:5173`.
- `npm run typecheck` — `tsc --noEmit` (frontend + server).
- `npm test` — Vitest single-run for the frontend.
- `npm run test:server` — Vitest single-run for the server.
- `npm run test:scripts` — Pester 5 single-run for `scripts/lib/` PowerShell helpers
  (log rotation/pruning). Requires Pester >= 5.0; install once with
  `Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck`.
- `npm run test:sidecar` — pytest single-run for `server/tts-sidecar/tests/`.
  Uses the sidecar venv at `server/tts-sidecar/.venv\Scripts\python.exe`; emits
  a SKIP banner and exits 0 when the venv isn't bootstrapped yet (fresh clone).
- `npm run test:e2e` — Playwright (chromium) against Vite in mock mode on port 5174.
  Requires one-time `npx playwright install chromium`. See `docs/features/37-e2e-playwright.md`.
- `npm run test:fast` — frontend + server only (matches the pre-commit hook).
- `npm run test:all` — frontend + server + PowerShell-scripts + sidecar tests (no e2e).
- `npm run verify` — full battery: typecheck + all tests + e2e + build (matches the pre-push hook).
- `npm run verify:quick` — all tests (no e2e, no typecheck, no build) — alias for `test:all`.
- `npm run verify:fast` — fast tests only (alias for `test:fast`) — pre-commit gate.
- `npm run build` — production build into `dist/`.
- `npm run openapi:types` — regenerate `src/lib/api-types.ts` from `openapi.yaml`.
- `cd server && npm run dev` — local analysis backend on `:8080`. Reads `server/.env`
  (Node 20.6+ native `process.loadEnvFile`, no dotenv dep).
  - `ANALYZER=manual` (default) — writes prompts to `server/handoff/inbox/`, waits
    for the user to drop JSON into `server/handoff/outbox/` (file-drop cowork flow).
  - `ANALYZER=gemini` + `GEMINI_API_KEY=…` — calls the free-tier Gemini API
    directly. Optional `GEMINI_MODEL` (default `gemma-4-31b-it` — separate
    free-tier bucket from `gemini-*` and 1,500 RPD; flip to
    `gemini-3.1-flash-lite` etc. via env). Every outbound call (primary
    AND retry) is gated through a per-model RPM/TPM/RPD limiter
    (`server/src/analyzer/rate-limit.ts`) so retries can't compound into
    429/500 storms. See `server/.env.example` for `GEMINI_RPM_*` /
    `GEMINI_TPM_*` / `GEMINI_RPD_*` overrides and
    [docs/features/06-analyzer-gemini.md](docs/features/06-analyzer-gemini.md)
    for the limits table.

## Layout
- `src/main.tsx` — entry; mounts `<App/>` inside `<Provider>`.
- `src/App.tsx` — root component; selects off the discriminated-union `ui.stage`
  and renders the matching view + any active modals.
- `src/lib/` — `icons.tsx`, `time.ts`, `colors.ts`, `router.ts`, `api.ts`,
  `types.ts`, generated `api-types.ts`.
- `src/data/` — design fixtures (characters, chapters, voices, books, etc.).
- `src/store/` — RTK slices (`ui`, `cast`, `chapters`, `revisions`, `manuscript`)
  + `index.ts` (configureStore, typed `useAppDispatch`/`useAppSelector`, router
  install).
- `src/components/`, `src/modals/`, `src/views/` — UI.
- `src/mocks/canned-data.ts` + `src/mocks/manuscripts/` — mock API payloads.
- `openapi.yaml` (root) — **API contract**, source of truth for backend shapes.

## Conventions worth preserving
- **Discriminated-union `ui.stage`** (`src/store/ui-slice.ts`) — `{ kind: 'books'
  | 'upload' | 'analysing' | 'confirm' | 'ready' }`, with `view`/`currentChapterId`/
  `openProfileId` living *inside* the `ready` variant. Don't flatten.
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
`C:\Users\dudar\Downloads\the Coalfall Commission.txt` (do not commit — copyrighted).
Cite this file from any regression plan that needs an e2e run rather than
inventing fresh fixtures. See `docs/features/28-chapter-audio-format.md` for
the canonical recipe.

## Planning-mode behaviour

When in planning mode, or when asked "what's outstanding?" / "what's left?" / "summarise what we'd do":

- **List ALL items, in priority order.** No top-N truncation, no "and a few more" hand-waves. If there are 12 things, write 12. The user reads the whole list and re-prioritises if needed — collapsing it to "top 3" forces them to ask follow-ups.
- **Each item carries a one-line benefit.** Tag it `*Benefit (user / technical / architectural):*` so the *why* is visible at a glance. An item without a benefit line is a TODO masquerading as a plan — write the benefit or drop the item.
- **Priority is explicit.** Number the list (1, 2, 3 …) — do not present a flat unordered set. If two items are genuinely tied, group them under one number and say so.
- **Distinguish "must do" from "nice to have."** When the plan has a natural break (e.g. v1 vs. follow-up), call it out with a heading rather than burying it in adjectives.
- **Do not narrate work already done in the summary section.** Past tense belongs in a separate "Done in this session" line, NOT mixed into the outstanding list.

This applies to BOTH formal plans (ExitPlanMode) AND informal end-of-turn summaries when the user is mid-planning.

## Before-shipping checklist

Run this before declaring any non-trivial task "done." Skipping a step is fine when the step genuinely does not apply (e.g. a doc-only change has no test plan) — but say so explicitly rather than silently omitting.

1. **Update or create the regression plan** under `docs/features/`. New feature → new file from `TEMPLATE.md`. Changed behaviour cited in an existing plan → update that plan in the same diff. Use frontmatter `status:` (`draft` / `active` / `stable` / `scaffolded` / `deferred`).
2. **Land paired automated test(s).** New behaviour → new test. Bug fix → regression test (fails before, passes after). UI-visible behaviour crossing router/redux/layout seams → Playwright e2e spec under `e2e/`.
3. **Update `docs/features/INDEX.md`** if the plan is new or moved (new entry under its area, or move to `## Shipped (archive)` per `archive/README.md` when shipping a plan).
4. **Run `npm run verify`** locally — same battery as pre-push. Catches typecheck + all tests + e2e + build in one shot.
5. **If shipping a plan** (status → `stable`): fill its **Ship notes** section with the shipped date and the commit SHA, then `git mv` it under `docs/features/archive/` and re-link any active plan that pointed at it.
6. **Surface what changed** in the end-of-turn summary in 1–2 sentences. Do not narrate the diff — point at the user-visible delta and the test that locks it.

## Out of scope until told otherwise
- New features. Surface area is final for v1.
- Visual redesign. Reproduce the existing look pixel-for-pixel.
- Backend work. This repo is the frontend that will call the OpenAPI spec.

## Suggested follow-ups (not requirements)
- Swap `src/lib/router.ts` for `react-router` v6 `createHashRouter` keeping the
  grammar identical.
- `redux-persist` on `ui` and `manuscript` slices.
- Real `<audio>` element in `MiniPlayer` once the backend returns URLs.
- Vitest + slice tests (`applyGenerationTick`, `applyVoiceMatches`).
- ESLint + Prettier, axe-core a11y pass.
- Align the `Sentence` shape with the OpenAPI spec (currently the fixtures use
  `{ id: string, charId, text }` while the spec uses `{ id: number, characterId,
  chapterId, text }`).
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
  - **Per-character voice profiles are per-engine**: each cast member
    carries an `overrideTtsVoices: { coqui?: {name}, kokoro?: {name},
    gemini?: {name} }` map. Engine switches preserve cast assignments;
    no re-cast needed when toggling Coqui ↔ Kokoro. Legacy single-field
    `overrideTtsVoice` is migrated lazily at cast.json read time.

## Commit gate
Two-tier automated test gate, enforced by husky hooks in `.husky/`:
- **pre-commit** (`.husky/pre-commit`): runs `npm run verify:fast` —
  frontend + server tests only. Sub-5s on a warm cache. Refuses the
  commit if any Vitest spec is red. Sidecar (pytest), Pester scripts,
  Playwright e2e, and typecheck are NOT in pre-commit — they live in
  pre-push so commits stay snappy.
- **pre-push** (`.husky/pre-push`): runs `npm run verify` — typecheck +
  all tests + e2e + build. Refuses the push if any step fails.

Hooks activate automatically after `npm install` via the `prepare` script
(husky v9 — sets `core.hooksPath` to `.husky/`). On a fresh clone, run
`npm install` once and you're done.

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
  `test_kokoro.py`, `test_logging_format.py`. `test_runtime_wiring.py`
  pins the CUDA+DeepSpeed+fp16 primary path: DeepSpeed init reaches the
  model and runs before `tts.to(device)`, init failure is swallowed,
  fp16 autocast wraps the synth call, `_float_audio_to_int16_le` handles
  clipping / stereo downmix / list input, and speaker-manifest
  enumeration tolerates API drift. Wired into `npm run test:all` via
  `npm run test:sidecar` (skips with a banner on an unbootstrapped venv).
  Next milestone: concurrent-synthesis / thread-pool saturation.
