---
status: active
shipped: null
owner: null
---

# fs-38 Part A — Wizard models-status single source of truth

> Status: active
> Key files: `server/src/tts/voice-engine-registry.ts`, `server/src/tts/models-status.ts`,
> `server/src/routes/models-status.route.ts`, `server/src/routes/setup-readiness.ts`,
> `src/lib/api.ts` (`ModelsStatus`, `getModelsStatus`), `src/components/setup/step-voice.tsx`,
> `src/components/setup/engine-card-status.ts`, `src/views/model-manager.tsx`,
> `src/components/{kokoro,qwen,coqui}-install.tsx`, `src/components/venv-bootstrap.tsx`
> URL surface: `#/setup` (Voice step), `#/model-manager`
> OpenAPI ops: none (`GET /api/setup/models-status` is hand-written in `server/src/routes/models-status.route.ts` + mirrored client-side in `src/lib/api.ts`, matching the existing `SetupReadiness`/`BlockerDiagnosis` convention — not openapi-generated)

Closes #1612 (epic #1613). Builds on
[257 — fe-49 analyzer/wizard split](257-fe49-analyzer-wizard-split.md), which put the Voice
step (`step-voice.tsx`) at step 4 of 7, and on
[archive/240 — Setup checker defense-in-depth diagnosis](archive/240-setup-checker-defense-in-depth.md),
which introduced `deriveEngineHealth`, the function this plan's `buildModelsStatus` reuses
rather than re-deriving.

## Benefit / Rationale

- **User:** The Voice step's runtime badge and each engine's install card can no longer
  disagree — previously the badge (readiness blockers) and the card (a separately-fetched
  per-engine probe) could read "Runtime installed" next to "Kokoro is not installed" for the
  same underlying state. Model Manager's voice-engine cards get the same guarantee. A
  transiently-starting sidecar now shows a neutral "starting" pill instead of a false amber
  "Runtime needed".
- **Technical:** One server-side computation (`computeModelsStatus`, `models-status.route.ts`)
  makes exactly one `probeSidecarHealth()` call and feeds both `GET /api/setup/readiness`'s
  `tts`/`sidecar` blockers and the new `GET /api/setup/models-status` endpoint. The client's
  install cards become controlled components (`status` prop from one `getModelsStatus()` fetch
  in the parent) instead of each self-fetching.
- **Architectural:** Locks a single-source-of-truth seam for voice-engine status: server
  computes once, every surface (wizard badge, wizard cards, Model Manager cards) renders the
  same object. Per-engine health can never be masked by an aggregate green, and a
  disk-vs-process two-axis split (`runtime.installedOnDisk` vs `runtime.process`) replaces the
  old conflated sidecar blocker.

## Architectural impact

- **New seams:**
  - `VOICE_ENGINES` registry (`server/src/tts/voice-engine-registry.ts`) — the three
    installable voice engines (kokoro, qwen, coqui) with disk probes + live selectors +
    default model key. Whisper (ASR), Gemini, and Piper are deliberately excluded — this
    registry is scoped to installable *voice-synthesis* engines only, not a general engine list.
  - `buildModelsStatus` (`server/src/tts/models-status.ts`) — pure composition over
    `deriveEngineHealth` (per engine) + runtime/info, independent of any HTTP concerns.
  - `computeModelsStatus` (`server/src/routes/models-status.route.ts`) — the route-level
    orchestration that makes the single `probeSidecarHealth()` call and feeds both
    `GET /api/setup/models-status` and (via `setup-readiness.ts`) the `sidecar`/`tts` blockers.
  - `ModelsStatus` client type + `api.getModelsStatus()` (`src/lib/api.ts`).
  - `runtimeLivenessPill` / `engine-card-status.ts` — pure classifier that keeps `starting`
    neutral (blue) and only `down`/`crashed` alarm (rose); `installedOnDisk:false` is always a
    blocker regardless of process state.
  - Controlled install cards: `KokoroInstall`/`QwenInstall`/`CoquiInstall`/`VenvBootstrap` now
    take a required `status` prop and an `onInstalled` callback instead of self-fetching.
