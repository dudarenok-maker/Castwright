---
status: draft
date: 2026-08-07
---

# The onnxruntime namespace chokepoint: one guarded pip path into the sidecar venv

Closes the design work behind **#2192**.

> **Revision 2.** Revision 1 went through the mandatory adversarial review gate and did
> not survive it. The gate found a **Critical defect in the fix itself**: revision 1's
> boot-time self-heal would have silently converted healthy GPU boxes to CPU Kokoro —
> the exact bug this spec exists to fix, fired on every boot, on machines that never had
> the bug. It also found two more pip doors into the venv that revision 1 did not model,
> a `--no-deps` rule justified by false reasoning, a placement citation that would have
> run `pip uninstall` during the unit suite, and a guard that would have gone vacuously
> green. Every finding was re-verified against the tree before folding. §Review findings
> records the round in full.

## Problem

An alpha tester on a Pinokio install could not install Qwen3:

```
install-qwen3.mjs exited with code 1. ERROR: Could not install packages due to an
OSError: [WinError 5] Accès refusé:
'E:\pinokio\api\Castwright.git\server\tts-sidecar\.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_shared.dll'
Check the permissions.
```

It is not a permissions problem. `WinError 5` on a `.dll` is Windows reporting a
memory-mapped file held by a live process.

### The structural condition

`install-ort.mjs` deliberately replaces plain `onnxruntime` with `onnxruntime-gpu` on GPU
profiles — they share the `site-packages/onnxruntime/` namespace directory and cannot
co-exist. pip matches distributions by **name**, so `onnxruntime-gpu` never satisfies a
requirement spelled `onnxruntime`.

Three installed distributions require plain `onnxruntime` unconditionally. `pip check` on
a **correctly bootstrapped** NVIDIA box therefore reports (verified live, pip 25.0.1):

```
faster-whisper 1.2.1 requires onnxruntime, which is not installed.
kokoro-onnx 0.5.0 requires onnxruntime, which is not installed.
qwen-tts 0.1.1 requires onnxruntime, which is not installed.
```

…and **exits 1**. (`transformers` also lists `onnxruntime`, but only behind the `onnx` /
`onnxruntime` / `dev-*` extras, so it never participates in resolution.)

**The venv is permanently in a state pip considers broken, by design.** Any pip call whose
target depends on `onnxruntime` will try to repair it by installing the CPU build.

### The two failure modes

Both follow from that one condition; which you get depends only on whether the sidecar is
running.

**A — the reported crash.** The sidecar's `_run_device_probe()` (`main.py:9174`, wired into
the startup handler sequence at `main.py:668`) runs `import onnxruntime` on **every boot**,
unconditionally. That maps `onnxruntime_providers_shared.dll` and Windows holds the lock
for the process lifetime. Nothing stops or unloads the sidecar before the installers run.

**B — the silent clobber, which is worse.** With the sidecar stopped the same step succeeds
and installs CPU `onnxruntime` over `onnxruntime-gpu`. Verified with `--dry-run` on a fully
bootstrapped NVIDIA box:

```
Using cached onnxruntime-1.28.0-cp312-cp312-win_amd64.whl (13.8 MB)
Would install onnxruntime-1.28.0
```

That is the 2026-06-16 silent-CPU-Kokoro regression re-entering through a different door,
and it drives past `install-ort.mjs`'s deliberate `>=1.27,<1.28` pin. No error, no log line.

### Four doors, not one

`install-qwen3.mjs` is simply the first one someone walked through.

| # | Door | What it runs | Sidecar live? |
|---|---|---|---|
| 1 | `install-qwen3.mjs:399` | `pip install qwen-tts -c base.txt` | Yes — in-app installer |
| 2 | `install-whisper.mjs:96` | `pip install -U faster-whisper`, **no constraints** | Yes — in-app installer |
| 3 | `upgrade/apply.ts:254-269` | overlay install **plus** `pip uninstall -y onnxruntime onnxruntime-gpu` | **Yes** — in-app self-upgrade |
| 4 | `POST /api/setup/venv/bootstrap` | `bootstrap-venv.mjs` — same overlay install + ORT swap | **Yes** — "Rebuild the voice engine runtime" |

