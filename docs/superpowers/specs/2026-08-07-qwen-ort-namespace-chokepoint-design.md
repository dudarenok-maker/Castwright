---
status: draft
date: 2026-08-07
---

# Make the sidecar venv pip-consistent: one marker, carried by the swap plan

Closes the design work behind **#2192**.

> **Revision 6.** Five Premium adversarial rounds. Revisions 1–2 defended the symptom at
> seven pip call sites and failed twice, with round 2 finding that round 1's fixes had
> broken each other; revision 3 pivoted to attacking the root condition. **Round 3 cleared
> the mechanism** — no runtime code reads onnxruntime distribution metadata, and no pip
> mode in this repo defeats a marker — but found the *wiring* wrong in two Critical ways:
> `install-ort.mjs` is never executed as a CLI in production, so the marker would have
> fired on zero paths; and the claim that existing boxes self-heal via upgrade was false.
> Revision 4 fixed the wiring and restored the self-heal; **round 4 then returned "not safe
> to implement from"** — three Criticals in those fixes, including a venv state no revision
> had ever named (the already-clobbered box, which #2192 says is the largest population) and
> a version glob that would have failed every NVIDIA bootstrap. **Round 5**, scoped to those
> three, resolved one and rejected two — the ownership predicate could not tell a GPU build
> from a CPU one, and would have deleted a correct marker on every boot. **Revision 6** folds
> all of it. §Review findings records all five rounds.

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
silently replaces the GPU runtime, driving past the deliberate `>=1.26,<1.27` pin.

### Why per-site defence was abandoned

Doors onto this bug — a door is a pip call whose target depends on `onnxruntime`:

| Door | Runs | Server in the loop? |
|---|---|---|
| `install-qwen3.mjs:399` | `pip install qwen-tts` | Yes |
| `install-whisper.mjs:96` | `pip install -U faster-whisper` | Yes |
| `upgrade/apply.ts:254-269` | overlay install **plus** `pip uninstall -y onnxruntime onnxruntime-gpu` | Yes |
| `routes/venv-bootstrap.ts:38-41` → `tts/venv-bootstrap.ts:183-195` → `bootstrap-venv.mjs` | overlay install + swap | Yes |
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

**The two halves sit on opposite sides of the existing `ort.action === 'swap'` gate.** Today
each consumer does `if (ort.action === 'swap') { …steps… }`, so the skip branch executes
nothing at all.

- **`delete` goes OUTSIDE the gate**, at function entry — it must still run on
  cpu/amd/apple, which never enter the block.
- **`write` goes INSIDE the gate**, as its last statement — a write outside it would fire on
  profiles that have no `ortPackage` to derive a version from (see below).

**The two halves run at different points, and the order is load-bearing:**

- **`delete` runs FIRST**, before any overlay `pip install` in that flow.
- **`write` runs LAST**, after the swap steps succeed.

A single combined call — of either half — sited after the swap block would be too late for
the delete. `cpu.txt:26` carries an
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

**There are THREE call sites per consumer.** A single `applyOrtMarker` call cannot express
the ordering; the verb is split so an implementer cannot collapse it back. The third is the
failure path — the delete before re-throwing on a failed swap step, which in `apply.ts`
needs a `try`/`catch` around the swap loop that does not exist today.

**`writeOrtMarker` no-ops unless `plan.marker.action === 'write'`.** This is load-bearing
and was missing: `planOrtSwap`'s skip variant returns **no `ortPackage`**
(`install-ort.mjs:75-77`), so an ungated write on cpu/apple either (a) globs from
`undefined`, resolves nothing, hits the fail-loudly rule and **breaks every CPU bootstrap**,
or (b) writes a marker whose directory name is byte-identical to the *real* plain
distribution and — per "overwrite a stale marker rather than skip it" — replaces that
distribution's `RECORD` with an empty file and its `INSTALLER` with ours, making the real
onnxruntime un-uninstallable and permanently "satisfied." The skip variant gains `marker`
but still no `ortPackage`.

**Anchors are expressed as positions relative to named code, not line numbers.** Line
numbers in this spec have now drifted twice across review rounds — they are a second source
of truth for something the code already defines, and the review that caught the second drift
noted it was the same defect class as the first.

| File | Change | Exact anchor |
|---|---|---|
| `install-ort.mjs` | `planOrtSwap` returns `marker`; add `SWAP_ORT_PACKAGES`, `readInstalledOrtVersion`, `writeOrtMarker`, `deleteOrtMarkerIfOurs`, `ensureOrtMarker` | — |
| `install-ort.mjs` CLI block | Apply the same two calls, so the hand-run invocation #2192's workaround publishes also produces a marker | `:98-121` |
| `bootstrap-venv.mjs` | `deleteOrtMarkerIfOurs` at `installForProfile`'s **function entry** — before the AMD torch pre-install, the AMD→CPU fallback, the nvidia torch pre-install, *and* both overlay installs | first statement of `installForProfile` |
| `bootstrap-venv.mjs` | `writeOrtMarker` (gated) as the **last statement inside** the `if (ort.action === 'swap')` block, after the step loop | end of the swap block |
| `upgrade/apply.ts` | `deleteOrtMarkerIfOurs` in `pipInstall`, **after** `profile`/`sidecar` are computed and **before** the torch pre-install | before the first `run(...)` in `pipInstall` |
| `upgrade/apply.ts` | `writeOrtMarker` (gated) as the **last statement of `pipInstall`'s body** — *not* after the closing brace, which is `readReqHash` | end of `pipInstall` |
| both consumers | `deleteOrtMarkerIfOurs` on the swap-failure path, before re-throwing | `catch` around the swap loop |
| `upgrade/apply.ts` | **Add an injection seam to `createApplySteps`** — see §Testing; without it the apply half ships untested |
| `index.ts` | `ensureOrtMarker` — the self-heal, below | in `main()`, before `app.listen` |
| `install-whisper.mjs` | Drop `-U`, add `-c`; extract an exported arg builder | `:95-96`, header `:12-13` |
| `spawn-windows-hide.test.ts` | Widen the guard, below | `:54-62` |

`installForProfile` takes **positional** params and its `venvDir` defaults to `null`. Its
one production caller (`runInstall`) does pass a real dir, so the null case is test-only —
but the marker path is still derived from the venv python the function already holds rather
than from `venvDir`, so a null can never make the delete silently no-op.

### The three venv states, and why dist-info presence cannot tell them apart

The design must name the state the issue says is **most common**, which revisions 3–4 never
did: the already-clobbered box.

| State | `onnxruntime_gpu-*.dist-info` | plain `onnxruntime-*.dist-info` | Files in the namespace |
|---|---|---|---|
| Healthy nvidia (today) | present | absent | GPU |
| Healthy nvidia (**after this ships**) | present | present (**ours**) | GPU |
| **Interrupted swap** | absent | present (**ours**) | **none** |
| Healthy cpu/amd/apple | absent | present (**real**) | CPU |
| **Clobbered** | **present** | **present (real)** | **GPU** |

The GPU dist-info survives a clobber because pip uninstalls by *name* and never knew the
two collided (`install-ort.mjs:92-93` exists precisely because of this). **So dist-info
presence proves nothing about who owns the namespace**, and two predicates must be stated
separately or an implementer will conflate them:

- **Ownership** — read from a file the wheel ships:
  `site-packages/onnxruntime/capi/build_and_package_info.py`, whose first line is
  `package_name = 'onnxruntime-gpu'` (verified in the live venv). Plain text, no interpreter,
  no DLL load, no CUDA. Fallback signal: `capi/onnxruntime_providers_cuda.dll`, present in
  the GPU wheel and absent from the CPU one. **Absent or unreadable ⟹ not a swap build.**

  **Do NOT probe via `import onnxruntime` + `get_available_providers()`.** `__version__` is
  identical across builds, and a GPU install whose CUDA/cuDNN DLLs fail to load reports
  `['AzureExecutionProvider','CPUExecutionProvider']` — so a provider probe reads a
  correctly-installed GPU box as a CPU box and would delete a *correct* marker on every
  boot, re-opening #2192 permanently. It would also memory-map
  `onnxruntime_providers_shared.dll` — the exact file in #2192's `WinError 5` — on the
  blocking path before `app.listen`.
- **Marker identity** — a directory is ours **only** if its `INSTALLER` reads
  `castwright-ort-marker` **and** its `RECORD` is empty. Never by name: on cpu/amd/apple the
  *real* plain distribution has a byte-identical directory name. **Every** glob match is
  identity-tested, not the first: ours and a real plain distribution can coexist (Spike 2
  proves pip leaves ours behind), and answering from the first match can report "no real
  distribution" and then overwrite one.

**`ensureOrtMarker` refuses to write when a real plain `onnxruntime-*.dist-info` exists.**
That is the clobbered box, and writing a marker over it would corrupt pip's dependency bookkeeping
(creating a stray, unaccounted-for dist-info folder or overwriting the existing one's contents,
depending on version pinning) while the GPU build's files continue actually working. The real cost
is that `ensureOrtMarker`'s own book-keeping would then wrongly certify a clean state, hiding the
coexistence problem from any future pip operation that checks for it. Writing a marker there would
deepen the corruption: a currently silent, un-repaired coexistence problem becomes one that's
permanent and completely hidden from pip's own checks — exactly the failure class this design exists
to prevent. A clobbered box takes the loud path instead: **the log must name the exact remedy**,
not gesture at one — the only repair this design ships for that population is the hand-run CLI:

```
  (PowerShell) $env:CASTWRIGHT_ACCELERATOR_PROFILE='<profile>'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
  (POSIX) CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
```

Leaving that string unwritten would ship the entire remedy for the largest affected
population as a TODO.

**The interrupted-swap row has no other reaper.** The swap uninstalls both runtimes before
reinstalling (`install-ort.mjs:92-93`), so a kill or power loss between the steps leaves a
marker asserting a runtime that is not there. The in-consumer delete-before-rethrow cannot
cover it — the process died — and `reqHash` is unchanged, so
`bootstrap-venv.mjs:240-243` / `apply.ts:134` no-op forever. Without an explicit rule that
lying marker is **permanent**: `pip check` green, `import onnxruntime` dead.

**So the delete rule is stated by exclusion, not by naming CPU:** `ensureOrtMarker` deletes
a *verified* marker whenever ownership is **not** a swap distribution — CPU files, no files
at all, or an unreadable namespace. "Do nothing" is reserved for a genuinely inconclusive
read, never for "nothing is installed."

**`ensureOrtMarker` may therefore delete**, but only a directory that passes the
marker-identity test above. This closes the one hole in the `delete` branch's coverage: a
`noop` box (unchanged `reqHash`) runs neither `installForProfile` nor `pipInstall`
(`bootstrap-venv.mjs:240-243`, `apply.ts:134`), so nothing else would ever reap a stale
marker. It remains non-destructive by construction — it can only remove a file we wrote.

**Version derivation.** Read from the dist-info the swap just installed, globbed from
`plan.ortPackage` — **not** hardcoded, and **not** hardcoded to `onnxruntime_gpu-*` either:
`planOrtSwap` already supports a non-GPU swap package (the documented
`onnxruntime-directml` re-enable, `install-ort.mjs:9,21-23`), which would find no
`onnxruntime_gpu-*` dist. A hardcoded version silently starts lying the first time the pin
is bumped, and `faster-whisper`'s `onnxruntime<2,>=1.14` bound means a sufficiently wrong
version makes pip resolve *against* us.

**The glob must escape the package name, or every NVIDIA bootstrap fails.** `plan.ortPackage`
is the literal string `onnxruntime-gpu`; pip escapes distribution names per PEP 427
(`re.sub(r"[-_.]+", "_", name)`), so the directory on disk is
`onnxruntime_gpu-1.27.0.dist-info` — verified in the live venv. A naive
`` `${plan.ortPackage}-*.dist-info` `` matches **zero** directories, returns `null`, and the
fail-loudly rule below then escalates that into a failed bootstrap **on every NVIDIA box**.
The rule is: `plan.ortPackage.replace(/[-_.]+/g, '_')`, then glob `<escaped>-*.dist-info`.
A unit assertion builds the glob from the literal `'onnxruntime-gpu'` and resolves a fixture
directory, mutation-checked by removing the escape.

**One list of swap distributions, derived not hand-maintained.** `ensureOrtMarker` takes no
plan and no profile — it reads what is installed — so it needs the set of package names that
count as "a swap distribution." That set is **derived** by mapping `installRecipe` over the
four profiles and keeping every `ortPackage !== 'onnxruntime'`, exported from
`install-ort.mjs` as `SWAP_ORT_PACKAGES`. A hand-typed constant would be a second source of
truth for something `installRecipe` already determines — the exact drift
`install-ort.mjs:66-70` warns about — and would silently miss the `onnxruntime-directml`
re-enable.

Note `readInstalledOrtVersion` globs from `plan.ortPackage` and does not need the list; the
ownership check in §The three venv states does. State multiple-match behaviour explicitly:
if more than one `<escaped>-*.dist-info` exists (a stale `onnxruntime_gpu-1.26.0` beside
1.27.0), the read is **inconclusive** — fail the swap loudly rather than picking one.

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

`ensureOrtMarker(venvDir)` runs once at server boot, using the two predicates in §The three
venv states: write when a swap distribution owns the namespace and no plain
`onnxruntime-*.dist-info` exists at all; delete when a *verified* marker is present but plain
CPU `onnxruntime` owns the namespace; **refuse and log loudly** when a real plain
distribution is present alongside a swap one (the clobbered box). Otherwise do nothing.

**Placement:** in `main()`, **before `app.listen`** — not inside the `app.listen` callback,
which is downstream of an `enforceSingleSidecarOwner` that can `process.exit` first. On a box
with no venv, or a half-built one, it is a no-op: it must never create a `site-packages`
tree, and every read is wrapped so an unreadable venv logs and continues rather than throwing
inside server startup.

**This is safe in a way the repair killed in rounds 1–2 was not.** It uninstalls nothing,
downloads nothing, needs no network, touches no locked DLL, and needs no accelerator
profile — it reads what is *installed*, not what *should* be. Every Critical from rounds
1–2 lived in a destructive repair whose mechanism no longer exists here. Worst case is a
directory with three small files.

It is no longer strictly "write-only" — it may delete a directory it can prove it wrote —
but it still never uninstalls a package, never downloads, and (with the file-based ownership
oracle, not a provider probe) never imports onnxruntime or touches a locked DLL. That is
where every Critical in rounds 1–2 lived. It is also pure fs, so it adds no subprocess to
server startup.

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
stated rule out of step.

**Keep `EXTERNAL_FILES` as a floor and ADD a glob on top — do not replace it.** Replacing it
loses coverage and lands red at the same time:

- `launch.mjs` sits at the **repo root**, matching neither glob, and contains **zero**
  occurrences of `pip` (verified) — as do all four current entries. A "spawns pip" filter
  drops every one of them, including the versioned-dir launcher the test's own header
  (`:22-24`) names as its motivating case.
- `scripts/run-sidecar-tests.mjs` contains the string `pip` in help text and has **two
  `spawnSync` calls with no `windowsHide`** (`:54`, `:70`). A naive
  `readFileSync(f).includes('pip')` selector picks it up and the guard fails on landing.

So: floor + glob over `server/tts-sidecar/scripts/*.mjs` and `scripts/*.mjs`, with the
selector defined as *matches `-m['"]?\s*,?\s*['"]pip` in the source **after** the file's own
`blankCommentsAndStrings` pass* — the helper the test already has. `ensure-python312.mjs`
carries three unguarded spawns (`:49`, `:65`, `:86`) and no `pip` string: decide it
explicitly in the PR — fix it or exclude it with a stated reason — rather than letting the
selector decide by accident.

## Testing

### The test that would have caught round 3's Critical

At the seam where the marker is actually applied, asserting the action is **emitted** — and
in the right order. Revision 3's plan tested only isolated planners and writers, so it would
have been fully green while the shipped change did nothing.

**The two consumers are not symmetric, and only one has a seam today.**

- `installForProfile` (`bootstrap-venv.mjs:148-154`) already injects `runPip`, and
  `bootstrap-venv-helpers.test.ts:44` drives it. Add the fs writer the same way.
- `pipInstall` has **no seam**. It is a member of the injected `ApplySteps` interface
  (`apply.ts:49`), and `apply.test.ts:29` replaces it wholesale with
  `vi.fn(async () => {})`; the real body lives in `createApplySteps` (`:254-272`), calls a
  module-private `run()` around real `spawn`, and has **zero** test coverage today. A test
  written at the `applyUpgrade` level would be green while the real `pipInstall` did
  nothing — round 3's Critical, recurring.

  **So `createApplySteps` gains a `run`/`writeMarker` injection point**, listed in §Changed
  files. If that is rejected as too invasive, the spec must instead say plainly that the
  apply half is covered only by on-box acceptance — but it may not claim a seam test that
  cannot be written.

Ordering is asserted, not just presence: a test that only checks "delete was called" passes
under the broken after-the-swap-block ordering.

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
- `deleteOrtMarkerIfOurs` is a no-op when absent, and **refuses to delete a directory whose
  `INSTALLER` is not `castwright-ort-marker` or whose `RECORD` is non-empty** —
  mutation-checked against a fixture of the *real* plain distribution, which a name-only
  matcher would delete. That failure is concrete: cpu profile, `pip-in-place` re-run, box
  offline → delete-at-entry removes the real `onnxruntime-1.28.0.dist-info`, then the
  overlay install fails and throws (`bootstrap-venv.mjs:206`), leaving working files with
  destroyed metadata from a run that today changes nothing.
- **Swap-failure path:** the marker is deleted before re-throwing on any failed swap step,
  in both consumers. Without it: marker present → the overlay install skips plain
  `onnxruntime` (Spike 1) → swap step 1 uninstalls the real GPU build → step 2 fails → the
  venv has *no* onnxruntime, a marker asserting it does, `pip check` green, and the
  sidecar's `import onnxruntime` dead. Today that same failure self-repairs on the next pip
  call. Asserted as "delete emitted on the throw path."
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
5. **AMD box** — no marker is written. (A leftover from a *prior nvidia profile* is not
   reachable: a profile change returns `rebuild` → `needs-reinstall`, which exits without
   touching the venv. The live case is the AMD→ROCm-failure→CPU fallback inside a single
   `installForProfile` call, which is what the delete-at-entry ordering exists for.)
6. **Clobbered box** — a venv with both dist-infos and GPU files in the namespace takes the
   loud path on boot: no marker written, the condition logged, the fix named. This is the
   population #2192 says is largest, and the state a wrong predicate would entomb.

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

Round 4 attacked revision 4's wiring and returned **"not safe to implement from as
written"** — three Criticals in the fixes themselves, plus five Majors. All folded here:

| Finding | Severity | Disposition |
|---|---|---|
| The already-clobbered state (both dist-infos, CPU files) was never named; one reading of `ensureOrtMarker` writes a marker over the real CPU dist and entombs the bug permanently | Critical | §The three venv states added; ownership and marker-identity predicates specified separately; refuse-and-log on a clobbered box *[Superseded in this PR: CPU/GPU direction corrected; the clobbered state has GPU files, not CPU files]* |
| §Changed files said "after the swap block" while the prose two paragraphs above called that fatal | Critical | Table replaced with two named entry points and exact anchors |
| The version glob uses `plan.ortPackage` verbatim; pip escapes to `onnxruntime_gpu-*`, so it resolves to nothing → `null` → fail-loudly → **every NVIDIA bootstrap fails** | Critical | PEP-427 escaping stated in §Version derivation, with a mutation-checked assertion |
| Swap-failure path leaves a marker asserting a runtime that was just uninstalled | Major | Delete before re-throwing, in both consumers |
| `createApplySteps` has no injection point; the apply half would ship untested | Major | Injection point added to §Changed files |
| `deleteOrtMarker` could not tell the marker from the real plain distribution | Major | Identity check on `INSTALLER` + empty `RECORD`, mutation-checked against a real-dist fixture |
| The widened `windowsHide` glob drops `launch.mjs` and lands red on `run-sidecar-tests.mjs` | Major | Floor + glob; selector defined against blanked source; `ensure-python312.mjs` decided explicitly |
| `ensureOrtMarker` had no way to derive the swap-package set | Major | `SWAP_ORT_PACKAGES` exported from `install-ort.mjs` |
| `index.ts:309` is inside the `app.listen` callback, downstream of a `process.exit` | Minor | Moved into `main()` before `app.listen`; no-venv behaviour specified |
| The hand-run CLI (#2192's published workaround) produced no marker | Minor | CLI block wired |
| Acceptance criterion 5 was unreachable | Minor | Rewritten; clobbered-box row added |
| `venv-bootstrap` citation drift | Minor | Corrected |

**A stale marker on a `noop` box** (unchanged `reqHash`, so neither consumer runs) had no
reaper — the `delete` branch's coverage hole. Closed by letting `ensureOrtMarker` delete a
*verified* marker when ownership proves it is lying.

Round 5 was scoped to round 4's three Criticals only. It returned **Critical 3 RESOLVED**,
Criticals 1 and 2 **not**:

| Finding | Disposition |
|---|---|
| `get_available_providers()` cannot distinguish a GPU build from a CPU one — `__version__` is identical, and a GPU install with unloadable CUDA DLLs reports CPU providers. The probe would delete a *correct* marker on every boot | Ownership moved to `capi/build_and_package_info.py`'s `package_name` (verified live), pure fs — which also removes the interpreter spawn and the locked-DLL import from server startup |
| A **fifth** state: marker present, **no onnxruntime files at all** (interrupted swap). No consumer runs, `reqHash` unchanged, and the delete rule named CPU specifically — so the lying marker was permanent | Delete rule restated by exclusion: delete a verified marker whenever ownership is **not** a swap distribution |
| `writeOrtMarker` was never gated on `plan.marker.action`, and the skip variant carries no `ortPackage` — so cpu/apple either fail every bootstrap or overwrite the **real** plain distribution's `RECORD`/`INSTALLER` | Write is gated; skip variant carries `marker` but not `ortPackage` |
| `apply.ts`'s write anchor was off by two and landed inside `readReqHash` | **All line-number anchors replaced with positions relative to named code** — they had now drifted twice |
| The failure-path delete contradicted "TWO call sites per consumer" | Three call sites, with the `apply.ts` `try`/`catch` named |
| Identity answered from the first glob match could miss a real distribution | Every match is identity-tested |
| `SWAP_ORT_PACKAGES` would be a hand-maintained second source of truth | Derived from `installRecipe` across the four profiles |
| "Name the command that fixes it" never named it | Exact command string written out |
| The `installForProfile` null-`venvDir` rationale was false (its one production caller passes a real dir) | Corrected; the prescription stands on its own grounds |
