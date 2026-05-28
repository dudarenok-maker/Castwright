---
status: active
shipped: null
owner: null
---

# Build version footer

> Status: active
> Key files: `vite.config.ts`, `src/lib/build-info.ts`, `src/components/build-stamp.tsx`, `src/components/layout.tsx`, `src/vite-env.d.ts`
> URL surface: none — renders in the app shell on every stage
> OpenAPI ops: none

## Benefit / Rationale

- **User:** every page carries a small footer stating which release is running. In a production build it reads `v1.4.0 (a1b2c3d)` — clean, presentable, and enough to quote in a bug report.
- **Technical:** answers "which commit is this build?" in-app while debugging. The dev build is verbose — `v1.4.0 · a1b2c3d* · fix/foo · 14:32` (version · short-SHA, `*` = dirty working tree · branch · build time) — so a developer can tell at a glance whether the running bundle includes their latest commit and whether the tree was dirty when it was built.
- **Architectural:** introduces a build-time `define` seam (five injected constants) plus a pure, dependency-free formatter. Any future "about" / diagnostics surface can reuse `buildInfo` + `formatBuildStamp` instead of re-deriving provenance.

## Architectural impact

- **New seams / extension points:** `vite.config.ts` now injects `__APP_VERSION__` / `__GIT_SHA__` / `__GIT_BRANCH__` / `__GIT_DIRTY__` / `__BUILD_TIME__` via `define`. `src/lib/build-info.ts` exposes the typed `buildInfo` object and the pure `formatBuildStamp(info, { dev })`.
- **Invariants preserved:** design tokens only — the footer uses `text-ink/55`, no hex literals (plan 25). The `ui.stage` machine is untouched; the footer is shell-level chrome, not a route leaf, so it renders uniformly across `books | upload | analysing | confirm | ready` without any stage logic. Mocks toggle (plan 23) is unaffected.
- **Migration story:** none — no persisted data shape changes.
- **Reversibility:** delete the `<BuildStamp/>` mount + the `define` block and the feature is gone; `build-info.ts` becomes inert (it already tolerates undefined globals).

## Invariants to preserve

1. Every value in the `vite.config.ts` `define` block must be `JSON.stringify`'d — including the `__GIT_DIRTY__` boolean (`JSON.stringify(true)` → the literal `true`). A bare string `"false"` would be truthy and break the dirty marker. Ambient type in `src/vite-env.d.ts` is `declare const __GIT_DIRTY__: boolean`.
2. `src/lib/build-info.ts` must read every injected global behind a `typeof X !== 'undefined'` guard. Vitest runs with its own config and NO `define`, so the globals are undefined there; without the guard, importing the module (and therefore the footer component, and therefore `layout.tsx`) would `ReferenceError` at load.
3. `formatBuildStamp` stays pure — no `import.meta`, no globals — so it is unit-testable with plain fixtures. The `import.meta.env.DEV` read lives only in `build-stamp.tsx`.
4. `<BuildStamp/>` is the last **in-flow** child of the shell `<div>` in `layout.tsx`, rendered right after the `<Outlet>` Suspense and before the fixed overlays (`ToastStack`, `MiniPlayer`). The root's `pb-20`/`pb-24` already reserves space for the fixed `MiniPlayer`, so the footer is never occluded in the `ready` stage.
5. A single top-level `<footer aria-label="Build version">` is the page's only `contentinfo` landmark — keeps axe (`test:a11y`) landmark-uniqueness happy and names the otherwise-cryptic stamp.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/build-info.test.ts`) — `formatBuildStamp` dev-clean / dev-dirty (the `*` marker) / empty-buildTime (no dangling separator) / prod-minimal shapes; plus a `buildInfo` test asserting the import doesn't throw and exposes the sentinel fallbacks under Vitest (locks invariant 2).
- Vitest component (`src/components/build-stamp.test.tsx`) — the footer renders with the `build-stamp` testid + a named `contentinfo` landmark, and shows a version-shaped, `·`-joined stamp in dev.
- Playwright e2e (`e2e/build-stamp.spec.ts`) — on the cold-boot books library the footer is visible and contains `v1.4.0` + `·`. The e2e webServer runs `vite --mode e2e` (a dev server → `import.meta.env.DEV === true`), so the verbose path renders; SHA/branch/time are not asserted (they vary per checkout/CI).

### Manual acceptance walkthrough

Run in mock mode (`npm run dev`).

1. **Cold boot at `#/`** → stage `{ kind: 'books' }`, library cards visible; footer at the bottom of content reads `v1.4.0 · <sha>[*] · <branch> · <HH:MM>`.
2. **Open a book and play a chapter** (`ready` stage) → the fixed MiniPlayer appears at the very bottom; scroll to the end of content and confirm the footer is present above the player's reserved gap, not hidden behind it.
3. **Production build** (`npm run build && npm run preview`) → footer collapses to `v1.4.0 (<sha>)`.

Note: on the dev server the SHA/branch/dirty/time are captured at vite-start. Commit while `npm run dev` is running and the footer keeps the old values until Vite restarts (HMR does not re-run the config). `vite build` is always fresh.

## Out of scope

- A clickable / copy-to-clipboard / GitHub-commit-link footer.
- A dedicated server-side version endpoint or runtime client/server version-mismatch detection. The repo SHA already covers both halves — frontend and server build from one tree.

## Ship notes

(Filled in when status flips to `stable`.)
