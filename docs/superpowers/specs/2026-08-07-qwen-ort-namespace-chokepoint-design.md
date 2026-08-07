---
status: draft
date: 2026-08-07
---

# Make the sidecar venv pip-consistent: one marker, carried by the swap plan

Closes the design work behind **#2192**.

> **Revision 4.** Three Premium adversarial rounds. Revisions 1–2 defended the symptom at
> seven pip call sites and failed twice, with round 2 finding that round 1's fixes had
> broken each other; revision 3 pivoted to attacking the root condition. **Round 3 cleared
> the mechanism** — no runtime code reads onnxruntime distribution metadata, and no pip
> mode in this repo defeats a marker — but found the *wiring* wrong in two Critical ways:
> `install-ort.mjs` is never executed as a CLI in production, so the marker would have
> fired on zero paths; and the claim that existing boxes self-heal via upgrade was false.
> This revision fixes the wiring and restores the write-only self-heal. §Review findings
> records all three rounds.

## Problem

An alpha tester on a Pinokio install could not install Qwen3:

```
install-qwen3.mjs exited with code 1. ERROR: Could not install packages due to an
OSError: [WinError 5] Accès refusé:
'…\server\tts-sidecar\.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_shared.dll'
```

`WinError 5` on a `.dll` is Windows reporting a memory-mapped file held by a live process.

### The root condition

The nvidia profile replaces plain `onnxruntime` with `onnxruntime-gpu` — they share the
`site-packages/onnxruntime/` namespace and cannot co-exist. **pip matches distributions by
name**, so `onnxruntime-gpu` never satisfies a requirement spelled `onnxruntime`.

Three installed distributions require plain `onnxruntime` unconditionally, so `pip check`
on a **correctly bootstrapped** NVIDIA box reports — and exits 1:

```
faster-whisper 1.2.1 requires onnxruntime, which is not installed.
kokoro-onnx 0.5.0 requires onnxruntime, which is not installed.
qwen-tts 0.1.1 requires onnxruntime, which is not installed.
```

**The venv is permanently in a state pip considers broken.** Any pip call whose target
depends on `onnxruntime` tries to repair it by installing the CPU build — which either
crashes on the sidecar's DLL lock (`main.py:9174`'s `_run_device_probe` runs
`import onnxruntime` on every boot, wired at `main.py:668`) or, with the sidecar stopped,
silently replaces the GPU runtime, driving past the deliberate `>=1.27,<1.28` pin.

### Why per-site defence was abandoned

Doors onto this bug — a door is a pip call whose target depends on `onnxruntime`:

| Door | Runs | Server in the loop? |
|---|---|---|
| `install-qwen3.mjs:399` | `pip install qwen-tts` | Yes |
| `install-whisper.mjs:96` | `pip install -U faster-whisper` | Yes |
| `upgrade/apply.ts:254-269` | overlay install **plus** `pip uninstall -y onnxruntime onnxruntime-gpu` | Yes |
| `routes/venv-bootstrap.ts:38-41` → `bootstrap-venv.mjs` | overlay install + swap | Yes |
| `pinokio-scripts/install.js:80`, `update.js:73` | `bootstrap-venv.mjs` | **No** |

The last two run with no server process at all, so no server-side chokepoint, quiesce, or
boot-time repair can reach them — and the Pinokio update path is the deployment shape that
reported this bug. (`install-coqui.mjs`'s three pip steps are *not* doors: none of
`coqui-tts`, `torchcodec`, or the CJK phonemizers declares `onnxruntime`.)

## Approach

Record, once, what is already true: **`onnxruntime-gpu` provides the `onnxruntime`
package** — same import name, same API, same version line. A minimal
`onnxruntime-<version>.dist-info` marker beside the GPU distribution makes pip agree, and
pip stops trying to repair the venv from every door simultaneously.

Today's state is arguably the dishonest one: the venv asserts a requirement is unmet that
is in fact met.

### Spike 1 — the mechanism works

Validated on a bootstrapped NVIDIA box before this design was written. Marker created,
every path dry-run (writes nothing), marker removed, baseline confirmed restored.

