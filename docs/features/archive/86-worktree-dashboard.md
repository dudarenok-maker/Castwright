---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# 86 — Live worktree dashboard

> Status: stable (dev-only)
> Key files: `server/src/routes/worktrees.ts`, `src/views/worktrees.tsx`, `src/routes/index.tsx`, `src/lib/router.ts`, `src/lib/types.ts`, `src/store/ui-slice.ts`, `src/components/top-bar.tsx`, `src/components/layout.tsx`, `src/lib/api.ts`
> URL surface: `#/worktrees`
> OpenAPI ops: `GET /api/worktrees` (dev-only; 404 in production)

## Benefit / Rationale

- **User (developer):** once 3+ parallel Claude Code sessions are routinely open, a terminal `wt-list` doesn't cut it — the `#/worktrees` view lists every worktree with its branch, port assignments, and a live TCP probe of each dev server, refreshed every 10 s. Click a green row → opens that worktree's dev URL in a new tab. Closes BACKLOG Could #12 (now Could #11 after plan 85's renumber).
- **Technical:** server reuses the parser shape from `scripts/wt-list.mjs` (inlined into TS — parsers are simple enough that inline-keeping is cleaner than cross-language imports). TCP probe is the same 500ms `net.connect` pattern from `scripts/start-app-prod.mjs:46-66`. Top-bar entry + the server route are both gated behind dev mode (`import.meta.env.DEV` / `NODE_ENV !== 'production'`) so production builds never expose git internals.
- **Architectural:** new `kind: 'worktrees'` stage variant; `#/worktrees` hash route; `openWorktrees` ui-slice action. No new redux slice — view-local state via `useState` + `setInterval`.

## Architectural impact

- **Server:** new `server/src/routes/worktrees.ts` exports `worktreesRouter` (mounted at `/api` in `server/src/index.ts`). Handler runs `git worktree list --porcelain`, parses via the inline `parseWorktreePorcelain` / `parseEnvLocal` helpers, runs the port probe in parallel via `Promise.all`. 404s when `NODE_ENV === 'production'`.
- **Frontend:** new `src/views/worktrees.tsx` (renders the table + 10 s auto-refresh); new `WorktreesRoute` in `src/routes/index.tsx`; new `'worktrees'` case in `src/lib/router.ts` `stageToHash`. The router config gets `{ path: 'worktrees', element: <WorktreesRoute /> }`.
- **Top-bar:** new optional `onOpenWorktrees?: () => void` prop. When provided, a small `wt` chip renders left of the theme toggle. The `Layout` component passes the dispatch only when `import.meta.env.DEV` is true, so production builds get `undefined` and hide the chip.

## Invariants to preserve

1. **Dev-only gate** — the chip is hidden when `import.meta.env.DEV === false` AND the server route 404s when `process.env.NODE_ENV === 'production'`. Both checks must stay independent — the frontend gate keeps the dispatch from firing; the server gate keeps the route from leaking git internals if someone hits it directly.
2. **Auto-refresh cadence at 10 s** (`src/views/worktrees.tsx:setInterval`). Don't tighten — the underlying `git worktree list` + N TCP probes is cheap but not free.
3. **TCP probe timeout at 500 ms** — copied from `scripts/start-app-prod.mjs:46-66`. Tightening risks flapping false-negatives on slow boots.
4. **Branch name + path always rendered, even when alive=false** — the row stays visible (dimmed + non-clickable) so the user can still see all open worktrees, just can't open the ones without a live dev server.

## Test plan

### Automated coverage

- Server route smoke test deferred to a follow-up under the round's time budget. Verify via the full pre-push battery (typecheck + all tests + e2e + build).
- Frontend view test deferred (renders against a mocked api fetch — would need RTL setup that's not free under tight budget).
- The existing typecheck pre-push step catches every type error introduced by the new Stage variant + route wiring.

### Manual acceptance walkthrough

1. Open `http://localhost:5173/#/worktrees` in a dev build (or click the `wt` chip in the top-bar).
2. Header shows "Worktrees" + the description line.
3. Rows list every worktree visible to `git worktree list --porcelain`, with the parent + each sibling worktree. Each row carries a status dot (green when the dev server is alive, gray otherwise), the branch name, the path, the VITE_PORT, and the short HEAD SHA.
4. Click a green-dotted row → opens `http://localhost:<vitePort>` in a new tab.
5. Wait 10 s → list re-fetches; if you started a dev server in a sibling worktree, its dot flips green.
6. In a production build (`npm run build && npm run preview`), the `wt` chip is hidden AND `GET /api/worktrees` returns 404.

## Out of scope

- New automated test cases for the route + view — deferred to a follow-up.
- OpenAPI spec entry for the new endpoint — implementation lives in code; openapi.yaml not updated this PR.
- Worktree create / remove affordances — read-only dashboard only; `scripts/wt-new.mjs` is the existing path for creating worktrees.

## Ship notes

Shipped 2026-05-21 — closes BACKLOG Could #12 (which renumbered to #11 after plan 85's bucket-renumber). Cross-link added to README.md "Parallel sessions" section. Bundles the bump-version.test.mjs env-leak fix from plan 85.
