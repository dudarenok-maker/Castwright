---
status: stable
shipped: 2026-07-04
owner: null
---

# Setup checker defense-in-depth diagnosis

> Status: stable
> Key files: `server/src/routes/setup-diagnosis.ts`, `server/src/tts/venv-core-package.ts`,
> `server/src/tts/sidecar-supervisor.ts`, `server/src/routes/sidecar-health.ts`,
> `server/src/routes/setup-readiness.ts`, `src/lib/api.ts`, `src/lib/use-setup-diagnosis.ts`,
> `src/components/blocker-fix-action.tsx`, `src/components/ModelControlPill.tsx`,
> `src/components/setup/setup-wizard.tsx`, `src/components/setup/step-models.tsx`,
> `src/components/setup/step-ffmpeg.tsx`, `src/components/status-popover.tsx`,
> `src/components/layout.tsx`, `src/components/top-bar.tsx`
> URL surface: `#/setup` (wizard), the global header Status popover (any stage)
> OpenAPI ops: `GET /api/setup/readiness` (response shape changed, additive),
> `POST /api/sidecar/restart` (new `exhausted` branch), plus the pre-existing
> `POST /api/setup/venv/bootstrap`, `POST /api/setup/{kokoro,qwen,coqui}/install`,
> `POST /api/ollama/{install,pull}` fix-action endpoints (reused, not new)

## Benefit / Rationale

- **User:** every setup blocker (voice engine runtime, voice engine package,
  ffmpeg, analyzer) now tells you *why* it isn't ready and, where a safe
  automated fix exists, gives you a working one-click button — instead of a
  flat "not ready" with no path forward. This shows up identically in both
  the Setup wizard and the always-available Status popover, so you're never
  stuck reading the same unhelpful message from two different screens.
- **Technical:** the diagnosis engine (`diagnoseSidecar`/`diagnoseTts`/
  `diagnoseFfmpeg`/`diagnoseAnalyzer`) is a set of pure functions — no I/O —
  fed by exactly one round of live probing per `GET /readiness` call. Adding
  a new cause or action is a matter of extending one cause chain and one
  action-mapping table, not touching every UI consumer separately.
