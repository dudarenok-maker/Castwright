---
status: active
shipped: null
owner: null
---

# 238 — Preload-at-startup toggle dedup (Model Manager vs. Advanced Settings)

> Status: active
> Key files: `server/src/tts/spawn-sidecar.ts`, `server/src/workspace/user-settings.ts`,
> `server/src/config/registry.ts`, `src/components/model-settings-form.tsx`,
> `src/store/account-slice.ts`, `src/lib/account-defaults.ts`, `openapi.yaml`
> URL surface: `#/models` (Model Manager "Voice engine" section), `#/advanced`
> ("Voice engine & device" section)
> OpenAPI ops: `GET`/`PUT /api/user/settings` (drops `eagerLoadKokoro`/`eagerLoadQwen`)

## Benefit / Rationale

- **User:** there was exactly one behaviour ("does the voice engine warm up at
  boot") controlled from two different settings screens — Model Manager's
  "Eager-load Kokoro/Qwen at startup" checkbox (plan 134) and Advanced
  Settings' "Preload Kokoro/Qwen/Qwen 1.7B-Base at startup" knobs (plan 199).
  Whichever the user touched last silently won, with no UI indication that
  the other screen's control had gone inert. Advanced Settings is now the only
  place this is controlled, removing the duplicate and the silent-override
  confusion.
- **Technical:** `buildSidecarEnv` (`server/src/tts/spawn-sidecar.ts`) no
  longer derives `PRELOAD_QWEN`/`PRELOAD_QWEN_BASE17`/`PRELOAD_KOKORO` from
  `defaultTtsModelKey` + an `eagerLoad*` account flag; those three env vars
  now come exclusively from the existing "inject any restart-sidecar knob
  whose value is not default" registry-override loop, exactly like every
  other `tts.preload.*` knob. `PRELOAD_COQUI` is unchanged (still derived from
  `modelKey` — it never had a Model Manager duplicate to reconcile).
- **Architectural:** drops the old implicit "the non-default engine is always
  forced lazy" coupling. Each `tts.preload.*` knob is now a flat, independent
  boolean — matching how `tts.preload.coqui` already worked, and how
  `tts.gen.workers` already superseded the account-level `generationWorkers`
  field (that precedent's `getResolvedGenerationWorkers()` precedence chain —
  env → Advanced Settings override → legacy setting → default — is the
  pattern this plan follows for the preload knobs).

## Architectural impact

- **Removed:** `eagerLoadKokoro` / `eagerLoadQwen` from `userSettingsSchema` +
  `DEFAULT_USER_SETTINGS` (`server/src/workspace/user-settings.ts`), from
  `FRONTEND_ACCOUNT_DEFAULTS` (`src/lib/account-defaults.ts`), from the
  `AccountState` slice actions (`src/store/account-slice.ts`), from the
  `UserSettings` OpenAPI schema, and from `SpawnSidecarOpts`/
  `BuildSidecarEnvOpts` (`server/src/tts/spawn-sidecar.ts`). The Model Manager
  "Eager-load Kokoro/Qwen at startup" `FieldRow` is deleted from
  `src/components/model-settings-form.tsx`.
- **Migration:** a one-time, best-effort migration
  (`migrateLegacyEagerLoadFields` in `server/src/workspace/user-settings.ts`,
  run inside `readUserSettings()`) translates a pre-existing
  `eagerLoadKokoro`/`eagerLoadQwen` value into the equivalent
  `tts.preload.kokoro`/`tts.preload.qwen`/`tts.preload.qwenBase17`
  `configOverrides` entries, reproducing the OLD "non-default engine forced
  lazy" behaviour as a snapshot at migration time (keyed off the raw
  `defaultTtsModelKey` field, not the fully-resolved
  `getResolvedTtsModelKey()` — the Qwen-install probe that resolver depends
  on hasn't run yet this early in boot, so the raw field is used as a
  good-enough proxy). Never overwrites an override the user already set
  explicitly. Persists the migrated document back to disk (stripping the two
  legacy fields) so it only ever fires once per install.
- **Invariants preserved:** OpenAPI stays the type source of truth — the
  fields were removed from `openapi.yaml` first and `api-types.ts`
  regenerated via `npm run openapi:types`. `PRELOAD_COQUI`'s
  `modelKey`-derived default is untouched (out of scope — no Model Manager
  duplicate existed for it).
- **Reversibility:** re-add the two fields to the four schemas + the
  `buildSidecarEnv` modelKey/eagerLoad-derived block + the Model Manager
  `FieldRow` to restore the old coupling. The migration is one-directional
  (legacy fields are dropped from disk once migrated) — reverting after a
  user has upgraded would require re-deriving `eagerLoadKokoro`/`eagerLoadQwen`
  back out of their now-independent `tts.preload.*` overrides, which the old
  UI never needed to do.