Doors 3 and 4 are the severe pair: they run `pip uninstall` on the ORT namespace **from
inside the running server, against a live sidecar**. The upgrade gate refuses only on
in-flight generation/analysis (`upgrade/busy-probe.ts`), not on "the sidecar is running,"
and its teardown happens *after* the pip run (`apply.ts:155`). Door 3 can therefore break
TTS during a routine upgrade, which is arguably more severe than the reported bug.

`install-ort.mjs:11` calls itself "the SINGLE enforcement point for GPU Kokoro." It is not
one, and cannot be, while four other paths pip-install into the same venv behind its back —
the same one-door-in-a-many-door-building shape recorded in the #2040 wave.

## Approach

Four layers. The door table above determines which layer covers which door: doors 1–2 can
be prevented outright, doors 3–4 genuinely need full dependency resolution and so must be
made safe instead.

| Layer | Mechanism | Covers |
|---|---|---|
| 0. Quiesce | Venv-mutating operations stop the sidecar first, restart after; refuse with an actionable message if they can't | Doors 3–4 |
| 1. Prevention | `--no-deps` where the active overlay installs the package | Doors 1–2 |
| 2. Repair | One-directional, prefetch-first ORT invariant check before the sidecar spawns | Residual B, and already-broken boxes |
| 3. Honesty | `pip check` parsed and filtered after each install | A dependency `--no-deps` genuinely skipped |

### Layer 0 — quiesce, and the acceptance criterion revision 1 dropped

Revision 1 silently dropped #2192's option 3 (manage the sidecar around the install) and
with it the issue's own acceptance criterion: *"either succeed, or fail with an actionable
message — never a raw `WinError 5`."* With doors 3–4 in scope that criterion is
unreachable any other way, because those doors must resolve dependencies.

A shared helper wraps any venv-mutating operation: stop the sidecar, run the operation,
restart it. If the sidecar cannot be stopped — a generation is in flight — the operation
**refuses with an actionable message** rather than proceeding into a `WinError 5`. Any
lock error that still escapes is translated at the chokepoint into that same actionable
message, so a raw `WinError 5` never reaches the UI.

### Layer 1 — the rule, restated correctly

Revision 1 justified `--no-deps` as *"the package's dependencies are already declared in
the requirements overlay."* **That reasoning is false.** `qwen-tts==0.1.1` declares nine
requirements (`transformers`, `accelerate`, `gradio`, `librosa`, `torchaudio`, `soundfile`,
`sox`, `onnxruntime`, `einops`); only `transformers` (`base.txt:50`) and `torchaudio`
(`nvidia-cuda.txt:32`) appear in any overlay. The overlays declare the **package**, not its
dependencies.

`--no-deps` works for a different reason: `bootstrap-venv.mjs:204` runs
`pip install -r <overlay>` **with** full resolution, so the other seven arrive there. The
correct rule follows from that, and carries a precondition revision 1 lacked:

> `--no-deps` is safe only where the **active profile's overlay installs this exact
> package**, so the bootstrap already resolved its tree. The chokepoint **refuses
> `--no-deps` when the target is absent from the active overlay.**

That precondition matters immediately: **`cpu.txt` has no `qwen-tts` line at all** (Qwen is
GPU-only), yet `install-qwen3.mjs:67` still ships a `--cpu` flag that
`qwen-install-bootstrap.ts:56` documents forwarding. Under revision 1's rule that path
would install `qwen_tts` alone and then die at `from qwen_tts import Qwen3TTSModel`
(`install-qwen3.mjs:419`) on a missing `einops`, reporting "Check network, disk space."
Under the corrected rule it is a clean, explicit skip. The same precondition survives a
future `qwen-tts` version bump that adds a dependency.

