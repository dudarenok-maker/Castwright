---
status: stable
shipped: null
owner: null
---

# Qwen→Kokoro fallback is loud, never silent + stale-sidecar replacement

> Status: stable
> Key files: `server/src/tts/spawn-sidecar.ts` (protocol handshake + stale-sidecar replacement), `server/tts-sidecar/main.py` (`SIDECAR_PROTOCOL_VERSION` + `/health`), `server/src/routes/sidecar-health.ts` (`deriveQwenInstallState`), `server/src/routes/generation.ts` (`qwen_unavailable_kokoro_fallback` warning), `src/store/generation-stream-runner.ts` (`warning` → toast), `openapi.yaml` + `src/lib/api-types.ts` (GenerationTick `warning` type + `code`/`message`)
> URL surface: indirect — generation SSE stream (`POST /api/books/{id}/generation`); GET `/api/sidecar/health`; sidecar `/health`
> OpenAPI ops: extends `GenerationTick` (adds `warning` to the `type` enum + `code`/`message` properties)

## Benefit / Rationale

Fixes the 2026-05-29 incident where a whole Qwen book silently rendered in
Kokoro — generic fallback voices instead of the bespoke designed Qwen voices —
with **no signal to the user**. Generation just looked "very very fast" (Kokoro
is ~RTF 0.4 vs Qwen ~2 on this box) and the Qwen batch knobs looked like they'd
"lost their settings" (the Qwen batch path simply never ran).

