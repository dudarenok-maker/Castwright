---
status: stable
shipped: 2026-07-27
owner: null
---

# react-router 8 + Node 22.22 floor

> Status: stable
> Key files: `package.json`, `src/main.tsx`, `src/routes/index.tsx`, `src/lib/router.ts` (unchanged — the point), `INSTALL.md`, `docs/wiki/Installing-Castwright.md`
> URL surface: unchanged — see `docs/features/archive/01-hash-router.md`
> OpenAPI ops: none

## Benefit / Rationale

- **User:** none directly, except one deployer-visible prerequisite change — the
  minimum supported Node moves from 20.19 to **22.22**. An operator on Node 20 or
  21 must upgrade before installing. Node 20 reached EOL in April 2026 and 22 is
  the active LTS, so the floor was overdue independent of the router.
- **Technical:** `react-router-dom` is a **dead package** — v8 folded the DOM
  APIs back into `react-router` and `react-router-dom` is frozen at 7.18.1
  permanently. Every day on v7 accrued a migration that only got more expensive
  as more files imported it. Removes the recurring Dependabot nag on the router.
- **Architectural:** proves the `RouterStore` adapter seam actually holds. The
  router major version moved underneath the app and `src/lib/router.ts` needed
  **zero** changes — the hash grammar is decoupled from the routing library, as
  designed. That is the invariant this plan exists to demonstrate, not just to
  preserve.

## Architectural impact

- **New seams:** none. This is a dependency migration, not a design change.
- **Invariants preserved:** the hash-router grammar (plan 01) and the
  discriminated-union `ui.stage` (`src/store/ui-slice.ts`) are both untouched.
  `src/lib/router.ts` has a zero-line diff across the whole change.
- **Migration story:** no persisted data shape changes. `state.json`,
  `cast.json` and `openapi.yaml` are untouched. localStorage/redux-persist
  blobs are unaffected — the router never owned them.
- **Reversibility:** revert the PR. The only non-code fallout is the advertised
  Node floor in `INSTALL.md` + `docs/wiki/Installing-Castwright.md`, which
  reverts with it. No user data is migrated, so there is no one-way door.

## The import split — the part that does not typecheck

This is the single trap in the upgrade, and the reason this plan exists rather
than the issue body being sufficient.

v8 did **not** simply rename `react-router-dom` → `react-router`. The DOM APIs
live at **`react-router/dom`**, and `RouterProvider` is one of them (with
`HydratedRouter`). From the v8.0.0 release notes:

> In v7, we collapsed the DOM APIs into `react-router/dom`, but to ease the
> v6->v7 upgrade we continued re-exporting everything through
> `react-router-dom`. We have now dropped `react-router-dom`.

`react-router/dom`'s `RouterProvider` is a thin wrapper that supplies
`flushSync: ReactDOM.flushSync` over the base one
(`node_modules/react-router/dist/development/lib/dom-export/dom-router-provider.js`).

