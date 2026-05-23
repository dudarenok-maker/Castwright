---
status: stable
shipped: 2026-05-18
owner: null
---

# Lint, format, and a11y baseline (ESLint + Prettier + axe-core)

> Status: stable
> Key files: `.eslintrc.cjs`, `.prettierrc`, `.prettierignore`, `src/test/setup.ts`, `src/test/a11y.test.tsx`, `package.json`
> URL surface: none (developer tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer-facing):** every PR landed after this baseline gets free code-style enforcement (Prettier) + static a11y signal (ESLint jsx-a11y plugin) + rendered-DOM a11y signal (axe-core on the four core views). Catches regressions in the contributor's local `npm run verify` before they reach the reviewer.
- **Technical:** consolidates "is this code well-formatted?" into one tool (Prettier wins formatting fights via `eslint-config-prettier`). The autofix baseline lands ONCE on a clean tree so future PR diffs aren't polluted with whitespace churn.
- **Architectural:** the lint gate ratchets — every rule we currently relax in `.eslintrc.cjs` because of inherited debt is a known follow-up. When the underlying patterns get refactored, the rule re-promotes to `error`. The base config is built on the recommended rulesets (`eslint:recommended`, `@typescript-eslint/recommended`, `react`, `react-hooks`, `jsx-a11y`), so adding plugins (e.g. `eslint-plugin-vitest`) later doesn't require a config rewrite.

## Architectural impact

- **New seams / extension points:**
  - `.eslintrc.cjs` (legacy config for ESLint 8.57 — flat config is a future migration).
  - `.prettierrc` / `.prettierignore` — standard Prettier config.
  - `src/test/setup.ts` extended with `expect.extend(toHaveNoViolations)` so any spec can call `expect(await axe(container)).toHaveNoViolations()`.
  - `src/test/a11y.test.tsx` — the four-view harness. Add a `describe` block here per new view to extend coverage; no separate setup needed.
  - `package.json` scripts: `format`, `format:check`, `test:a11y`. `lint` tightened to `--max-warnings 0`, `verify` prefixes `lint`.
- **Invariants preserved:**
  - Plan 38 (commit gate): unchanged. `commit-msg` validator + `pre-commit verify:fast` + `pre-push verify` keep the same shape; `verify` just gets an extra `lint` step at the front.
  - Plan 25 (design tokens): the autofix did not touch token usages. `tailwind.config.ts` referenced tokens unchanged.
  - Plan 26 (RTK Immer drafts): no slice reducer logic changed in the autofix.
  - Plan 24 (OpenAPI is source of truth): `src/lib/api-types.ts` is in `.prettierignore` and `.eslintrc.cjs` ignorePatterns — regenerator output stays canonical.
- **Migration story:** none. The autofix commit (`f821a87`) is a one-shot whitespace + quotes + trailing-comma normalisation across 343 files. Tests passed before and after; no behaviour change.
- **Reversibility:**
  - Delete `.eslintrc.cjs` and `.prettierrc` → `npm run lint` errors out, `prettier` falls back to defaults. Existing source remains formatted.
  - `npm uninstall eslint prettier jest-axe` (+ plugins) → linter / formatter / a11y harness gone. The autofix commit is a normal commit; revert if desired.

## Invariants to preserve

1. **`lint` runs at `--max-warnings 0`.** `package.json:17` — the strict flag is what makes the gate a ratchet. Removing it silently allows new warnings to accumulate.
2. **Pre-commit hook MUST NOT include `lint`.** `.husky/pre-commit` runs `verify:fast`; lint costs 4–8 s cold and overruns the sub-5 s budget that CLAUDE.md §"Commit gate" promises. Pre-push is the right gate.
3. **`src/lib/api-types.ts` MUST stay in both `.eslintrc.cjs:67` ignorePatterns and `.prettierignore`.** It's generated from `openapi.yaml` via `npm run openapi:types`. Formatting it would clobber the next regen.
4. **`audiobook-workspace/` MUST stay in `.prettierignore`.** User-state JSON lives there; Prettier rewriting it would corrupt active books.
5. **The four a11y view-specs (`a11y.test.tsx`) keep the AXE_OPTS exclusion list narrow.** Only `aria-allowed-role`, `heading-order`, and `nested-interactive` are disabled — each flags an inherited card pattern that gets its own cleanup PR. Adding a new exclusion requires a comment explaining the inherited pattern + a follow-up backlog entry.
6. **Relaxed ESLint rules in `.eslintrc.cjs` are "off" rather than "warn"** because the `--max-warnings 0` gate would otherwise block on inherited debt. Each `off` ships with a comment explaining the inherited pattern and a "re-promote when…" trigger. Promotion back to `error` is a follow-up PR's job, not a backlog item to chase.

