---
status: draft
date: 2026-08-07
---

# Make the sidecar venv pip-consistent: one marker, at one site

Closes the design work behind **#2192**.

> **Revision 3 — architecture change.** Revisions 1 and 2 defended the symptom at every
> pip call site. Both failed the adversarial review gate with Criticals, and round 2's
> findings were largely round 1's *fixes* breaking: a repair rule that could no longer fire
> on the states it existed to heal, a quiesce primitive that silently no-ops on an adopted
> sidecar, a prefetch that still needed the network after uninstalling. The design had
> grown to four layers over seven call sites and still could not reach the three
> out-of-process Pinokio paths.
>
> This revision attacks the root condition instead, and was **empirically validated before
> being written** — see §The spike. It replaces the chokepoint, the quiesce layer, the
> boot-time repair, `--no-deps`, and `overlayDeclares` with a marker written at one site.
> §Review findings records what both rounds found and which findings the pivot dissolves
> rather than fixes.

## Problem

An alpha tester on a Pinokio install could not install Qwen3:

```
install-qwen3.mjs exited with code 1. ERROR: Could not install packages due to an
OSError: [WinError 5] Accès refusé:
'…\server\tts-sidecar\.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_shared.dll'
```

`WinError 5` on a `.dll` is Windows reporting a memory-mapped file held by a live process.

### The root condition

`install-ort.mjs` replaces plain `onnxruntime` with `onnxruntime-gpu` on GPU profiles —
they share the `site-packages/onnxruntime/` namespace and cannot co-exist. **pip matches
distributions by name**, so `onnxruntime-gpu` never satisfies a requirement spelled
`onnxruntime`.

Three installed distributions require plain `onnxruntime` unconditionally, so `pip check`
on a **correctly bootstrapped** NVIDIA box reports (verified, pip 25.0.1) — and exits 1:

```
faster-whisper 1.2.1 requires onnxruntime, which is not installed.
kokoro-onnx 0.5.0 requires onnxruntime, which is not installed.
qwen-tts 0.1.1 requires onnxruntime, which is not installed.
```

**The venv is permanently in a state pip considers broken.** Any pip call whose target
depends on `onnxruntime` tries to repair it by installing the CPU build — which either
crashes on the sidecar's DLL lock (`main.py:9174`'s `_run_device_probe` runs
`import onnxruntime` on every boot, wired at `main.py:668`) or, with the sidecar stopped,
silently replaces the GPU runtime. The latter is worse: no error, no log line, and it
drives past `install-ort.mjs`'s deliberate `>=1.27,<1.28` pin.

### Why per-site defence failed

At least seven pip sites reach this venv, across five entry points:

| Door | Runs | Server in the loop? |
|---|---|---|
| `install-qwen3.mjs:399` | `pip install qwen-tts` | Yes |
| `install-whisper.mjs:96` | `pip install -U faster-whisper` | Yes |
| `install-coqui.mjs` ×3 (`:149`, `:154`, `:158-172`) | opt-in Coqui + CJK phonemizers | Yes |
| `upgrade/apply.ts:254-269` | overlay install **plus** `pip uninstall -y onnxruntime onnxruntime-gpu` | Yes |
| `routes/venv-bootstrap.ts:38-41` → `bootstrap-venv.mjs` | overlay install + ORT swap | Yes |
| `pinokio-scripts/install.js:80`, `update.js:73` | `bootstrap-venv.mjs` | **No** |
| `pinokio-scripts/reset.js:13` | `fs.rm` on the venv, no stop step | **No** |

The last three run with no server process at all, so no server-side chokepoint, quiesce, or
boot-time repair can ever reach them — and the Pinokio update path is the exact deployment
shape that reported this bug.

## Approach

Record, once, the thing that is already true: **`onnxruntime-gpu` provides the
`onnxruntime` package** — same import name, same API, same version line. A minimal
`onnxruntime-<version>.dist-info` marker alongside the GPU distribution makes pip agree,
and pip then stops trying to "repair" the venv from every door simultaneously.

Today's state is arguably the dishonest one: the venv asserts a requirement is unmet that
is in fact met.

### The spike

Validated empirically on a bootstrapped NVIDIA box before this revision was written.
Marker created, every path dry-run (writes nothing), marker removed, baseline confirmed
restored.