### Layer 2 — one-directional and prefetch-first

Revision 1's repair was **the most dangerous thing in the spec**. Two independent defects:

**It could fire in the destructive direction.** `spawn-sidecar.ts:526-529` resolves the
profile as `envOverride → venv stamp → detected`, with `detected` hardcoded `'cpu'`, and
`resolveProfile` falls through to `'cpu'` when nothing matches
(`accelerator-profile.mjs:59-64`). A correctly-installed NVIDIA box with a missing or
unreadable stamp — fresh worktree, partial Pinokio reset, `SIDECAR_VENV_DIR` pointing
elsewhere — resolves to `cpu`. Revision 1's rule ("delegate to
`installRecipe(profile).ortPackage`") would then see `onnxruntime-gpu` owning the namespace
against an expected plain `onnxruntime`, call it broken, and repair it *away*. Revision 1's
unit matrix never listed that cell.

**And the repair is not recoverable.** `planOrtSwap`'s step 1 is
`['uninstall','-y','onnxruntime', ortPackage]` — it removes **both** runtimes before step 2
downloads the replacement (`install-ort.mjs:92-93`). A failed step 2 (offline, empty pip
cache, disk full) leaves the venv with **no onnxruntime at all**. Revision 1 moved that
sequence from install-time onto every boot and justified it as "degraded, not broken,"
which was simply untrue.

Three corrections, all required:

1. **One-directional.** Repair **only** when plain `onnxruntime` is present on a GPU
   profile. **Never** remove `onnxruntime-gpu` because the profile reads `cpu`. The
   destructive direction is not a case to handle carefully; it is a case that must not
   exist.
2. **Positive profile signal required.** `resolveProfile`'s `'cpu'` fallthrough is an
   absence of information, not an assertion that the box is CPU. The repair no-ops with a
   log line unless there is a present, parseable venv stamp or an explicit `ACCELERATOR`.
3. **Prefetch-first.** `applyOrtSwap(python, plan, { prefetch })` — with `prefetch: true`
   the replacement is `pip download --no-deps`ed to a temp dir first, and the uninstall
   only happens once the wheel is on disk. A network failure then aborts having touched
   nothing. This mirrors the download-verify-install shape `install-qwen3.mjs` already uses
   for the FA2 wheel. `install-ort.mjs`'s own CLI keeps today's ordering (`prefetch: false`)
   — it runs at install time with the user watching and the network obviously up, where a
   loud failure is the correct outcome.

**Placement.** Revision 1 said "`spawn-sidecar.ts` (~530), before the child spawn." Line 530
is inside **`buildSidecarEnv`** (459–534), a sync, side-effect-free function that unit tests
call directly with a real `repoRoot` (`sidecar-env.test.ts:38,47,58,72,85`) — a pip-spawning
repair there would fire `pip uninstall` against the developer's venv during
`npm run test:server`. The correct site is inside `spawnSidecar` (from 540), **after** the
adopt/probe decision and only on the branch that actually spawns; the adopt branch returns
early when a fit sidecar already holds the port, and repairing there would run
`pip uninstall` against a live adopted sidecar — the original bug. The resolved profile is
passed in rather than re-derived.

**Anti-storm guard.** Keyed on the detected owner-set, not once-per-process. A
once-per-process guard is spent by the boot-time no-op check and would never fire for the
canonical sequence: boot (nothing to fix) → in-app install clobbers ORT → sidecar restarts
(`routes/sidecar-health.ts:636`) → repair already spent.

**Totality and budget.** `assertOrtInvariantBeforeSpawn` never throws — its caller is
fire-and-forget (`index.ts:309` `void`s `sidecarSupervisor.start()`), so a rejection would
surface as an unhandled rejection. The repair carries an explicit time budget; its worst
case is a ~250 MB download between server start and the sidecar existing, during which TTS
is unavailable.

