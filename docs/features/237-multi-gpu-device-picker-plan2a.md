---
status: active
shipped: null
owner: null
---

# 237 — Multi-GPU device picker (Plan 2a)

> Status: active — this PR. Extends the existing Advanced Configuration
> device rows (#1205) with canonical GPU-UUID identity, stale-reason badges,
> footprint pre-warn, a read-only analyzer row, and env-shadow detection.
> Builds on Wave 2 (#1220, merged — [236](236-multi-gpu-per-model-safety.md)),
> the per-card safety runtime this picker's badges/plumbing read from.
> **Auto-revert (Task 16/16.5) is deliberately excluded** — a follow-up PR,
> pending Wave 2's own on-box acceptance (still owed; Wave 2's `tripEvent()`
> hasn't been exercised on real hardware, and auto-revert directly consumes
> it).
> Key files: `src/views/advanced.tsx`, `src/components/settings/override-row.tsx`,
> `server/src/routes/{config,gpu-devices,gpu-uuid,ollama-health}.ts`,
> `server/src/config/resolver.ts`, `server/src/gpu/gpu-device-list-state.ts`,
> `server/tts-sidecar/main.py` (`_read_device_env`, `_resolve_uuid_to_index`,
> `_enumerate_cuda_devices`, `_warn_if_cuda_env_shadow_active`).
> URL surface: none new — extends the existing `#/advanced` route.
> OpenAPI ops: `GET /api/config` gained `cudaEnvShadow: boolean`;
> `GET /api/gpu/devices` device entries gained `resident`/`torchReservedMb`
> (Wave 2's `/health` merge) plus a synthetic `idx:-1` entry when an engine
> has fallen back to CPU; new `GET /api/ollama/device`.
> Design spec + plans: `docs/superpowers/specs/2026-06-27-multi-gpu-per-model-design.md`,
> `docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md` (Part B —
> Tasks 10, 10.5, 11-15, 17).
> Closes [#1222](https://github.com/dudarenok-maker/Castwright/issues/1222).

## Benefit / Rationale

- **User:** pinning an engine to a specific GPU now survives a driver
  renumber (the picker stores a UUID, not a raw index) and gives visible
  feedback the moment a pin goes stale — a vanished card shows "card no
  longer found," an engine that silently fell back to CPU shows "fell back
  to CPU," and selecting a card without enough free VRAM warns before you
  apply the change. The analyzer's device is surfaced read-only (it's not
  app-pinnable — a user/OS-managed Ollama daemon), so "why is the analyzer
  slow" no longer needs a log dig. A stale `CUDA_VISIBLE_DEVICES` env-var
  stop-gap (the pre-picker workaround) is now called out with a banner and
  a sidecar startup WARN instead of silently overriding every per-engine pin.
- **Technical:** closes the loop between Wave 1/2's server-side `cuda-uuid:`
  identity scheme and the operator — the picker is the first UI surface that
  actually writes and displays that form. `resolveKnob` (server) and
  `_read_device_env` (sidecar) are two independent resolution paths for the
  same UUID, each degrading safely on its own (server shows
  `uuid_unresolved`; sidecar WARNs and falls back to `auto`) rather than one
  being a single point of failure.
- **Architectural:** no new server-side plumbing — reuses Wave 2's
  `DeviceLedger`/`/health` `gpus[]` and Wave 1's `GET /api/gpu/devices`. The
  env-shadow signal is a single top-level `cudaEnvShadow` flag (not a
  per-knob `staleReason`), since `CUDA_VISIBLE_DEVICES` is a global fact that
  shadows every `cuda:N` pin identically — a corrected scope decision made
  mid-implementation (see the plan doc's Task 12 note).

## Architectural impact

- **New seams:** `_read_device_env`/`_resolve_uuid_to_index` (sidecar) are
  the one place every `*_DEVICE` env read goes through, so a UUID-keyed
  assignment always resolves against the box's LIVE card list rather than a
  bare `os.environ.get`. `getLastKnownGpuDevices()`/`setLastKnownGpuDevices()`
  (`server/src/gpu/gpu-device-list-state.ts`) mirror the existing
  `vram-state.ts` last-known-value cache pattern for the server-side half of
  the same resolution.
- **Invariants preserved:** `resolveKnob`'s UUID reconciliation never
  silently substitutes a different physical card — an unmatched UUID reports
  `staleReason: 'uuid_unresolved'` and keeps the raw value, it does not fall
  back to `cuda:0` or any other card. Same on the sidecar side: an unresolved
  UUID WARNs and falls back to `auto` (never a silently-wrong specific index).
- **Migration story:** none — the device knobs (`tts.{qwen,coqui,kokoro}.device`)
  already existed since #1205; this PR only changes what value gets
  PERSISTED for them (bare `cuda:N` → `cuda-uuid:<uuid>` on write, still
  displayed as `cuda:N`). No stored data shape changes for any other knob.
- **Reversibility:** every addition is additive (new response fields, a new
  route, a new banner) — no existing behaviour changes for a knob whose
  value isn't the `device` type.

## Invariants to preserve

- `resolveKnob`/`_read_device_env` never silently substitute a card for an
  unresolved UUID — always `uuid_unresolved`/WARN+`auto`, never a guess.
- `cudaEnvShadow` stays a single top-level flag, not a per-knob `staleReason`
  value — `StaleReason` is the 2-value union `'cpu_fallback' | 'uuid_unresolved'`
  in both `src/lib/types.ts` and `server/src/config/types.ts`. Do not
  reintroduce a third `'env_shadow'` value (a real plan-authoring gap this
  PR's own history corrected mid-implementation).
- `mergeResidentData` (`server/src/routes/gpu-devices.ts`) must keep
  surfacing the sidecar's synthetic `idx:-1` "unindexed" bucket — dropping it
  silently breaks the `cpu_fallback` badge for every non-indexed-card
  fallback (a real bug this PR's on-box acceptance found and fixed; see
  below).
- `_enumerate_cuda_devices`/`_sample_card` (sidecar) must stay defined
  BEFORE `ENGINES = {"qwen": QwenEngine(), ...}`'s module-level construction
  — moving them back below it reintroduces a NameError crash-loop on any
  fresh boot with a UUID-keyed device override already persisted (the other
  real bug this PR's on-box acceptance found and fixed).
- `override-row.tsx`'s device `<select>` options must keep filtering
  `idx >= 0` — the synthetic `idx:-1` device entry is not a real, pinnable
  card and must never become a selectable `cuda:-1` option.

## Test plan

### Automated coverage

- Vitest frontend: `src/views/advanced.test.tsx` (banner, analyzer row,
  group headers), `src/components/settings/override-row.test.tsx` (device
  knob, stale-reason badges, footprint pre-warn, the `idx:-1` exclusion),
  `src/store/config-slice.test.ts`, `src/lib/api.test.ts`.
- Vitest server: `server/src/routes/{config,gpu-devices,gpu-uuid,ollama-health}.test.ts`,
  `server/src/config/resolver.test.ts`.
- Pytest sidecar: `server/tts-sidecar/tests/test_cuda_env_shadow.py` (startup
  WARN), `server/tts-sidecar/tests/test_module_import_order.py` (the
  fresh-subprocess-import regression for the NameError crash — the first
  subprocess-isolated import test in this suite; every other test in this
  suite injects `torch_module` directly and can't reproduce a module-level
  ordering bug, since `main` is already cached in `sys.modules` by the time
  any test runs).
- E2E: `e2e/gpu-device-badge.spec.ts` (cpu_fallback badge via the
  `__SEED_GPU_DEVICES__` mock-mode convention), `e2e/responsive/coverage.spec.ts`
  (Advanced Configuration, pre-existing).
- A11y: `src/test/a11y.test.tsx`'s new Advanced Configuration block — found
  and fixed a real pre-existing a11y gap (device/enum/number/string
  `OverrideRow` controls had no accessible name; fixed with
  `aria-label={descriptor.label}`).

### Manual acceptance walkthrough — DONE (2026-07-03, real 2-GPU hardware)

Full checklist lived in the plan doc's Ship notes:
`docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md` → "## Ship
notes" → "### Plan 2a". All 8 scoped items passed on the real box (RTX 4070
Laptop 8GB + RTX 5070 Ti 16GB), confirmed via live `/api/gpu/devices`,
`/health`, sidecar logs, and the actual rendered picker UI (browser
automation) — not simulated. Setup used an isolated worktree-local
`WORKSPACE_DIR` and `USER_SETTINGS_FILE` override so the run never touched
real user data.

**Two real bugs were found and fixed during this run** (both missed by 8
task-level reviews and a whole-branch review — neither is reproducible via
mocked tests, since both are specific to a real, fresh process boot):

1. **Sidecar crash-loop (Critical).** `ENGINES = {"qwen": QwenEngine(), ...}`
   constructs at module-import time and transitively calls
   `_enumerate_cuda_devices`, which was defined ~2300 lines later in
   `main.py`. Any fresh sidecar boot with a UUID-keyed device override
   already persisted (exactly what the picker is FOR — a pin surviving a
   restart) crashed with `NameError` and crash-looped forever. Fixed by
   moving the function definitions to their actual first call site.
2. **cpu_fallback badge unreachable (Important).** `mergeResidentData`
   silently dropped the sidecar's synthetic `idx:-1` "unindexed" bucket
   (where `cpu_fallback` actually lives), so the badge could never reach the
   picker regardless of what the sidecar reported. Fixed by appending the
   synthetic entry when non-empty, with a frontend filter so it never
   becomes a selectable option.

Both fixes are commit `df188e49`, independently re-reviewed (Opus,
2026-07-03) — approved, 0 Critical/Important findings.

## Out of scope

- Task 16 (auto-revert on a repeated bad pin) + Task 16.5 (its operator
  toast) — a follow-up PR, pending Wave 2's own on-box acceptance (owed;
  auto-revert directly consumes Wave 2's `tripEvent()`, untested on real
  hardware).
- Wave 2's own on-box acceptance checklist (starving a card, forcing
  code-43 streaks, analyzer CPU/GPU cross-charge confirmation) — separate
  from this PR's scoped Plan 2a checklist; still owed, tracked in
  [236](236-multi-gpu-per-model-safety.md).
- ~~The `/docs/local-llm.md` links in the env-shadow banner and the analyzer
  row 404 in a production (`dist/`) deployment~~ — fixed by
  [#1223](https://github.com/dudarenok-maker/Castwright/issues/1223)'s
  `scripts/sync-docs-to-public.mjs` `prebuild` step, which mirrors
  `docs/local-llm.md` into `public/docs/` (git-ignored, regenerated on every
  build) so both hrefs resolve in `dist/` too.

## Ship notes

(Filled in once this PR merges.)