| Path | Before | With the marker |
|---|---|---|
| `pip install qwen-tts` | `Would install onnxruntime-1.28.0` | `already satisfied: onnxruntime … (1.27.0)` |
| `pip install faster-whisper` | same clobber | `already satisfied: onnxruntime<2,>=1.14 … (1.27.0)` |
| `pip install -r nvidia-cuda.txt` (upgrade / rebuild / Pinokio) | same clobber | `already satisfied` |
| `pip check` | 3 errors, **exit 1** | `No broken requirements found.` **exit 0** |

No `Would install onnxruntime` on any path. Every door closes at once, including the three
out-of-process ones.

### The second spike result, which shapes the design

Tested separately in a throwaway venv, because `install-ort.mjs`'s swap **begins** with
`pip uninstall -y onnxruntime onnxruntime-gpu`:

```
Found existing installation: onnxruntime 1.27.0
Can't uninstall 'onnxruntime'. No files were found to uninstall.
uninstall exit=0                     ← the swap's step 1 does not break
```

…**and the marker directory survived.** An empty `RECORD` means pip finds nothing to
remove and leaves the `.dist-info` in place.

Two consequences, both load-bearing:

1. **Removal must be explicit.** pip will never delete the marker, so this design owns
   both writing *and* deleting it. A `rm -rf` of the directory is the only mechanism.
2. **A stale marker suppresses a legitimate install.** With the marker present,
   `pip install onnxruntime` reports "already satisfied" and installs nothing. That is
   exactly what a profile migration from `nvidia` to `cpu` needs to do — the CPU profile
   requires real plain `onnxruntime`. **So the marker must be deleted whenever the swap is
   not in effect**, not merely written when it is. `planOrtSwap`'s existing `skip` branch
   (cpu / amd / apple) becomes an active *delete-if-present*, not an early return.

Missing consequence 2 would convert this fix into a new silent-breakage bug on profile
migration — the same class it exists to close.

## Components

### Changed: `server/tts-sidecar/scripts/install-ort.mjs`

The single site. Both branches of `planOrtSwap` gain a marker action:

| Branch | Profiles | Marker action |
|---|---|---|
| `swap` | nvidia | **Write** (overwrite) after the force-reinstall succeeds |
| `skip` | cpu, amd, apple | **Delete if present** — plain `onnxruntime` is correct there |

`installRecipe(profile, platform).ortPackage !== 'onnxruntime'` is the mechanical predicate
for "this profile swaps." AMD and Apple both resolve to plain `onnxruntime`
(`accelerator-profile.mjs:178,189`) and must therefore take the **delete** branch — a
"GPU profile" shorthand would wrongly group AMD with NVIDIA.

New exports, pure planner plus thin writer, matching the file's existing shape:

| Export | Kind | Purpose |
|---|---|---|
| `planOrtMarker(profile, platform)` | pure | `{ action: 'write' \| 'delete' }` |
| `readInstalledOrtVersion(sitePackages)` | fs read | Version from the installed `onnxruntime_gpu-*.dist-info` |
| `writeOrtMarker(sitePackages, version)` | fs write | Create/overwrite the marker |
| `deleteOrtMarker(sitePackages)` | fs write | Remove it if present |

**The version is derived, never hardcoded** — read from the `onnxruntime_gpu-*.dist-info`
that the swap just installed. A hardcoded version silently starts lying the first time the
`>=1.27,<1.28` pin is bumped, and `faster-whisper`'s `onnxruntime<2,>=1.14` bound means a
sufficiently wrong version would make pip resolve *against* us.

**Marker contents** — minimal and self-identifying, so it is greppable and obviously ours:

```
METADATA    Metadata-Version: 2.1 / Name: onnxruntime / Version: <derived>
INSTALLER   castwright-ort-marker
RECORD      (empty — nothing to uninstall; see §The spike)
```

**Cosmetic note for the implementer:** with the marker present, the swap's step 1 prints
`Can't uninstall 'onnxruntime'. No files were found to uninstall.` and exits 0. That is
expected output, not an error, and should not be "fixed."