- **Invariants preserved:**
  - `deriveEngineHealth` (plan 240) is reused unchanged, not re-derived — `buildModelsStatus`
    calls it once per engine and passes the result through.
  - `packageBroken` stays a **sidecar-up-only** signal: it is derived exclusively from
    `importable === false` on a *reachable* sidecar probe, never inferred from an unreachable
    sidecar. An unreachable sidecar cannot honestly distinguish "package broken" from "process
    down" — collapsing that distinction would be a false positive.
  - `GET /api/setup/readiness` continues to own the boot gate (`ready` = all blockers
    pass/warn); this plan changes how the `sidecar`/`tts` blockers are *computed*
    (from `computeModelsStatus`'s single probe) but not the gate's pass/fail semantics.
  - Coqui is now gated on `!packageBroken` the same uniform way as Kokoro/Qwen — previously
    Coqui had a separate ad hoc broken-state check.
- **Migration story:** none — no persisted shape changes. `ModelsStatus` is a fresh
  request/response type, not a stored one.
- **Reversibility:** UI + a read-only status endpoint; reverting restores the prior
  self-fetching cards and the conflated sidecar blocker with no data cleanup.

## Invariants to preserve

- `VOICE_ENGINES` (`voice-engine-registry.ts`) lists exactly `kokoro | qwen | coqui` —
  `whisper`/`gemini`/`piper` excluded (`voice-engine-registry.test.ts:5`).
- `buildModelsStatus` (`models-status.ts`) maps each engine through `deriveEngineHealth` and
  never lets a green aggregate mask a broken engine — per-engine independence
  (`models-status.test.ts:49`).
- `packageBroken` is only ever set from a *reachable* sidecar's `importable === false`
  (`models-status.test.ts:25`; `setup-readiness.orchestration.test.ts:139`
  — reachable-but-broken reads `sidecar:pass` + `tts:package-broken`, not unreachable).
- `computeModelsStatus` calls `probeSidecarHealth()` **exactly once** per request
  (`models-status.route.test.ts:62`) — do not reintroduce a second probe (e.g. via
  `buildDiagnostics`) for the `info.gpu` string; it is now built by `gpuDetail` off the single
  `/health` probe.
- `runtimeLivenessPill`: `starting` → neutral tone, never a blocker; `down`/`crashed` → alarm;
  `installedOnDisk:false` → blocker regardless of process (`engine-card-status.test.ts:5,13,21`).
- Re-check (`onRefetch`/`onInstalled`) always re-fetches `models-status`, not just
  `readiness` — `step-voice.tsx`'s `refetchBoth` calls both; a stale card after a real install
  is the exact bug class this plan closes.
- `anyEngineUsable` off a *different* engine can still mask a broken/missing one at the
  aggregate `tts` blocker level (by design — the aggregate answers "can generation proceed at
  all", not "are all engines healthy"); the **per-engine card** is the surface that must never
  mask (`setup-readiness.orchestration.test.ts:180` for the aggregate; `models-status.test.ts:49`
  for the per-engine guarantee this plan adds).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/voice-engine-registry.test.ts`) — registry lists exactly the
  three installable engines; each entry exposes disk probes, live selectors, default model key;
  live selectors read the matching `SidecarHealthResult` fields.
- Vitest server (`server/src/tts/models-status.test.ts`) — `buildModelsStatus` maps each engine
  via `deriveEngineHealth` + `packageBroken`; flags `packageBroken` only when on-disk-but-not-
  importable-live; preserves `package-missing` (weights present, package absent) distinctly from
  `not-installed`; per-engine independence (a broken engine isn't masked by a green aggregate);
  passes `runtime`/`info` through unchanged.
- Vitest server (`server/src/routes/models-status.route.test.ts`) — `computeModelsStatus`
  reports kokoro ready / qwen not-installed / runtime installed+reachable end to end; calls
  `probeSidecarHealth` exactly once per call; skips the probe entirely (deriving
  `runtime.process` from supervisor state) when the venv is absent.
- Vitest server (`server/src/routes/setup-readiness.test.ts`,
  `server/src/routes/setup-readiness.orchestration.test.ts`) — `sidecar`/`tts` blockers derive
  from `computeModelsStatus`'s single probe; reachable-but-package-broken → `sidecar:pass` +
  `tts:package-broken`; weights-missing-with-nothing-else-usable → `tts:weights-missing`;
  no-engine-installed → `tts:no-engine-installed`; `info.gpu`/`info.vramTotalMb` surface
  straight from `computeModelsStatus`, incl. a null-VRAM (no-GPU) case;
  `computeModelsStatus` called exactly once per readiness request.
- Vitest unit (`src/components/setup/engine-card-status.test.ts`) — `runtimeLivenessPill`
  classification matrix (starting=neutral, down/crashed=alarm, disk-missing=blocker
  regardless of process, ready=no pill).
- Vitest unit (`src/components/{kokoro,qwen,coqui}-install.test.tsx`,
  `src/components/venv-bootstrap.test.tsx`) — rewritten as controlled components: render
  purely off the `status` prop (no self-fetch), call `onInstalled` after a successful
  install/repair, and (Coqui) gate the broken-state card on `!packageBroken` the same way as
  Kokoro/Qwen.
- Vitest unit (`src/components/setup/step-voice.test.tsx`) — one `models-status` fetch feeds
  the runtime badge/liveness pill AND the controlled cards so they can't disagree;
  weights-missing card wording matches the badge (never "not installed" while installed);
  a `starting` process shows a neutral pill over a green "Runtime installed" disk badge (never
  amber); a broken Coqui surfaces on its own card while the aggregate "Voice ready" stays green.
- Vitest unit (`src/components/setup/setup-wizard.test.tsx`) — summary board treats a
  transiently-starting voice engine as neutral, not "needs attention" (#1612 regression case).
- Vitest unit (`src/views/model-manager.test.tsx`) — voice-engine cards render from the same
  controlled `status`/`onInstalled` contract as the wizard (migrated off self-fetching).
- Playwright e2e (`e2e/setup-models-status.spec.ts`) — ready-state golden path: drives the
  wizard to the Voice step (step 4 of 7) under the mock (`kokoro: ready`,
  `runtime: installedOnDisk/process ready`) and asserts the runtime badge reads green "Runtime
  installed" (never amber "Runtime needed") and the Kokoro card reads "Kokoro is installed"
  (never "Kokoro is not installed") — the badge/card agreement invariant, exercised end to end
  through a real browser rather than mocked React state.
  - **Scope note:** the weights-missing / starting / broken-coqui contradiction cases are
    deliberately NOT covered at the e2e layer — `src/mocks` has no generic per-scenario
    override hook (`window.__mockQueue.seed` is export-queue-specific), and building one solely
    for this e2e would be speculative plumbing. Those three cases are the exact regressions
    locked at the RTL layer in `step-voice.test.tsx` above, which is the right altitude for them.

### Manual acceptance walkthrough

Run against the real server + sidecar (not mock mode — this plan's guarantee is specifically
about live probe results agreeing across surfaces).

1. **Weights-missing Kokoro.** Remove/rename the Kokoro voice weights on disk (package still
   installed) and open `#/setup` → Voice step. Expected: the runtime badge stays green
   "Runtime installed" (the *package* is fine — only the weights are missing), and the Kokoro
   card reads "Kokoro is installed — voice weights not downloaded" (never "Kokoro is not
   installed"). Badge and card agree on the on-disk-package truth; the card alone carries the
   weights-specific nuance.
2. **Package-missing engine → Model Manager repair.** Force a package-missing state for an
   engine (weights present, Python package absent/uninstalled) and open `#/model-manager`.
   Expected: the engine's card offers a repair action, and clicking it restarts the TTS
   sidecar process (not just a client-side re-fetch) — confirm via the sidecar process log or
   PID change that a real restart occurred, then confirm the card flips to "installed" once the
   restarted sidecar reports the package importable again.
3. **Re-check refresh.** From the Voice step, trigger a real install/repair action on any
   engine card. Expected: on completion, both the runtime badge/pill AND the card status
   refresh together (single `refetchBoth` call) — no stale card next to an updated badge.

## Out of scope

- **Part B** (engine *recommendation* — surfacing `info.vramTotalMb` client-side to suggest an
  engine tier) is deferred; the server already computes `vramTotalMb` but the client
  `SetupReadiness.info` type intentionally stays `{ gpu: string }` in Part A. See the design
  spec referenced from the kickoff issue (#1612) for the Part B shape.
- Whisper (ASR) status — it stays on its own self-fetching `WhisperInstall` path; it's excluded
  from the voice-engine registry by design (ASR, not TTS).
- Consolidating this registry with the codebase's other engine lists (`ALL_TTS_ENGINES`,
  `TRACKED_ENGINES`, etc.) — explicitly out of scope; `VOICE_ENGINES` is scoped to this surface
  only.

## Cosmetic deltas (non-functional, noted for reviewers)

- **`info.gpu` wording changed.** The Voice step's GPU string is now built by `gpuDetail` off
  the single `computeModelsStatus` probe, not the old separate `buildDiagnostics` call — the
  exact phrasing of the GPU description may differ slightly from before (no functional change;
  still one human-readable string).
- **Brief blank-card window.** Because the install cards are now controlled off one
  `getModelsStatus()` fetch (Voice step and Model Manager both), there is a brief window on
  first mount, before that fetch resolves, where the cards render blank/loading rather than
  each independently showing its own stale-but-present state. `step-voice.tsx` covers this with
  an explicit `step-voice-loading` state; Model Manager has the equivalent loading gap.

## Ship notes

(Filled in when status flips to `stable`.)
