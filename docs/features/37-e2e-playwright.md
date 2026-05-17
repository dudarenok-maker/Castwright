---
status: active
shipped: null
owner: null
---

# Playwright e2e harness

> Status: KNOWN: scaffolded — one golden-path smoke test in place; broader coverage and visual-regression baselines deferred.
> Key files: `playwright.config.ts`, `e2e/smoke.spec.ts`, `.env.test`, `package.json` (`test:e2e` script).
> URL surface: covers `#/` and `#/new`; widens as new specs land.
> OpenAPI ops: none — runs against `VITE_USE_MOCKS=true`, so the mock API in `src/lib/api.ts` is the contract under test.

## Benefit / Rationale

- **User:** First regression net that exercises the app exactly as a user does — real router, real timers, real layout. Catches the class of bug where Vitest+jsdom passes but the browser is wedged (route hydration, focus management, layout-dependent visibility).
- **Technical:** Adds a third harness alongside Vitest frontend + Vitest server. Same `VITE_USE_MOCKS=true` flag the unit tests use, so no separate fixture surface to maintain.
- **Architectural:** Locks in a stable seam (`baseURL` + mock mode + dev server on port 5174) that future tests extend, instead of one-off scripts. Establishes the visual-regression on-ramp: Playwright's built-in `toHaveScreenshot()` is now one config flip away.

## Architectural impact

- **New seams added:**
  - `e2e/` directory — Playwright spec home. Not in `tsconfig.json` `include`, so excluded from `npm run typecheck` (Playwright handles its own ts compilation).
  - `.env.test` — Vite mode file (`--mode test`) that flips mocks on without disturbing `.env.development` (which targets the real backend).
  - `npm run test:e2e` — single entry point, runs Playwright with the config above.
  - Port 5174 — Playwright's dev server pins to a non-default port so a running `npm run dev` (5173) does not block test runs.
- **Invariants preserved:**
  - [00 — Stage machine](00-stage-machine.md) — smoke test asserts `#/new` after the "Start a new book" click, exactly the URL grammar `01-hash-router.md` documents.
  - [23 — Mock toggle](23-mock-toggle.md) — e2e runs under `VITE_USE_MOCKS=true`, never imports real backend code.
- **Reversibility:** Removing the harness is `git rm -r e2e playwright.config.ts .env.test` plus deleting `test:e2e` from `package.json`. No application code touches Playwright.
- **Migration story:** None — additive scaffold.

## Invariants to preserve

- `playwright.config.ts` `webServer.url` MUST match `use.baseURL` (both `http://127.0.0.1:5174`). Drift = Playwright hangs waiting for a server that never appears on the URL it polls.
- `webServer.command` MUST include `--mode test` so Vite loads `.env.test`. Without it, the test runs against the real backend (which is not booted in CI) and every API call 502s.
- `e2e/` stays out of `tsconfig.json` `include`. If a spec needs a project type, import from `src/lib/types.ts` via relative path — do not widen `include` (would pull e2e specs into the production `tsc -b` build).
- One worker locally, one worker on CI — `playwright.config.ts` `workers: process.env.CI ? 1 : undefined`. Mocks are in-memory per-page so parallelism is safe in principle, but we keep CI deterministic until concurrency-specific tests exist.

## Test plan

### Automated coverage

- **Playwright e2e** (`e2e/smoke.spec.ts`) — asserts cold boot lands on the library, the "Start a new book" CTA is visible, the hash is one of `''`/`'#'`/`'#/'`, and clicking the CTA navigates to `#/new`. Runs in chromium under `VITE_USE_MOCKS=true`.
- **Playwright e2e** (`e2e/new-book-flow.spec.ts`) — walks cold boot → "Start a new book" → paste manuscript → fill author → submit → analysing route → click "Start analysis" → wait for the mock SSE (~7.6 s) to land confirm → click "Confirm cast and review manuscript" → assert URL on the ready/manuscript stage. End-to-end check of the upload pipeline and the four stage transitions. Wall-clock ~13 s warm.
- **Playwright e2e** (`e2e/listen-playback.spec.ts`) — navigates directly to `#/books/sb/listen` for the seeded 'complete' Solway Bay mock book, clicks "Play from the start", asserts the MiniPlayer's `<audio>` element renders with a `stub-b.mp3` src and `paused === false`. Locks the mock-seed → chapter hydrate → MiniPlayer mount → audio playback seam. Wall-clock ~5 s warm. Depends on the `MOCK_BOOK_STATES['sb']` seed in `src/lib/api.ts` (shipped alongside).
- **Playwright e2e** (`e2e/visual.spec.ts`) — captures `toHaveScreenshot()` baselines for the six core surfaces (library, upload, analysing-pre-start, confirm, ready/manuscript, listen). First defence against silent CSS-token / Tailwind / icon-set drift. See "Visual baselines" below.