**Which `site-packages`.** The marker is written relative to the venv `install-ort.mjs` was
handed (`process.argv[2]`, the venv python), derived from that interpreter — not from a
second convention. This repo has two conflicting ones (`SIDECAR_VENV_DIR` vs a hardcoded
`repoRoot/server/tts-sidecar/.venv`), and they differ on exactly the versioned-dir install
that reported this bug.

### Changed: `server/tts-sidecar/scripts/install-whisper.mjs`

Independent of the marker, and a real defect: `:96` runs `pip install -U faster-whisper`
with **no constraints file**, against a package `base.txt:45` pins to `>=1.0,<2.0`. `-U`
can walk it past its own pin, and on a box where it is absent pip resolves to whatever is
latest — a 2.x release would install cleanly in violation of the pin. Every sibling passes
`-c` (`install-qwen3.mjs:100`, `install-coqui.mjs:149`).

Fix: **drop `-U`, add `-c <sanitized base.txt>`.** This clears the fix-now bar (one
defensible answer, coverable by a test here) and is declared in the PR body as an
incidental fix.

The pip args are currently inline in an unexported `main()` — `install-whisper.mjs` exports
nothing — so **extracting an exported arg builder** (mirroring `qwenPipInstallArgs` at
`install-qwen3.mjs:99-101`) is part of the work, not a test detail. Without it the
regression test fails on import rather than on its assertion: a red phase by accident.

### Changed: `server/src/spawn-windows-hide.test.ts`

Its `EXTERNAL_FILES` array (`:55-63`) is a **hardcoded list** enforcing `windowsHide` on
prod-reachable pip spawners outside `server/src`. It names three installers but omits
`install-ort.mjs` (spawns pip at `:113`) and `bootstrap-venv.mjs` (`:104`) — both satisfy
the array's own stated rule verbatim. This design makes `install-ort.mjs` materially more
load-bearing, so both are added and the rule restated as "any file outside `server/src`
that spawns pip" rather than re-enumerating installers.

### Detection, not repair — a deliberate change from the earlier decision

The agreed direction was "detect and self-heal on boot." **This revision detects and
reports, and does not repair.** The reasoning, stated so it can be overruled:

- Every Critical in both review rounds lived in the boot-time repair — the profile signal
  that reads absence as an assertion, the adopted sidecar that defeats the stop primitive,
  the uninstall-before-download ordering, the placement that would have run `pip uninstall`
  inside the unit suite.
- With the marker in place, **nothing new becomes broken**, so a repair mechanism only ever
  serves the historical population.
- That population is already healed by any path that re-runs the swap — an in-app upgrade
  (`apply.ts:254-269`) or a venv rebuild — both of which now also write the marker.
- The core sin of this bug is *silence*. A loud, accurate diagnosis plus a one-command fix
  removes the silence at a fraction of the risk of an automatic destructive repair.

So: a read-only check reports when the namespace owner disagrees with the active profile,
and names the command that fixes it. It never uninstalls anything.

## Testing

### Regression tests (fail before, pass after)

- `install-whisper`'s args contain `-c` and **not** `-U` — fails on today's tree.
- `planOrtMarker` returns `delete` for `cpu`, `amd`, **and** `apple`, and `write` only for
  `nvidia` — the AMD/Apple cells are the ones that would silently break profile migration.

### Unit

- `readInstalledOrtVersion` parses the real `onnxruntime_gpu-1.27.0.dist-info` shape and
  returns `null` (not a hardcoded fallback) when absent, so a missing dist can never
  produce a confidently-wrong marker.
- `writeOrtMarker` overwrites an existing stale marker rather than skipping it — the
  spike proved pip leaves stale markers behind, so create-if-missing would preserve a lie.
- `deleteOrtMarker` is a no-op when absent and removes only the marker directory.
- The marker matcher targets the **raw** `.dist-info` directory name, and is
  mutation-checked against `onnxruntime-1.28.0.dist-info` **and**
  `onnxruntime_gpu-1.27.0.dist-info` in one assertion — pip normalises the GPU
  distribution with an **underscore** (verified in the live venv), so a matcher that
  catches both would delete the real GPU distribution.

Every assertion is mutation-checked on its own line.

### Not applicable, stated rather than silently skipped

