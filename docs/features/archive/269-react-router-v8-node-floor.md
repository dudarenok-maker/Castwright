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
  21 needs to upgrade, but nothing forces them to: `engines` is advisory (see
  "Node floor sites"), so an old-Node install succeeds with a warning and fails
  later, obscurely. Node 20 reached EOL in April 2026 and 22 is the active LTS,
  so the floor was overdue independent of the router.
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

**Both modules export a component named `RouterProvider`**, and
`dom-router-provider.d.ts` declares `Omit<RouterProviderProps, "flushSync">`, so
`<RouterProvider router={router}/>` compiles against either. A migration guided
by "rewrite every `react-router-dom` import to `react-router`" (which is what
issue #1859 originally instructed) would have taken the wrong one straight past
`tsc --noEmit` at the app's sole mount point.

**Severity calibration — added after independent review, because the first
draft of this section overstated it.** The wrong import would be behaviourally
*identical today*, not broken. `flushSync` is consumed only behind
`if (reactDomFlushSyncImpl && flushSync)` (`components.js:144,152`), and this app
uses no `viewTransition` and no `flushSync` anywhere — so the miss currently
degrades to a dev-only `warnOnce`, not a runtime failure. The invariant and its
guard are still worth keeping: they protect the moment someone adopts view
transitions, at which point the wrong import silently stops flushing. But "it
breaks at runtime" was wrong, and is corrected here rather than left to
propagate.

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
   `src/lib/router.test.ts` (30 tests, 39 assertions) plus every literal hash
   assertion in the e2e suite.
4. `package.json` declares `react`/`react-dom` at `^19.2.7` or higher —
   react-router 8.3.0's peer floor. The previous `^19.0.0` range permitted
   resolving 19.0.0, which v8 rejects, so the range itself was the defect.
5. `package.json` `engines.node` is `>=22.22.0`, and every advertised
   prerequisite agrees with it (see "Node floor sites" below).

## Node floor sites

The floor is advertised in **five** places that are **not** generated from each
other and must be changed together. (The first draft of this plan said four —
independent review found the fifth, which is itself the point: nothing mechanical
keeps these in sync.)

| Site | Note |
|---|---|
| `package.json` `engines.node` | the nominally machine-checkable one — but see the enforcement caveat below |
| `INSTALL.md` line 11 | deployer-facing prerequisites |
| `docs/wiki/Installing-Castwright.md` line 25 | hand-maintained mirror of INSTALL.md, synced to the GitHub wiki by `scripts/sync-wiki.mjs` — **not** generated from INSTALL.md, so it drifts silently |
| `.github/workflows/copilot-setup-steps.yml` | was pinned to Node 20; every other workflow already pinned 24 |
| `.github/copilot-instructions.md` line 10 | the *sibling* of the file above, and the one this plan's first draft missed — a live agent-instructions doc that would have gone on contradicting `package.json` |

**`engines` does not enforce.** npm emits `EBADENGINE` and exits 0 without
`engine-strict`, and this repo sets no `.npmrc`. This is not a discovery — it is
recorded in `docs/features/164-deps-ci-hygiene.md:31` — but the first draft of
this plan, and both release-notes entries, claimed npm would refuse the install.
It will not. The floor documents intent and converts a "wrong Node" into a late,
obscure failure rather than an install-time one. That is the whole reason the
advertised prerequisite in the five places above is load-bearing: **the
documentation IS the enforcement.**

**The Pinokio path is an open risk, not a safe one.** An earlier draft of this
section said Pinokio "provisions its own Node" on the strength of `INSTALL.md`
line 40. It does not: `pinokio-scripts/install.js` step 1 conda-installs
`ffmpeg mkcert` only, and that file carries an unimplemented TODO about exactly
this. Castwright therefore runs on the Pinokio *kernel's* bundled Node, whose
version cannot be determined from this repo. Tracked as owed acceptance —
`docs/testing/onbox-acceptance-register.md` row **E1**.

Checked and confirmed to need no change: `.nvmrc` (already `24`), all other CI
workflows (already `'24'`), `server/package.json` (no `engines` field), and there
is **no** first-run Node-version check anywhere in `scripts/`.

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
- Vitest unit (`src/lib/router.test.ts`) — pre-existing, unmodified, 30 tests /
  39 assertions on the hash grammar. Passing unchanged is the evidence for
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

1. On a machine with **Node 20 or 21**, run `npm install`. Expect a
   **non-fatal `EBADENGINE` warning and exit 0** — npm does *not* enforce
   `engines` without `engine-strict`, and this repo sets no `.npmrc`
   (`docs/features/164-deps-ci-hygiene.md:31` already recorded this). The floor
   documents intent and produces a late, obscure failure on an old Node; it does
   **not** block the install. Do not "fix" a passing install here — that is the
   expected result, and any doc claiming otherwise is the bug.
2. **Pinokio**: unresolved, and tracked as owed acceptance rather than asserted.
   `pinokio-scripts/install.js` never conda-installs `nodejs`, so Castwright
   runs on the Pinokio kernel's bundled Node, whose version is undetermined from
   this repo. Combined with step 1 (no enforcement), a too-old Pinokio Node
   installs cleanly and fails later. See
   [`docs/testing/onbox-acceptance-register.md`](../../testing/onbox-acceptance-register.md)
   row **E1** and item 2 of
   [218's open verifications](../218-pinokio-installer.md).

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
Base commit `db8b2b81` (migration + floor), plus one review-round commit on the
same branch folding in the corrections described below.

Behaviour delta vs. the original issue: the issue instructed rewriting every
`react-router-dom` import to `react-router`, which is wrong for `RouterProvider`
— see "The import split" above. It also under-listed the floor work: v8 requires
**React >=19.2.7 and Vite >=7** in addition to Node, and `package.json`'s
`react: ^19.0.0` range was itself too loose. Vite was already 8.0.16 so no
change was needed there. The issue's file survey also missed
`docs/wiki/Installing-Castwright.md`.

### Corrections folded in from independent review

The review found no Critical defects and confirmed the import split is correct
(`react-router/dom` exports exactly five symbols — `HydratedRouter`,
`RouterProvider`, and three `unstable_RSC*`; every other symbol this app imports
is present on the bare entrypoint and `undefined` on `/dom`, so `RouterProvider`
is the only overlap and nothing that should have used `/dom` didn't). It did
find four Significant problems, all in documentation rather than code, and all
fixed on this branch:

1. **"npm will refuse to install" was false**, and appeared in *user-facing*
   release notes. `engines` is advisory without `engine-strict`; the repo had
   already written this down in `164-deps-ci-hygiene.md:31`, so the claim
   contradicted the repo's own knowledge. Both release-notes files and this
   plan's acceptance step now describe the real behaviour.
2. **"Pinokio takes care of it" was unsupported.** Pinokio uses its *bundled*
   Node and `install.js` never installs one. Rewritten as an open risk, with an
   escalated row in the on-box register.
3. **`.github/copilot-instructions.md:10`** still advertised Node 20.19 — a
   fifth floor site, missed by both the issue's survey and this plan's first
   draft. The "four places" framing above was wrong when written.
4. **`docs/features/218-pinokio-installer.md`** open-verification item 2 carried
   the stale 20.19 threshold and the stale Vite-8 rationale.

Minor corrections in the same round: the assertion count for
`src/lib/router.test.ts` was stated as 43 across five documents; it is **30 tests
/ 39 assertions**. And the "breaks at runtime" framing was overstated — see the
calibration note under "The import split".

The pattern worth noting for next time: every one of these was a *documentation*
defect in a PR whose code was clean, and the two that mattered most were
confident claims about behaviour nobody had measured. The code was verified;
the prose about the code was not.
