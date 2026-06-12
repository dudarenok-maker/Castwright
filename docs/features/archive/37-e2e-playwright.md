---
status: stable
shipped: 2026-05-18
owner: null
---

# Playwright e2e harness

> Key files: `playwright.config.ts`, `e2e/*.spec.ts` (14 specs at ship), `.env.test`, `package.json` (`test:e2e` script).
> URL surface: covers cold boot, `#/new`, `#/books/:id/{analysing,confirm,ready/*,listen,library}`, `#/voices`, `#/account`; widens as new specs land.
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
- **Playwright e2e** (`e2e/responsive/visual.spec.ts`) — captures `toHaveScreenshot()` baselines for the seven core surfaces (library, upload, analysing-pre-start, confirm, ready/manuscript, listen, generate) × light + dark theme × three Playwright projects (chromium / mobile-chrome / tablet-chrome). First defence against silent CSS-token / Tailwind / icon-set drift. Relocated from `e2e/visual.spec.ts` on 2026-05-22 (BACKLOG Could #34). See "Visual baselines" below.

### Test hooks (DEV + e2e only)

- **`window.__store__`** — the Redux store is exposed on `window` in `import.meta.env.DEV` builds (`npm run dev` on port 5173) and in `--mode e2e` builds (Playwright on port 5174). Gated in `src/main.tsx`; never set in production builds (`vite build`) because the gate tree-shakes. Use it in specs as:

  ```ts
  await page.evaluate(() => window.__store__!.getState().ui.stage.kind);
  ```

  Don't add untyped writes to the store from specs — assertions only. The spec helper `getStageKind(page)` in `e2e/new-book-flow.spec.ts` is the canonical read pattern.

- **What this enables:** per-stage Redux assertions on top of URL/visibility checks (catches the class of bug where `ui.stage` desyncs from the URL or the visible view) and refresh-restores-stage assertions that exercise the redux-persist whitelist (`UI_PERSIST_WHITELIST` in `src/store/index.ts`). Deleting `ui` from that whitelist would now fail the `new-book-flow` refresh assertion.

### Visual baselines

- **Storage:** per-platform AND per-project under `e2e/{platform}/responsive/visual.spec.ts/{projectName}/<name>.png`. `{platform}` resolves to `win32` | `linux` | `darwin` via `process.platform`. `{projectName}` resolves to `chromium` | `mobile-chrome` | `tablet-chrome`. Wired via `snapshotPathTemplate: '{snapshotDir}/{platform}/{testFilePath}/{projectName}/{arg}{ext}'` in `playwright.config.ts`. Per-platform was chosen over a single committed set because chromium font rendering and sub-pixel layout drift between OSes. Per-project was added 2026-05-22 (BACKLOG Should #4) so mobile-chrome (Pixel 7) and tablet-chrome (iPad Pro 11) viewports can't compete against the desktop chromium baseline.
- **Stability knobs:** `animations: 'disabled'` and `maxDiffPixelRatio: 0.01` in the global `expect.toHaveScreenshot` config. Animations:'disabled' freezes CSS transitions + animations at their final frame for capture. The 1% pixel ratio absorbs minor font hinting noise without masking real visual regressions.
- **Spec location:** `e2e/responsive/visual.spec.ts` since 2026-05-22 (BACKLOG Could #34 — moved from `e2e/visual.spec.ts` so the existing `testMatch: /responsive[\\/].*\.spec\.ts$/` glob picks it up at all three Playwright projects, not just chromium). The file has `test.describe.configure({ mode: 'serial' })` at both describe blocks so the 14 baselines per project never race the other 80+ specs locally.
- **Verify step:** visuals run in a dedicated `verify:visual` step via `scripts/verify-cache.mjs` STEPS array (chromium-only, `--workers=1`). The main `test:e2e` battery now skips visuals via `--grep-invert="visual baselines"` so the parallel run can't contribute drift. Direct invocation: `npm run test:e2e:visual`.
- **The analysing baseline captures the pre-Start state**, not mid-stream. The streaming UI's phase-progress percent is React state (not CSS animation) so animations:'disabled' wouldn't make it deterministic. The pre-Start state still exercises the analysing-view layout — model picker, Start button, header — which is the layout under regression test.
- **Regenerate workflow:** intentional visual changes (token tweaks, layout edits, new icons) require regenerating baselines. Run `npm run verify:visual -- --update-snapshots` for chromium, or `npx playwright test --project=mobile-chrome --project=tablet-chrome --update-snapshots e2e/responsive/visual.spec.ts` for mobile/tablet. Review the new PNGs in `git diff` and commit alongside the source change. Reviewers see both deltas in one PR.
- **Invariant:** any change that touches `src/styles.css`, `tailwind.config.ts`, an icon under `src/lib/icons.tsx`, or layout JSX in the seven baselined surfaces SHOULD regenerate baselines in the same commit. Drift caught by a later unrelated PR muddies blame.
- **Self-hosted webfonts (2026-06-12, #698):** webfonts (General Sans + Lora) are self-hosted in `public/fonts/` (woff2, generated by `scripts/fetch-self-hosted-fonts.mjs`) — `index.html` no longer links `api.fontshare.com` / `fonts.googleapis.com`. The external `<link rel="stylesheet">` font tags gated `page.goto()`'s `load` event; under parallel-worker contention a slow CDN pushed `goto` past its 60 s budget and flaked about-page / admin / visual specs, forcing `--no-verify` pushes. Proven causally by a spike: `goto` took ~28 s with a slow external font vs ~1 s without. Regression net: `e2e/self-hosted-fonts.spec.ts` (zero external font requests at runtime) + `src/index-html-fonts.test.ts` (fast-tier static guard). JetBrains Mono was never actually served (Fontshare ignores the family) so `--font-mono` still falls back to system mono — not self-hosted, no visual change.
- **Parallel cold-start herd (2026-06-12, #698):** the *second* cause of the same flake. In dev, Vite serves ~300 unbundled `/src` ES modules per page; when the parallel battery boots, N Chromium workers cold-load the SPA at once, oversubscribe CPU + the single-threaded dev server, and the first specs (alphabetically about/admin) stall waiting for `load`. Two levers, both in `playwright.config.ts`: (1) a **`warmup` setup project** (`e2e/warmup.setup.ts`) that loads the app + every lazy route once before `chromium` (via `dependencies: ['warmup']`), warming the server transform cache; (2) **`workers: 4`** locally (was unbounded ≈ cpus/2), bounding the cold-load herd. CI stays at `workers: 1` (no herd) and the warm-up self-skips there. Validated clean: 177 passed / 0 flaky on a 16-core box (down from 8 hard failures).
- **Browser-leak teardown (2026-06-12, #698):** on Windows, Playwright's bundled `headless_shell` + children orphan after a run (~52/run measured), accumulating until they contaminate later runs. `e2e/global-teardown.ts` sweeps **only** `ms-playwright`-path processes after each run (never the real Chrome); Windows-only, opt out via `PLAYWRIGHT_NO_BROWSER_SWEEP=1`.
- **Per-platform skip (2026-05-19, broadened 2026-05-22):** `e2e/responsive/visual.spec.ts` calls `test.skip` at each describe block when `e2e/<process.platform>/responsive/visual.spec.ts/` doesn't exist. Only `e2e/win32/responsive/visual.spec.ts/` is committed today, so PR CI on `ubuntu-latest` skips all 14 specs per project rather than fail with "snapshot doesn't exist, writing actual". The check is directory-level — committing a single PNG re-enables the whole spec for that platform automatically. Tracking landing Linux baselines as Should #1 in `docs/BACKLOG.md`.

### Regenerate baselines (workflow_dispatch)

- **Workflow:** `.github/workflows/regen-visual-baselines.yml` — `workflow_dispatch`-triggered GitHub Action that regenerates the Linux baseline tree on `ubuntu-latest` without needing a Linux box on the dev side. The workflow fans out across the three Playwright projects (chromium / mobile-chrome / tablet-chrome) in a `fail-fast: false` matrix so a flake in one leg doesn't kill the other two.
- **Invocation:** `gh workflow run regen-visual-baselines.yml --ref main` from any dev box that has the `gh` CLI authenticated against the repo.
- **What lands:** each matrix leg writes `e2e/linux/responsive/visual.spec.ts/<project>/*.png` (14 per project, 42 total) via Playwright's `--update-snapshots` + the snapshot path template in `playwright.config.ts:47`. A consolidation job downloads all three artifacts back into the working tree, commits them on a fresh `ci/linux-visual-baselines-regen-<run-number>` branch, pushes via `${{ secrets.GITHUB_TOKEN }}`, and opens a PR titled `ci(e2e): regenerate Linux visual baselines (run #N)` against `main`.
- **Review path:** reviewer merges the auto-PR; the directory-level skip at `e2e/responsive/visual.spec.ts:85` un-skips the Linux visual specs automatically the moment `e2e/linux/responsive/visual.spec.ts/` exists in the merged tree. From the next PR Verify run onward, the visual battery reports `42 passed` instead of `42 skipped`.
- **When to re-run:** any time an upstream chromium bump causes Linux drift (font hinting changes, system-font path swaps on the runner image), or when a deliberate visual change lands and the Linux baselines need to follow the Windows ones in the same diff. Cheaper than maintaining WSL/Docker on every dev box.

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

- **CI integration.** No CI runs anything yet. When CI exists, `test:e2e` is the slowest job; budget accordingly. Tracked as `[BACKLOG Could #18]`.

## Ship notes

- **Shipped:** 2026-05-18.
- **Final coverage:** 14 specs / 30 tests at archive. The harness has grown organically as features shipped (theme toggle, toast surface, listen resume, manual continuity link, revision diff, voices compare, bulk sync, cover framing) — each new feature lands a paired spec under `e2e/`. The two scaffolded follow-ups documented when the harness landed are now closed: (a) **Voice library tab + cast/profile-drawer goldens** — added `e2e/voices.spec.ts` (pin/unpin round-trip on the global `#/voices` tab) and `e2e/cast-drawer.spec.ts` (drive to confirm-stage, click character → drawer opens with evidence "+ Show 1 more" toggle round-trip), both passing in <20 s warm. The earlier-shipped `e2e/voices-compare.spec.ts` (plan 22a) already covered the Compare selection seam, so the new specs target the *other* user actions on the same views.
- **Quarantined:** two specs carry `test.fixme` markers for parallel-worker contention on Windows — `e2e/listen-playback.spec.ts:15` and `e2e/new-book-flow.spec.ts:32`. Both pass in isolation; tracked as `[BACKLOG Could #20]`.
- **Visual baselines** since 2026-05-22 live under `e2e/{platform}/responsive/visual.spec.ts/{projectName}/<name>.png` (was `e2e/{platform}/visual.spec.ts/<name>.png` until BACKLOG Could #34 / Should #4 added per-project per-platform layout). The regenerate workflow above stays the canonical contract for intentional visual deltas; visuals now run in a dedicated `verify:visual` step (chromium, `--workers=1`).

## Reliability addendum (2026-05-22)

Post-plan-89 the suite started showing local-only first-mount flakes: two consecutive `npm run verify` runs on a Windows dev box failed with different specs flaking each time (`account-analyzer-knobs`, `account-models`, `bulk-sync-library`, `binary-upload`), each timing out at the `{ timeout: 10_000 }` `toBeVisible()` while the route-level Suspense `Loading…` fallback was still painting. CI on Ubuntu stayed green 80/80 because it's locked to `workers: 1` (`playwright.config.ts:37`). Root cause: plan 89 C5's `React.lazy` route code-split makes first-paint sensitive to dev-server contention — under ~CPU/2 parallel workers, the lazy-chunk request queues behind other workers' fetches long enough to bust the 10 s budget.

Three coupled fixes landed (PR `fix/e2e-and-mobile-workers`):

1. **`waitForRouteReady(page)` helper** (`e2e/helpers.ts:71-75`) — waits for the `route-suspense-fallback` testid to detach (15 s budget). Already shipped alongside plan 89's `route-lazy.spec.ts`; now applied to every `page.goto(...)` in the four cited flaky specs.
2. **Default `expect.timeout` bumped 5 s → 15 s** (`playwright.config.ts`). Affects every assertion that doesn't pass an explicit timeout. CI's `workers: 1` makes the bump a no-op there; locally it's the safety margin.
3. **Explicit `{ timeout: 10_000 }` overrides removed** from the first-mount visibility assertions in the four flaky specs. Non-first-mount overrides (state-machine progress waits, "Saved." flash hidden, URL transitions) stay explicit.

**When to use `waitForRouteReady`**: any new spec whose first action is `page.goto(...)` followed by `expect(...testid...).toBeVisible()`. The helper is opt-in (not a fixture), so existing specs that don't navigate into a lazy route stay untouched.

**Mobile suite worker cap** — `npm run test:e2e:mobile` now passes `--workers=2` (`package.json:32`) instead of inheriting the default `~CPU/2`. Running 3 Playwright projects (`chromium` + `mobile-chrome` + `tablet-chrome`) at default parallelism exhausted process slots on the dev box and tripped `browserType.launch: Timeout 180000ms exceeded` on mobile/tablet specs (3 hard, 7 flaky on retry pre-fix). Playwright `^1.60.0` doesn't expose a per-project `workers` field — CLI `--workers=N` is the supported override. If 2 workers still proves flaky under repeat runs, the next escalation is `--workers=1`.