| Path | Before | With the marker |
|---|---|---|
| `pip install qwen-tts` | `Would install onnxruntime-1.28.0` | `already satisfied … (1.27.0)` |
| `pip install faster-whisper` | same clobber | `already satisfied … (1.27.0)` |
| `pip install -r nvidia-cuda.txt` (upgrade / rebuild / Pinokio) | same clobber | `already satisfied` |
| `pip check` | 3 errors, **exit 1** | `No broken requirements found.` **exit 0** |

Round 3 independently confirmed the two ways this could have been undermined and found
neither: **no runtime code reads onnxruntime distribution metadata** (`main.py`'s only
`importlib.metadata` use is `_coqui_installed_version`; every ORT probe is
`import onnxruntime` + `get_available_providers()`), and **no pip mode in this repo
defeats it** — no `--require-hashes`, no `--report`, no `uv`, no `pip freeze`.

### Spike 2 — the marker is sticky

Tested in a throwaway venv, because the swap **begins** with
`pip uninstall -y onnxruntime onnxruntime-gpu`:

```
Found existing installation: onnxruntime 1.27.0
Can't uninstall 'onnxruntime'. No files were found to uninstall.
uninstall exit=0                     ← the swap's step 1 does not break
```

…**and the marker directory survived.** An empty `RECORD` means pip finds nothing to
remove. So removal must be an explicit `rm` by our own code — pip will never do it — and
the design owns both writing and deleting.

## Components

### The marker travels in the plan, not in a script nobody runs

**`install-ort.mjs` is not an execution site.** Nothing in the tree runs it as a CLI: its
`planOrtSwap` export is imported by `bootstrap-venv.mjs:39` and `upgrade/apply.ts:28`, and
both consumers execute the returned pip steps **in their own process**
(`bootstrap-venv.mjs:212-220`, `apply.ts:263-266`). Its `import.meta.url === argv[1]` block
(`:98-121`) is reachable only by a human running it by hand — which is exactly what
#2192's manual workaround instructs, and why it reads like the site.

So the marker action rides the plan both consumers already loop over:

```
planOrtSwap(profile, platform) → { action, steps, ortPackage, marker: { action: 'write' | 'delete' } }
```

| Branch | Profiles | `marker.action` |
|---|---|---|
| `swap` | nvidia | `write` — after the steps succeed |
| `skip` | cpu, amd, apple | `delete` — plain `onnxruntime` is correct there |

`installRecipe(profile, platform).ortPackage !== 'onnxruntime'` is the mechanical predicate
for "this profile swaps." **AMD and Apple both resolve to plain `onnxruntime`**
(`accelerator-profile.mjs:178,189`) and take the `delete` branch — a "GPU profile"
shorthand would wrongly group AMD with NVIDIA.

**Critically, both consumers apply the marker OUTSIDE their `ort.action === 'swap'` gate.**
Today each does `if (ort.action === 'swap') { …steps… }`, so the skip branch executes
nothing. The delete side must still run on cpu/amd/apple.

**The two halves run at different points, and the order is load-bearing:**

- **`delete` runs FIRST**, before any overlay `pip install` in that flow.
- **`write` runs LAST**, after the swap steps succeed.

A single call sited after the swap block would be too late. `cpu.txt:26` carries an
**explicit** `onnxruntime` line (the nvidia overlay only pulls it transitively), and
`bootstrap-venv.mjs:181`'s AMD→ROCm-failure→CPU fallback runs
`pip install -r <cpu overlay>`. With a stale marker still present at that moment, pip
reports `onnxruntime` satisfied and installs nothing — leaving the box with
`onnxruntime-gpu` files, no CPU runtime, and a deleted marker afterwards: broken in both
directions at once.

The `rebuild` gate makes a marker on a non-nvidia venv unlikely (a profile change forces a
full reinstall), but "unlikely" is the reasoning that failed the three previous rounds of
this design. Deleting first costs nothing and removes the state entirely.

### Changed files

