---
status: stable
shipped: 2026-06-02
owner: null
---

# 167 — Frontend React-cluster + TypeScript major upgrade (fe-19 / ops-10 / fe-18 / fe-21)

> Status: stable (shipped 2026-06-02 via PR #454, merge `8793214`)
> NOTE: plan number 167 collides with `archive/167-coqui-in-app-installer.md`
> (a parallel session, PR #450). Both kept per the repo's collision policy —
> disambiguate by slug. See INDEX.md "Plan-number collisions".
> Key files: `package.json`, `server/package.json`, `vite.config.ts`,
> `vitest.config.ts`, `server/vitest.config.ts`, `server/vitest.config.slow.ts`,
> `src/store/index.ts`
> URL surface: none (toolchain/runtime bump)
> OpenAPI ops: none
> Closes: #403 (fe-19), #404 (ops-10), #407 (fe-18), #408 (fe-21)

## Benefit / Rationale

The core frontend toolchain was two majors behind and React/router/TypeScript one
major behind. Plan 164 filed these as research-complete BACKLOG items and deferred
them; this round executes them as one branch.

- **User:** none — zero behaviour change; the existing test battery is the regression net.
- **Technical:** back on supported tooling/runtime lines. Vite 8 (Rolldown + Oxc)
  builds the production bundle in **~1.8s** (was multi-second). Vitest 4, TS 6,
  React 19, react-router 7 all current.
- **Architectural:** unblocks React-19-only ecosystem deps; keeps RTK/react-redux
  on a supported line.

## What shipped (4 stages, one branch)

Targets moved past plan 164's research — the latest majors at execution time were
Vite **8** (Rolldown) / Vitest **4** / plugin-react **6**, chosen over the
conservative Vite 7 / Vitest 3.

1. **fe-19** — `vite ^5.2 → ^8`, `vitest ^2.1.9 → ^4.1.8` (root + `server/`),
   `@vitejs/plugin-react ^4.3 → ^6.0.2`.
2. **ops-10** — `typescript ^5.9 → ^6` (root + `server/`). `typescript-eslint ^8`
   already supports TS 6 (peer `>=4.8.4 <6.1.0`), no bump.
3. **fe-18 + fe-21 (coupled, one commit)** — `react`/`react-dom ^18.3.1 → ^19`,
   `@types/react(-dom) → ^19`, `react-redux ^9.1 → ^9.2`, `@reduxjs/toolkit
   ^2.2 → ^2.5`, `react-router-dom ^6.26 → ^7`.

## Architectural impact / decisions

- **`manualChunks` → `advancedChunks` (Vite 8 / Rolldown).** The function-form
  `manualChunks` (Plan-89-C5 react/vendor split) is deprecated under Rolldown.
  Migrated to `build.rollupOptions.output.advancedChunks.groups` — ordered
  first-match-wins: a `react` group (same node_modules paths the old predicate
  matched) then a `vendor` catch-all. Verified `dist/assets/` still emits one
  `react` chunk + one `vendor` chunk.
- **Vitest 4 removed `poolOptions`.** `maxThreads`/`maxForks` → top-level
  `maxWorkers`; `minWorkers` dropped. Migrated all three vitest configs;
  `pool: 'forks'` and the `SLOW_FILES ↔ exclude` mirror invariant preserved.
- **Vitest 4 `vi.fn()` typing.** `vi.fn()` is now `Mock<Procedure | Constructable>`
  (constructors supported) and no longer assigns to a specific function prop/param.
  Affected mocks pinned via the component's / function's own signature
  (`ComponentProps` / `Parameters`-derived) in 4 test files.
- **Vitest 4 unhandled-error strictness.** Vitest 4 now FAILS a run on a
  post-teardown unhandled rejection that Vitest 2 swallowed. `layout.tsx`'s
  route-prefetch (`importUploadView`/`importGenerationView`) fired async imports
  that outlived the jsdom env in `layout.test.tsx` → mocked `../routes/prefetch`
  there (only that spec mounts the real `Layout`).
- **TS 6 + `openapi-typescript`.** `openapi-typescript` 7.x still peers
  `typescript ^5.x`, blocking a clean install under TS 6 (it runs fine and
  reproduces `api-types.ts` byte-for-byte). Pinned its peer via npm `overrides`
  (`openapi-typescript.typescript = $typescript`).
- **redux-persist storage under Rolldown.** `import storage from
  'redux-persist/lib/storage'` (CJS default) is left wrapped as a namespace by
  Vite 8 / Rolldown interop → `storage.getItem is not a function` at rehydrate,
  breaking app boot (dev + prod). Switched to the ESM build
  (`redux-persist/es/storage`). **Bundler-specific** — vitest's transform unwraps
  the CJS default fine, so a unit test passes both before and after; the **e2e
  app-boot is the only regression net** for it.
- **fe-18 ↔ fe-21 coupling.** react-router-dom **6.26 is not React-19-compatible**:
  `navigate()` from the Layout stage→URL effect is dropped under React 19's
  rendering, so a view-tab switch stopped pushing the URL
  (`generation-resume.spec.ts`). Bisect: React 18 + Vite 8 PASSES, React 19 FAILS.
  react-router 7 (which officially supports React 19) fixes it with **zero code
  changes**. So fe-18 + fe-21 ship as one atomic commit. An app-side workaround
  (live-stage read in the nav effect) did NOT help and was reverted.

## Invariants to preserve

- `build.rollupOptions.output.advancedChunks.groups` in `vite.config.ts` keeps the
  `react` group ordered BEFORE the `vendor` catch-all (first-match-wins), so the
  react/redux runtime stays one chunk (Plan-89-C5 circular-chunk-graph guarantee).
- `SLOW_FILES` in `server/vitest.config.slow.ts` ↔ `test.exclude` in
  `server/vitest.config.ts` stay mirrored (no double-run / no missed file).
- Server `@types/node` stays pinned at major 20 (plan 164 Node-20.6-floor invariant)
  — TS 6 / Vitest 4 did not force a bump.
- `redux-persist` storage import stays on the **ESM** path (`es/storage`) so the
  default export unwraps under Rolldown.

## Test plan / Automated coverage

No new behavioural test — a deps round with zero new user surface; CLAUDE.md's
refactor rule makes the existing battery the regression net. The Playwright e2e
specs already exercise the router/redux/layout seams these majors stress (and
caught both the redux-persist boot break and the router-6/React-19 navigation
break — neither reproducible in vitest/jsdom). Adding a new spec would be coverage
theatre.

Gate (all green on `build/frontend-react-cluster-upgrade`):

- `npm run typecheck` (frontend + server)
- `npm run lint`
- `npm run test` — 2141 frontend
- `npm run test:server` — 1718, `npm run test:server-slow` — 170
- `npm run build` (Vite 8 + advancedChunks; react + vendor chunks intact)
- `npm run test:e2e` — 125 passed
- `npm run test:e2e:visual` — 14 passed after re-baking the **stale** `library`
  baseline (it predated the 2026-06-01 language-UX feature `a4e0ec2`, failing on
  main too; only `library.png` changed — the upgrade added no win32 visual drift).
  Linux baselines regenerated via the CI regen workflow.

## Ship notes

- **Shipped 2026-06-02** via PR #454 (merge commit `8793214`), closing
  #403 / #404 / #407 / #408. CI `npm run verify` green (15m42s); rebased onto
  `main` @ #453 before merge and re-verified (frontend 2170, server 1743, e2e 127).
- fe-18 and fe-21 landed as one atomic commit — react-router 6.26 is not
  React-19-compatible (`navigate()` from the Layout stage→URL effect is dropped),
  router 7 fixes it with zero code changes.
- Win32 `library` visual baseline re-baked in the PR (stale on `main` since the
  2026-06-01 language-UX feature `a4e0ec2`). Linux baselines regenerated post-merge
  via `regen-visual-baselines.yml` (which itself needed a `--no-verify` push fix —
  same PR series — because its pre-push hook required ffmpeg the runner lacks).