**Scope honesty.** Layer 2 runs pre-spawn, so it is structurally blind to a clobber that
happens while the server is up — which is every one of the four doors. It heals the
already-broken population at next launch; it is not, and must not be described as, the
thing that keeps the invariant during a session. Layers 0 and 1 do that.

### Layer 3 — parse, don't trust the exit code

`pip check` **exits 1** in the expected state on every GPU box (verified). The runner must
therefore parse stdout and ignore the exit code for the classification; treating non-zero
as failure would report failure on every install on every GPU box. The trio above, and only
on a GPU profile, is expected; anything else is reported.

## Components

### New: `server/tts-sidecar/scripts/sidecar-pip.mjs`

Pure planners plus a thin runner, matching the `install-torch.mjs` / `install-ort.mjs`
house pattern.

| Export | Kind | Purpose |
|---|---|---|
| `sidecarPipInstallArgs(specs, { constraints, noDeps })` | pure | Build the pip argv |
| `overlayDeclares(packageName, profile, platform)` | pure | The Layer-1 precondition |
| `parsePipCheck(stdout)` | pure | → `{ dist, requirement }[]` |
| `expectedOrtInconsistencies(profile)` | pure | The trio, **GPU profiles only** |
| `unexpectedInconsistencies(output, profile)` | pure | The cry-wolf filter |
| `translateVenvLockError(stderr)` | pure | `WinError 5` on a venv path → actionable message |
| `runSidecarPip(python, specs, opts)` | I/O | install → re-assert ORT if deps resolved → parse `pip check` |

### Changed: `server/tts-sidecar/scripts/install-ort.mjs`

Export `applyOrtSwap(python, plan, { prefetch })`, extracted from the CLI block
(`:98-121`). This is **a signature change, not pure motion**: the existing block is built
around `process.exit(code)` and `stdio:'inherit'`, so the extracted function needs a return
value and injectable I/O to be callable from the server and testable. `planOrtSwap` is
unchanged.

### New: `server/src/tts/ort-invariant.ts`

| Export | Kind | Purpose |
|---|---|---|
| `detectOrtNamespaceOwner(sitePackages)` | fs read | Which distributions claim the namespace |
| `planOrtRepair({ profileSignal, platform, owners })` | pure | `ok` / `repair` / `no-signal` |
| `assertOrtInvariantBeforeSpawn(deps)` | I/O | Detect, repair, log. Never throws |

**The matcher is specified, not left to the implementer:** `/^onnxruntime-\d/` against the
normalized dist-info name. pip 25.0.1 normalizes the GPU distribution to
`onnxruntime_gpu-1.27.0.dist-info` with an **underscore** (verified in the live venv), so a
naive `startsWith('onnxruntime')` matches it and would fire a destructive repair on every
healthy GPU box, every boot.

**Detection also probes the namespace, not just the dist-infos.** `install-ort.mjs:86-90`
documents a third state the dist-info rule alone cannot see: a *gutted namespace*, where a
`pip uninstall onnxruntime` after a clobber strips shared files via the CPU build's RECORD,
leaving `onnxruntime_gpu-*.dist-info` present over a hollow `onnxruntime/`. `import
onnxruntime` breaks entirely and the dist-info rule returns `ok`. A cheap presence check on
`capi/` and the provider DLLs covers it.

### New: `server/src/tts/venv-quiesce.ts` (Layer 0)

Wraps a venv-mutating operation: stop the sidecar, run, restart. Refuses with an actionable
message when the sidecar cannot be stopped. Consumed by doors 3 and 4.

### Call sites

