---
status: stable
shipped: 2026-05-19
owner: null
---

# 54 — verify-cache `--steps` filter (caches `verify:fast` / pre-commit)

> Status: active
> Key files: `scripts/verify-cache.mjs`, `package.json`, `scripts/tests/verify-cache.test.mjs`
> URL surface: indirect — `npm run verify:fast` (pre-commit hook in `.husky/pre-commit`)
> OpenAPI ops: none

## Benefit / Rationale

- **Developer:** Pre-commit drops from sub-5 s warm to under 1 s for no-source-change commits (docs, lockfile-only, regen-only). Compounds across the hundreds of commits in v1.3.0 and beyond — the gate is the single most-frequently-run battery in the day.
- **Technical:** Reuses the cache infrastructure shipped in plan 50 (`docs/features/archive/50-verify-cache.md`). The cache file is shared — a `test:server` entry written by `verify:fast` skips correctly in a subsequent `verify` and vice-versa. No new cache shape, no new schema-version bump.
- **Architectural:** Generalises `verify-cache.mjs` from "one entry point, full pipeline" to "one entry point, parameterised subset." The `--steps` flag is reusable for any future caller that wants a subset (e.g. CI matrix shards).

## Architectural impact

- **New seam:** `--steps=<csv>` (or `--steps <csv>`) flag on `scripts/verify-cache.mjs`. `parseFlags` parses it; `runPipeline` filters the hardcoded `STEPS` array against the parsed list before iterating. Validation: unknown step names → exit 2 with a clear error listing valid names.
- **Invariants preserved:**
  - Pipeline ordering is preserved — `--steps` filters but does not reorder. The relative order of `test:hooks` → `test` → `test:server` (as run today by `test:fast`) is identical to the order they appear in `STEPS`, so `verify:fast` matches the pre-existing run shape.
  - Per-step hash key is `stepName`. The cache is unaware of which entry-point invoked the step; entries written by `verify:fast` are read by `verify` and vice-versa.
  - `--no-cache` continues to force a run; combines freely with `--steps`.
  - Empty `--steps` (no following value, or no flag) → full pipeline (the historical behaviour).
- **Migration:** None. The cache file shape is unchanged.
- **Reversibility:** Revert the `package.json:verify:fast` line to `npm run test:fast` and the runner is again a single-entry-point full-pipeline tool.

## Invariants to preserve

1. **`parseFlags` is pure.** It does not validate step names against `STEPS` — that responsibility sits in `runPipeline` (which has both `STEPS` and the parsed list in scope). This keeps `parseFlags` trivially testable without importing `STEPS`.
2. **Pipeline ordering by `STEPS` declaration order** — `runPipeline` filters via `STEPS.filter(s => selected.has(s.name))`, not by `flags.steps.map(name => STEPS.find(...))`. The filter preserves declaration order regardless of the order the caller listed names on the CLI.
3. **`--steps` with no value is a user error**, surfaced by `runPipeline` (parsed as `steps: []` and treated as "no valid filter passed"). Falling back to the full pipeline silently would mask the typo; the runner exits 2 instead.
4. **Cache-file location and schema version unchanged.** `CACHE_FILENAME = '.verify-cache.json'` and `SCHEMA_VERSION = 1` are not bumped — the per-step hash format and key set are unchanged.

## Test plan

### Automated coverage

Extends `scripts/tests/verify-cache.test.mjs` (already runs via `npm run test:hooks` — Node's built-in `node:test`):

- `parseFlags --steps` with space-separated form: `['--steps', 'a,b,c']` → `{ steps: ['a', 'b', 'c'] }`.
- `parseFlags --steps` with `=` form: `['--steps=a,b,c']` → `{ steps: ['a', 'b', 'c'] }`.
- `parseFlags --steps` trims whitespace and drops empty segments.
- `parseFlags --steps` combines with `--no-cache`.
- `parseFlags --steps` with no following value → `{ steps: [] }` (runPipeline surfaces as exit 2).
- `parseFlags` absent `--steps` → `{ steps: null }` (full pipeline).

All 21 pre-existing tests continue passing — the only API change to `parseFlags` is the added `steps` field on its return value, which the existing `assert.deepEqual` checks have been updated to expect.

### Manual acceptance walkthrough

1. **Clean state:** `npm run verify -- --no-cache` once → all steps green, cache populated.
2. **Trivial commit:** `git commit --allow-empty -m "chore: smoke"` — pre-commit hook calls `verify:fast` → output shows three `[cached]` lines (test:hooks, test, test:server) → exits in sub-1 s.
3. **Source change:** touch a `src/` file → `git commit -am "test: src tweak"` — pre-commit runs `test` (cache miss) and skips `test:hooks` + `test:server` (cache hit) → still well under 5 s.
4. **Unknown step name:** `node scripts/verify-cache.mjs --steps nosuch,test` → exits 2 with `[verify-cache] unknown step name(s): nosuch` and the valid-step list.

## Out of scope

- Extending `verify:fast` to include `lint` or `typecheck`. Today's `test:fast` doesn't, so this plan preserves the same step set (`test:hooks,test,test:server`). Adding more is a separate decision tracked separately if needed.
- CI matrix sharding via `--steps`. The seam is reusable, but no CI workflow exists yet.

## Ship notes

Shipped 2026-05-19 — merged via PR #36 (`45aa993`). `--steps` flag accepts both `--steps a,b,c` and `--steps=a,b,c` forms; unknown step names exit 2 with the valid-step list. `package.json` `verify:fast` rewired to `node scripts/verify-cache.mjs --steps test:hooks,test,test:server`. Verified end-to-end: an empty-commit pre-commit prints three `[cached]` lines and exits sub-1s when the cache is warm. No spec deltas.