| File | Change |
|---|---|
| `install-ort.mjs` | `planOrtSwap` returns `marker`; add `applyOrtMarker`, `readInstalledOrtVersion`, `writeOrtMarker`, `deleteOrtMarker` |
| `bootstrap-venv.mjs` | Call `applyOrtMarker` after the swap block, outside the gate. Needs its own injectable seam — `installForProfile` already injects `runPip` (`:151`), and an un-injected fs write there is untestable at that layer |
| `upgrade/apply.ts` | Same call in `pipInstall`, outside the gate |
| `index.ts` (server boot) | `ensureOrtMarker` — the write-only self-heal, below |
| `install-whisper.mjs` | Drop `-U`, add `-c`; extract an exported arg builder |
| `spawn-windows-hide.test.ts` | Widen the guard, below |

**Version derivation.** Read from the dist-info the swap just installed, globbed from
`plan.ortPackage` — **not** hardcoded, and **not** hardcoded to `onnxruntime_gpu-*` either:
`planOrtSwap` already supports a non-GPU swap package (the documented
`onnxruntime-directml` re-enable, `install-ort.mjs:9,21-23`), which would find no
`onnxruntime_gpu-*` dist. A hardcoded version silently starts lying the first time the pin
is bumped, and `faster-whisper`'s `onnxruntime<2,>=1.14` bound means a sufficiently wrong
version makes pip resolve *against* us.

