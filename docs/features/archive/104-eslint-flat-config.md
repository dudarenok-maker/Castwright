---
status: stable
shipped: 2026-05-23
owner: null
---

# ESLint 9 flat-config migration + jsdom/archiver deprecation-chain bumps

> Status: stable
> Key files: `eslint.config.js` (new), `.eslintrc.cjs` (deleted), `package.json`, `.github/workflows/verify.yml`, `scripts/verify-cache.mjs`, `scripts/build-release-zip.mjs`, `scripts/tests/archiver-zip.test.mjs`, `src/views/listen.test.tsx`, `src/store/persist-config.test.ts`
> URL surface: none (developer tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer-facing):** a fresh `npm install` at root now prints ZERO deprecation warnings. Before this, ESLint 8's `file-entry-cache → flat-cache` plumbing dragged in the loud `inflight@1.0.6` / `glob@7` / `rimraf@3` chain, and jsdom 25 + archiver 7 each added their own (`whatwg-encoding`, `glob@10`). The install log is clean.
- **Technical:** ESLint 9 + flat config is the only supported config format going forward (ESLint 8 is EOL upstream). Migrating now — while the rule surface is small and well-understood — is far cheaper than waiting for more transitive deps to drop ESLint-8 support and forcing the migration under pressure. Bundles the two upstream-unblocked deprecation-chain bumps (jsdom 25 → 29, archiver 7 → 8) that also ride root `package.json`.
- **Architectural:** preserves the plan-46 lint ratchet exactly — same relaxed rules, same `--max-warnings 0` gate, same `src/lib/api-types.ts` / `audiobook-workspace/` ignores — translated faithfully into flat-config shape. No rule was relaxed to make the migration green.

## ESLint 9, NOT 10 — the peer-dep decision

