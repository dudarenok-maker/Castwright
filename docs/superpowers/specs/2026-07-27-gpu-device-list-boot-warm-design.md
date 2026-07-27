# GPU device-list cache: server-owned boot warm + codec device-knob parity

Design for [#1857](https://github.com/dudarenok-maker/Audiobook-Generator/issues/1857).
Branch `fix/1857-gpu-device-cache-boot-warm`.

## Summary

1. Route `QWEN_CODEC_DEVICE` through `_read_device_env` in the sidecar, so the
   fourth and last `type: 'device'` knob resolves a `cuda-uuid:` pin like the
   other three already do.
2. Warm the Node-side GPU device-list cache from a **server-owned** background
   loop started at boot, instead of relying on an HTTP request having happened.
   Two supporting changes fall out of adding a concurrent writer: a no-downgrade
   rule in the device-list state module (2a), and a definitive stop condition so
   the loop can tell "no CUDA on this box" from "torch still importing" (2b).

Change 1 is the only misrouting bug. Change 2 closes the structural hole #1857
names — nothing server-side warms the cache — without claiming to fix a case
that cannot be fixed from the sidecar's device list.

## Premise correction

#1857's stated harm does not occur, and its acceptance criteria assert a
behaviour the sidecar was deliberately built not to need. This spec supersedes
them.

The issue is mechanically correct that with a cold cache `buildSidecarEnv`
(`server/src/tts/spawn-sidecar.ts:472-480`) injects `String(st.effective)`, so a
raw `cuda-uuid:<uuid>` literal reaches the sidecar. It is wrong that this
misroutes the engine.

`main.py:1873` `_read_device_env()` runs every `*_DEVICE` read through
`_resolve_uuid_to_index()` (`main.py:1858`), which enumerates live torch devices
and maps `cuda-uuid:<uuid>` → `cuda:N`. All three engine device knobs the issue
names go through it:

| Knob | Env | Python read site | Resolves UUID |
|---|---|---|---|
| `tts.coqui.device` | `COQUI_DEVICE` | `main.py:1124` `_read_device_env` | yes |
| `tts.kokoro.device` | `KOKORO_DEVICE` | `main.py:1444` `_read_device_env` | yes |
| `tts.qwen.device` | `QWEN_DEVICE` | `main.py:2860`, `2656`, `6233` `_read_device_env` | yes |
| `tts.qwen.codecDevice` | `QWEN_CODEC_DEVICE` | `main.py:2996` bare `os.environ.get` | **no** |

That Python-side resolution exists *because* the Node cache is cold at the boot
spawn. `_enumerate_cuda_devices`'s docstring (`main.py:1843-1847`) says so:

> the Node-side spawn-time cache in `getLastKnownGpuDevices()` is empty before
> the frontend's first GET `/api/gpu/devices` poll, so `buildSidecarEnv` passes
> the RAW `'cuda-uuid:...'` string through unresolved on a fresh server boot,
> not the pre-resolved `'cuda:N'` form a warm cache would produce

So #1857's acceptance bullet — *"a supervisor respawn … passes a translated
device index, not the raw `cuda-uuid:` literal"* — would pin redundancy, not a
fix. The raw literal is a supported input at that boundary.

## What is actually broken

### B1. `QWEN_CODEC_DEVICE` does not resolve a UUID pin

`tts.qwen.codecDevice` is `type: 'device'` (`registry.ts:589`), so
`PUT /api/config` uuid-ifies it on write (`routes/config.ts:100` gates on
`knob.type === 'device'`), and the frontend offers it the card dropdown
(`override-row.tsx:366` — "only consumed by `type: 'device'` knobs"). A user
pinning the codec to a card therefore gets `cuda-uuid:<uuid>` on disk.

At load, `main.py:2996` reads it with a bare `os.environ.get`.
`_resolve_codec_device` (`main.py:383-403`) lowercases and returns any
unrecognised string unchanged, so `cuda-uuid:gpu-…` becomes the codec device.

It then passes validation rather than being rejected by it. `_parse_device`
(`main.py:1801`) lowercases, matches `p.startswith("cuda")`, partitions on `:`,
finds `"gpu-…"` is not a digit, and returns `("cuda", None)`.
`_validate_cuda_index` raises only when `index is not None`, so it no-ops. The
literal therefore reaches `_move_codec_to_device(model, codec_device, torch)`
(`main.py:3064`) and fails inside torch's `.to()`, which is caught at
`main.py:431` and rolled back to CPU with `"Could not move Qwen codec to %s (%s)
-- rolling back to cpu."`.

Impact: the codec ends up on CPU instead of the pinned card. Narrow, but real,
warned-not-silent, and it hits the **first** spawn as well as respawns — the one
case no Node-side warming could ever have covered.

**Adjacent latent trap, not fixed here but named so it stays dormant.**
`_parse_device` classifies `cuda-uuid:<uuid>` as family `cuda` with *no index*.
Any path that treats `("cuda", None)` as "plain cuda → card 0" and receives a raw
UUID literal would silently use the **wrong card** rather than fail. Today the
only consumer at risk, `_engine_env_pin` (`main.py:1898`), is safe solely because
it routes through `_read_device_env` first. Change 1 makes the codec path the
fourth caller to depend on that same invariant: *every* `*_DEVICE` read goes
through `_read_device_env` before `_parse_device` ever sees it.

### B2. Nothing server-side warms the device-list cache

`ensureGpuDeviceListWarm()` has exactly one call site, `GET /api/config`
(`routes/config.ts:39,46`) — verified by grep on this branch. The other two
writers of the cache are also request-scoped: `GET /api/gpu/devices`
(`routes/gpu-devices.ts:23`) and `toUuidForm` on a `PUT /api/config` device
write (`routes/gpu-uuid.ts:41`).

Before PR #1852 every page load incidentally warmed the cache via a boot
`fetchConfig()` dispatch. That dispatch existed only to hydrate the deleted
`voices.library.enabled` gate. With it gone, all three triggers are dispatched
from `src/views/advanced.tsx` alone.

The defect is structural, not behavioural: an invariant ("device-knob UUID
resolution works only if an HTTP request happened first") that nothing enforces
and no test pins. Today's blast radius is small, but by luck rather than design:

- The only `server/src` consumer of a device knob's effective value is
  `engine-device.ts:36`, which tests `raw.startsWith('cuda')` — satisfied by
  `'cuda-uuid:…'`. Verified by grep for the three keys across `server/src`.
- `resolveAll()` ships every device knob's `effective` and `staleReason` to the
  frontend on `GET /api/config` (`config.ts:65`), `PUT /api/config`
  (`config.ts:107`) and `POST /api/config/reset` (`config.ts:126`). Only the GET
  warms. The PUT and reset responses can carry `uuid_unresolved` against a cold
  cache; in practice `advanced.tsx` has already warmed it on mount, which is
  precisely the accidental dependency at issue.

The next consumer need not be so lucky, and this is exactly how #1852 unmasked
the hole.

## Constraint: a pre-spawn warm is not achievable from this data source

#1857 suggests warming "before the first `spawnSidecar`". The only source of the
uuid↔idx mapping is the sidecar's own `GET /devices` (`main.py:6505`), served by
`_enumerate_cuda_devices`. At the initial boot spawn the sidecar process does not
yet exist, so that fetch cannot succeed. The suggestion is unachievable as
written, and its acceptance bullet ("closes the initial-spawn case too") cannot
be met by warming.

B1 is what actually closes the initial-spawn case, at the correct seam.

## Design

### Change 1 — `QWEN_CODEC_DEVICE` parity (`server/tts-sidecar/main.py`)

Replace the bare read at `main.py:2995-2997` with `_read_device_env`, extracted
into a named helper beside `_resolve_codec_device`:

```python
def _codec_device_pref() -> str:
    return _read_device_env("QWEN_CODEC_DEVICE") or "cpu"

# at the call site, main.py:2995-2997:
codec_device = _resolve_codec_device(_codec_device_pref(), self._device)
```

The helper is named rather than inlined for testability: the call site is inside
`_load_qwen_model`, which needs real Qwen weights and a GPU to invoke, so a test
asserting on a hand-composed `_resolve_codec_device(_read_device_env(...) or
"cpu", …)` would pass identically before and after the fix — a placebo. Testing
`_codec_device_pref()` exercises the function production actually calls.

Behaviour is unchanged for every value that works today:

| `QWEN_CODEC_DEVICE` | Before | After |
|---|---|---|
| unset | `"cpu"` → `None` (no move) | `None or "cpu"` → `None` (no move) |
| `""` | `""` → `p = "cpu"` → `None` | `""` falsy → `"cpu"` → `None` |
| `cpu` / `auto` / `cuda:N` / `mps` | pass-through | pass-through (`_resolve_uuid_to_index` returns non-`cuda-uuid:` values unchanged) |
| `cuda-uuid:<visible>` | passes validation, torch `.to()` raises → rolled back to CPU | → `cuda:N`, codec on the pinned card |
| `cuda-uuid:<vanished>` | passes validation, torch `.to()` raises → rolled back to CPU | → `"auto"` → follows the model's own device |

The vanished-UUID fallback is `"auto"` because that is what `_read_device_env`
returns for an unresolvable pin, and `_resolve_codec_device('auto', …)` means
"follow the model" — the codec can never land on a different card than its
model. This is a strictly better failure mode than today's demotion to CPU via a
torch exception, and matches how the other three knobs already degrade.

### Change 2 — server-owned warm loop (`server/src/gpu/warm-device-list.ts`, new)

```
ensureGpuDeviceListWarm(): Promise<void>   // moved from routes/config.ts; idempotent + in-flight-deduped
startGpuDeviceListWarmup(opts?): void      // bounded retry, fire-and-forget, never throws
_resetWarmDeviceListForTests(): void       // clears the in-flight promise
```

Note there are two distinct reset seams, not a duplicate:
`_resetWarmDeviceListForTests()` here clears this module's shared in-flight
promise, while `_resetGpuDeviceListForTests()` (Change 2a) clears the cached
device list in `gpu-device-list-state.ts`.

`ensureGpuDeviceListWarm` returns early when the cache is non-empty, else
`fetchSidecarDevices()` and store, plus a shared in-flight promise so a boot-loop
attempt and a concurrent `GET /api/config` pay one round-trip rather than two.

### Change 2a — no-downgrade rule in the state module

`gpu-device-list-state.ts` gains the invariant directly, so it holds for **every**
writer rather than only the new one:

```ts
export function setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void {
  if (devices.length === 0 && lastKnownGpuDevices.length > 0) return; // never downgrade
  lastKnownGpuDevices = devices;
}
export function _resetGpuDeviceListForTests(): void { lastKnownGpuDevices = []; }
```

Why the setter and not the warm helper: all three writers pass through
unguarded today. `gpu-devices.ts:20-23` returns early only when `result` is
`null`, then unconditionally writes `result.devices.map(...)` — so a
*reachable-but-empty* `GET /api/gpu/devices` clobbers a warm cache. `toUuidForm`
(`gpu-uuid.ts:41`) does the same. With one request-scoped warmer this was
unreachable in practice; adding a long-lived background writer that runs
concurrently with both makes a transient empty — sidecar recycle, torch reload —
able to flip resolved pins back to `staleReason: 'uuid_unresolved'` and make
`buildSidecarEnv` emit raw literals after having emitted indices. Guarding only
`ensureGpuDeviceListWarm` would leave two of three holes open while claiming the
property.

Cost: exactly three existing call sites use `setLastKnownGpuDevices([])` as a
reset — `config.test.ts:350`, `config.test.ts:387`, `gpu-devices.test.ts:25` —
and must move to `_resetGpuDeviceListForTests()`, or they silently stop
resetting and their cold-cache assertions start passing for the wrong reason.
(`config.test.ts:374` also calls the setter but with a non-empty list; it is
unaffected.)

### Change 2b — the loop's stop conditions

`startGpuDeviceListWarmup` polls until one of three things happens: the cache
holds at least one card, the sidecar definitively reports zero cards, or the
attempt budget is spent.

**Why an empty response alone does not stop it.** `[]` is ambiguous:
`_enumerate_cuda_devices` (`main.py:1848-1855`) returns `[]` on any exception and
whenever `torch.cuda.is_available()` is false — including the window before torch
finishes importing, which the sidecar reports as `devices_state: 'pending'`
(`sidecar-health.ts:92-98`).

**How the loop disambiguates.** On an empty response it consults the sidecar's
own `devices_state` and stops early on `'ready'` **or** `'error'` — respectively
"torch is up and there are no CUDA cards" and "the device probe failed"
(`main.py:6271`). Neither resolves itself by retrying. `'pending'` means the
background torch import is still running (`main.py:5198`) and keeps retrying, as
does a `null` (unregistered) answer, per the gate module's documented fail-closed
contract (`sidecar-health-gate.ts:25-31`).

**Reaching `devices_state` without side effects.** The obvious route —
`probeSidecarHealthIfRegistered()` — is wrong here. The registered implementation
writes three other caches on every reachable poll:
`setLastKnownQwenInstallState`, `setLastKnownVram` and `setLastKnownEngineDevices`
(`sidecar-health.ts:263-268`). Calling it from a boot timer would make this loop
a writer to all three during the window the supervisor is deciding what to spawn
— and `index.ts:274` seeds Qwen install state from a *disk* probe precisely
because the sidecar isn't up yet, while `buildOpts` re-reads
`getResolvedTtsModelKey()` on every spawn (`index.ts:290-300`). A poll landing
between those could change which model the first spawn preloads.

Reimplementing a small `/health` fetch instead is also barred:
`sidecar-health-gate.ts:19-21` requires exactly one source of truth ("nothing
here copies or reimplements the probe, so it can't drift").

So: give `probeSidecarHealth` an opts parameter — `{ recordState = true }` — that
suppresses only the three `setLastKnown*` writes, keeping one implementation of
the probe itself. `sidecar-health-gate.ts` gains a second provider slot:

```ts
export type DeviceProbeState = 'pending' | 'ready' | 'error';
export function setDeviceProbeStateProvider(fn: () => Promise<DeviceProbeState | null>): void
export function probeDeviceProbeStateIfRegistered(): Promise<DeviceProbeState | null>
```

registered by `routes/sidecar-health.ts` as
`() => probeSidecarHealth({ recordState: false }).then((r) => r.devicesState ?? null)`.
The state type is spelled locally rather than imported, for the same
cycle-avoidance reason the file header already gives for `SidecarHealthSnapshot`
— a type-only import still counts as an edge. `SidecarHealthSnapshot` itself is
left untouched.

**Per-attempt timeout.** `fetchSidecarDevices` hardcodes
`PROBE_TIMEOUT_MS = 2_000` (`fetch-sidecar-devices.ts:13`), sized for a UI
round-trip. `/devices` is a synchronous `def` (`main.py:6506`), so FastAPI runs
it on the threadpool and the *first* call triggers `import torch` inside
`_enumerate_cuda_devices` — far more than 2s on a cold box. Early attempts will
abort.

That is expected to be tolerable rather than fatal, on the following reasoning:
an aborted client fetch should not cancel the server-side import, because a
running Python thread cannot be interrupted by a client disconnect and Starlette
has no way to reach into `run_in_threadpool`'s worker. A later attempt then lands
on an already-imported module. **This is reasoning, not a verified fact** — it
was not checked against this repo's pinned Starlette/uvicorn versions and no test
covers it. If it is wrong, the loop spends its budget re-triggering work that
never completes and warms nothing; the fallback is to raise the warm path's own
timeout above `fetchSidecarDevices`'s shared 2s rather than to change the budget.

The budget is sized to outlast a torch import, not a single probe:
`maxAttempts: 24`, `attemptDelayMs: 5_000` (≈2 min),
the same shape as `runCatalogAudit` (`tts/coqui-catalog-audit.ts:52-57`) which
solves the identical "sidecar takes 30–60s, one shot would miss it" problem.
`fetchSidecarDevices`'s timeout is left alone — raising it would slow the UI path
that shares it, for no gain the retry budget doesn't already provide.

Timers are `unref()`'d, per this codebase's existing convention for boot-time
background timers (`index.ts:304-307`). Exhausting the budget logs one
informational line that states what was actually observed — sidecar never
reachable, versus reachable but reporting zero cards — rather than asserting
"CPU-only", which the loop cannot determine. Neither is a warning: a CPU-only box
and an autostart-disabled server both land here legitimately.

**`autoStart: false`.** `index.ts:283` branches on `getResolvedAutoStartSidecar()`
immediately above the insertion point. The warm loop is started unconditionally
anyway: a no-autostart server may still be pointed at an externally-run sidecar,
which is exactly a case worth warming.

**Worst-case cost, stated per case.** Sidecar never reachable (no autostart and
nothing external): 24 fetches that fail fast against a dead URL over two minutes,
then stop. Zero-card box with a healthy sidecar: polls while `devices_state` is
`'pending'` — the background torch import, "takes seconds" per `main.py:5198`, so
a small number of 5s-spaced attempts — then exits on `'ready'`. Box with missing
or broken torch: exits on `'error'` on the first attempt that reaches `/health`.
Without Change 2b both of those would pay all 24 round-trips on every boot. GPU
box: warms on the first attempt after torch is up.

`index.ts` starts it immediately after `void sidecarSupervisor.start()`
(`index.ts:301`), inside `listenerCallback`. `routes/config.ts` deletes its
private copy and imports the shared one; the `GET /api/config` call stays, since
that remains the right freshness point for the Advanced UI.

### Why the boot loop and not an existing poll

Three candidate hook points, two rejected:

- **`routes/sidecar-health.ts`** already feeds `setLastKnownVram`,
  `setLastKnownEngineDevices` and `setLastKnownQwenInstallState` on every
  reachable poll (`sidecar-health.ts:263-268`) — the established
  "last-known state from a reachable poll" pattern, and superficially the
  obvious home. Rejected: `probeSidecarHealth()` is driven by
  `GET /api/sidecar/health`, i.e. by the frontend. Hooking there rebuilds the
  precise accidental dependency #1852 exposed, just on a different route.
- **`sidecar-supervisor.ts`'s health poll** runs only for *adopted* sidecars —
  it is the fitness watchdog (`sidecar-supervisor.ts:315-319`) and does not fire
  for an owned child. Rejected: covers the minority case only.
- **A dedicated boot-time background warm** — server-owned, fires on every boot
  with no client, and has a working precedent in `runCatalogAudit`. Chosen.

### Rejected: Node-side `nvidia-smi` enumeration

A pre-spawn warm *is* reachable via `nvidia-smi --query-gpu=index,uuid`, and the
machinery exists (`gpu/device-total.ts:40-54`). Rejected on correctness: NVML
indices diverge from torch ordinals under `CUDA_VISIBLE_DEVICES` /
`CUDA_DEVICE_ORDER`, which this codebase already tracks as a hazard
(`routes/config.ts:67` `cudaEnvShadow`; `main.py:6031`). It would also introduce
a second, NVIDIA-only source of truth for `idx` that can disagree with the
sidecar's under the AMD/ROCm/DirectML profiles the accelerator knob supports. A
confidently wrong index is worse than a literal the sidecar resolves correctly.

## Testing

- **`server/src/gpu/gpu-device-list-state.test.ts`** (new) — the no-downgrade
  rule: an empty list over a warm cache is ignored; an empty list over an empty
  cache is a no-op; a non-empty list always replaces;
  `_resetGpuDeviceListForTests()` clears.
- **`server/src/gpu/warm-device-list.test.ts`** (new) — cold cache + reachable
  sidecar warms it; an already-warm cache issues no fetch; concurrent callers
  share one fetch; unreachable-then-reachable retries and eventually warms; an
  empty response with `devices_state: 'pending'` keeps retrying and a later
  populated response warms; `'ready'` and `'error'` each stop the loop early; an
  unregistered provider (`null`) keeps retrying; exhausting the attempt budget
  resolves without throwing.
- **`server/src/routes/sidecar-health.test.ts`** — `probeSidecarHealth({
  recordState: false })` returns the same parsed result but performs none of the
  three `setLastKnown*` writes; the default (`recordState` omitted) still
  performs all three. Without this the side-effect suppression is unpinned and a
  later refactor silently reintroduces the boot-time writer.
- **`server/src/tts/sidecar-env.test.ts`** — at the `buildSidecarEnv` seam: a
  warm cache plus a `cuda-uuid:` override yields `QWEN_DEVICE=cuda:N`; a **cold**
  cache yields the raw literal, asserted as the documented contract with a
  comment citing `main.py:1873`, not as a bug.
- **`server/tts-sidecar/tests/test_device_parse.py`** —
  `QWEN_CODEC_DEVICE=cuda-uuid:<uuid>` resolves to `cuda:N`; an unmatched UUID
  yields `auto`. Follows the file's existing pattern of monkeypatching
  `main._enumerate_cuda_devices` (lines 92-113).

No GPU is required by any of these; the existing GPU-gated codec smoke test
(`tests/test_codec_device_smoke.py`) is unchanged.

The `index.ts` insertion needs no test-isolation work: `server/src/index.test.ts`
imports `index.js`, but the main-module guard at the bottom of `index.ts` —
`if (invokedHref && import.meta.url === invokedHref)`, comparing
`import.meta.url` against `pathToFileURL(realpathSync(process.argv[1])).href` —
keeps `main()` from running on import, so `listenerCallback`, and therefore the
warm loop's timer, never fires in the server suite. (Both `index.ts:110` and
`index.test.ts:9` call this the "isMainModule guard"; no such identifier exists,
the name lives only in those comments. Verified against the code, not the
comments — a leaked boot timer is this repo's known tinypool worker-exit flake.)

## Out of scope

- Cache staleness after a driver reload or hot-plug. Change 2a makes this
  explicit rather than incidental: once warm, the list is only ever replaced by
  another **non-empty** list, from any writer. A box whose cards genuinely
  disappear mid-run therefore keeps serving the last good mapping indefinitely.
  That is the same staleness tradeoff `gpu-device-list-state.ts:1-8` already
  documents against `vram-state.ts`, and it is chosen over the alternative
  failure — a transient empty during a sidecar recycle silently unpinning every
  UUID assignment. Genuine hot-unplug handling would need an invalidation signal
  this design does not add.
- Re-warming per supervisor respawn. The card inventory does not change across
  respawns of the same box, and the boot loop's budget covers the window in
  which the first sidecar becomes reachable.
- `qa.asr.device` / `SPK_DEVICE`, which also read `os.environ` bare
  (`main.py:4754`, `4907`). Both are `type: 'string'` in the registry, so
  `routes/config.ts:100` never writes them a `cuda-uuid:` value and no UUID can
  reach them. Noted here so the asymmetry is not re-discovered as a bug.

## Acceptance

Replaces #1857's acceptance criteria:

1. `QWEN_CODEC_DEVICE=cuda-uuid:<visible-uuid>` places the Qwen codec on the
   pinned card on a cold-cache spawn, rather than demoting it to CPU.
2. Server boot **initiates** the device-list warm with no `GET /api/config`, no
   `GET /api/gpu/devices`, and no visit to Advanced settings. Stated as
   "initiates", not "populates": no Node-side work can guarantee completion. The
   loop has three terminal outcomes — cache warmed, sidecar definitively reported
   zero cards (`devices_state` `'ready'` or `'error'`), or budget exhausted — and
   the testable claim is that the loop runs unprompted and that a sidecar
   reachable with cards inside the budget warms the cache.
3. A device list that comes back empty never downgrades an already-warm cache —
   from **any** writer, not only the boot loop.
4. A zero-card box stops polling as soon as the sidecar reports a settled
   `devices_state` (`'ready'` or `'error'`), rather than exhausting the retry
   budget on every boot — and consulting that state does not perturb Qwen
   install state, VRAM or per-engine device ground truth.
5. `buildSidecarEnv`'s behaviour under both a warm and a cold cache is pinned by
   test, with the cold-cache case documented as the sidecar-resolves contract.
