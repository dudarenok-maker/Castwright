---
status: active
shipped: null
owner: null
---

# 209 — In-app Help / troubleshooting view (fe-29)

> Key files: `src/views/help.tsx`, `src/data/help-failures.ts`, `src/data/help-topics.ts`,
> `server/src/routes/failure-remediations.ts`, `src/lib/router.ts`, `src/components/top-bar.tsx`
> URL surface: `#/help`, `#/help?code=<failure-code>`

## Benefit / Rationale

- **User:** support deflection — getting started, live keyboard shortcuts, and every
  fs-19 failure's remediation live where the user already is, offline, deep-linked
  from the exact failure row that sent them.
- **Technical:** n/a — no new backend surface; the view is pure frontend + the shared
  `failure-remediations.ts` module that already exists.
- **Architectural:** `failure-remediations.ts` is the single copy source for the
  taxonomy AND the Help view; a FailureCode without copy fails typecheck on both ends.

## Architectural impact

- **New seams / extension points:** `src/views/help.tsx` (new stage `help` in the
  `ui.stage` discriminated union); `src/data/help-failures.ts` (maps every `FailureCode`
  to a display title, `satisfies Record<FailureCode, string>`); `src/data/help-topics.ts`
  (5 curated static topics); `helpHrefForFailureCode` pure helper in `src/lib/router.ts`.
- **Invariants preserved:** the `ui.stage` discriminated union is extended additively
  (`{ kind: 'help' }`) — existing variants unchanged; `failure-remediations.ts` imports
  nothing (frontend bundles it across the package boundary — plan 173 invariant 6).
- **Migration story:** none — no persisted state; hash router is additive.
- **Reversibility:** remove the `help` stage variant + its routing wiring + the three
  new data files. No other state is touched.

## Invariants to preserve

1. `failure-remediations.ts` imports NOTHING (frontend bundles it across the package boundary).
2. The Help view performs zero network calls — it must render with the server down.
3. Every `FailureCode` has a Help anchor (`id={code}`) and a title in `help-failures.ts`
   (`satisfies Record<FailureCode, string>`).
4. The top-bar "?" renders on every stage (it lives in the shared TopBar).
5. `helpHrefForFailureCode` returns null for `unknown`/missing codes, and the analysing
   surfaces additionally gate on `isHelpLinkable` — failure rows never link to a non-anchor.

## Test plan

### Automated coverage

- Vitest unit (`src/views/help.test.tsx`) — sections render, focus lands on deep-linked
  code anchor, unknown-code query param is a no-op, live + rebound keybindings surface.
- Vitest unit (`src/data/help-failures.test.ts`) — copy completeness: every `FailureCode`
  has a non-empty title entry in `help-failures.ts`.
- Vitest unit (`src/lib/router.test.ts`) — round-trip `stageToHash`/`parseHash` for the
  new `help` stage; `helpHrefForFailureCode` returns correct anchor for known codes,
  `null` for `unknown`.
- Vitest unit (top-bar affordance) — "?" button renders and links to `#/help`.
- Vitest unit (generation/analysing More-help links) — link href matches
  `helpHrefForFailureCode(code)` for a known code; link absent when `isHelpLinkable` is false.
- Playwright e2e (`e2e/help.spec.ts`) — top-bar "?" entry opens `#/help`; deep-link
  `#/help?code=sidecar-unreachable` scrolls the matching section into view.
- Playwright responsive coverage case (`e2e/responsive/coverage.spec.ts`) — Help view
  appended as a case.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`).

1. **Cold boot at `#/`** → expected stage = `{ kind: 'books' }`. Click "?" in the top bar → URL = `#/help`, stage = `{ kind: 'help' }`, all sections visible.
2. **Navigate to `#/help?code=sidecar-unreachable`** → the sidecar-unreachable section is focused / scrolled into view.
3. **Navigate to `#/help?code=unknown-garbage`** → Help view renders without error; no section is highlighted.
4. **Stop the server** (Ctrl+C the backend) **then open `#/help`** → page fully renders with no network error (all data is static).
5. **Trigger a generation failure** → the failure row shows a "More help →" link; click it → navigates to `#/help?code=<matching-code>`.

## Out of scope

- Server-rendered or remotely-fetched help content — all copy is static, bundled at build time.
- Searchable help — a future extension point; the section IDs + titles form a natural index when needed.
- Per-failure video or animated guidance — copy + bullet points only for v1.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec. Once filled, the plan becomes eligible
for archive — move to `docs/features/archive/` in the same PR as the ship.)