## Invariants to preserve

- `buildSidecarEnv` (`server/src/tts/spawn-sidecar.ts`) sets `PRELOAD_COQUI`
  from `modelKey` only; `PRELOAD_QWEN`/`PRELOAD_QWEN_BASE17`/`PRELOAD_KOKORO`
  are set ONLY by the registry-override loop, and are absent from the child
  env (not `'0'`/`'1'`) when the corresponding knob is at its registry
  default — the sidecar's own Python default then applies.
- `userSettingsSchema` (`server/src/workspace/user-settings.ts`) has no
  `eagerLoadKokoro`/`eagerLoadQwen` fields. `migrateLegacyEagerLoadFields`
  runs once per install (a no-op once neither legacy field is present on
  disk) and never clobbers an existing `configOverrides` entry.
- Model Manager (`src/components/model-settings-form.tsx`) has no eager-load
  checkbox; Advanced Settings' `tts.preload.*` group (`server/src/config/registry.ts`)
  is the only preload-at-startup UI surface.

## Test plan

### Automated coverage

- Vitest server (`server/src/workspace/user-settings.test.ts`) — the retired
  fields no longer appear on `DEFAULT_USER_SETTINGS`/a fresh parse; a legacy
  Qwen-default document migrates into the three `tts.preload.*` overrides
  (reproducing the old forced-lazy-Kokoro snapshot) and the legacy fields are
  stripped from disk; an existing explicit `configOverrides` entry is never
  clobbered by the migration.
- Vitest server (`server/src/tts/sidecar-env.test.ts`) — `PRELOAD_QWEN` /
  `PRELOAD_QWEN_BASE17` / `PRELOAD_KOKORO` are left `undefined` at their
  registry default regardless of `modelKey` (no more modelKey coupling); a
  registry override for any of the three sets it regardless of which engine
  is the resolved default (including setting `PRELOAD_KOKORO` under a Qwen
  default, which the old coupling forbade).
- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — the real
  `spawnSidecar()` child-env contract: `PRELOAD_COQUI` still follows
  `modelKey`; the other three preload vars are absent from the spawned
  child's env for every `modelKey` when nothing is overridden.
- Vitest server (`server/src/routes/user-settings.test.ts`) — the
  "every writable field round-trips through PUT" completeness guard no longer
  requires (or accepts) `eagerLoadKokoro`/`eagerLoadQwen` sample values.
- Vitest unit (`src/store/account-slice.test.ts`) — the retired
  `setEagerLoadKokoro`/`setEagerLoadQwen` reducer tests and hydrate/round-trip
  describe blocks are removed (no reducer exists for them any more).
- **e2e:** not added — this removes a settings control rather than adding
  new UI-visible behaviour; the existing Model Manager / Advanced Settings
  e2e coverage (`e2e/model-manager-analyzer-knobs.spec.ts`,
  `e2e/advanced-settings.spec.ts`) doesn't reference the removed checkbox, so
  no spec update was needed.

### Manual acceptance walkthrough

Real backend + sidecar (this governs boot-time `PRELOAD_*` env vars).

1. Fresh install (no `user-settings.json`) → `npm start` → sidecar boots with
   Kokoro preloaded (Python default `true`) and Qwen/Qwen-1.7B lazy (Python
   default `false`), regardless of which engine is the resolved default.
2. Open `#/models` → Voice engine section → confirm no "Eager-load
   Kokoro/Qwen at startup" row exists; "Auto-start with server", "Keep both
   voice engines loaded", and "Generation workers" are still present.
3. Open `#/advanced` → "Voice engine & device" section → toggle "Preload Qwen
   at startup" on, save, restart the sidecar → spawn log line shows
   `PRELOAD_QWEN=1`.
4. Upgrade path: seed `~/.castwright/user-settings.json` with
   `defaultTtsModelKey: 'qwen3-tts-0.6b', eagerLoadKokoro: true, eagerLoadQwen: false`
   (pre-fix shape) → boot the app → confirm the sidecar spawns with
   `PRELOAD_KOKORO=0` (reproducing the old forced-lazy behaviour, not the
   Python default `true`) and the file on disk no longer has the two legacy
   keys after the first read.

## Out of scope

- Reconciling `tts.gen.workers` vs. the Model Manager `generationWorkers`
  field — already has its own documented precedence chain
  (`getResolvedGenerationWorkers()`) and wasn't part of the user-reported
  duplicate-preload-toggle confusion this plan addresses.
- `dualModelEnabled` / `autoStartSidecar` — no Advanced Settings equivalent
  exists for either, so there's nothing to dedupe.
- Changing `PRELOAD_COQUI`'s `modelKey`-coupled default — it never had a
  Model Manager duplicate.

## Ship notes

(Filled in when status flips to `stable`.)
