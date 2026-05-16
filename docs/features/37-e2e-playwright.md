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

- **Visual regression baselines.** Playwright supports `toHaveScreenshot()` natively. Capture baselines for the library, upload, analysing, confirm, and ready stages once they stabilise. Open question: where do baselines live (`e2e/__screenshots__/` per-platform vs. committed-as-art) — capture in a follow-up plan when the first baseline lands.
- **More golden paths.** Upload → analysing → confirm → ready. Listen-view playback (mock player). Voice library tab. Each gets its own spec, all reuse the mock backend.
- **CI integration.** No CI runs anything yet. When CI exists, `test:e2e` is the slowest job; budget accordingly.

## Ship notes

_(Empty — plan is `active`, not `stable`. Filled in when broader coverage lands and the harness leaves "scaffolded" territory.)_