- **pytest** — no Python behaviour changes.
- **e2e** — no router/redux/layout seam.

### On-box acceptance (owed; recording it is the merge gate, running it is not)

1. **Fresh NVIDIA bootstrap** → marker present at the installed GPU version; `pip check`
   clean, exit 0; Kokoro reports `CUDAExecutionProvider`.
2. **The reported bug** — Windows + NVIDIA, **app running**, in-app Qwen3 install completes
   with no `WinError 5`; GPU Kokoro afterwards.
3. **Profile migration `nvidia` → `cpu`** — the marker is deleted and real plain
   `onnxruntime` installs. This is the case the second spike result created; it is the
   most likely way this design breaks.
4. **Pinokio update path** — `pinokio-scripts/update.js` on a real Pinokio install, the
   deployment shape that reported the bug.

Register row, run sheet, and live view all move in the shipping PR per checklist step 3.

## Before-shipping coverage

Steps 1/4: substantial and cross-cutting — **owes a plan under `docs/features/` and an
`INDEX.md` entry**. Step 5: user-visible (installs stop failing; upgrades stop breaking
GPU Kokoro), so **both release-notes documents move in the PR**.

## Risks

- **Marker version drift.** If `onnxruntime-gpu` is changed by something other than
  `install-ort.mjs` (a manual `pip install -U onnxruntime-gpu`), the marker keeps the old
  version. `faster-whisper`'s `onnxruntime<2,>=1.14` bound tolerates a wide range, so the
  practical blast radius is small, but ORT-gpu changes should go through the swap.
- **A stale marker suppressing a real install.** The failure mode the `delete` branch
  exists to prevent; on-box case 3 is its acceptance.
- **The marker is a metadata assertion.** It states that `onnxruntime-gpu` provides
  `onnxruntime`, which is true at the package level but is not something pip derived
  itself. A future pip that validates `RECORD` hashes could object; nothing in the pinned
  toolchain does today.
- **Pre-existing and untouched:** doors 1–3 resolve the venv as `SIDECAR_DIR/.venv`
  (`install-qwen3.mjs:165-169`, `install-whisper.mjs:56-63`, `install-coqui.mjs:46`) while
  doors 4–5 and the sidecar honour `SIDECAR_VENV_DIR` — on a versioned-dir install those
  differ. This design does not fix that; it is called out because the marker lives in
  whichever venv the swap ran against, and a split-venv install has a deeper problem than
  this bug. **Files as its own issue.**

## Review findings

Two Premium-tier rounds against the per-site architecture. Round 1 found nine defects;
round 2, briefed to attack round 1's fixes, found sixteen — including that those fixes had
broken each other. Every finding was re-verified against the tree before being acted on.

**Dissolved by the pivot** (the mechanism they attacked no longer exists): the
one-directional repair rule and its unreachable no-runtime states; the positive-profile-
signal predicate; prefetch-first ordering; the `applyOrtSwap` signature change; quiesce and
the adopted-sidecar `stop()` no-op; the repair's placement in `spawnSidecar`; the
owner-set anti-storm guard; `overlayDeclares` and its `-r base.txt` include graph;
`--no-deps` disabling `install-qwen3.mjs`'s documented repair purpose; the gutted-namespace
probe; the `pip check` cry-wolf filter and its exit-1 handling.

**Carried into this revision as real fixes:**

| Finding | Round | Disposition |
|---|---|---|
| `install-whisper.mjs` `-U` with no `-c` | 1 (#9), sharpened in 2 | Fixed here |
| `install-whisper.mjs` exports nothing, so the test can't be written | 1 (#6) | Arg-builder extraction is part of the work |
| `spawn-windows-hide.test.ts` list omits pip spawners | 1 (#5), widened in 2 (#9) | `install-ort.mjs` + `bootstrap-venv.mjs` added |
| AMD/Apple are not "GPU profiles" | 2 (#7) | Drives the `write`/`delete` split |
| Raw vs normalised `.dist-info` matcher | 2 (#12) | Matcher specified + mutation-checked |
| Two venv-path conventions | 2 (#8, #14) | Marker follows the swap's venv; the split filed separately |
| Out-of-process Pinokio doors | 2 (#3, #14) | Closed by construction — no server needed |
