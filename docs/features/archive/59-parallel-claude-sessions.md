---
status: stable
shipped: 2026-05-19
owner: dudarenok@gmail.com
---

# 59 — Parallel Claude Code sessions (worktree spawn helper)

> Status: stable
> Key files: `scripts/wt-new.mjs`, `scripts/wt-list.mjs`, `scripts/lib/branch-name.mjs`, `scripts/tests/wt-new.test.mjs`, `vite.config.ts`, `playwright.config.ts`, `CONTRIBUTING.md`
> URL surface: n/a (tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** spinning up a second / third / fourth top-level `claude` session against this repo is now a one-liner (`node scripts/wt-new.mjs <branch>`) instead of six manual steps. The single largest friction for fanning out work across parallel Claude conversations was the port-collision footgun on `:5173` / `:8080` — that's gone for slot-1+ worktrees, which now run on `:5183` / `:8090` / etc.
- **Technical:** `vite.config.ts` and `playwright.config.ts` now read their ports from the environment (`VITE_PORT`, `VITE_API_PORT`, `PLAYWRIGHT_PORT`) with stock defaults. The main worktree's `npm run dev` behaviour is identical to pre-plan-59 when env is unset.
- **Architectural:** seam between commit-convention vocab and branch-name validation. `scripts/lib/branch-name.mjs` reuses the `TYPES` + `SCOPES` exports from `validate-commit-msg.mjs` so changing the vocabulary in one place updates both the commit gate and the worktree helper.

## Architectural impact

- **New seams:** `scripts/lib/branch-name.mjs` exports `parseBranchName(name) → { ok, type, scope, slug } | { ok: false, reason }` for any future script that needs to validate a `<type>/<scope>-<slug>` branch name.
- **Env-driven ports** (NEW): `VITE_PORT`, `VITE_API_PORT`, `PORT`, `LOCAL_TTS_PORT`, `PLAYWRIGHT_PORT`. Stock defaults preserve pre-plan-59 behaviour exactly.
- **Invariants preserved:** the commit-msg gate's accepted-subjects set is unchanged (the existing 147 hook tests pass after the lib extraction). The verify-cache (plan 50) is per-worktree because `.verify-cache.json` is gitignored — parallel worktrees do not race on it.
- **Reversibility:** delete `scripts/wt-new.mjs` + `scripts/wt-list.mjs` + `scripts/lib/branch-name.mjs` + `scripts/tests/wt-new.test.mjs`; revert `vite.config.ts` + `playwright.config.ts` to literal port numbers; revert CONTRIBUTING.md insert. Users who created worktrees with this helper would need to manually clean them via `git worktree remove ../wt-<slug>` + `git branch -D <branch>`.

## Invariants to preserve

1. **Slot 0 keeps stock ports.** `scripts/wt-new.mjs` (`BASE_PORTS` constant) — slot 0 = `5173 / 8080 / 9000 / 5174`. The main worktree must never have its ports shifted by this tooling. Tested by `computePorts slot 0 yields stock ports` in `scripts/tests/wt-new.test.mjs`.
2. **`VITE_API_PORT` tracks `PORT` per slot.** The Vite proxy target must point at the same server port the helper assigned to the same worktree. Tested by `computePorts keeps VITE_API_PORT == PORT so the Vite proxy stays correct`.
3. **Branch-name vocab single-sourced.** `scripts/lib/branch-name.mjs` imports `TYPES` + `CHORE_TYPE` + `SCOPES` from `scripts/validate-commit-msg.mjs`. New scopes / types added to the validator automatically apply to the worktree helper. Verified by `scripts/tests/validate-commit-msg.test.mjs` still passing after the lib extraction (no regression in the 19-accepted / 13-rejected commit-msg suite).
4. **Verify-cache stays per-worktree.** `.verify-cache.json` remains gitignored (plan 50). Two worktrees running `npm run verify` in parallel write to their own cache files — no race condition.

## Test plan

### Automated coverage

`scripts/tests/wt-new.test.mjs` (29 cases, runs under `npm run test:hooks`):

- `parseBranchName accepts <branch>` × 9 — every supported `<type>/<scope>-<slug>` shape across the type vocabulary and a sample of scopes.
- `parseBranchName rejects <branch>` × 13 — empty, missing slug, missing slash, unknown type, unknown scope, uppercase, `main`, underscore-in-slug, double-slash, `null` / `undefined` / `123`.
- `computePorts slot 0 / 1 / 2 / 9` — port allocation locks the `slot N → base + N*10` contract.
- `computePorts keeps VITE_API_PORT == PORT` — invariant #2 above; iterated over slots 0/1/2/5/9.
- `computePorts rejects negative or non-integer slots` — `-1`, `1.5`, `'1'`, `null` all throw.
- `renderEnvLocal emits all five port variables` — header + body shape.
- `renderEnvLocal is round-trippable via parseEnvLocal` — `wt-list.mjs` must be able to read back what `wt-new.mjs` wrote.
- `parseWorktreePorcelain extracts path + branch for each worktree` + detached-HEAD case — locks the porcelain parser against future git output drift.

`scripts/tests/validate-commit-msg.test.mjs` — re-runs unchanged (147 cases pass) — proves the `scripts/lib/branch-name.mjs` extraction did not regress the commit-msg gate.

No new Vitest / Playwright / pytest needed — the helper is a dev-tooling script, not runtime code.

### Manual acceptance walkthrough

Run from the main worktree:

1. **Spawn:** `node scripts/wt-new.mjs feat/scripts-parallel-test` →
   - Creates `../wt-parallel-test` on the new branch.
   - Writes `.env.local` with `VITE_PORT=5183`, `PORT=8090`, `VITE_API_PORT=8090`, `LOCAL_TTS_PORT=9010`, `PLAYWRIGHT_PORT=5184`.
   - Prints `[wt-new] slot 1 → ports VITE=5183 API=8090 TTS=9010 E2E=5184` and a next-steps block.
2. **Run dev in main + worktree simultaneously:**
   - Tab A (main tree): `npm run dev` → frontend `:5173`, server `:8080`.
   - Tab B (worktree): `cd ../wt-parallel-test && npm install && npm run dev` → frontend `:5183`, server `:8090`. No `EADDRINUSE`.
3. **Browse both:** `http://127.0.0.1:5173/` + `http://127.0.0.1:5183/`. Each loads the library; `/api/*` proxies land on the matching server.
4. **List:** `node scripts/wt-list.mjs` → table with two rows (slot 0 main / slot 1 wt-parallel-test) and their port assignments.
5. **Validation gate:** invoke `node scripts/wt-new.mjs feat/server` (no slug) → exits non-zero with "does not match `<type>/<scope>-<slug>`". Invoke with an existing branch name → exits non-zero with "branch X already exists."
6. **Cleanup:** `git worktree remove ../wt-parallel-test` + `git branch -D feat/scripts-parallel-test`.

## Out of scope

- **GPU arbitration.** Two sessions both hitting `/analyse` or `/synthesize` still fight over VRAM. Tracked as `docs/BACKLOG.md` Could #39 (GPU semaphore).
- **Live worktree dashboard in the app.** `wt-list.mjs` is terminal-only. Tracked as Could #40.
- **Auto-reconcile helper.** The `integration/<date>` ritual from CONTRIBUTING.md is still manual. Tracked as Could #41.
- **Per-worktree `WORKSPACE_DIR`.** Sessions writing to the same book races on `state.json`. Mitigation documented in CONTRIBUTING.md "GPU + shared-resource caveats" — user sets `WORKSPACE_DIR=…` in `.env.local` per worktree when isolation matters.
- **Per-worktree sidecar venv.** The Python venv at `server/tts-sidecar/.venv/` is shared. Fine for read-only use; upgrades happen from one worktree.

## Ship notes

- **Shipped:** 2026-05-19
- **Commit:** `d6241a6c58d15ecb2606a275f9a4f656d3334b63` (feat branch `feat/scripts-parallel-claude-sessions`)
- **Behaviour delta vs. plan:** none. Implementation matched the approved plan 1:1. Three follow-ups filed at BACKLOG Could #39 / #40 / #41 (GPU semaphore / live dashboard / auto-reconcile) — explicitly out-of-scope per the user's "helper script + short docs" answer, recorded so the v2 surface stays tracked.
