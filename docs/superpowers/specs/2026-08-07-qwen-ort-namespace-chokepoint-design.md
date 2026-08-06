---
status: draft
date: 2026-08-07
---

# The onnxruntime namespace chokepoint: one guarded pip path into the sidecar venv

Closes the design work behind **#2192**.

## Problem

An alpha tester on a Pinokio install could not install Qwen3:

```
install-qwen3.mjs exited with code 1. ERROR: Could not install packages due to an
OSError: [WinError 5] Accès refusé:
'E:\pinokio\api\Castwright.git\server\tts-sidecar\.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_shared.dll'
Check the permissions.
```

It is not a permissions problem. `WinError 5` on a `.dll` is Windows reporting a
memory-mapped file held by a live process. The report is one visible symptom of a
structural condition that has been present since the ORT swap was introduced.

### The structural condition

`install-ort.mjs` deliberately replaces plain `onnxruntime` with `onnxruntime-gpu` on
GPU profiles — they share the `site-packages/onnxruntime/` namespace directory and
cannot co-exist. pip does **not** accept `onnxruntime-gpu` as satisfying a requirement
spelled `onnxruntime`: distributions match by name, not by the directory they own.

Three installed distributions require plain `onnxruntime` unconditionally. `pip check`
on a **correctly bootstrapped** NVIDIA box therefore reports:

```
faster-whisper 1.2.1 requires onnxruntime, which is not installed.
kokoro-onnx 0.5.0 requires onnxruntime, which is not installed.
qwen-tts 0.1.1 requires onnxruntime, which is not installed.
```

(`transformers` also lists `onnxruntime`, but only behind the `onnx` / `onnxruntime` /
`dev-*` extras, so it never participates in resolution here.)

**The venv is permanently in a state pip considers broken, by design.** Any later pip
invocation whose target package depends on `onnxruntime` will try to repair it by
installing the CPU build.

### The two failure modes

Both follow from that one condition; which one you get depends only on whether the
sidecar is running.

**A — the reported crash.** The sidecar's `_run_device_probe()` (`main.py:9174`, wired
into the startup handler sequence at `main.py:668`) runs `import onnxruntime` on **every
boot**, unconditionally — it is not gated on Kokoro ever being loaded. That maps
`onnxruntime_providers_shared.dll` and Windows holds the lock for the process lifetime.
`POST /api/qwen/install` spawns the installer without stopping or unloading the sidecar
(there is no stop/unload path in `routes/qwen-install.ts` or `tts/qwen-install-bootstrap.ts`),
so pip tries to overwrite a locked DLL and exits 1.

**B — the silent clobber, which is worse.** With the sidecar stopped, the same pip step
succeeds and installs CPU `onnxruntime` over `onnxruntime-gpu`. Verified with `--dry-run`
against a fully bootstrapped NVIDIA box:

```
Using cached onnxruntime-1.28.0-cp312-cp312-win_amd64.whl (13.8 MB)
Would install onnxruntime-1.28.0
```