### Visual baselines

- **Storage:** per-platform under `e2e/visual.spec.ts-snapshots/{platform}/visual.spec.ts/<name>.png`. `{platform}` resolves to `win32` | `linux` | `darwin` via `process.platform`. Wired via `snapshotPathTemplate: '{snapshotDir}/{platform}/{testFilePath}/{arg}{ext}'` in `playwright.config.ts`. Per-platform was chosen over a single committed set because chromium font rendering and sub-pixel layout drift between OSes (and CI will land on Linux per Could #1 in `docs/BACKLOG.md`).
- **Stability knobs:** `animations: 'disabled'` and `maxDiffPixelRatio: 0.01` in the global `expect.toHaveScreenshot` config. Animations:'disabled' freezes CSS transitions + animations at their final frame for capture. The 1% pixel ratio absorbs minor font hinting noise without masking real visual regressions.
- **The analysing baseline captures the pre-Start state**, not mid-stream. The streaming UI's phase-progress percent is React state (not CSS animation) so animations:'disabled' wouldn't make it deterministic. The pre-Start state still exercises the analysing-view layout — model picker, Start button, header — which is the layout under regression test.
- **Regenerate workflow:** intentional visual changes (token tweaks, layout edits, new icons) require regenerating baselines. Run `npm run test:e2e -- --update-snapshots visual.spec.ts`, review the new PNGs in `git diff`, and commit alongside the source change. Reviewers see both deltas in one PR.
- **Invariant:** any change that touches `src/styles.css`, `tailwind.config.ts`, an icon under `src/lib/icons.tsx`, or layout JSX in the six baselined surfaces SHOULD regenerate baselines in the same commit. Drift caught by a later unrelated PR muddies blame.

### Manual acceptance walkthrough

Run from a clean checkout:

1. `npm install` — pulls `@playwright/test`.
2. `npx playwright install chromium` — one-time browser download (~100 MB).
3. `npm run test:e2e` — expect one passing spec (`golden path › cold boot lands on books library …`) in ~30 s on a warm cache.
4. Kill the test mid-run with Ctrl-C — webServer process should exit cleanly; no stray vite on port 5174 (verify with `Get-NetTCPConnection -LocalPort 5174` or `netstat -ano | findstr 5174`).
5. Open `playwright-report/index.html` after a deliberate failure (edit the spec to expect `#/nope`, rerun) — confirm the trace viewer renders.

## Commit gate wiring

- **pre-commit** (`npm run verify:fast`): does NOT run e2e. Frontend + server unit tests only.
- **pre-push** (`npm run verify`): typecheck + `test:all` + `test:e2e` + build. Playwright runs here.
- Rationale: e2e is ~30 s warm / ~60 s cold; sidecar pytest + Pester scripts already moved to pre-push (see CLAUDE.md "Commit gate"). Keeping pre-commit at ~5 s preserves the "commit frequently, push deliberately" workflow.

## Out of scope (follow-ups)

- **More golden paths.** Voice library tab. Each gets its own spec, all reuse the mock backend. (Upload → analysing → confirm → ready *shipped 2026-05-17 as `e2e/new-book-flow.spec.ts`*; Listen-view playback *shipped 2026-05-17 as `e2e/listen-playback.spec.ts` with the `MOCK_BOOK_STATES['sb']` seed*; Visual baselines *shipped 2026-05-17 as `e2e/visual.spec.ts` covering six core surfaces*.)
- **CI integration.** No CI runs anything yet. When CI exists, `test:e2e` is the slowest job; budget accordingly.

## Ship notes

_(Empty — plan is `active`, not `stable`. Filled in when broader coverage lands and the harness leaves "scaffolded" territory.)_