- **Architectural:** locks in a single shared diagnosis engine on the server
  (one `GET /readiness` computes each blocker's diagnosis exactly once), so
  the wizard and the popover cannot structurally disagree about the same
  underlying cause — a risk called out explicitly in the design spec's
  Decision 1. The Status popover consumes this via the shared
  `useSetupDiagnosis()` polling hook; the Setup wizard route
  (`src/routes/index.tsx`'s `SetupRoute`) currently has its own inline
  fetch-on-mount + manual-refetch instead of the hook — both still read the
  identical server response shape, so this is a code-duplication gap, not a
  data-disagreement risk. Wiring `SetupRoute` onto the shared hook too is a
  candidate follow-up (it would add a 10s poll to the wizard screen, a minor
  behavior change worth a deliberate decision rather than a drive-by fix
  here).

## Architectural impact

- **New seam:** `BlockerDiagnosis` (`{status, cause, message, remediation,
  action?}`) replaces the old flat `BlockerStatus` (`'pass' | 'fail'`) as the
  per-blocker shape inside `SetupReadiness`. This is a breaking shape change
  to `GET /api/setup/readiness`'s response — every frontend consumer was
  migrated in the same PR (no dual-shape transition period), since the type
  is generated/shared, not independently versioned.
- **New seam:** `BlockerAction` (`{kind, label, params?, href?}`) is an
  optional field on `BlockerDiagnosis` — present only when a safe, automated
  fix exists for that specific cause. `<BlockerFixAction>` is the one shared
  component that knows how to render and drive every `BlockerActionKind`
  (`venv-bootstrap`, `kokoro-install`, `qwen-install`, `coqui-install`,
  `sidecar-restart`, `ollama-install`, `ollama-pull`, `navigate`).
- **New seam:** `resetAndRespawn()` (`server/src/tts/sidecar-supervisor.ts`,
  renamed/merged from `clearTripAndRespawn()`) now recovers BOTH the
  code-43-trip case and the new plain-exhaustion case
  (`consecutiveFailures > maxConsecutiveFailures`) in one function. Safety
  under concurrent calls is a **caller-side contract**, not an internal
  guard: the function itself has no dedup/epoch check, so any future caller
  MUST re-check `exhaustedEvent()`/`tripEvent()` synchronously — with **no
  `await` in between** — immediately before calling it, exactly as
  `POST /api/sidecar/restart` already does. Inserting an `await` (e.g. a
  config read) between the guard check and the call reopens a double-spawn.
- **Invariant preserved:** `buildSetupReadiness()` is still a pure function
  (no I/O) — all live probing happens exactly once per `GET /readiness`
  call, in the route handler, and is threaded in as plain data. This
  mirrors the pre-existing convention from plan 210 (the original fs-21
  wizard) and was deliberately not broken by this plan.
- **Invariant preserved:** diagnosis order is fixed, not parallel —
  `diagnoseSidecar()` must run first and its result is passed into
  `diagnoseTts()`, because the tts cause chain's `sidecar-blocked` gate
  depends on the sidecar's own diagnosis. `ffmpeg` and `analyzer` are
  independent of the sidecar and of each other.
- **Reversibility:** if this needs to be rolled back, the response shape
  change is the only hard-to-reverse piece (a live client polling the old
  flat shape against a rolled-back server would see stale-looking data, not
  a crash — every consumer already null-checks `readiness`). No data
  migration, no persisted-state shape changed.

## Invariants to preserve

1. `BlockerCause` (`src/lib/api.ts`, mirrored byte-for-byte in
   `server/src/routes/setup-diagnosis.ts`) has exactly 19 members: 18 fail
   causes across the four blockers plus `'pass'`. The frontend and server
   copies of this union must stay identical — there is no shared package
   between them, so a divergence is silent until a specific cause is hit at
   runtime.
2. The sidecar cause chain evaluates, first-match-wins: `python-missing` →
   `venv-missing` → `venv-broken` → `supervisor-exhausted` →
   `supervisor-tripped` → `unreachable-transient` →
   `unreachable-no-supervisor` → `pass`. `python-missing` is nested inside
   the venv-missing check (a `spawnSync` probe, cached 10s via
   `probePython312Cached()`), not a standalone first layer evaluated on
   every poll (`server/src/routes/setup-diagnosis.ts`).
3. The tts cause chain's `sidecar-blocked` gate fires when the sidecar
   diagnosis is `status: 'fail'` with a cause **other than**
   `unreachable-transient` — a merely-booting sidecar must NOT gate tts
   (disk-only checks like `no-engine-installed`/`weights-missing` stay
   answerable independent of sidecar reachability), but
   `unreachable-no-supervisor` (autoStart off, permanent) DOES gate it.
4. `anyEngineUsable` in `TtsDiagnosisInput` combines disk-readiness AND live
   package-health (`!kokoroPackageConfirmedBroken`/`!qwenPackageConfirmedBroken`)
   into one signal that gates BOTH `weights-missing` and `package-broken` —
   this prevents a live-broken engine's `package-broken` verdict from
   failing the whole tts blocker when a *different* engine is fully usable
   (`server/src/routes/setup-diagnosis.ts`, `diagnoseTts`).
5. `resetAndRespawn()` (`server/src/tts/sidecar-supervisor.ts`) contains no
   `await` anywhere in its body — every statement is synchronous. Any future
   caller must preserve the same "no `await` between guard check and call"
   contract described above.
6. `suppressUnreachableAction` on `<ModelControlPill>` only hides the
   generic Retry button when the sidecar diagnosis is BOTH `status: 'fail'`
   AND has a cause other than `unreachable-transient` — a transient boot
   state has no diagnosis-block action either, so the pill's own Retry stays
   the only affordance in that case (`src/components/layout.tsx`).

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/setup-diagnosis.test.ts`) — pins every
  cause-chain branch for `diagnoseSidecar`/`diagnoseTts`/`diagnoseFfmpeg`/
  `diagnoseAnalyzer`, including the `sidecar-blocked` gate's
  `unreachable-transient` exclusion, the `anyEngineUsable` mixed-state cases,
  and the `model-not-pulled` → `ollama-pull` allowlist gate.
- Vitest server (`server/src/tts/venv-core-package.test.ts`) — asserts
  `venvCorePackageInstalled()` detects `fastapi` in site-packages on both
  Windows and posix layout.
- Vitest server (`server/src/tts/sidecar-supervisor.test.ts`) — asserts
  `exhaustedEvent()` is computed live from `consecutiveFailures` (not a
  stored flag), and `resetAndRespawn()` recovers both the code-43-trip and
  plain-exhaustion paths.
- Vitest server (`server/src/routes/setup-readiness.orchestration.test.ts`)
  — pins the route handler's call order (sidecar diagnosed before tts),
  gating, and probe counts (exactly one extra `probeSidecarHealth()` call
  for the package-broken flags).
- Vitest frontend (`src/lib/api.test.ts`) — asserts `mockGetSetupReadiness()`'s
  ready/not-ready shapes.
- Vitest frontend (`src/lib/use-setup-diagnosis.test.ts`) — asserts the
  polling hook fetches on mount, re-polls on interval, and cleans up its
  timer on unmount.
- Vitest frontend (`src/components/blocker-fix-action.test.tsx`) — asserts
  all 6 action kinds drive their respective endpoints correctly, including
  the `ollama-pull` `'pulled'` terminal-status handling and the
  `ollama-install` Windows manual-installer-path handshake (checked in both
  the POST response and the poll response).
- Vitest frontend (`src/components/setup/setup-wizard.test.tsx`,
  `step-models.test.tsx`, `step-ffmpeg.test.tsx`) — assert each step renders
  the right diagnosis message/action per blocker.
- Vitest frontend (`src/components/status-popover.test.tsx`,
  `src/components/layout.test.tsx`) — assert all four diagnosis blocks
  render in the popover, the ffmpeg banner shows only on fail, and the
  sidecar Retry-suppression branch in `layout.tsx` is exercised (both the
  actionable-cause and `unreachable-transient` branches). `top-bar.test.tsx`
  (unchanged by this plan) still passes with the two new optional
  `StatusDetail` fields threaded through it.
- Playwright e2e (`e2e/setup-checker-venv-fix.spec.ts`) — drives the real
  failure→fix→pass cycle for the sidecar's `venv-missing` diagnosis: mocks
  the venv-bootstrap job endpoints, confirms the exact diagnosis message and
  action button render, clicks it, confirms the busy state, then confirms
  the badge flips to "Runtime ready" once the job completes.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`) unless otherwise
noted. The `?setup=notready` query param (consumed on `#/`, latched into
`sessionStorage` so it survives the redirect to `#/setup`) puts the app into
the not-ready mock state.

1. **`http://localhost:5173/?setup=notready`** → redirects to `#/setup`,
   guided wizard opens on Step 1 (Environment).
2. Click **Next** twice → Step 3 (Models). Expect a "Runtime needed" badge
   under **Voice engines** reading "Voice engine runtime not set up." with a
   **Set up the voice engine runtime** button.
3. Click that button → badge shows a busy/"Working…" state, then (once the
   mocked job completes) flips to "Runtime ready" and the Voice-ready badge
   clears its own diagnosis block.
4. Click the header **Status pill** from any stage → the popover shows the
   same four sections (Voice engines / Analysis), each with the matching
   diagnosis block or nothing if passing — confirms the wizard and popover
   agree, since both read the identical `GET /readiness` response.
5. **Real-backend causes not reachable via the mock latch** (needs a real,
   deliberately-broken local sidecar/Ollama to exercise; not required for
   every PR, tracked here for the eventual on-box acceptance pass):
   - Stop Ollama with `SEG_ANALYZER=local` and no `GEMINI_API_KEY` →
     Analyzer badge should read `ollama-unreachable` with an **Install
     Ollama** action (or `model-not-pulled` with a **Pull `<model>`** action
     if Ollama is up but the model isn't pulled).
   - Rename/delete `server/tts-sidecar/.venv` → sidecar badge should read
     `venv-missing` (not crash-loop straight to `supervisor-exhausted`).
   - Interrupt a venv build after `python -m venv` but before `pip install`
     finishes → sidecar badge should read `venv-broken`, not `venv-missing`.
   - Set `autoStartSidecar` off in Advanced Settings with no sidecar running
     → sidecar badge should read `unreachable-no-supervisor` with a
     **navigate to the setting** action, not a "try again shortly" that
     never resolves.
   - Remove `ffmpeg`/`ffprobe` from `PATH` → ffmpeg badge should read the
     matching `ffmpeg-missing`/`ffprobe-missing`/`both-missing` cause, text
     only (nothing in-app can safely PATH-edit this).

## Out of scope

- **A standing, always-rendered "recheck" button on every blocker card**
  (spec Design §1 originally described one). `useSetupDiagnosis()`'s 10s
  poll plus `<BlockerFixAction>`'s post-mutation refetch already surface a
  fix within one poll cycle, and the bespoke Setup-wizard widgets
  (`VenvBootstrap`, `step-ffmpeg.tsx`) already ship their own "Re-check"
  buttons for the one case that actually needs one (a fix applied entirely
  outside the app between polls). A standing recheck button specifically in
  the Status popover is a small, cheap follow-up if this gap is felt in
  practice.
- **In-place venv teardown for `venv-broken`.** The `venv-bootstrap` action
  reuses the existing job, which fails with an honest, specific error
  message telling the user to delete the venv folder themselves before
  retrying — one manual step short of fully one-click. See
  `docs/features/210-fs21-first-run-wizard.md` (archived) and
  `venv-migration.mjs`'s `classifyVenvState`/`needs-reinstall` path for the
  existing mechanics this plan deliberately did not extend.
- **Root-cause diagnosis for a persistent, un-fixable fault.** If
  `resetAndRespawn()` is clicked and the underlying fault is still present
  (e.g. a hardware/GPU issue unrelated to the venv), the supervisor simply
  crash-loops back to `supervisor-exhausted` again — this mirrors real
  operator behavior today (manual retry after checking logs); the fix
  button stays clickable for another attempt rather than locking out.

## Ship notes

Shipped 2026-07-04. Implemented via `subagent-driven-development` across 18
tasks on `feat/setup-checker-diagnosis` (branched from `main` via the merged
`docs/setup-checker-diagnosis-spec` spec/plan branches). No behavior delta
from the approved design spec
(`docs/superpowers/specs/2026-07-03-setup-checker-defense-in-depth-design.md`)
or plan
(`docs/superpowers/plans/2026-07-03-setup-checker-defense-in-depth-diagnosis.md`)
beyond what those documents' own multi-round adversarial reviews already
folded in. Two implementer process incidents (subagent commits landing on a
different, shared checkout) were recovered via safe cherry-picks with no
work lost — see the plan's own progress ledger for detail. Two additional
gaps surfaced and were closed during implementation, beyond the plan's
literal task list: a missing test for the `layout.tsx` Retry-suppression
branch (Task 15 fix), and one leftover flat-string test fixture
(`src/views/setup.test.tsx`) that evaded the Task 16 migration sweep's grep
pattern because it was an inline prop literal rather than a named mock
helper (closed alongside an unrelated stray `tsc` error).
