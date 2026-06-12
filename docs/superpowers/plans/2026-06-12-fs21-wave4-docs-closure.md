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
  - Frontmatter: `status: active` (code-complete + CI-green, but on-box acceptance OWED — NOT `stable`, so do NOT `git mv` to archive/; `active` is the precise enum here, confirmed by the review). `shipped: null`. `owner: null`. (TEMPLATE has three frontmatter keys — include all three.)
  - Key files (CORRECT PATHS — verified): server routes `server/src/routes/setup-readiness.ts` (/readiness, /complete, /smoke), `server/src/routes/kokoro-install.ts`, `server/src/routes/venv-bootstrap.ts`; bootstraps `server/src/tts/kokoro-install-bootstrap.ts`, `server/src/tts/venv-bootstrap.ts`; **scripts at `server/tts-sidecar/scripts/install-kokoro.mjs` + `server/tts-sidecar/scripts/bootstrap-venv.mjs`** (NOT top-level `scripts/`); helpers `server/src/tts/python-discovery.ts`, `engine-presence.ts`, `kokoro-install-detect.ts`, `server/src/diagnostics/venv.ts`; frontend `src/views/setup.tsx`, `src/components/setup/*` (setup-wizard + 5 steps), the install components (`kokoro-install.tsx`, `venv-bootstrap.tsx`, `ollama-install.tsx`), `src/routes/index.tsx` (SetupRoute), `src/components/layout.tsx` (boot gate), `src/lib/api.ts` (getSetupReadiness/completeSetup/runSmokeTest), the `setupCompletedAt` user-setting.
  - **Invariants to preserve** (the load-bearing ones): the hard gate is DERIVED from `readiness.blockers` (never flag-driven — `setupCompletedAt` does not open it); `/api/setup/readiness` is a THIN mapper over `buildDiagnostics()` (don't re-implement); the boot gate FAILS OPEN on probe error; Kokoro/venv/smoke routes return graceful errors (ok:false / job error) never 500; the smoke button is always-enabled (not gated on readiness); `/api/setup/venv` mounts cleanly alongside `/api/setup`; install components survive reload (polling jobs); decision-Z degrade (no Python → instructions); guided-Next is never blocker-gated (the derived gate is the lock).
  - **Test plan** (automated): the unit/route/component/e2e tests added per wave (list the files). **Manual acceptance walkthrough:** fresh-box first-run (gate fires → install Kokoro + venv + analyzer → defaults → Tier-1 smoke plays → optional demo run); re-entry via Account "Re-run setup" → checklist mode; headless/Docker (gate fires on first UI open).
  - **OWED on-box acceptance matrix** (the bullet above).
  - **Out of scope / deferred:** ffmpeg auto-install (instruct-only); the layout `completedAt`-aware splash-skip optimization (deferred); Tier-2 "re-analyze first" toggle (not built — the demo's analysis is frozen); i18n (`fs-14`).
  - **Ship notes:** the 5 merge commits (Wave 0 #744/3cacff98 wait — use the actual merge SHAs: Wave 0 PR #744, Wave 1 #748, Wave 1b #749, Wave 2 #750, Wave 3 #751), dated 2026-06-12. (Verify the SHAs with `git log`.)
- [ ] **Step 3: Commit** `docs(docs): fs-21 first-run wizard regression plan (210) (fs-21 wave 4)`.

## Task W2: INDEX entry

**Files:** Modify `docs/features/INDEX.md`.

- [ ] **Step 1: READ `docs/features/INDEX.md`** — there is NO "Onboarding/Setup" area; the right home is **`### K. Cross-cutting invariants`** (where peer app-infra plans live — 209 help-view, 203 brand, 199 advanced-settings). Put the 210 entry under **Plans by area → section K**, NOT under "## Shipped (archive)" (that's for `stable`/archived plans only — 210 is `active`). Match the one-bullet format: `- [210 — fs-21 first-run setup wizard](210-fs21-first-run-wizard.md) — ` + status + one-line hook + `Refs #474`.
- [ ] **Step 2: Commit** `docs(docs): index the fs-21 wizard regression plan (fs-21 wave 4)`.

## Task W3: BACKLOG row removal + spec-correction pass

**Files:** Modify `docs/BACKLOG.md`, `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md`.

- [ ] **Step 1: `docs/BACKLOG.md`** — REMOVE the `fs-21` row (the "First-run setup wizard (cross-platform setup owner)" Must item under `## Must → Onboarding, install & updates`). Delivered Must → remove (CLAUDE.md: collapse is only for Won't items). **Leave the `fs-21` ID references in the sibling installer rows (`ops-1`, `ops-15`, `ops-16`, `ops-2`) intact** — they're permanent cross-references ("the wizard the installer hands off to"), not structural deps; do NOT scrub them. (A new on-box-acceptance follow-up row is added in W4.)
- [ ] **Step 2: Spec corrections** — (a) **FIX the stale reference on spec line ~111**: it says the regression plan is `209-fs21-first-run-wizard.md` → change to **`210-`** (209 is the help-view); and its Testing-strategy still cites a `runInstallScript()` helper that was never built → remove/correct it. (b) Append a brief "Implementation deltas (folded in Wave 4)" note: install progress is **polling, not SSE**; the in-app Kokoro install path is the Node **`install-kokoro.mjs`** (uniform `node` spawn) — the `install-kokoro.ps1`/`.sh` **remain as terminal/manual fallbacks** (they were NOT removed; "no wrapper" was never the claim); no `runInstallScript` helper; the venv bootstrap was split to **Wave 1b**; guided-Next is not blocker-gated (the derived gate is the lock); the layout `completedAt` splash-skip optimization was deferred.
- [ ] **Step 3: Commit** `docs(docs): remove delivered fs-21 backlog row + spec deltas (fs-21 wave 4)`.

## Task W4: on-box follow-up issue + verify + PR (Closes #474)

- [ ] **Step 1: File the on-box-acceptance follow-up** (so closing the epic doesn't drop the OWED work): `gh issue create --title "fs-21 — on-box acceptance (Mac/Linux installs, fresh venv, audible smoke + demo)" --label "area:fs,type:task" --body "<the OWED matrix from plan 210 + run cross-os.yml before release>. Follows #474 (delivered code-complete + CI-green; this tracks on-box verification)."` Then add a thin BACKLOG row for it under the same Must group (the backlog must stay current). (Confirm the exact label names exist — `area:fs`, `type:task`; adjust to the repo's taxonomy.)
- [ ] **Step 2:** `npm run verify` — docs-only, cache-aware battery fast/green (no code inputs changed). Retry the `test:server` contention flake if it appears.
- [ ] **Step 3:** `gh pr create --draft --title "docs(docs): fs-21 wave 4 — regression plan + closure" --body "Consolidated regression plan (210), INDEX (section K), backlog-row removal + on-box follow-up row, spec deltas + 209→210 fix. **Closes #474** (epic delivered: Waves 0/1/1b/2/3 merged, CI-green). On-box acceptance tracked in the new follow-up issue #<N> + plan 210's OWED matrix."` → `gh pr ready` once green → merge.
- [ ] **Step 4:** After merge: confirm #474 auto-closed; **remove the `needs-plan` label from #474** (plan 210 satisfies it) if it didn't auto-clear.

---

## Self-Review
- Closes the epic with the standard artifacts (regression plan + INDEX + backlog removal + issue close). Records OWED on-box acceptance in the plan (honest — the feature is CI-green but not on-box-verified).
- **Open questions for the adversarial review:** (1) verify the actual merge SHAs/PR numbers for the Ship notes via `git log` (don't trust the summary); (2) confirm the `fs-21` BACKLOG row exists + its exact form (remove vs collapse per the backlog convention in CLAUDE.md); (3) is `status: active` right, or should it be `stable` with an OWED caveat (the before-shipping checklist says stable → git mv to archive — but OWED on-box means not fully stable; confirm the convention for "code-complete, on-box-OWED"); (4) does closing #474 prematurely lose the OWED-acceptance tracking — should a follow-up "fs-21 on-box acceptance" issue be filed instead of/alongside closing #474 (per the user's review-first/backlog-currency rules)?