| File | Change |
|---|---|
| `install-qwen3.mjs:399` | Chokepoint, `noDeps: true` (guarded by `overlayDeclares`) |
| `install-whisper.mjs:96` | Chokepoint, `noDeps: true`, **drop `-U`**, **add `-c <constraints>`** |
| `install-coqui.mjs:149` | Chokepoint **with** deps — Coqui is opt-in, in no overlay |
| `install-coqui.mjs:154` | Already `--no-deps`; route for uniformity |
| `install-coqui.mjs` step 3 (`:158-172`) | The CJK-phonemizer/`spacy` step — the file's largest dep-resolving install |
| `upgrade/apply.ts:254-269` | Chokepoint **and** Layer 0 quiesce |
| `bootstrap-venv.mjs` `runPip` | Chokepoint **and** Layer 0 quiesce |
| `spawn-sidecar.ts` (in `spawnSidecar`, post-adopt) | `assertOrtInvariantBeforeSpawn` |

The whisper fix is `-U` removal **plus** `-c <constraints>`. Dropping `-U` alone leaves the
unconstrained half intact: on a box where `faster-whisper` is absent, pip still resolves to
latest, so a 2.x release would install cleanly in violation of `base.txt:45`'s
`>=1.0,<2.0` — with `--no-deps` guaranteeing it arrives dependency-less. Every sibling
installer already passes `-c` (`install-qwen3.mjs:100`, `install-coqui.mjs:149`).

**Explicitly out of scope:** the FlashAttention-2 wheel path in `install-qwen3.mjs`. Opt-in,
hash-pinned, already non-fatal on every path.

## Testing

### The regression test

`install-whisper.mjs` **exports nothing** — its pip args are inline in an unexported
`main()`, so revision 1's proposed assertion would have failed on *import* rather than on
the assertion: a red phase by accident. Extracting an exported arg builder (mirroring
`qwenPipInstallArgs` at `install-qwen3.mjs:99-101`) is therefore **part of the work**, not
a test detail.

With that in place, both assertions genuinely fail on today's tree and pass after:

- `install-qwen3`'s args contain `--no-deps`
- `install-whisper`'s args contain `--no-deps` and `-c`, and **not** `-U`

### The guard that would otherwise go vacuously green

`server/src/spawn-windows-hide.test.ts:54-62` enforces `windowsHide` by scanning a
**hardcoded** `EXTERNAL_FILES` list that names the three installer scripts. Moving the pip
spawns into `sidecar-pip.mjs` removes them from every file the guard scans — **the guard
keeps passing while the actual spawn site goes unchecked.** `sidecar-pip.mjs` must be added
to that array in the same PR. This is the "a guard test isn't wired until its file list
moves" failure this repo has already recorded twice.

### Unit

- `sidecar-pip-helpers.test.ts` — argv shapes; `overlayDeclares` returning false for
  `qwen-tts` on `cpu`; `parsePipCheck` against real captured output; the filter asserting
  the trio is expected on `nvidia` but **not** on `cpu`, where those lines would be genuine;
  `translateVenvLockError`.
- `ort-invariant.test.ts` — the matcher against the real `onnxruntime_gpu-…` underscore
  form; and a matrix that **must** include the two cells revision 1 omitted:
  **`{onnxruntime-gpu}` on a `cpu` profile → `ok`, never `repair`**, and
  **no profile signal → `no-signal`, never `repair`**. Plus the gutted-namespace state.
- Prefetch ordering — a failed download leaves both distributions installed.
- Spawn wiring — the check runs on the spawning branch only, never on adopt, never from
  `buildSidecarEnv`; a failed repair does not block the spawn; the function never throws.
- Layer 0 — refusal path returns the actionable message rather than proceeding.

Every assertion is mutation-checked on its own line. The `cpu`-profile and no-signal cells
specifically must fail if the profile input is dropped — they exist to catch the defect that
killed revision 1.

### Not applicable, stated rather than silently skipped

- **pytest** — no Python behaviour changes.
- **e2e** — no router/redux/layout seam.

### On-box acceptance (owed, cannot be discharged in the PR)

