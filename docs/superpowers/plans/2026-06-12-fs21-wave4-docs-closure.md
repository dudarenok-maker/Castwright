# fs-21 Wave 4 — Docs + closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or direct, since this is docs-only). Checkbox (`- [ ]`) steps.

**Goal:** Close out the fs-21 first-run wizard epic: write the consolidated regression plan, index it, remove the backlog row, fold the spec corrections discovered during execution, and close the epic issue #474 — noting the on-box acceptance still OWED.

**Architecture:** Docs-only. One new regression plan `docs/features/210-fs21-first-run-wizard.md` (TEMPLATE-based, covering Waves 0/1/1b/2/3 invariants + manual acceptance + the OWED on-box matrix), an INDEX entry, the BACKLOG row removal, a spec-correction pass, and `Closes #474` in the PR.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Epic:** #474 · **Branch:** `feat/fs21-wave4-docs` off `main` (worktree `C:\Claude\Projects\wt-fs21-wave4`).

> **What shipped across the epic (for the regression plan):**
> - **Wave 0** (#745, merged): derived adaptive gate — `GET /api/setup/readiness` (thin mapper over `diagnostics.ts` + venv/weights probes), `{ kind:'setup' }` stage at `#/setup`, `setupCompletedAt`, Layout boot-splash gate (fail-open), `api.getSetupReadiness` dual-state mock, `SetupView` stub.
> - **Wave 1** (merged): in-app Kokoro installer — `install-kokoro.mjs` (SHA256-verify), `KokoroInstallBootstrap`, `/api/kokoro` polling route, `KokoroInstall` component, Model-Manager wiring; `detectKokoroInstalledOnDisk` DRY. (+ fixed a REPO_ROOT off-by-one in install-kokoro.mjs.)
> - **Wave 1b** (merged): venv bootstrap (decision Z) — `findPython311`, `bootstrap-venv.mjs`, `VenvBootstrap` + `/api/setup/venv`, `venv-bootstrap.tsx` with the no-Python degrade-to-instructions path.
> - **Wave 2** (merged): the 5-step hybrid guided/checklist wizard UI — `SetupWizard` + 5 step components, `POST /api/setup/complete`, `api.completeSetup`, `OllamaInstall` onInstalled, Account "Re-run setup" entry, `SetupRoute` re-fetch.
> - **Wave 3** (merged): two-tier smoke test — `POST /api/setup/smoke` (Tier 1, ok:false-never-500), `api.runSmokeTest`, Step-Finish smoke UI, Tier-2 demo-book run via the fs-22 flow.

> **OWED on-box acceptance (record in the plan, NOT a CI gate):** real Kokoro install on Mac + Linux; a real fresh venv bootstrap (Win/mac/linux); real audible Tier-1 smoke + Tier-2 demo generation on a box with sidecar+Kokoro+ffmpeg+GPU; and a `cross-os.yml` run before any release that ships this.

> **Standing rule:** adversarial plan review BEFORE executing.

---

## Task W1: regression plan `docs/features/210-fs21-first-run-wizard.md`

**Files:** Create `docs/features/210-fs21-first-run-wizard.md` (from `docs/features/TEMPLATE.md`).

- [ ] **Step 1: READ `docs/features/TEMPLATE.md`** + a recent shipped plan (e.g. `docs/features/archive/207-fs22-bundled-demo-book.md`) for the house format (frontmatter `status:`, Key files, Benefit, Architectural impact, Invariants, Test plan, Manual acceptance, Ship notes, Out of scope).
- [ ] **Step 2: Write the plan** covering the whole epic (use the "What shipped" summary above). Required content:
  - Frontmatter `status: active` (the feature is code-complete + CI-green, but on-box acceptance is OWED — not yet `stable`). `owner: null`.
  - Key files: the new routes (`setup-readiness.ts` incl. /readiness,/complete,/smoke; `kokoro-install.ts`; `venv-bootstrap.ts`), bootstraps (`kokoro-install-bootstrap.ts`, `venv-bootstrap.ts`), scripts (`install-kokoro.mjs`, `bootstrap-venv.mjs`), helpers (`python-discovery.ts`, `engine-presence.ts`, `kokoro-install-detect.ts`, `diagnostics/venv.ts`), frontend (`src/views/setup.tsx`, `src/components/setup/*`, the install components, `src/routes/index.tsx` SetupRoute, `layout.tsx` gate, `api.ts` setup methods), the `setupCompletedAt` setting.
  - **Invariants to preserve** (the load-bearing ones): the hard gate is DERIVED from `readiness.blockers` (never flag-driven — `setupCompletedAt` does not open it); `/api/setup/readiness` is a THIN mapper over `buildDiagnostics()` (don't re-implement); the boot gate FAILS OPEN on probe error; Kokoro/venv/smoke routes return graceful errors (ok:false / job error) never 500; the smoke button is always-enabled (not gated on readiness); `/api/setup/venv` mounts cleanly alongside `/api/setup`; install components survive reload (polling jobs); decision-Z degrade (no Python → instructions); guided-Next is never blocker-gated (the derived gate is the lock).
  - **Test plan** (automated): the unit/route/component/e2e tests added per wave (list the files). **Manual acceptance walkthrough:** fresh-box first-run (gate fires → install Kokoro + venv + analyzer → defaults → Tier-1 smoke plays → optional demo run); re-entry via Account "Re-run setup" → checklist mode; headless/Docker (gate fires on first UI open).
  - **OWED on-box acceptance matrix** (the bullet above).
  - **Out of scope / deferred:** ffmpeg auto-install (instruct-only); the layout `completedAt`-aware splash-skip optimization (deferred); Tier-2 "re-analyze first" toggle (not built — the demo's analysis is frozen); i18n (`fs-14`).
  - **Ship notes:** the 5 merge commits (Wave 0 #744/3cacff98 wait — use the actual merge SHAs: Wave 0 PR #744, Wave 1 #748, Wave 1b #749, Wave 2 #750, Wave 3 #751), dated 2026-06-12. (Verify the SHAs with `git log`.)
- [ ] **Step 3: Commit** `docs(docs): fs-21 first-run wizard regression plan (210) (fs-21 wave 4)`.

## Task W2: INDEX entry

**Files:** Modify `docs/features/INDEX.md`.

- [ ] **Step 1: READ `docs/features/INDEX.md`** — find the area section where fs-* / setup features live (and how shipped vs active plans are listed). Add an entry for `210 — fs-21 first-run setup wizard` with a one-line hook, under the correct area, matching the existing entry format.
- [ ] **Step 2: Commit** `docs(docs): index the fs-21 wizard regression plan (fs-21 wave 4)`.

## Task W3: BACKLOG row removal + spec-correction pass

**Files:** Modify `docs/BACKLOG.md`, `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md`.

- [ ] **Step 1: `docs/BACKLOG.md`** — find the `fs-21` row (the "First-run setup wizard (cross-platform setup owner)" Must item). It's now delivered across Waves 0-3 (modulo OWED on-box). REMOVE the row (the epic is delivered; the OWED acceptance lives in plan 210, not the backlog). If the backlog convention prefers collapsing delivered items, follow that — but the standard is: delivered → remove the row. Confirm no other backlog row depends on fs-21.
- [ ] **Step 2: Spec corrections** — append a short "Implementation deltas (folded in Wave 4)" note to the spec recording what execution corrected vs the original design: install progress is **polling, not SSE**; Kokoro uses a Node **`install-kokoro.mjs`** (no `.ps1`/`.sh` wrapper at runtime, no `runInstallScript` helper); the venv bootstrap was split to **Wave 1b**; the regression-plan number is **210** (209 was taken by fe-29); guided-Next is not blocker-gated (the derived gate is the lock); the layout `completedAt` splash-skip optimization was deferred. Keep it brief.
- [ ] **Step 3: Commit** `docs(docs): remove delivered fs-21 backlog row + spec deltas (fs-21 wave 4)`.

## Task W4: verify + PR (Closes #474)

- [ ] **Step 1:** `npm run verify` — docs-only, so the cache-aware battery should be fast/green (no code inputs changed). Retry the `test:server` contention flake if it appears.
- [ ] **Step 2:** `gh pr create --draft --title "docs(docs): fs-21 wave 4 — regression plan + closure" --body "Consolidated regression plan (210), INDEX entry, backlog-row removal, spec deltas. **Closes #474.** OWED on-box acceptance recorded in plan 210 (real installs on Mac/Linux, fresh venv bootstrap, audible smoke + demo generation) + run cross-os.yml before the next release that ships this."` → `gh pr ready` once green → merge.
- [ ] **Step 3:** After merge, confirm #474 closed (the `Closes #474` auto-closes on merge).

---

## Self-Review
- Closes the epic with the standard artifacts (regression plan + INDEX + backlog removal + issue close). Records OWED on-box acceptance in the plan (honest — the feature is CI-green but not on-box-verified).
- **Open questions for the adversarial review:** (1) verify the actual merge SHAs/PR numbers for the Ship notes via `git log` (don't trust the summary); (2) confirm the `fs-21` BACKLOG row exists + its exact form (remove vs collapse per the backlog convention in CLAUDE.md); (3) is `status: active` right, or should it be `stable` with an OWED caveat (the before-shipping checklist says stable → git mv to archive — but OWED on-box means not fully stable; confirm the convention for "code-complete, on-box-OWED"); (4) does closing #474 prematurely lose the OWED-acceptance tracking — should a follow-up "fs-21 on-box acceptance" issue be filed instead of/alongside closing #474 (per the user's review-first/backlog-currency rules)?
