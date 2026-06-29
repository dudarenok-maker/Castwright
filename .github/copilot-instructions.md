# Copilot helper for Castwright (repo root)

This file is for future Copilot/Claude Code sessions to bootstrap quickly in this repository.
Refer to CLAUDE.md and CONTRIBUTING.md for deeper context; this is a concise, actionable summary.

---

## 1) Build, test, and lint (quick reference)

Prereqs: Node >= 20.19.0, Python 3.12 (for sidecar), ffmpeg on PATH. See INSTALL.md for platform setup.

Root-level npm scripts (use from repository root):
- Start / dev
  - npm start                # frontend + server + TTS sidecar (one-shot)
  - npm run dev              # vite frontend (:5173) + server dev
  - npm run dev:lan          # LAN HTTPS dev (host 0.0.0.0)
- Build / preview
  - npm run build            # tsc -b && vite build && npm --prefix server run build
  - npm run preview
- Typecheck / formatting / lint
  - npm run typecheck
  - npm run lint             # eslint . --max-warnings 0
  - npm run format
  - npm run format:check
- Tests
  - npm test                 # Vitest frontend (single-run)
  - npm run test:watch       # Vitest watch
  - npm run test:server      # server Vitest
  - npm run test:server-slow # slow server tests (special config)
  - npm run test:scripts     # Pester (PowerShell) helpers
  - npm run test:sidecar     # pytest harness in server/tts-sidecar/
  - npm run test:e2e         # Playwright chromium (mock mode)
  - npm run test:e2e:visual  # visual snapshot run
  - npm run test:all         # aggregated harnesses
- Verify
  - npm run verify           # full battery (typecheck + all tests + e2e + build)
  - npm run verify:fast      # fast subset (pre-commit gate)
  - npm run verify:quick     # alias for test:all

How to run a single frontend test file (examples):
- npx vitest path/to/file.test.ts         # runs that test file
- npm run test -- path/to/file.test.ts    # pass args through npm script

How to run a single server test file:
- npm --prefix server run test -- server/src/routes/foo.test.ts

Playwright single spec:
- npx playwright test e2e/responsive/my.spec.ts
- npm run test:e2e -- e2e/responsive/my.spec.ts

Sidecar/pytest (optional venv):
- cd server/tts-sidecar && .\.venv\Scripts\activate && pytest -k "pattern"
- npm run test:sidecar (wrapper; prints SKIP if venv not bootstrapped)

Pester (PowerShell scripts tests):
- Install Pester 5 once: Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck
- npm run test:scripts

---

## 2) High-level architecture (big picture)

- Frontend: Vite + React + TypeScript (src/). Uses Redux Toolkit slices under src/store/; UI stage is a discriminated union in ui-slice.
- Backend: Node/Express in server/src; openapi.yaml is the API contract and is the source of truth for generated types (src/lib/api-types.ts).
- Sidecar: Python TTS engine in server/tts-sidecar/ (FastAPI + PyTorch-based engines). Tests are pytest-based under that folder.
- Companion: Flutter Android app under apps/android/ (native companion builds handled by npm script apk:companion).
- CI & gating: Local pre-push hooks run npm run verify. GitHub Actions are opt-in via a run-ci label; verify.yml exists under .github/workflows.

Design notes Copilot should know:
- OpenAPI is authoritative for shapes; avoid hand-editing api types.
- Mocks behind VITE_USE_MOCKS — components import from src/lib/api.ts and don't care which implementation is active.
- Brand assets (brand/, mockups/) are local-only (git-ignored); public/ contains generated runtime assets.

---

## 3) Key conventions & repo-specific patterns

- Commit & branch conventions enforced by hooks (see CONTRIBUTING.md):
  - Branches: <type>/<scope>-<slug> (e.g., feat/server-batch-retry)
  - Commit subjects: <type>(<scope>): <subject> — pre-commit-msg hook rejects others
- Worktree helpers for parallel Claude/agent sessions:
  - scripts/wt-new.mjs and scripts/wt-merge.mjs automate creating isolated worktrees and reconciling multiple agent branches.
  - Use git worktree when running concurrent Copilot/Claude sessions; the repo expects that pattern.
- Testing discipline:
  - Every change must add or update paired automated tests. UI-visible changes should include an e2e Playwright spec when crossing router/RTK/layout seams.
  - Flaky tests: use quarantinedIt utilities; test:quarantine exists.
- UI state: ui.stage is a discriminated union; maintain its shape (don't flatten into booleans).
- Router: hash-based grammar (src/lib/router.ts) — use parseHash/stageToHash, keep router logic decoupled from components.
- Type generation: run npm run openapi:types after changing openapi.yaml; prefer the generated src/lib/api-types.ts.
- Mock flag: VITE_USE_MOCKS toggles mock vs real API. Use it when running e2e vs unit tests as intended.
- Precommit & prepush lifecycle:
  - prepare runs husky; pre-commit runs verify:fast:scoped; pre-push runs full verify.
- Tests organization:
  - Frontend vitest next to code. Server vitest under server/. Sidecar pytest under server/tts-sidecar. Scripts Pester tests under scripts/tests.

---

## 4) Files & docs for Copilot to consult (authoritative sources)

- CLAUDE.md — long-form project context and working principles (this repo's primary assistant brief). Consult first for policy/mode-of-work.
- CONTRIBUTING.md — branch/commit rules, branching/worktree helpers, verify workflow.
- README.md & INSTALL.md — environment and install prerequisites.
- openapi.yaml — API contract; regenerate types with npm run openapi:types.
- .github/workflows/verify.yml — how CI verify is composed; label-gated CI behavior.

Copilot sessions should prefer these files over ad-hoc assumptions.

---

## 5) Notes for automated assistants (explicit guidance)

- When making code changes: keep changes surgical. Touch only what you must and include paired tests.
- If running multiple assistant sessions: spawn isolated worktrees (scripts/wt-new.mjs) to avoid overlapping diffs and port collisions.
- When proposing a change that affects build/test lifecycle, include the exact npm script(s) and the smallest targeted test/verify command to run locally.
- Respect private/brand assets: do not attempt to read or require files under brand/ or mockups/ — they are local-only and not part of CI.

---

Generated by a Copilot CLI helper on 2026-06-29.

(If a pre-existing .github/copilot-instructions.md exists, merge these sections selectively; prefer preserving human-written notes.)