**On `null`, fail the swap loudly.** If the version cannot be read, the swap fails —
`bootstrap-venv.mjs:217` already treats a swap failure as fatal ("better to fail the
install loudly than ship a GPU box that quietly synthesises on the CPU"). Silently skipping
the write would re-open the bug with no signal, which is the exact silence class this
design exists to close. Writing a version-less marker would produce invalid metadata.

**Marker contents** — minimal and self-identifying, so it is greppable and obviously ours:

```
METADATA    Metadata-Version: 2.1 / Name: onnxruntime / Version: <derived>
INSTALLER   castwright-ort-marker
RECORD      (empty — nothing to uninstall; see Spike 2)
```

**Which `site-packages`.** One resolver, named here so it is not re-derived: the
`SIDECAR_VENV_DIR ?? <repoRoot>/server/tts-sidecar/.venv` convention already in
`diagnostics/venv.ts:9-11`, extracted to a shared `resolveSidecarVenvDir(repoRoot)`. Within
that venv, `Lib/site-packages` on Windows and `lib/python<maj>.<min>/site-packages` on
posix — resolved by asking the venv interpreter, since the posix layout needs its minor
version. This repo has a competing hardcoded convention in the `*-install-detect.ts` files;
copying that one would make the marker land in a directory that does not exist on a
versioned-dir install.

**Cosmetic note:** with the marker present, the swap's step 1 prints `Can't uninstall
'onnxruntime'. No files were found to uninstall.` and exits 0. Expected, not an error.

### The self-heal, restored — and write-only

Round 3 disproved the claim that existing boxes heal themselves. Both upgrade
(`apply.ts:134`) and rebuild (`decideVenvAction` → `noop` when `stamp.reqHash ===
required.reqHash`) gate on the requirements hash, and **this change touches no
`requirements/*.txt`** — so nothing re-runs the swap and no existing box would ever get a
marker.

`ensureOrtMarker(venvDir)` runs once at server boot, before the supervisor starts
(`index.ts:309`): if the namespace is owned by a swap distribution and no marker is
present, write one. Otherwise do nothing.

**This is safe in a way the repair killed in rounds 1–2 was not.** It uninstalls nothing,
downloads nothing, needs no network, touches no locked DLL, and needs no accelerator
profile — it reads what is *installed*, not what *should* be. Every Critical from rounds
1–2 lived in a destructive repair whose mechanism no longer exists here. Worst case is a
directory with three small files.

It runs at server boot rather than per-spawn, so it is unaffected by the adopt/unfit-replace
branching that round 2 showed makes `spawnSidecar` placement treacherous.

### `install-whisper.mjs` — independent, and a real defect

`:96` runs `pip install -U faster-whisper` with **no constraints file**, against a package
`base.txt:45` pins to `>=1.0,<2.0`. `-U` can walk it past its own pin; where it is absent,
pip resolves to whatever is latest, so a 2.x release would install cleanly in violation.
Every sibling passes `-c` (`install-qwen3.mjs:100`, `install-coqui.mjs:149`).

Fix: **drop `-U`, add `-c <sanitized base.txt>`.** Round 3 confirmed this safe: `base.txt`
carries no `onnxruntime` line (enforced by `requirements-layout.test.ts:21`), so the
constraints file cannot conflict with the marker's version, and it has no `-r` includes,
satisfying `pip-constraints.mjs`'s documented assumption.

Because the pip args are inline in an unexported `main()` — `install-whisper.mjs` exports
nothing — **extracting an exported arg builder is part of the work**, not a test detail;
without it the regression test fails on import rather than on its assertion. The step also
becomes a no-op on every normal box, so its header (`:12-13`) and log line (`:95`), which
still say "pulls ctranslate2 + av", are updated in the same diff.

### `spawn-windows-hide.test.ts`

Its `EXTERNAL_FILES` array (`:54-62`) enforces `windowsHide` on prod-reachable pip spawners
outside `server/src` via a **hardcoded list** that names three installers. It omits
`install-ort.mjs` (`:113`), `bootstrap-venv.mjs` (`:104`), and `install-torch.mjs` (`:59`,
prod-reachable on the AMD path via `installForProfile`). Adding names keeps the list and the
stated rule out of step. **Replace the enumeration with a glob** over
`server/tts-sidecar/scripts/*.mjs` + `scripts/*.mjs`, selecting files that spawn pip.

## Testing

### The test that would have caught round 3's Critical

At the seam where the marker is actually applied — `installForProfile` and `pipInstall` —
with the fs writer injected alongside the existing `runPip`: assert the marker action is
**emitted** for nvidia and the delete for cpu/amd/apple. Revision 3's plan tested only
isolated planners and writers, so it would have been fully green while the shipped change
did nothing.

### Regression (fail before, pass after)

- `install-whisper`'s args contain `-c` and **not** `-U` — fails on today's tree.
- `planOrtSwap` returns `marker.action === 'delete'` for `cpu`, `amd`, **and** `apple`, and
  `'write'` for `nvidia`. Note this is a *new* return field, so its red phase is an import
  failure, not an assertion failure — it is listed here for completeness, and the
  seam test above is the one that carries the regression weight.

### Unit

- `readInstalledOrtVersion` globs from `plan.ortPackage`, parses the real
  `onnxruntime_gpu-1.27.0.dist-info` shape, and returns `null` when absent — with a paired
  test that `null` **aborts the swap** rather than skipping the write.
- `writeOrtMarker` overwrites a stale marker rather than skipping it — Spike 2 proved pip
  leaves stale markers behind, so create-if-missing would preserve a lie.
- `deleteOrtMarker` is a no-op when absent and removes only the marker directory.
- **Ordering**: on a non-swapping profile the delete is emitted **before** the overlay
  install, not after — asserted at the seam, with the AMD→CPU fallback as the case. A test
  that only checks "delete was called" passes under the broken ordering.
- `ensureOrtMarker` is a no-op when a marker exists, when the namespace is unowned, and on
  a cpu-profile venv; and never calls uninstall or network code.
- The marker matcher targets the **raw** `.dist-info` directory name, mutation-checked
  against `onnxruntime-1.28.0.dist-info` **and** `onnxruntime_gpu-1.27.0.dist-info` in one
  assertion — pip normalises the GPU distribution with an **underscore** (verified live), so
  a matcher catching both would delete the real GPU distribution.

Every assertion is mutation-checked on its own line.

### Not applicable, stated rather than silently skipped

- **pytest** — no Python behaviour changes.
- **e2e** — no router/redux/layout seam.

### On-box acceptance (owed; recording it is the merge gate, running it is not)

1. **Fresh NVIDIA bootstrap** → marker present at the installed GPU version; `pip check`
   clean, exit 0; Kokoro reports `CUDAExecutionProvider`.
2. **The reported bug** — Windows + NVIDIA, **app running**, in-app Qwen3 install completes
   with no `WinError 5`; GPU Kokoro afterwards.
3. **Self-heal on an existing box** — a venv bootstrapped *before* this change (no marker,
   `pip check` failing) gains one on next server start with no reinstall. This is the case
   round 3 proved nothing else covers.
4. **Pinokio update path** — `pinokio-scripts/update.js` on a real Pinokio install, the
   deployment shape that reported the bug.
5. **AMD box** — no marker is written, and one left over from a prior nvidia profile is
   deleted.

Register row, run sheet, and live view all move in the shipping PR per checklist step 3.

## What this does not deliver

#2192 asks that the in-app install "either succeed, or fail with an actionable message —
**never a raw `WinError 5`**." This design delivers prevention, not translation: there is no
`WinError`/errno handling in `routes/qwen-install.ts` or `tts/qwen-install-bootstrap.ts`,
so a lock on any *other* venv DLL (ctranslate2, torch) would still surface a raw pip
traceback. Prevention is the better fix for the reported case; the translation half is
**explicitly not shipped here** and is filed separately rather than left implied.

## Before-shipping coverage

Steps 1/4: substantial and cross-cutting — **owes a plan under `docs/features/` and an
`INDEX.md` entry**. Step 5: user-visible (installs stop failing; upgrades stop breaking GPU
Kokoro), so **both release-notes documents move in the PR**.

## Risks

- **Wiring, not mechanism, is where this design has failed before.** The marker rides the
  plan and is applied by both consumers outside their swap gate; the seam test exists
  specifically because revision 3 was green while shipping nothing.
- **Marker version drift** if `onnxruntime-gpu` is changed outside the swap (a manual
  `pip install -U onnxruntime-gpu`). `faster-whisper`'s `<2,>=1.14` bound tolerates a wide
  range, so blast radius is small.
- **`pip freeze` now lists both** `onnxruntime==<v>` and `onnxruntime-gpu==<v>`. Nothing in
  the tree runs it, but a future support-bundle `pip install -r frozen.txt` would clobber.
- **The marker is a metadata assertion** — true at the package level, but not something pip
  derived itself. A future pip that validates `RECORD` hashes could object; nothing in the
  pinned toolchain does today.
- **`cpu.txt:26` carries an explicit `onnxruntime` line.** The AMD→CPU fallback
  (`bootstrap-venv.mjs:181`) is the one live path where a marker would suppress a real,
  explicitly-requested install — reachable only on an AMD box, which takes the `delete`
  branch and so never carries one. This is why `delete` is active rather than a no-op.
- **Pre-existing and untouched:** doors 1–2 resolve the venv as `SIDECAR_DIR/.venv` while
  the rest honour `SIDECAR_VENV_DIR` — on a versioned-dir install those differ. **Filed as
  its own issue**; a split-venv install has a deeper problem than this bug.

## Review findings

Three Premium-tier rounds. Rounds 1 and 2 attacked a per-site architecture (chokepoint,
`--no-deps`, quiesce, destructive boot repair) and found nine and sixteen defects
respectively — round 2 briefed to attack round 1's fixes, which it found had broken each
other. That architecture was abandoned rather than patched a third time; §Approach is what
replaced it.

Round 3 attacked the replacement. **It cleared the mechanism** (no runtime metadata reader;
no pip mode defeats a marker; the `install-whisper` fix is safe) and found the wiring wrong:

| Finding | Severity | Disposition |
|---|---|---|
| `install-ort.mjs` is never run as a CLI — the marker would fire on zero paths | Critical | Marker rides the plan; both consumers apply it; both now Changed files |
| Existing boxes are *not* healed by upgrade/rebuild — both gate on an unchanged reqHash | Critical | Write-only `ensureOrtMarker` at server boot, restored |
| Profile migration returns `rebuild` → refuses, so the marker dies with the venv | Major | Risk model corrected; `delete` kept as insurance for the AMD→CPU fallback |
| Test plan could not detect the fix not working | Major | Seam test at `installForProfile` / `pipInstall` |
| The read-only detector was never specified | Major | Superseded — the write-only self-heal replaces it |
| `null` version handling unspecified; glob hardcoded to `onnxruntime_gpu-*` | Major | Fails the swap loudly; glob derived from `plan.ortPackage` |
| `site-packages` resolution ambiguous | Major | One named resolver + interpreter-derived layout |
| Widened `windowsHide` rule still omits `install-torch.mjs` | Minor | Glob instead of enumeration |
| `install-coqui.mjs` rows were padding — none of those packages needs `onnxruntime` | Minor | Removed from the doors table |
| The "actionable message" half of the acceptance criterion is not delivered | Minor | Stated explicitly in §What this does not deliver |