**Both modules export a component named `RouterProvider`.** Importing the wrong
one compiles cleanly and passes `tsc --noEmit` — it only breaks at runtime. A
migration guided by "rewrite every `react-router-dom` import to `react-router`"
(which is what issue #1859 originally instructed) would have shipped past
typecheck and broken the app's sole mount point.

Everything else the app uses — `createHashRouter`, `Navigate`, `Outlet`,
`Link`, `MemoryRouter`, `Routes`, `Route`, `useLocation`, `useNavigate`,
`useParams`, `useSearchParams`, `useOutletContext` — is re-exported unchanged
from the root package.

## Invariants to preserve

1. `src/main.tsx:6` imports `RouterProvider` from **`react-router/dom`**, not
   `react-router`. Pinned by `src/main.test.tsx`; see the note above for why
   typecheck cannot catch this.
2. `src/lib/router.ts` stays free of any `react-router` import — the pure
   `parseHash`/`stageToHash` grammar is decoupled from the routing library via
   the `RouterStore` adapter. A router upgrade must not need to touch it.
3. The `#/…` URL grammar is byte-identical across the upgrade. Pinned by
   `src/lib/router.test.ts` (43 assertions) plus every literal hash assertion
   in the e2e suite.
4. `package.json` declares `react`/`react-dom` at `^19.2.7` or higher —
   react-router 8.3.0's peer floor. The previous `^19.0.0` range permitted
   resolving 19.0.0, which v8 rejects, so the range itself was the defect.
5. `package.json` `engines.node` is `>=22.22.0`, and every advertised
   prerequisite agrees with it (see "Node floor sites" below).

## Node floor sites

The floor is advertised in four places that are **not** generated from each
other and must be changed together:

| Site | Note |
|---|---|
| `package.json` `engines.node` | the machine-checkable one |
| `INSTALL.md` line 11 | deployer-facing prerequisites |
| `docs/wiki/Installing-Castwright.md` line 25 | hand-maintained mirror of INSTALL.md, synced to the GitHub wiki by `scripts/sync-wiki.mjs` — **not** generated from INSTALL.md, so it drifts silently |
| `.github/workflows/copilot-setup-steps.yml` | was pinned to Node 20; every other workflow already pinned 24 |

Checked and confirmed to need no change: `.nvmrc` (already `24`), all other CI
workflows (already `'24'`), `server/package.json` (no `engines` field). There is
**no** first-run Node-version check in `scripts/`, and the Pinokio path
provisions its own Node (`INSTALL.md` line 40), so neither is affected.

`docs/BACKLOG.md` still says "Node 20.6+" in the ops-1 / ops-15 installer rows.
Left alone deliberately: that file is generated from the GitHub Projects board
(`npm run backlog:sync`) and must not be hand-edited, and those installers do
not exist yet.

## Test plan

### Automated coverage

- Vitest unit (`src/main.test.tsx`) — **new.** Mocks `react-router/dom` and
  `react-router` with distinct sentinel `RouterProvider`s, imports `main.tsx`
  for real, and asserts the DOM-specific one rendered and the bare one did not.
  This is the only automated guard on invariant 1, because the failure mode is
  invisible to `tsc`. Mutation-verified: reverting the import to bare
  `'react-router'` fails this test; restoring it passes.
- Vitest unit (`src/lib/router.test.ts`) — pre-existing, unmodified, 43
  assertions on the hash grammar. Passing unchanged is the evidence for
  invariants 2 and 3.
- Playwright e2e (`e2e/**`) — 292 specs, unmodified, exercising ~50 distinct
  `#/…` URL shapes in a real browser against the upgraded router. Every literal
  hash-string assertion still passes.
- Playwright visual (`e2e/responsive/visual.spec.ts`) — 19 snapshots, no
  baseline drift, nothing blessed. The router change touches layout and
  navigation, so these are load-bearing here rather than incidental.

### Manual acceptance walkthrough

Not required — the e2e suite covers the navigation surface end to end in a real
browser, which is strictly stronger than a click-through for this change. The
one thing e2e cannot cover is the deployer prerequisite:

1. On a machine with **Node 20 or 21**, run `npm install`. Expect npm to refuse
   or warn on the `engines.node` floor. This is the intended new behaviour, not
   a regression — it is why the floor is documented in four places.

## Out of scope

- Adopting v8 SSR / framework-mode features. This app is a pure client-side
  `createHashRouter` with no loaders, actions, or `meta` functions; every
  middleware / `passThroughRequests` / `trailingSlashAwareDataRequests` /
  `splitRouteModules` / `hasErrorBoundary` breaking change in v8 was assessed
  and is inapplicable (verified by grep — none of those symbols appear in
  `src/`).
- Raising the Node floor anywhere it is not currently advertised (the two
  BACKLOG installer rows above).

## Ship notes

Shipped 2026-07-27 on `chore/frontend-router-v8-node-floor`, closing #1859.

Behaviour delta vs. the original issue: the issue instructed rewriting every
`react-router-dom` import to `react-router`, which is wrong for `RouterProvider`
— see "The import split" above. It also under-listed the floor work: v8 requires
**React >=19.2.7 and Vite >=7** in addition to Node, and `package.json`'s
`react: ^19.0.0` range was itself too loose. Vite was already 8.0.16 so no
change was needed there. The issue's file survey also missed
`docs/wiki/Installing-Castwright.md`.