## Test plan

### Automated coverage

- **`src/test/a11y.test.tsx`** — four `describe` blocks (library, upload, confirm-cast, listen). Each renders the view inside a minimal seeded `<Provider>` and asserts `toHaveNoViolations`. AXE_OPTS disables the three inherited-pattern rules listed above; nothing else.
- **No separate test for the lint config.** It's exercised by every other PR — if the config breaks, `npm run verify` red-tests next PR.
- **Existing 869 frontend + 851 server + 38 hook tests all still green** after the autofix (the formatting baseline must not introduce semantic change).

### Manual acceptance walkthrough

1. `npm install` — picks up devDeps (ESLint, Prettier, jest-axe, plugins).
2. `npm run format:check` — Prettier reports zero misformatted files.
3. `npm run lint` — ESLint exits 0 with zero warnings.
4. `npm run test:a11y` — axe-core runs against the four views; 4 specs pass.
5. `npm run verify` — full battery (lint + typecheck + all tests + e2e + build) green.
6. Open a PR with a malformed commit — `commit-msg` hook rejects. PR title with malformed shape — `.github/workflows/pr-title-lint.yml` rejects (plan 44 harness).

## Out of scope

- **Axe checks beyond the four named views** (profile drawer, modals, voices, etc.). Each is its own follow-up — extending coverage is a one-PR-per-view ratchet. Tracked as net-new backlog if the user wants to queue it.
- **Re-promoting relaxed rules to `error`.** Each relaxation in `.eslintrc.cjs` has a "re-promote when…" comment naming the cleanup that unblocks it. Those are individual follow-up PRs, not this plan.
- **`lint-staged` for staged-file scoping.** Would let lint move into pre-commit. Tracked separately if the user wants the cycle-time win.
- **ESLint flat config migration (ESLint 9).** ESLint 8 is deprecated upstream but still works; the migration is a non-trivial rewrite of `.eslintrc.cjs` to `eslint.config.js`. Tracked separately when ESLint 8 EOLs.
- **`react-hooks/rules-of-hooks` violations fix.** Plan 46 surfaces the inherited bugs (`layout.tsx`, `character-regenerate.tsx`, `confirm-metadata.tsx`) but DOES NOT fix them — each is a surgical hook-move that belongs in its own scoped PR.

## Ship notes

- Shipped 2026-05-18 on branch `ci/ci-plan-46-lint-prettier-a11y` via PR (commit SHA filled at merge).
- Seven commits land the change:
  1. `build(deps): plan 46 add eslint + prettier + jest-axe devdeps`
  2. `ci(ci): plan 46 add eslint + prettier config`
  3. `chore: apply eslint --fix + prettier --write baseline` (343 files reformatted)
  4. `ci(ci): plan 46 triage remaining lint warnings`
  5. `test(frontend): plan 46 add axe-core a11y spec for four views`
  6. `ci(ci): plan 46 wire test:a11y + lint into verify chain`
  7. `docs(docs): plan 46 ship + archive`
- ESLint 8.57.1 pinned (legacy config); flat-config migration intentionally deferred. **Followed up 2026-05-23 by plan 104 — `.eslintrc.cjs` migrated to `eslint.config.js` (flat config) on ESLint 9; the lint ratchet here (same relaxed rules, `--max-warnings 0`, api-types/workspace ignores) is preserved verbatim. See [docs/features/104-eslint-flat-config.md](../104-eslint-flat-config.md).**
- Three axe rules disabled at the spec level (`AXE_OPTS` in `a11y.test.tsx`); see invariant #5.
- Seven ESLint rules relaxed in `.eslintrc.cjs` (rules-of-hooks, four jsx-a11y interaction rules, media-has-caption, no-constant-condition + no-control-regex + no-empty + no-inner-declarations on server); see invariant #6.
- Two pre-existing flakes named explicitly: `server/src/routes/user-settings.test.ts` and `server/src/workspace/user-settings.test.ts` share `server/user-settings.json` on disk and produce sporadic round-trip failures in the full server suite. They pass in isolation. Quarantine is out of scope here; tracked as a follow-up.