- **User:** a Qwen→Kokoro engine downgrade now raises a toast at run setup
  ("Qwen is unavailable … will render in Kokoro … regenerate affected
  chapters"), so the wrong-voice render is caught immediately, not after a
  listen pass.
- **Technical:** a sidecar that reports `qwen_loaded: true` can no longer be
  recorded as `qwenInstallState: "not-installed"`. A loaded model is definitive
  proof Qwen is installed and usable, so it overrides a missing/stale
  `qwen_install_state` field — which is exactly what a pre-plan-130 (stale)
  sidecar omits.
- **Architectural:** `warning` becomes a first-class `GenerationTick` variant
  (OpenAPI-sourced), and the stream runner gains a generic `warning` → toast
  branch — so the pre-existing `dual_model_off_multi_engine` advisory (which was
  also being dropped on the floor) now surfaces too.

## Root cause (what actually happened)

1. A stale TTS sidecar (process predating plan 130) sat on `:9000`. Its
   `/health` omits `qwen_install_state` / `qwen_package_installed` /
   `qwen_weights_present`, but still reports `qwen_loaded: true`.
2. `sidecar-health.ts` normalised the **absent** `qwen_install_state` to
   `'not-installed'` on every 30 s poll, and `setLastKnownQwenInstallState`
   cached it.
3. At generation setup, `generation.ts` reads `getLastKnownQwenInstallState()`;
   `!== 'ready' && !== 'loaded'` ⇒ `qwenUnavailable = true`.
4. `synthesise-chapter.ts`'s `applyQwenFallback` then routed **every** Qwen
   character to Kokoro (the same graceful path an undesigned voice takes).
5. The only signal was a per-segment `renderedFallbackEngine` stamp — never
   surfaced as a run-level warning. Silent.

The deepest cause: `spawnSidecar` reused **anything** listening on `:9000`
after a bare TCP check (`already listening … skipping spawn`). It never asked
whether that process was the current build, so a stale sidecar (orphaned across
a `tsx watch` reload while the code advanced, or a manual launch of an old
build) was trusted indefinitely. Note the listener PID (68624) differed from
the last PID the server had spawned (64268) — a `.run/tts.pid` check alone
would not have found it.

## The three layers (defence in depth)

1. **Stop the stale sidecar being trusted at all (root cause).** The sidecar's
   `/health` now reports `SIDECAR_PROTOCOL_VERSION`. At startup, when something
   already holds `:9000`, `spawnSidecar` handshakes on `/health`:
   - current build (`protocol_version >= EXPECTED`) → reuse, as before;
   - **stale** (looks like our sidecar but the version is missing/old) → log
     loudly, find the listening PID (cross-platform: `Get-NetTCPConnection` on
     Windows, `lsof` on posix), kill it, wait for the port to free, and spawn
     the current build;
   - **not our sidecar** (reachable but wrong shape, or hung) → never killed;
     leave it and let the health route surface TTS-down.
2. **A loaded model can't read as not-installed.** `deriveQwenInstallState`
   makes `qwen_loaded:true` override a missing/stale `qwen_install_state`, so
   even a stale sidecar that slips through can't poison the install-state cache.
3. **Any genuine downgrade is visible.** `generation.ts` emits a `warning` tick
   and the stream runner shows it as a toast.

## Architectural impact

- **New seams:** `deriveQwenInstallState(body)` in `sidecar-health.ts`;
  `warning` event variant + `code`/`message` on `GenerationTick`; a `warning`
  branch in `generation-stream-runner.ts` that pushes a deduped `warn` toast.
- **Invariants preserved:** OpenAPI stays the type source of truth (schema
  edited, `npm run openapi:types` regenerated `api-types.ts`). The graceful
  Qwen→Kokoro fallback itself is unchanged — generation still proceeds rather
  than hard-failing; we only make it visible. Audio bytes unaffected.
- **Migration:** none — additive schema fields, all optional.
- **Reversibility:** revert the three code edits + the schema fields; the
  fallback returns to silent (don't).

## Invariants to preserve

- `SIDECAR_PROTOCOL_VERSION` (`server/tts-sidecar/main.py`) and
  `EXPECTED_PROTOCOL_VERSION` (`server/src/tts/spawn-sidecar.ts`) must be bumped
  **together** whenever a `/health` or wire-protocol change makes an older
  sidecar incompatible — that coupling is what the handshake relies on.
- `spawnSidecar` only ever kills a process that positively identifies as our
  sidecar (`/health` returns `ok:true` + an `engines` array) AND is stale. A
  reachable-but-unrecognised process on the port is left untouched.
- `deriveQwenInstallState` (`server/src/routes/sidecar-health.ts`): `qwen_loaded
  === true` ⇒ `'loaded'`, else `normaliseQwenInstallState(qwen_install_state)`.
  A loaded model must never normalise to `'not-installed'`.
- The forwarded `qwenPackageInstalled` / `qwenWeightsPresent` booleans are
  OR'd with `qwenLoaded` so the UI never shows "loaded but package=false".
- `generation.ts` emits `send({ type: 'warning', code:
  'qwen_unavailable_kokoro_fallback', message, qwenInstallState })` whenever
  `qwenUnavailable` — i.e. a Qwen-in-use cast whose install-state is not
  `ready`/`loaded`.
- `generation-stream-runner.ts` pushes a `kind: 'warn'` toast for any
  `ev.type === 'warning'` with a `message`, deduped by
  `generation-warning:${code ?? message}`.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — reuses a
  current-protocol sidecar; leaves a non-sidecar listener untouched; leaves a
  stale sidecar in place when its PID can't be found; and (win32) kills a stale
  sidecar then spawns the current build.
- Pytest sidecar (`server/tts-sidecar/tests/test_kokoro.py::test_health_reports_protocol_version`)
  — `/health` carries `protocol_version == SIDECAR_PROTOCOL_VERSION`.
- Vitest server (`server/src/routes/sidecar-health.test.ts`) — `qwen_loaded:true`
  with an ABSENT `qwen_install_state` ⇒ `qwenInstallState:'loaded'` +
  `qwenPackageInstalled/qwenWeightsPresent` true; and `qwen_loaded:true`
  overrides an explicit downgraded `qwen_install_state:'not-installed'`. The
  existing "missing/garbage ⇒ not-installed" test still passes (no `qwen_loaded`).
- Vitest server (`server/src/routes/generation.test.ts`) — a Qwen cast with
  install-state `not-installed` emits a `warning` tick with code
  `qwen_unavailable_kokoro_fallback`; install-state `loaded` emits no such
  warning.
- Vitest frontend (`src/store/generation-stream-runner.test.ts`) — a `warning`
  tick becomes a `warn` toast with the right dedupeKey; identical warnings dedupe
  to a single toast.

### Manual acceptance walkthrough

1. **Stale sidecar on :9000 (omits `qwen_install_state`, `qwen_loaded:true`)** →
   `curl :8080/api/sidecar/health` now shows `qwenInstallState:"loaded"` (was
   `"not-installed"`). Generation runs on Qwen — `tts.err.log` shows `qwen batch
   synth`, not `kokoro synth`.
2. **Genuinely uninstalled Qwen, Qwen cast, start generation** → a toast appears:
   "Qwen is unavailable … render in Kokoro … regenerate affected chapters", and
   the server log carries the same `[generation]` warn line.

## Out of scope

- Killing a process that holds `:9000` but isn't our sidecar (a genuine port
  conflict). We detect it and log, but never kill an unknown process.
- Per-character "Fallback (Kokoro)" badges in the cast view (already exist via
  `renderedFallbackEngine`, plan 108).

## Ship notes

Shipped 2026-05-29 on branch `fix/server-qwen-unavailable-loud-fallback`
(commit SHA filled at merge). Delta vs. spec: scope grew to include the
root-cause stale-sidecar replacement (formerly backlog `side-8`) — the
`/health` protocol handshake + cross-platform kill-and-respawn in
`spawnSidecar` — so a stale sidecar is no longer trusted in the first place.
Also fixed the forwarded install-booleans to stay consistent with a derived
`'loaded'` state, and the generic `warning`→toast branch retroactively
surfaces the pre-existing `dual_model_off_multi_engine` advisory.