1. **Windows + NVIDIA, app running.** In-app Qwen3 install completes; `pip check` after
   shows only the expected trio; Kokoro still reports `CUDAExecutionProvider`.
2. **Self-heal.** Deliberately clobber ORT, restart the server, confirm the pre-spawn repair
   fires, logs, and restores `onnxruntime-gpu` within its pin.
3. **No-signal safety.** Remove the venv stamp on a healthy NVIDIA box, restart, and confirm
   the repair **does not** fire.
4. **Upgrade path.** Run an in-app upgrade with the sidecar live; confirm quiesce, no
   `WinError 5`, and GPU Kokoro afterwards.

Register row, run sheet, and live view all move in the shipping PR per checklist step 3.

## Before-shipping coverage

Revision 1 omitted these rather than stating them. Step 1/4: this is substantial,
cross-cutting work and **owes a plan under `docs/features/` plus an `INDEX.md` entry**.
Step 5: it is user-visible (installs stop failing; a boot-time repair begins running; the
upgrade path changes), so **both release-notes documents move in the PR**.

## Risks

- **A repair firing in the destructive direction** would delete a working GPU runtime.
  Mitigated by making the repair one-directional by construction, requiring a positive
  profile signal, and by the two dedicated unit cells. This is the highest-severity failure
  the design can produce and it is what killed revision 1.
- **A prefetch that succeeds followed by an install that fails** still leaves the venv
  without a runtime. Narrower than revision 1's window but not zero; the pre-spawn check
  retries next boot, and the gutted-namespace probe detects it.
- **`--no-deps` masking a new dependency** if an overlay drifts from the package's real
  requirements. Mitigated by `overlayDeclares` plus Layer 3.
- **Two servers.** This repo has a documented two-stacks-on-`:9000` history, guarded by
  `enforceSingleSidecarOwner` (`index.ts:291-292`) — which only fires when
  `getResolvedAutoStartSidecar()` is true. A second server with autostart off could run its pre-spawn repair against the other
  stack's live sidecar. "Nothing holds the lock at pre-spawn time" is a single-process
  assumption; the prefetch-first ordering and fail-open policy bound the damage to a failed
  repair rather than a gutted venv.

## Review findings

Round 1, Premium tier, briefed to attack the world model rather than the prose. Nine
findings; every one re-verified against the tree before folding.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | Repair fires in the destructive direction on an unstamped GPU box; `planOrtSwap` uninstalls both before downloading | Layer 2 rewritten: one-directional, positive-signal, prefetch-first |
| 2 | Critical | `--no-deps` rule justified by false reasoning; breaks on the `--cpu` path | Rule restated; `overlayDeclares` precondition added |
| 3 | Critical | Two unmodelled doors (`upgrade/apply.ts`, venv-bootstrap route) run pip against a live sidecar | Folded in; Layer 0 added |
| 4 | Major | Line 530 is inside `buildSidecarEnv`, which unit tests call directly | Placement corrected to post-adopt inside `spawnSidecar` |
| 5 | Major | `spawn-windows-hide.test.ts`'s hardcoded file list goes vacuously green | `sidecar-pip.mjs` added to the array in the same PR |
| 6 | Major | `install-whisper.mjs` exports nothing; the regression test could not be written | Arg-builder extraction is now part of the work |
| 7 | Major | Once-per-process guard is spent before the clobber it targets | Guard keyed on the detected owner-set |
| 8 | Minor | `pip check` exits 1 in the expected state | Layer 3 parses stdout, ignores the exit code |
| 9 | Minor | Dropping `-U` alone leaves whisper unconstrained | `-c <constraints>` added |

Also folded: the gutted-namespace detection gap, the explicit dist-info matcher, the
`applyOrtSwap` signature change, the two-servers assumption, `install-coqui.mjs:165`, the
totality/budget requirement, and the Before-shipping steps revision 1 omitted.
