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
- **Troubleshooting reorg (feat/frontend-help-troubleshooting-wiki-links):** the
  Troubleshooting section is now grouped by `HELP_CATEGORIES` (`src/data/help-categories.ts`);
  category assignment is pinned data — `CATEGORIES satisfies Record<FailureCode, CategoryId>`
  in `src/data/help-failures.ts`, plus a `category` field on each `HelpTopic` in
  `src/data/help-topics.ts` — so failures and FAQs merge by topic instead of listing
  separately. The section is collapsible (the `setup` group is open by default) and
  client-side searchable. Page-level "Read more on the wiki" links come from
  `src/lib/wiki-links.ts` via the `WikiLink` component (`src/components/wiki-link.tsx`),
  used in Help and in Admin (`src/views/admin.tsx`, `src/components/lan-access-card.tsx`).
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
6. Invariant 3 now reads: every `FailureCode`'s Help anchor (`id={code}`) is present
   whenever its group is open; the only deep-link path (`focusCode`) auto-expands the
   focused entry's group — including when `focusCode` hydrates AFTER mount (a `useEffect`
   folds the late `focusedCategory` into the expanded set).
7. Wiki links are page-level only (no `#anchor`); `wiki-links.test.ts` asserts each
   referenced `WikiPage` exists as `docs/wiki/<page>.md`. The Help view still makes zero
   network calls — wiki links are inert `<a href>` until clicked.

## Test plan

### Automated coverage

- Vitest unit (`src/views/help.test.tsx`) — sections render, focus lands on deep-linked
  code anchor, unknown-code query param is a no-op, live + rebound keybindings surface.
- Vitest unit (`src/data/help-failures.test.ts`) — copy completeness: every `FailureCode`
  has a non-empty title entry in `help-failures.ts`.
- Vitest unit (`src/lib/router.test.ts`) — `stageToHash` serialisation + `stageEqual`
  focusCode discrimination for the new `help` stage (URL parsing is react-router's
  `HelpRoute`, covered via the view/e2e tiers); `helpHrefForFailureCode` returns the
  correct anchor for known codes, `null` for `unknown`.
- Vitest unit (top-bar affordance) — "?" button renders and links to `#/help`.
- Vitest unit (generation/analysing More-help links) — link href matches
  `helpHrefForFailureCode(code)` for a known code; link absent when `isHelpLinkable` is false.
- Playwright e2e (`e2e/help.spec.ts`) — top-bar "?" entry opens `#/help`; deep-link
  `#/help?code=vram-spill` lands on the matching entry (`data-focused` + in viewport).
- Playwright responsive coverage case (`e2e/responsive/coverage.spec.ts`) — Help view
  appended as a case.
- Vitest unit (`src/data/help-categories.test.ts`) — category completeness (every
  `FailureCode` and `HelpTopic` maps to a valid `CategoryId`).
- Vitest unit (`src/lib/wiki-links.test.ts`) — every referenced `WikiPage` exists as
  `docs/wiki/<page>.md`.
- Vitest unit (`src/components/wiki-link.test.tsx`) — `WikiLink` renders the expected
  page-level href.
- Vitest unit (updated `src/views/help.test.tsx`) — the `setup` group is open by
  default; groups expand/collapse; search filters entries; deep-link mount focuses
  the right group and anchor, including when `focusCode` hydrates after mount.
- Vitest unit (updated `src/views/admin.test.tsx`) — Admin panels render the expected
  wiki hrefs.
- Playwright e2e (`e2e/help.spec.ts`) — new cases for the grouped view, search, wiki
  href, and deep-link auto-expand.

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