That is the 2026-06-16 silent-CPU-Kokoro regression re-entering through a different door,
and it also drives past `install-ort.mjs`'s deliberate `ONNXRUNTIME_GPU_CONSTRAINT =
'>=1.27,<1.28'` pin. No error, no log line. Anyone who installed Qwen3 after their initial
bootstrap is likely running Kokoro on the CPU without knowing it. Failure mode A is the
lucky one — it failed loudly.

### Why this is not a bug in `install-qwen3.mjs`

`install-qwen3.mjs` is simply the first door someone walked through. `install-whisper.mjs:96`
is a second and is more aggressive — `pip install -U faster-whisper`, with `-U` and no
constraints file at all, against a package `base.txt:45` pins to `>=1.0,<2.0`. Any future
installer that pip-installs a package depending on `onnxruntime` re-introduces both failure
modes with nothing to catch it.

`install-ort.mjs` describes itself as "the SINGLE enforcement point for GPU Kokoro." It is
not one, and cannot be, while other installers pip-install into the same venv behind its
back. This is the recurring shape recorded in the #2040 wave: a guard that holds at one
door in a building with several.

## Approach

Three layers. Layer 1 alone fixes both reported failure modes on both known paths; layers
2 and 3 exist because layer 1 is a per-call decision that a future caller can forget.

| Layer | Mechanism | Kills |
|---|---|---|
| 1. Prevention | `--no-deps` on overlay-declared packages | A and B, on the known paths |
| 2. Repair | ORT invariant re-asserted after any dep-resolving pip call, and before the sidecar spawns | B, including already-broken boxes |
| 3. Honesty | Filtered `pip check` after each install | A dependency `--no-deps` genuinely skipped |

### Layer 1 is per-call, not a blanket policy

`--no-deps` is safe **only** when the package's dependencies are already declared in the
requirements overlay, so nothing needs resolving:

- `qwen-tts==0.1.1` — in `nvidia-cuda.txt:67` / `amd-rocm.txt:16`. Safe.
- `faster-whisper>=1.0,<2.0` — in `base.txt:45`. Safe.
- `coqui-tts` — **opt-in and deliberately not in any overlay.** `--no-deps` here would
  install a broken Coqui. It must keep full resolution.

So the chokepoint takes `noDeps` as an explicit per-call flag that the caller justifies,
never a default. A blanket policy would be a worse bug than the one being fixed.

### Layer 2 cannot live in the sidecar

Repairing the invariant means `pip uninstall onnxruntime`, and the sidecar holds that DLL
open from boot. **A sidecar-side self-heal would hit the exact `WinError 5` it exists to
fix.** The check therefore runs in the server, immediately before it spawns the sidecar
child, when nothing holds the lock. `spawn-sidecar.ts:530` already resolves the accelerator
profile and injects it into the child env, so the one input the check needs is in hand at
the right moment.

Detection needs no Python and no import: read `site-packages/` for a plain
`onnxruntime-*.dist-info`. On a healthy NVIDIA box only `onnxruntime_gpu-*.dist-info`
exists; a clobber leaves **both**, because pip never knew they collided.

### Layer 3 must not cry wolf

`pip check` on a healthy GPU box always prints the three lines above. Reported unfiltered,
it would fire on every install and be tuned out within a week. The chokepoint treats
exactly that trio, and only on a GPU profile, as expected — and reports anything else.

## Components

### New: `server/tts-sidecar/scripts/sidecar-pip.mjs`

Pure planners plus a thin runner, matching the `install-torch.mjs` / `install-ort.mjs`
house pattern (pure decision fn + guarded CLI, unit-testable without a venv).

| Export | Kind | Purpose |
|---|---|---|
| `sidecarPipInstallArgs(specs, { constraints, noDeps })` | pure | Build the pip argv |
| `parsePipCheck(stdout)` | pure | → `{ dist, requirement }[]` |
| `expectedOrtInconsistencies(profile)` | pure | The trio, **GPU profiles only** |
| `unexpectedInconsistencies(output, profile)` | pure | The cry-wolf filter |
| `runSidecarPip(python, specs, opts)` | I/O | install → re-assert ORT if deps resolved → filtered `pip check` |

### Changed: `server/tts-sidecar/scripts/install-ort.mjs`

Export `applyOrtSwap(python, plan)`, extracted from the existing CLI block, so the CLI and
the chokepoint run the same loop. `planOrtSwap` is unchanged. This avoids a second copy of
the swap sequence — that file's own `#1844` note records that re-deriving the package name
in a second place is exactly how the CLI drifted before.

### New: `server/src/tts/ort-invariant.ts`

| Export | Kind | Purpose |
|---|---|---|
| `detectOrtNamespaceOwner(sitePackages)` | fs read | Which distributions claim the namespace |
| `planOrtRepair({ profile, platform, owners })` | pure | `ok` / `repair` + reason |
| `assertOrtInvariantBeforeSpawn(deps)` | I/O | Detect, repair via `install-ort.mjs`, log |

`planOrtRepair` delegates "what *should* own the namespace" to
`installRecipe(profile, platform).ortPackage` rather than re-deriving it — same
single-source-of-truth rule as above.

**The sharpest footgun in this design:** on `cpu` and `apple` profiles plain `onnxruntime`
is *correct*. A check that repairs on "plain `onnxruntime` is present" without consulting
the profile would rip the working runtime out of every CPU install. The profile is a
required input, not an optimisation.