The original backlog item (Should #3) and the parent plan assumed ESLint 9 / leapfrog-to-10. A peer-dependency audit at execution time settled it on **ESLint 9 as the ceiling**:

| Plugin | `peerDependencies.eslint` | ESLint 10 OK? |
|---|---|---|
| `eslint-plugin-react@7.37.5` | `…^9.7` | ❌ no `^10` |
| `eslint-plugin-jsx-a11y@6.10.2` | `…^9` | ❌ no `^10` |
| `eslint-plugin-react-hooks@7.1.1` | `…^9.0.0 \|\| ^10.0.0` | ✅ |
| `typescript-eslint@8.59.4` | `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` | ✅ |
| `eslint-config-prettier@10.1.8` | `>=7.0.0` | ✅ |

Two of the five plugins (`eslint-plugin-react`, `eslint-plugin-jsx-a11y`) do NOT declare an ESLint-10 peer range, so ESLint 10 would install with peer warnings / undefined behaviour. ESLint 9 (9.39.4) is the highest major all five support. **Revisit a 9 → 10 bump once `eslint-plugin-react` and `eslint-plugin-jsx-a11y` ship an `eslint: …^10` peer range.**

## Architectural impact

- **Dependency changes (root `package.json`):**
  - `eslint` `^8.57.1` → `^9` (resolves 9.39.4)
  - removed `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` (`^7.18.0`); added the unified `typescript-eslint` `^8` meta-package (flat-config idiom `tseslint.config(...)`)
  - `eslint-plugin-react-hooks` `^4.6.2` → `^7` (7.1.1)
  - `eslint-config-prettier` `^9.1.2` → `^10` (10.1.8)
  - added `@eslint/js` `^9` (for `js.configs.recommended`) + `globals` `^17` (for `languageOptions.globals`)
  - kept `eslint-plugin-react` `^7.37.5`, `eslint-plugin-jsx-a11y` `^6.10.2`, `prettier` `^3`
  - **deprecation-chain bumps (BACKLOG #32):** `jsdom` `^25.0.1` → `^29` (29.1.1), `archiver` `^7.0.1` → `^8` (8.0.0)
- **`.eslintrc.cjs` → `eslint.config.js`** (flat). Root `package.json` is `"type": "module"`, so the flat config is ESM `eslint.config.js` (not `.mjs`). Full translation of the legacy shape:
  - `env: { browser, es2022, node }` → `languageOptions.globals` via the `globals` package (`globals.browser` + `globals.node` + `globals.es2021`).
  - `parser` / `parserOptions` → `tseslint.parser` applied ONLY to `**/*.{ts,tsx,mts,cts}` (a scoped `{ files }` object). The `scripts/**/*.{mjs,cjs,js}` files keep ESLint's default espree parser — this replaces the old `parser: 'espree'` scripts override.
  - `extends` chain → flat composition in `tseslint.config(...)`: global-ignores object → `js.configs.recommended` → `...tseslint.configs.recommended` → `react.configs.flat.recommended` → `jsxA11y.flatConfigs.recommended` → base rules block → TS-parser-scoping object → 5 override objects → `eslintConfigPrettier` LAST.
  - `ignorePatterns` → a standalone `{ ignores: [...] }` config object (flat-config global-ignores must contain ONLY `ignores`). Every entry carried verbatim, incl. `src/lib/api-types.ts` and `audiobook-workspace/` (plan-46 invariants #3/#4).
  - all 14 rules carried verbatim, including the documented `off` relaxations.
  - the 5 `overrides` → 5 separate `{ files, rules }` flat objects.
- **`react-hooks` v7 nuance:** react-hooks v7 bundles the React Compiler ruleset into its `recommended` / `recommended-latest` flat configs (~15 brand-new rules: `static-components`, `immutability`, `set-state-in-effect`, …). Enabling those wholesale would inject new lint noise, which the plan-46 ratchet forbids. To preserve the EXACT v4 rule surface the old config had (`plugin:react-hooks/recommended` → `rules-of-hooks` + `exhaustive-deps`), the flat config registers the `react-hooks` plugin and sets ONLY those two rules explicitly (`rules-of-hooks: off` carried verbatim, `exhaustive-deps: warn`). The bundled v7 config is deliberately NOT spread in.
- **`no-var-requires` → `no-require-imports`:** typescript-eslint v8 removed the standalone `@typescript-eslint/no-var-requires` rule (merged into `@typescript-eslint/no-require-imports`). The old config relaxed `no-var-requires` for `scripts/**` and config files; that relaxation is carried forward under the new rule name in those two override objects. This is the SAME relaxation, just renamed by the new major — not a new one.
- **`verify.yml` scope-detector regex:** the `frontend=true` match changed `\.eslintrc\.cjs$` → `eslint\.config\.(js|mjs)$` so a config-only change still trips the frontend leg.
- **`verify-cache.mjs` lint-step inputs:** `extraFiles: ['.eslintrc.cjs', …]` → `['eslint.config.js', …]` so the lint cache busts when the config changes.
- **`scripts/build-release-zip.mjs` archiver adaptation:** archiver 8 is pure ESM with NO callable factory (the v7 `archiver('zip', …)` signature is gone) — only named class exports (`Archiver`, `ZipArchive`, `TarArchive`, `JsonArchive`). The script now does `const { ZipArchive } = await import('archiver'); new ZipArchive({ zlib: { level: 9 } })`. `.pipe` / `.file` / `.finalize` / `warning`+`error` events are unchanged.
- **`src/views/listen.test.tsx` jsdom adaptation:** jsdom 29 canonicalises hex CSS colours to `rgb()` in the CSSOM (and in the serialised `style` attribute), so the cover-gradient assertion now matches `rgb(171, 205, 239)` / `rgb(18, 52, 86)` instead of the source `#abcdef` / `#123456` literals.
- **Migration story:** none for runtime — this is dev tooling only. The autofix re-baseline (see below) is a one-shot whitespace/directive normalisation, no behaviour change.
- **Reversibility:** `git revert` the PR. The lock-file pins the old majors; deleting `eslint.config.js` and restoring `.eslintrc.cjs` reverts the lint config.

## Invariants to preserve

1. **`lint` runs at `--max-warnings 0`.** `package.json` `lint` script is `eslint . --max-warnings 0` (the `--ext` flag is gone — flat config derives extensions from the config `files`/`ignores`). The strict flag is what makes the gate a ratchet.
2. **No rule relaxed to make the migration green.** Every `off` in `eslint.config.js` maps 1:1 to an `off` in the old `.eslintrc.cjs` (or is the renamed `no-var-requires` → `no-require-imports` carry-over). The react-hooks v7 Compiler ruleset is deliberately NOT adopted.
3. **`src/lib/api-types.ts` stays in the global-ignores object** (`eslint.config.js`) and `.prettierignore`. Generated from `openapi.yaml`; linting it would clobber the next regen. (plan-46 invariant #3)
4. **`audiobook-workspace/` stays in the global-ignores object** and `.prettierignore`. User-state JSON; touching it corrupts active books. (plan-46 invariant #4)
5. **`eslintConfigPrettier` is LAST** in the `tseslint.config(...)` array so it wins the cascade and disables every formatting rule the earlier configs turn on.
6. **The TS parser is scoped to `**/*.{ts,tsx,mts,cts}` only**, so `scripts/**` CommonJS/ESM files parse with espree (the old `parser: 'espree'` override behaviour).
7. **`verify.yml`'s `frontend` scope-detector matches `eslint.config.(js|mjs)$`** so a lint-config-only PR still runs the frontend leg in CI.
8. **`.claude/` stays in the global-ignores object.** The Claude Code harness directory holds settings JSON (not linted) and transient agent worktrees that each carry their own built `dist/` output. Without this ignore, `eslint .` walks into `.claude/worktrees/<agent>/server/dist/` (the root `server/dist/` ignore is relative to repo root and does NOT match the nested copy) and floods thousands of errors, blocking every push while a worktree exists. Added 2026-05-23 after the gap surfaced on an unrelated push.

## Test plan

### Automated coverage

- **`scripts/tests/archiver-zip.test.mjs`** (new, `node:test`, run by `npm run test:hooks`) — pins the archiver v8 contract `build-release-zip.mjs` depends on: `ZipArchive` is a constructable class (no v7 factory / no callable default), and a `new ZipArchive(opts)` driven via `.pipe` / `.file` / `.finalize` + warning/error events writes a non-empty zip starting with the `PK\x03\x04` magic.
- **`src/views/listen.test.tsx`** (adapted) — cover-gradient assertion locks the jsdom-29-canonicalised `rgb()` form of the book gradient.
- **`src/store/persist-config.test.ts`** (adapted) — two `initial` vars used only in `keyof typeof` type positions renamed to `_initial` to satisfy typescript-eslint v8's `no-unused-vars` (v8 now flags type-only usages; the `^_` allowance is the config's existing escape hatch).
- **No dedicated test for the lint config itself.** It's exercised by every PR's `npm run lint`; a broken flat config red-tests the next `npm run verify`. The full 1629 frontend + entire server suites stay green after the autofix re-baseline (the formatting normalisation must not introduce semantic change).

### Manual acceptance walkthrough

1. `npm install` (fresh, after `rm -rf node_modules`) → ZERO `npm warn deprecated` lines. `npm ls inflight` → `(empty)`.
2. `npm run lint` → exits 0, zero warnings, against `eslint.config.js`.
3. `npm run typecheck` → green (frontend + server) with `typescript-eslint@8` + TS 5.9.
4. `npm run test` → 1629 frontend tests pass under jsdom 29.
5. `npm run test:hooks` → the new archiver-zip contract test passes.
6. `npm run verify` → full battery green (lint + typecheck + all tests + e2e + build).

## Deprecation-audit results (2026-05-23)

Fresh `npm install` at root after the bumps:

- ✅ `inflight@1.0.6` — GONE (the ESLint 9 win; was inside ESLint 8's flat-cache).
- ✅ `glob@7.2.3` / `glob@10.5.0` — GONE from the root tree.
- ✅ `rimraf@3.0.2` — GONE.
- ✅ `whatwg-encoding@3.1.1` / `html-encoding-sniffer` — GONE (jsdom 29 win).
- ✅ `@humanwhocodes/config-array` / `@humanwhocodes/object-schema` — GONE (ESLint 9 win).
- **Net:** root `npm install` prints zero deprecation warnings. The only remaining monorepo deprecation is the server-side `@google/genai → … → node-domexception` chain (no `@google/genai` v3 exists), still tracked in BACKLOG #32.

## Out of scope

- **ESLint 9 → 10.** Blocked on `eslint-plugin-react` + `eslint-plugin-jsx-a11y` shipping an `eslint: …^10` peer range (see the decision table above).
- **Adopting react-hooks v7's React Compiler ruleset** (`static-components`, `immutability`, `set-state-in-effect`, …). Deliberately not enabled — it would inject ~15 new rules and violate the plan-46 ratchet. A future PR could opt in rule-by-rule.
- **Re-promoting the relaxed rules to `error`.** Each `off` keeps its plan-46 "re-promote when…" comment; those are individual follow-up PRs.
- **The `@google/genai` `node-domexception` chain.** No upstream fix available (no v3); stays tracked in BACKLOG #32.
- **The Multer 1 → 2 server upgrade** (BACKLOG #3) and the within-chapter parallelism work — separate clusters / branches.

## Ship notes

- Shipped 2026-05-23 on branch `chore/frontend-eslint-flat-config` (commit SHA filled at merge).
- ESLint target landed at **9** (9.39.4), not 10 — gated by the `eslint-plugin-react@7.37.5` (`…^9.7`) and `eslint-plugin-jsx-a11y@6.10.2` (`…^9`) peer ranges. Documented above.
- react-hooks bumped to v7 but only its two classic rules (`rules-of-hooks`, `exhaustive-deps`) are wired — the bundled React Compiler ruleset is intentionally not adopted (plan-46 ratchet).
- `@typescript-eslint/no-var-requires` relaxation carried forward under its v8 name `@typescript-eslint/no-require-imports` for `scripts/**` + config files.
- jsdom 25 → 29 and archiver 7 → 8 both landed (BACKLOG #32 chains cleared); only `@google/genai`'s `node-domexception` chain remains tracked. One frontend spec (jsdom CSS canonicalisation) and one release script (archiver ESM/class API) needed adapting; both pinned by tests.
- The autofix re-baseline (`eslint . --fix` + targeted `prettier --write` on the touched files) removed dead `eslint-disable` directives across 24 files (ESLint 9 flat config defaults `reportUnusedDisableDirectives` to `warn`; the legacy eslintrc default was `off`). No behaviour change.
- Companion: re-link plan `docs/features/archive/46-lint-format-a11y.md` Ship notes → this plan.
- Follow-up 2026-05-23 (branch `chore/frontend-eslint-ignore-worktrees`): added `.claude/` to the global-ignores object (invariant #8). The flat-config migration carried the plan-46 ignores verbatim but those predate agent worktrees living under `.claude/worktrees/`; once such a worktree exists with built `server/dist/` output, `eslint .` walked into it and the `--max-warnings 0` gate blocked every push. The root `server/dist/` entry is repo-root-relative and didn't match the nested path.
