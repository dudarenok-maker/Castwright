# fs-21 — First-run setup wizard (cross-platform setup owner)

> **Status:** design (awaiting review) · **Date:** 2026-06-12 · **Issue:** [#474](https://github.com/dudarenok-maker/Castwright/issues/474)
> **Owes:** a `docs/features/NN-*.md` regression plan at implementation (plans currently reach 208 → next free is 209).

## Summary

A guided, cross-platform (Windows / macOS / Linux) first-run flow that becomes the **single owner of post-install setup for every platform**. Both installers (`ops-1` Windows `.exe`, `ops-15` macOS `.dmg`) and the Docker deploy (`ops-2`) ship only the app + runtime prerequisites and hand off here, so model install + verification is identical across OSes rather than reimplemented per installer.

The wizard is an **orchestrator** over seams that already exist — the Model Manager install/inventory backends, the Ollama analyzer install/pull bootstraps, the existing `diagnostics.ts` health aggregator, the fs-43 device panel (`device-panel.tsx` over `/api/info`), the fs-22 bundled demo book, and the real generation pipeline — plus a small amount of new backend (a readiness shape *derived from* `diagnostics.ts`, a Kokoro install route, a light smoke endpoint, and — per the venv decision below — a sidecar-bootstrap path).

## Decisions locked in brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| Gate model | **Adaptive gate** | Block only when synthesis is genuinely impossible; guide everything else. |
| Hard blockers | **ffmpeg + ≥1 TTS engine (+ its runtime) + an analyzer** | The minimum to produce an audiobook end to end. GPU is *not* a blocker (CPU fallback survives). |
| Cross-platform install ambition | **Full parity** | v1 owns one-click *model* install on all three OSes, including a new Kokoro install route. (ffmpeg is verify+instruct — see below.) |
| Smoke test | **Two-tier**: a light always-on check + an opt-in full run on the bundled demo book | Light proof gates completion cheaply; the full run is faithful end-to-end *and* a first-listen delight moment. |
| Wizard shape | **Hybrid (one component, two modes)** | Guided/linear on first run; checklist on re-entry from Account. |
| Persisted state | **`setupCompletedAt` only** | A hard gate is purely *derived*; a separate "dismissed" flag would be meaningless (it could never grant app access). |
| Sidecar venv ownership | **Z — hybrid** (recommended; confirm on review) | Installer owns the venv; the wizard *detects* a missing/broken venv and offers a one-click bootstrap **when Python 3.11 is present**, degrading to instruct otherwise. |

## Architecture & app surface

- **New stage variant, not a modal.** Add `{ kind: 'setup' }` to the discriminated-union `ui.stage` (mirroring how `model-manager` was added in plan 193), routed at `#/setup` via pure `parseHash`/`stageToHash`. A real stage survives reload, deep-links, and slots into the e2e coverage spec.
- **The adaptive gate is derived, not flag-driven — and it reuses `diagnostics.ts`.** The existing `server/src/routes/diagnostics.ts` already aggregates the checks we need (`CheckId = 'gpu' | 'sidecar' | 'asr' | 'analyzer' | 'gemini' | 'ffmpeg' | 'disk'`), each returning a pass/fail + a human-readable detail line, and is built to "probe the sidecar once and reuse it." So `GET /api/setup/readiness` is a **thin mapper over diagnostics → the hard-blocker readiness shape**, adding only the probes diagnostics lacks: venv-present-on-disk, per-engine *weights* presence (from `/api/models/inventory`), and Ollama *model-pulled* state. It must NOT reinvent the aggregator. It degrades gracefully with the sidecar down (the diagnostics `sidecar`/`gpu` rows already model that).
- **Boot splash gates first paint.** Because the router is a pure URL↔stage map (it doesn't gate today), a short *"Checking your setup…"* splash blocks first render until readiness resolves, then redirects into `#/setup` if any hard-blocker fails. This avoids a flash-then-yank and is what makes **headless/Docker work for free** — a fresh container with no models serves the UI, the probe reports not-ready, and the same gate fires without any launcher event.
- **One persisted bit:** `setupCompletedAt` (user-settings, server-side) suppresses the *guided* intro on later launches and satisfies "doesn't re-run once completed." The hard gate stays purely derived, so removing a model later legitimately re-fires the gate in **checklist** mode (the Model Manager's "can't remove the in-use default → 409" guard already prevents a nasty mid-session yank).
- **Hybrid presentation, one component, two modes:**
  - *Guided* (first run, `setupCompletedAt == null`): linear paged flow, one step per screen, Back/Next, progress dots.
  - *Checklist* (re-entry from **Account → "Re-run setup"** / Admin, or a later launch where a blocker regressed): all steps visible, status per row, jump to any item. Resume is automatic because state is derived from live checks.
- **Reuse, don't rebuild:** install rows reuse `CoquiInstall` / `QwenInstall` / `WhisperInstall` and the Ollama analyzer section from the Model Manager; the readiness probe reuses `diagnostics.ts`; GPU facts are **sidecar-derived** (the diagnostics `gpu` row reads the sidecar's torch CUDA figures, so GPU info is simply absent until the venv/sidecar exist — consistent with GPU being info-only); the device-panel UI (`device-panel.tsx`) is reused for display; the full smoke run reuses fs-22 sample-load + the generation pipeline.

## Hard-blockers — precise definitions

The gate releases only when **all** of these pass; each is also a wizard step that reports `pass | fail` with remediation.

1. **Sidecar runtime reachable.** The Python sidecar responds *and* its venv exists. A missing venv means no engine can run, so this sits upstream of the TTS check. Ownership = **Z** (see below).
2. **ffmpeg present.** `ffmpeg -version` on PATH. **Verify + instruct only** on every platform (no bundled ffmpeg installer; it's the OS/installer's job). Per-OS copy-paste remediation + "Re-check".
3. **≥1 TTS engine with weights.** Kokoro is the default; **its weights are *not* in the release zip** (`build-release-zip.mjs` excludes `voices/kokoro/**`, "1.1 GB, fetched at install time"), so this blocker fires on *every* fresh install and is satisfied by the new one-click Kokoro install route (or Qwen/Coqui as alternates).
4. **An analyzer available**, matched to the resolved analyzer config:
   - `ANALYZER=gemini` → a Gemini API key is set (validated). **Recommended path — true zero local install.**
   - `ANALYZER=local` → the Ollama daemon is reachable **and** the configured model is pulled; falls back to a Gemini key if one is set.

GPU presence is surfaced (Step 1) but **never blocks** — CPU fallback is allowed.

**What opens the gate (and what the smoke test is *not*).** The hard gate — app access — opens the moment the hard-blockers above (Steps 1–3) pass, *derived live*, independent of the smoke test. The **smoke test (Step 5) is confidence, not a gate condition**: a user who has satisfied Steps 1–3 already has app access and could skip it. `setupCompletedAt` is stamped when the user finishes (or exits) the *guided* flow, only to suppress the guided re-intro. Consequence of choosing the adaptive gate, stated honestly: the issue's "prove the whole stack end-to-end *before* the user uploads" becomes **"offer proof," not "force it."** Guided mode walks the user into the smoke test by default, but it is not a wall.

## The steps

**Step 1 — Environment & sidecar** *(blocks only on sidecar-unreachable; GPU is info)*
OS/arch, GPU (CUDA / MPS / none + VRAM) — **sidecar-derived** (the diagnostics `gpu` row reads torch CUDA figures), so absent until the venv/sidecar exist — Python + sidecar reachability, venv presence, Node version. GPU is informational and *seeds the defaults* in Step 4 (CPU box → default to Kokoro, warn Qwen is slow). A missing venv / down sidecar surfaces the **Z** bootstrap affordance (below) or instruction.

**Step 2 — ffmpeg** *(hard blocker; verify + instruct)*
Pass shows the version; fail shows per-OS remediation (`winget install ffmpeg` / `brew install ffmpeg` / `apt install ffmpeg`) + Re-check.

**Step 3 — Models** *(hard blocker: ≥1 TTS engine AND an analyzer)*
- *TTS engine* — Kokoro present → green; absent → one-click **Install Kokoro** (new cross-platform route); Qwen/Coqui offered as alternates. At least one must end green.
- *Analyzer* — **Gemini key (recommended, zero local install)** validated with a cheap ping; **or** Ollama: install the daemon if absent (on **Windows this is a manual GUI `.exe` double-click** — surfaced honestly), then one-click pull the configured model.
- Whisper ASR is offered but **never blocks** (opt-in content-QA engine).
Install progress reuses the existing SSE-backed components, so long downloads survive reload exactly like the Model Manager.

**Step 4 — Defaults** *(skippable; sensible auto-picks)*
Default engine, analysis model, theme — pre-filled from Step 1, written through the existing `UserSettingsPatch` Save harness.

**Step 5 — Two-tier smoke test** *(locked until Steps 1–3 pass)*
- **Tier 1 — light check (automatic, on completion).** `POST /api/setup/smoke`: synth one fixed *committed* snippet with the default engine → ffmpeg assemble → audible inline clip, plus a cheap **analyzer liveness ping**. No book scaffold, no full analysis run. Pass = non-empty audio produced + assembled + plays (length/exit-code check, **not** a golden byte match — engines are stochastic). Fail names the broken stage with matching remediation.
- **Tier 2 — full run on the demo book (opt-in).** A "Hear a real audiobook now?" card loads **The Coalfall Commission** (fs-22, `POST /api/samples/the-coalfall-commission/load`, idempotent) and runs the **real generation pipeline** (all 13 voices synthesized + assembled) → ends in the Listen view with playable audio. The demo ships with a pre-designed cast and **no audio**, so generation *is* the end-to-end proof. **Flow caveat (verify at implementation):** a freshly-loaded sample may land in the **cast-confirm** state, not generate-ready (plan 207 routes to "cast-confirm or cast view depending on `book.status`"). So Tier 2 must either auto-advance past confirm for the demo, or the card walks the user through it — *not* assumed to be a single load→audio click. An optional **"re-analyze first"** toggle exercises the analyzer end-to-end for the thorough deployer. Refuses/queues if a generation is already active (no GPU contention); CPU-aware, progress-streaming budget (no false timeouts).

Finishing (or exiting) the guided flow stamps `setupCompletedAt`, so guided mode won't re-trigger — note the *app-access* gate already opened when Steps 1–3 passed (see "What opens the gate" above). The checklist stays reachable from Account.

## Cross-platform install work (the full-parity scope)

Audit of where the install backends stand today:

| Component | x-plat backend | In-app route | Gap to close |
|---|---|---|---|
| **Sidecar venv** | `start.{sh,ps1}` error if absent; manual `venv + pip install` | ✗ | Per **Z**: detect + optional one-click bootstrap when Python 3.11 present |
| **Kokoro** (default TTS) | `.ps1` + `.sh`, no `.mjs` | ✗ **none** | New `POST /api/kokoro/install` + `KokoroInstall` component |
| **Qwen-base** | `.mjs` + `.ps1` | ✓ | Verify mac/linux |
| **Coqui** | `.mjs` + `.ps1` + `.sh` | ✓ | Verify mac/linux |
| **Whisper** | `.mjs` | ✓ | Not a blocker — leave as-is |
| **Ollama daemon** | `install-bootstrap.ts` (per-platform) | ✓ (manual `.exe` on Win) | Verify; surface the Windows manual step |
| **Ollama model** | `pull-bootstrap.ts` (daemon must be up) | ✓ | Verify cross-OS |

New backend work:

1. **Kokoro install route** — `POST /api/kokoro/install` + a `KokoroInstall` SSE component + a `runInstallScript()` **platform-dispatch helper** (`.ps1` on Windows, `.sh` elsewhere). Targets the **versioned** `<install>/models/kokoro` path (per `setup-versioned-install.mjs`, which shares weights across releases — *not* the legacy `voices/kokoro`). ops-7 hash-verified; `windowsHide: true` on the spawn (commit-gate invariant).
2. **Sidecar bootstrap (per Z)** — detect Python 3.11 + venv; offer one-click `python -m venv + pip install -r requirements.txt` with streamed progress, degrading to instruction when Python 3.11 is absent. Reuses the platform-dispatch helper.
3. **Readiness probe** — `GET /api/setup/readiness` as a **thin mapper over the existing `diagnostics.ts` aggregator** → the hard-blocker `setupReadiness` shape, adding only the probes diagnostics lacks (venv-on-disk, per-engine weights from inventory, Ollama model-pulled). Explicitly *not* a parallel re-implementation. Works with the sidecar down. **Mockable to both ready and not-ready states** (query param / mock toggle) so dev and e2e can exercise both the gate firing and the happy path.
4. **Light smoke endpoint** — `POST /api/setup/smoke` (snippet → synth → assemble + analyzer ping); reuses real synth/assembly code, returns a per-stage breakdown.
5. **Install-backend parity audit** — run Qwen / Coqui / Ollama install on real macOS + Linux boxes and fix what breaks. **Time-boxed with a pressure-release valve:** if a backend can't be made cross-platform cheaply, degrade *that one engine* to instruct-only and file a follow-up rather than sinking v1.

## Edge cases & concurrency

- **Cross-tab:** readiness stays server-derived and is re-checked on focus, so a Tab-A completion releases Tab-B's gate via the existing BroadcastChannel sync — no stale local cache.
- **Reload mid-Tier-2 generation:** generation is the reload-resilient job; on reload the blockers now pass, the gate is open, and the running job resubscribes in the generation/Listen view. No special handling.
- **Model removed after completion:** gate re-derives and re-fires in checklist mode; the in-use-default removal guard prevents a mid-session yank.
- **Deep-link after gating:** a not-ready user hitting `#/listen` lands on `#/` after setup; no intended-destination restore in v1 (deliberate non-goal).
- **Offline + Gemini analyzer:** the Tier-1 analyzer ping needs network for the Gemini path; local/Ollama is fully offline. Acceptable.

## Delivery roadmap

Wave-structured, each independently reviewable with its own gate. Default disposition: one integration PR per parallel round, verified once (`integration/<date>`).

- **Wave 0 — Readiness spine** *(foundational, sequential)*: `GET /api/setup/readiness` as a **thin mapper over `diagnostics.ts`** (+ the 2-3 missing probes) + `{ kind: 'setup' }` stage + `#/setup` route + boot splash + `setupCompletedAt` + mock dual-state stub. *Gate:* typecheck + unit tests (mapper + selector + router redirect) + e2e stub that the gate fires when not-ready. (Reusing diagnostics keeps this wave small.)
- **Wave 1 — Cross-platform install parity** *(riskiest; owes on-box acceptance)*: Kokoro install route + `KokoroInstall` + `runInstallScript()` helper + sidecar bootstrap (Z) + the parity audit. *Gate:* server/sidecar unit tests for the route + dispatch helper. **On-box install acceptance (Mac + Linux) is documented-OWED**, not a CI gate.
- **Wave 2 — The wizard UI** *(hybrid; can run ∥ Wave 1 in a worktree, frontend scope)*: the `setup` view (two modes), 5 steps, reusing the existing installers + fs-43 panel; Account "Re-run setup" entry. *Gate:* vitest per step (pass/fail/remediation) + `e2e/responsive/coverage.spec.ts` entry.
- **Wave 3 — Two-tier smoke test**: Tier 1 endpoint + committed snippet fixture + inline player + mock stub; Tier 2 card wiring sample-load → generation → Listen + optional re-analyze. Completion stamps `setupCompletedAt`. *Gate:* server test (per-stage breakdown) + **the issue's required mock-mode e2e happy-path progression**.
- **Wave 4 — Docs & closure**: new `docs/features/209-fs21-first-run-wizard.md` regression plan + INDEX entry + BACKLOG row removal + `Closes #474`. Run `cross-os.yml` before any release announce.

**Parallelism:** Wave 0 lands first (spine). Then Wave 1 (server) ∥ Wave 2 (frontend, mocking the not-yet-real route via the existing install-component pattern) in worktrees → `integration/<date>`, verify between merges → Wave 3 → Wave 4.

## v1 Definition of Done

1. Fresh install on **Windows / macOS / Linux**: open app → gate fires → (Z: bootstrap sidecar if Python present) → one-click Kokoro + analyzer (ffmpeg + the Windows-Ollama `.exe` instructed) → defaults → Tier-1 smoke passes → optional demo-book full run plays audio → gate opens and never re-gates.
2. **Headless/Docker**: the same gate fires on first UI open, no launcher event needed.
3. Mock-mode e2e covers the happy-path progression (and the gate-fires-when-not-ready case).
4. On-box install acceptance (Mac + Linux) recorded as OWED in the plan.

## Out of scope / secondary gaps (explicitly not v1)

- ffmpeg **auto-install** (instruct-only by design).
- Owning Python/CUDA provisioning on every OS (Z bootstraps the venv only when Python 3.11 is already present).
- Tier-2 "re-analyze" is opt-in, not default.
- Whisper ASR never blocks.
- Installer packaging (`ops-1` / `ops-15` / `ops-2`) — separate work that *hands off* to this wizard. **Updated 2026-06-12 with the Z venv-ownership note:** native installers (`ops-1` #432 / `ops-15` #735) pre-build the sidecar venv (Python 3.11 stays the only hard prereq; the wizard's one-click bootstrap is the fallback); Docker (`ops-2` #433) bakes the venv into the image (wizard venv step = no-op there; venv is an image layer, not a mounted volume).
- Wizard-copy i18n (defers to `fs-14`).
- Intended-destination restore after gating.

## Testing strategy

- **Unit (frontend):** readiness selector, router redirect + boot-splash gating, each wizard step's pass/fail/remediation rendering, two-mode (guided/checklist) switch.
- **Unit (server/sidecar):** `runInstallScript()` platform dispatch, Kokoro install route (stubbed spawn), readiness shape (incl. sidecar-down degradation), smoke endpoint per-stage breakdown, sidecar-bootstrap detection.
- **e2e (mock mode):** happy-path progression through all five steps; gate-fires-when-not-ready; `coverage.spec.ts` entry for the new view.
- **Manual / on-box (OWED):** real one-click installs on a Mac + a Linux box; the Tier-2 demo-book full run producing audible output; the Z venv bootstrap on a box with Python 3.11.

## Issue handling

Per the review-first convention: land this spec branch first and **hold** filing the per-wave sub-issues until the spec is reviewed.

## Open question for review

- **Confirm the venv decision (Z).** The spec assumes Z (installer owns the venv; wizard offers one-click bootstrap when Python 3.11 is present). If you prefer **X** (pure installer responsibility, wizard instructs only) or **Y** (wizard fully owns Python/CUDA provisioning), the hard-blocker list, Wave 1 sizing, and the DoD shift accordingly.