**Failure policy — non-fatal, fail-open.** A failed repair logs loudly and lets the spawn
proceed. CPU Kokoro is degraded, not broken; blocking TTS entirely would be a worse outcome
than the bug. This also covers a previous child still dying and holding the DLL (the #2037
shape): the repair fails, and retries on the next boot. Note this is the opposite polarity
to `gpu/active-generation-gate.ts`'s fail-closed rule, and deliberately so — there the
worst case of failing open is evicting a model out from under a live render; here the worst
case of failing closed is no TTS at all.

The **repair action** gets a once-per-process guard so a recycle storm cannot become a pip
storm. **Detection** stays unguarded — it is one `readdir`, and it must re-run after any
repair to confirm the outcome.

### Call sites

| File | Change |
|---|---|
| `install-qwen3.mjs:399` | Chokepoint, `noDeps: true` |
| `install-whisper.mjs:96` | Chokepoint, `noDeps: true`, **and drop `-U`** |
| `install-coqui.mjs:149` | Chokepoint **with** deps — gains layers 2 and 3 only |
| `install-coqui.mjs:154` | Already `--no-deps`; route for uniformity |
| `spawn-sidecar.ts` (~530) | Call `assertOrtInvariantBeforeSpawn` before the child spawn |

The `-U` removal is a defect in code this branch already touches, with one defensible fix
and a paired test, so it clears the fix-now bar and lands here rather than becoming a
second ticket. It is declared in the PR body as an incidental fix.

**Explicitly out of scope:** the FlashAttention-2 wheel path in `install-qwen3.mjs`. It is
opt-in, hash-pinned, and already fully non-fatal on every failure path, so routing it buys
nothing this issue is about.

## Testing

### The regression test

Fails before the fix, passes after — asserting the installers' pip argv directly, importing
the `.mjs` the way `install-coqui-steps.test.ts` already does:

- `install-qwen3`'s args contain `--no-deps`
- `install-whisper`'s args contain neither `-U` nor a bare dep-resolving install

Both assertions fail on today's tree.

### Unit

- `sidecar-pip-helpers.test.ts` — argv shapes; `parsePipCheck` against real captured
  output; and the filter asserting the trio is expected on `nvidia` but **not** on `cpu`,
  where those same lines would be genuine breakage.
- `ort-invariant.test.ts` — `detectOrtNamespaceOwner` against temp dirs holding fixture
  `dist-info` directories: gpu-only → ok; gpu+plain → repair; plain-only on `cpu` → ok;
  plain-only on `nvidia` → repair. Plus `planOrtRepair` across profile × platform.
- Spawn wiring — the check runs before the spawn, and a failed repair does **not** block it.

Each assertion is mutation-checked on its own line: a test that passes with the fix reverted
is not a test. In particular the `cpu`-profile cases must fail if the profile input is
dropped, since that is the footgun they exist to catch.

### Not applicable, stated rather than silently skipped

- **pytest** — no Python behaviour changes.
- **e2e** — no router/redux/layout seam.

### On-box acceptance (owed, cannot be discharged in the PR)

This is precisely "behaviour only real hardware can prove." Two rows:

1. **Windows + NVIDIA, app running.** In-app Qwen3 install completes. `pip check`
   afterwards shows only the expected trio. Kokoro still reports `CUDAExecutionProvider`.
2. **Self-heal.** Deliberately clobber ORT (`pip install --force-reinstall onnxruntime`),
   restart the server, confirm the pre-spawn repair fires, logs, and restores
   `onnxruntime-gpu` within its `>=1.27,<1.28` pin.

Register row, per-feature run sheet, and the live view all move in the shipping PR per
Before-shipping checklist step 3.

## Risks

- **A `cpu`/`apple` profile mis-detected as GPU would delete a working runtime.** Mitigated
  by making the profile a required input to `planOrtRepair` and by the dedicated
  `cpu`-profile unit cases. This is the highest-severity failure the design can produce.
- **`--no-deps` masking a genuinely new dependency** if an overlay pin drifts out of sync
  with the package's real requirements. Mitigated by layer 3 — which is why the filtered
  `pip check` is part of the fix and not a nicety.
- **Repair racing a dying sidecar child** holding the DLL. Mitigated by fail-open plus
  retry-next-boot; the worst case is one more boot on CPU Kokoro.
