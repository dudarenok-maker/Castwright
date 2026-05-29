---
status: stable
shipped: null
owner: null
---

# 134 — Engine-aware eager-load toggle + Qwen-aware TTS-sidecar settings copy

> Status: stable
> Key files: `src/views/account.tsx`, `server/src/tts/spawn-sidecar.ts`, `server/src/workspace/user-settings.ts`, `src/lib/account-defaults.ts`, `src/store/account-slice.ts`, `openapi.yaml`
> URL surface: `#/account` (the "TTS sidecar" FormCard)
> OpenAPI ops: `GET`/`PUT /api/user/settings` (adds `eagerLoadQwen`)

## Benefit / Rationale

Qwen3-TTS became the default-when-installed engine in v1.5.0 (plan 130), but the
Account view's "TTS sidecar" card still behaved and read as Kokoro-only.

- **User:** Qwen-primary users get a real preload control. Before, the "Eager-load
  Kokoro at startup" toggle was *silently a no-op* under a Qwen default
  (`spawn-sidecar.ts` hardcoded `PRELOAD_QWEN=1` / `PRELOAD_KOKORO=0`), so the
  only visible toggle did nothing and there was no way to govern Qwen's preload.
  The card copy also stopped pretending Kokoro is the only local engine.
- **Technical:** A new persisted `eagerLoadQwen` boolean threads through the
  settings stack into the sidecar's `PRELOAD_QWEN` env. The eager-load toggle is
  now engine-aware: it governs whichever engine is the resolved default.
- **Architectural:** Preserves the existing rationale — the *default* engine
  eager-loads, the *non-default* engine is the on-demand fallback (forced lazy).
  No new dual-residency path; that stays the `dualModelEnabled` card's job.

## Architectural impact

- **New seam:** `eagerLoadQwen` user-setting (optional, default `true`) +
  `SpawnSidecarOpts.eagerLoadQwen`. Mirrors `eagerLoadKokoro` exactly.
- **Behaviour change in `spawn-sidecar.ts`:** the env block is now symmetric —
  `PRELOAD_QWEN = isQwenDefault ? (eagerLoadQwen ? '1' : '0') : '0'` and
  `PRELOAD_KOKORO = isQwenDefault ? '0' : (eagerLoadKokoro ? '1' : '0')`. The
  non-default engine is always lazy.
- **UI:** `src/views/account.tsx` renders ONE engine-aware `FieldRow`. Which one
  is decided by the form's selected model key (`defaultTtsModelKey === 'qwen3-tts-0.6b'`),
  so flipping the engine picker in-session swaps the toggle to match what the next
  sidecar restart will preload.
- **Migration story:** none required. Both `eagerLoadKokoro` and `eagerLoadQwen`
  are optional with a `true` default, so legacy `user-settings.json` files load
  unchanged (lazy default applied at read time).
- **Invariants preserved:** OpenAPI stays the type source of truth (24) — the
  field was added to `openapi.yaml` first and `api-types.ts` regenerated via
  `npm run openapi:types` (never hand-edited). RTK immer reducers (26) unchanged.
- **Reversibility:** delete the field from the three schemas + the FieldRow
  branch; the Kokoro-only behaviour returns.

## Invariants to preserve

- `spawn-sidecar.ts` env block: the default engine honours its own eager-load
  toggle; the non-default engine is forced lazy (`PRELOAD_KOKORO=0` under a Qwen
  default, `PRELOAD_QWEN=0` under any non-Qwen default).
- `account.tsx` shows exactly ONE eager-load FieldRow — Qwen's when
  `defaultTtsModelKey === 'qwen3-tts-0.6b'`, Kokoro's otherwise (Kokoro/Coqui).
- `DEFAULT_USER_SETTINGS.eagerLoadQwen === true` and
  `FRONTEND_ACCOUNT_DEFAULTS.eagerLoadQwen === true` stay in lockstep
  (`server/src/workspace/user-settings.ts` ⇄ `src/lib/account-defaults.ts`).

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — Qwen default +
  `eagerLoadQwen:true` → `PRELOAD_QWEN=1`/`PRELOAD_KOKORO=0`; Qwen default +
  `eagerLoadQwen:false` → `PRELOAD_QWEN=0`; non-Qwen default ignores
  `eagerLoadQwen` (Qwen stays off, Kokoro follows `eagerLoadKokoro`).
- Vitest server (`server/src/workspace/user-settings.test.ts`) — `eagerLoadQwen`
  defaults to `true`, accepts booleans, rejects non-booleans, is optional, and
  round-trips through write/read.
- Vitest unit (`src/store/account-slice.test.ts`) — `setEagerLoadQwen` reducer +
  fetch/save round-trip of `eagerLoadQwen`.
- Vitest unit (`src/views/account.test.tsx`) — engine-aware describe block: Qwen
  default shows `account-eager-load-qwen` (and hides `account-eager-load-kokoro`),
  reflects the persisted value, shows the restart-sidecar pill on flip, and
  round-trips `eagerLoadQwen=false` through the Save patch; a non-Qwen default
  shows the Kokoro row.
- **e2e:** not added — this is a single settings toggle that doesn't cross a
  router/redux/layout seam Vitest+jsdom can't cover (the toggle render + Save
  patch are exercised by the jsdom view test). Follow-up only if the account
  view grows a dedicated e2e spec.

### Manual acceptance walkthrough

Real backend + sidecar (this governs `PRELOAD_QWEN`, a boot-time env).

1. `npm start` with Qwen installed → open `#/account`. The "TTS sidecar" card
   hint reads "runs Qwen3-TTS / Kokoro / Coqui XTTS locally".
2. Resolved default is Qwen → the eager-load row reads **"Eager-load Qwen at
   startup"**, checked.
3. Switch the **TTS engine** picker to a Kokoro model → the row label flips to
   **"Eager-load Kokoro at startup"** (no save needed; tracks the form).
4. Switch back to Qwen, uncheck the toggle, **Save** → a "Restart the sidecar to
   apply this change" pill appears.
5. Restart the sidecar → the spawn log line shows `PRELOAD_QWEN=0` and Qwen warms
   on the first synth rather than at boot. Re-check + Save + restart → `PRELOAD_QWEN=1`.

## Out of scope

- Independent both-engines-eager preload — that is the `dualModelEnabled` card
  (plan 108). The eager-load toggle governs the default engine only.
- Qwen VoiceDesign / idle-TTL knobs — that lifecycle stays sidecar-managed.

## Ship notes

(Filled when merged: shipped date + commit SHA.)
