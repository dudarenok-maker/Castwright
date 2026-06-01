---
status: active
shipped: null
owner: null
---

# 164 — Dependency & CI-action hygiene (ops-8 Node-24 bump · srv-4 re-audit · safe bumps · deferred-major tracking)

> Status: active — code landed; ops-8 acceptance is the PR's own green CI run with no Node-20 deprecation annotations.
> Key files: `.github/workflows/*.yml`, `.github/actions/setup/action.yml`, `package.json`, `server/package.json`, `.nvmrc`, `docs/BACKLOG.md`
> URL surface: none (CI / build / dependency hygiene)
> OpenAPI ops: none

## Benefit / Rationale

- **Technical (ops-8, deadline):** GitHub forces JS actions onto the Node-24 runtime on **2026-06-16** and removes the Node-20 runner on **2026-09-16**. Every workflow pinned `@v4` action majors that run on the deprecated Node-20 runtime. Bumping to the latest Node-24 majors avoids CI breaking out from under us mid-June.
- **Technical (srv-4):** keeps the `npm install` deprecation surface clean and re-audited (2026-06-01). Two of three tracked chains already cleared in plan 104; the `@google/genai` chain is re-confirmed still upstream-blocked.
- **Technical (safe bumps):** TypeScript on the latest 5.x line, `@google/genai` current within v2, and a documented Node floor (`engines` + `.nvmrc`) so contributors and `npm install` agree on the runtime.
- **Architectural (deferred-major tracking):** every framework major that is now behind (React 19, Vite 7 / Vitest 3, Tailwind 4, Express 5, Zod 4, react-router-dom 7, TypeScript 6, pdfjs-dist 5) is filed as a research-complete BACKLOG entry so a later round can pick any of them up without re-scoping.

## Architectural impact

- **CI action majors bumped** (latest stable, all ship the Node-24 runtime, verified via `gh api repos/<action>/releases/latest` on 2026-06-01):
  - `actions/checkout@v4 → @v6`
  - `actions/setup-node@v4 → @v6`
  - `actions/cache@v4 → @v5`
  - `actions/upload-artifact@v4 → @v7`

  Touched: `.github/actions/setup/action.yml` (the shared composite most jobs funnel through — a Node-major bump stays a near-one-file edit), `verify.yml`, `cross-os.yml`, `release.yml`, `pr-title-lint.yml`, `regen-visual-baselines.yml`. The `node24-modules` cache-key string and the `node-version: '24'` inputs were already correct and are unchanged.
- **Compatibility checked:** setup-node v6 adds auto-caching when a `packageManager` field is present in `package.json` — we set no such field and keep our explicit `cache: 'npm'` + separate `actions/cache` node_modules step, so no double-cache. checkout v6 keeps `fetch-tags: false` default, so release.yml's annotated-tag-restore workaround stays load-bearing (comment de-pinned from `@v4`).
- **Dependency bumps:** `@google/genai ^2.0.1 → ^2.7.0`; `typescript ^5.4.0 → ^5.9.0` (root + server); new root `engines.node >= 20.6.0` (the documented `process.loadEnvFile` floor) + `.nvmrc` = `24` (the tested CI/dev runtime). `engines` is informational — npm does not hard-enforce without `engine-strict`.
- **Reversibility:** every change is a version-string edit + lockfile refresh; revert the commit to restore.

## Invariants to preserve

- The `verify` job `name:` stays exactly `npm run verify` (branch-protection required check) — untouched here.
- Server `@types/node` deliberately stays on major 20 (encodes the Node-20.6 min-runtime floor so server code can't reach for Node-21+ APIs); NOT aligned up to root's `@types/node@25`. Surfaced, intentionally not changed.
- The Python sidecar compat pins (`transformers<5.0`, `kokoro-onnx<0.5`, `onnxruntime-gpu<2.0`) are deliberate and out of scope.

## srv-4 re-audit result (2026-06-01)

Bumped `@google/genai → 2.7.0` and re-ran `npm ls` on the server tree. The `node-domexception@1.0.0` chain **persists** (`@google/genai@2.7.0 → google-auth-library@10.6.2 → gaxios@7.1.4 → node-fetch@3.3.2 → fetch-blob@3.2.0 → node-domexception`); still no `@google/genai` v3. **No** `glob` deprecation sub-chain exists in `gaxios@7.1.4` (the research-flagged `gaxios`→`glob` path does not apply to our resolved tree). srv-4 stays open, refreshed.

## Test plan

### Automated coverage

- No new unit test — this is a CI-config + dependency-floor change with no runtime-code delta. The acceptance harness IS the CI run:
  - **ops-8 acceptance:** the PR's `verify.yml` run (exercising checkout@v6 / setup-node@v6 / cache@v5 via the composite) shows **zero "Node.js 20 actions are deprecated" annotations** and stays green; `cross-os.yml` + `release.yml` confirmed by manual dispatch / next release.
  - **bump regression:** `npm run verify` (typecheck + all tests + e2e + build) stays green, with attention to `server/src/analyzer/gemini.*` tests after the `@google/genai` bump.
- This explicit no-new-test note satisfies the CLAUDE.md "say so when a step doesn't apply" rule — there is no code seam to pin; a YAML/version edit is verified by the pipeline running clean.

### Manual acceptance walkthrough

1. `git grep '@v4' .github/` → no `actions/*` matches remain.
2. Fresh `npm install` (root) + `npm install --prefix server` → the only `npm warn deprecated` is the `@google/genai` `node-domexception` chain (server side); root is clean.
3. Push as a draft PR → `npm run verify` locally green → `gh pr ready` fires one CI run → confirm no Node-20 annotations.

## Out of scope

- All framework-major upgrades — filed as research-complete BACKLOG entries (`fe-18` React 19, `fe-19` Vite 7 + Vitest 3, `fe-20` Tailwind 4, `fe-21` react-router-dom 7, `ops-10` TypeScript 6, `srv-24` Express 5, `srv-25` Zod 4, `srv-26` pdfjs-dist 5) under "Dependency major upgrades (deferred)".
- srv-4 stays open (upstream-blocked); this round only re-audits + bumps genai within v2.

## Ship notes

(Filled when status → stable: shipped date + merge SHA + confirmation the PR's CI run carried no Node-20 annotations.)
