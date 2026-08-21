---
status: active
shipped: null
owner: null
---

# ORT pip-consistency marker

> Status: active
> Key files: `server/tts-sidecar/scripts/install-ort.mjs`, `server/tts-sidecar/scripts/bootstrap-venv.mjs`, `server/src/upgrade/apply.ts`, `server/src/index.ts`, `server/src/diagnostics/venv.ts`, `server/tts-sidecar/scripts/install-whisper.mjs`
> URL surface: none — sidecar venv bootstrap/upgrade only, no UI surface
> OpenAPI ops: none

Design of record: [`docs/superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md`](../superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md)
(revision 6, five adversarial review rounds). Implementation plan:
[`docs/superpowers/plans/2026-08-07-ort-pip-consistency-marker.md`](../superpowers/plans/2026-08-07-ort-pip-consistency-marker.md).
Issue: **#2192**.

## Benefit / Rationale

- **User:** installing Qwen3 or Whisper — in-app, from a fresh Pinokio install, or via
  the in-app upgrade — no longer clobbers the GPU speech runtime with a WinError 5
  DLL-lock crash, or silently swaps `onnxruntime-gpu` back to the CPU build.
- **Technical:** `pip check` on a correctly-bootstrapped NVIDIA box now exits 0. Before
  this change it permanently reported `onnxruntime` as "not installed" even on a healthy
  GPU box, so every pip call whose target depends on `onnxruntime`
  (`faster-whisper`, `kokoro-onnx`, `qwen-tts` all declare it unconditionally) tried to
  "repair" the venv — either crashing on the sidecar's own DLL lock or silently
  replacing the GPU runtime.
- **Architectural:** the fix is recorded **once**, in the swap plan both consumers
  (`bootstrap-venv.mjs`, `upgrade/apply.ts`) already loop over, rather than defended at
  each of the five pip call sites separately — the per-site approach was attempted and
  abandoned across two earlier review rounds (see the design doc's revision history).
  A boot-time self-heal (`ensureOrtMarker`) additionally repairs any venv bootstrapped
  before this change, since neither the upgrade path nor the rebuild path re-runs on an
  unchanged requirements hash.

## Architectural impact

**The root condition.** The nvidia accelerator profile replaces plain `onnxruntime`
with `onnxruntime-gpu` — they share the `site-packages/onnxruntime/` namespace and
cannot co-exist. pip matches distributions **by name**, so `onnxruntime-gpu` never
satisfies a requirement spelled `onnxruntime`. A correctly-bootstrapped NVIDIA box is
therefore permanently in a state pip considers broken, and every pip call touching a
package that depends on `onnxruntime` tries to repair it.

**The fix records, once, what is already true**: `onnxruntime-gpu` provides the
`onnxruntime` package — same import name, same API, same version line. A minimal
`onnxruntime-<version>.dist-info` marker (METADATA + INSTALLER + an **empty** RECORD)
written beside the GPU distribution makes pip agree, and every door stops trying to
repair the venv simultaneously.

**New seams / extension points:**

- `planOrtSwap(profile, platform)` (`install-ort.mjs`) now returns a `marker: { action:
  'write' | 'delete' }` field alongside the existing `action`/`steps`/`ortPackage`. The
  `skip` variant (cpu/amd/apple) carries `marker: { action: 'delete' }` but still no
  `ortPackage` — a write there has nothing to derive a version from.
- `applyOrtMarkerDelete(venvDir, plan)` / `applyOrtMarkerWrite(venvDir, plan)` — the
  plan-driven entry points both consumers call. `applyOrtMarkerWrite` is a no-op unless
  `plan.marker.action === 'write'`.
- `ensureOrtMarker(venvDir, log?)` — the boot-time self-heal. Never throws; pure fs; no
  subprocess, no network, no `import onnxruntime`.
- `upgrade/apply.ts`'s `createApplySteps` gained an injectable `deps` parameter
  (`{ run?, markerDel?, markerWrite? }`) — it previously had no seam at all, so
  `pipInstall`'s real body had zero test coverage.
- `resolveSidecarVenvDir(repoRoot)` (`server/src/diagnostics/venv.ts`) — the
  `SIDECAR_VENV_DIR ?? <repoRoot>/server/tts-sidecar/.venv` convention, extracted so
  `ensureOrtMarker`'s boot call and the pre-existing `sidecarVenvPresent` share one
  resolver.

**Invariant preserved:** never probe ownership via `import onnxruntime` +
`get_available_providers()`. `__version__` is identical across the GPU and CPU builds,
and a GPU install whose CUDA/cuDNN DLLs fail to load reports
`['AzureExecutionProvider','CPUExecutionProvider']` — indistinguishable from a real CPU
box. Every predicate here is a file read.

**Migration story:** none — no `state.json`/`cast.json`/`openapi.yaml` shape changes.
The only persisted artifact is the marker directory itself, which is disposable
(deleting it just returns the venv to its pre-fix state on the next relevant pip call).

**Reversibility:** delete the `onnxruntime-<version>.dist-info` directory under the
sidecar venv's `site-packages` (or run `deleteOrtMarkerIfOurs` via the CLI) to undo.
Nothing else on disk changes.

## Invariants to preserve

1. **Marker identity is `INSTALLER == "castwright-ort-marker"` AND an empty `RECORD` —
   never the directory name.** On cpu/amd/apple the *real* plain `onnxruntime`
   distribution has a byte-identical directory name to the marker
   (`onnxruntime-<version>.dist-info`). `isOurMarker` (`install-ort.mjs`) checks both;
   `findPlainOrtDistInfos` tests **every** match in a site-packages dir, not just the
   first, because Spike 2 (design doc) proved ours and a real distribution can coexist.
2. **`RECORD` must stay empty.** That is what makes `pip uninstall onnxruntime` a
   documented no-op against it (`Can't uninstall 'onnxruntime'. No files were found to
   uninstall.`, exit 0) rather than deleting real files out from under the GPU build.
3. **Delete runs before the first pip call in a flow; write runs last, after the swap
   steps succeed.** `bootstrap-venv.mjs`'s `installForProfile` calls
   `applyOrtMarkerDelete` at function entry (line 162) — before the AMD torch
   pre-install, the AMD→CPU fallback (`cpu.txt` carries an **explicit** `onnxruntime`
   line the fallback needs to actually install), and both overlay installs — then
   `applyOrtMarkerWrite` as the last statement inside the `if (ort.action === 'swap')`
   block (line 230). `upgrade/apply.ts`'s `pipInstall` mirrors this at lines 276 (delete,
   before the first `run(...)`) and 295 (write, the function's last statement). A stale
   marker present at swap-failure or AMD-fallback time makes pip silently skip a real
   install it needs to make.
4. **Delete also runs on the swap-failure path, before re-throwing** — both consumers
   (`bootstrap-venv.mjs:226`, `apply.ts:291`) — so a failed swap never leaves a marker
   asserting a runtime that was just uninstalled.
5. **Write is gated on `plan.marker.action === 'write'`.** The skip variant (cpu/amd/
   apple) carries no `ortPackage`; an ungated write there is a crash, not a silent
   corruption — see "Corrections vs. the design doc's original prose" below.
6. **`ensureOrtMarker` never uninstalls, downloads, or imports onnxruntime**, and never
   throws — it runs in `server/src/index.ts`'s `main()`, before `app.listen` (line 128),
   ahead of `enforceSingleSidecarOwner`'s possible `process.exit`.
7. **A clobbered venv (real plain `onnxruntime` dist-info coexisting with `onnxruntime-gpu`
   files in the namespace) is refused, never repaired by writing over it.** Writing a marker
   there would stamp the GPU distribution's version onto the coexisting real dist-info, make
   `pip check` report clean, and leave GPU Kokoro permanently dead with no path in this
   design that ever fixes it. `ensureOrtMarker` logs the exact remedy command instead:
   `CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>`.

### The five venv states `ensureOrtMarker` distinguishes

| Namespace owner (`detectOrtOwner`) | Real plain dist-info present? | Our marker present? | Outcome |
|---|---|---|---|
| `swap` (GPU build owns it) | no | no | `wrote` — logs (records the version and provider) |
| `swap` | no | yes | `noop` (idempotent) |
| `swap` | no | yes — but **stale** (recorded version ≠ installed version) | `noop` — **known limitation**, see note below |
| `swap` | **yes** — the clobbered box | either | `clobbered` — refuse, log the remedy |
| `plain` (CPU build owns it) | — | yes | `deleted` — logs (Kokoro runs without GPU acceleration) |
| `none` (interrupted swap — no files at all) | — | yes | `deleted` — logs (Kokoro cannot load at all; names the remedy) |
| `none` | — | no | `noop` |

Ownership is read from files the wheel ships — `onnxruntime/capi/build_and_package_info.py`'s
`package_name = '<dist>'` line (plain text, no interpreter, no DLL load), falling back to
the presence of `onnxruntime_providers_(cuda|rocm).*` when that file is absent or its
`package_name` regex doesn't match. **Never** from `import onnxruntime` +
`get_available_providers()` — see invariant list above.

**Known, accepted limitation — the stale-version marker state.** The table above
distinguishes "our marker present?" as a boolean, but a present marker can still be
*wrong*: if an operator runs an out-of-band `pip install -U onnxruntime-gpu` (or
otherwise upgrades the swap distribution outside `install-ort.mjs`/`bootstrap-venv.mjs`)
after a marker already exists, `detectOrtOwner` still reports `swap` and
`ortMarkerVersion` still returns non-null, so `ensureOrtMarker` takes the `swap` +
marker-present branch and returns `noop` **without ever comparing the marker's
recorded METADATA version against the version actually installed**. The marker
silently keeps asserting the old version until the next full swap (`planOrtSwap` →
`writeOrtMarker`, e.g. a reinstall or a profile change) rewrites it — nothing in the
boot-time self-heal path ever notices or corrects the drift on its own. Consequence:
`pip check` stays clean (it only checks that *some* `onnxruntime` dist-info satisfies
the name-based requirement, not that its version matches reality), but anything that
trusts the marker's recorded version — a diagnostics surface, a support bundle, a
future version-pinned dependency — would read a stale number. This is accepted as a
known limitation rather than fixed here: closing it would mean `ensureOrtMarker`
re-deriving and comparing the installed version on every boot, which is exactly the
kind of scope this design deliberately keeps out of the pure-fs, no-pip-call
self-heal path (see the invariant list above).

## Corrections vs. the design doc's original prose

Three places where the shipped code behaves differently from (and, in the first two
cases, more sensibly than) the spec's original description — recorded here so a future
reader trusts the code over the spec text on these points.

1. **`detectOrtOwner` has a third reachable fallback path the spec didn't name.** The
   spec describes two signals: the `build_and_package_info.py` `package_name` line, and
   the CUDA/ROCm provider-DLL fallback "when that file is absent or unreadable." The
   shipped code (`install-ort.mjs`'s `detectOrtOwner`) has a third case: the info file
   is **present and readable**, but its `package_name` regex simply **fails to match**
   (`if (m) return …` has no `else`) — that case also falls through to the DLL signal
   rather than being treated as inconclusive. This is sensible degradation, not a bug:
   an info file that doesn't parse the way this repo expects is exactly the situation
   the DLL fallback exists for.
2. **An ungated `applyOrtMarkerWrite` does not glob `undefined-*` and silently overwrite
   the real plain distribution**, as an earlier design revision worried. Calling it with
   a plan carrying no `ortPackage` (the skip variant) throws
   `TypeError: Cannot read properties of undefined (reading 'replace')` from
   `escapeDistName(undefined)` inside `readInstalledOrtVersion` — it crashes before
   reaching any glob or any write. The `plan?.marker?.action !== 'write'` guard at the
   top of `applyOrtMarkerWrite` is still load-bearing for two reasons: (a) an obscure
   `TypeError` mid-bootstrap is its own defect, distinct from and worse than a clear
   guard-rejection path, and (b) the guard also protects a future plan shape that
   carries a **defined** `ortPackage` alongside `action !== 'write'`, which would reach
   the write and actually do the feared overwrite.
3. **A null `venvDir` does not make the marker delete silently no-op the way the
   spec's original prose claims.** The spec describes the marker path as "derived
   from the venv python the function already holds rather than from `venvDir`, so a
   null can never make the delete silently no-op." The shipped code does the
   opposite: `bootstrap-venv.mjs`'s `installForProfile` gates all three marker
   operations on `if (venvDir) …` (`bootstrap-venv.mjs:168,232,236`), so a null
   `venvDir` DOES silently no-op the delete-at-entry, the failure-path delete, and
   the write — exactly the behaviour the spec claims cannot happen. This is a real
   divergence, not a "more sensible" one like the two above, but its exposure is
   test-only: `installForProfile`'s one production caller (`runInstall`,
   `bootstrap-venv.mjs:327`) always passes a real `venvDir`, so a null only ever
   reaches this code from a test harness deliberately omitting it.

## Test plan

### Automated coverage

Every helper is unit-tested against the real on-disk shapes (pip's PEP-427 name
escaping, a real plain distribution fixture, a real `build_and_package_info.py`
excerpt), mutation-checked line by line. All server-side Vitest, run via
`cd server && npx vitest run src/tts/ort-*.test.ts src/upgrade/apply-ort-marker.test.ts src/tts/bootstrap-venv-helpers.test.ts src/tts/install-whisper-steps.test.ts src/spawn-windows-hide.test.ts`:

- `server/src/tts/ort-marker-paths.test.ts` — `escapeDistName` PEP-427 escaping
  (`onnxruntime-gpu` → `onnxruntime_gpu`); `SWAP_ORT_PACKAGES` derived from
  `installRecipe`, not hand-typed; `sitePackagesDir` resolves Windows/posix layouts and
  returns `null` when absent or ambiguous.
- `server/src/tts/ort-marker-io.test.ts` — `isOurMarker` accepts a marker we wrote and
  refuses a real plain distribution with a byte-identical name, and a dir with our
  INSTALLER but a non-empty RECORD; `writeOrtMarker` writes an **empty** RECORD and
  overwrites a stale marker; `deleteOrtMarkerIfOurs` refuses to delete a real
  distribution, including one sitting beside our own marker; `findPlainOrtDistInfos`
  identity-tests every match, not just the first.
- `server/src/tts/ort-owner-detect.test.ts` — `detectOrtOwner` reads the GPU wheel as
  `swap`, the CPU wheel as `plain`, falls back to the CUDA provider DLL when the info
  file is missing, and reports `none` for an absent or gutted namespace.
- `server/src/tts/ort-version-read.test.ts` — `readInstalledOrtVersion` resolves the
  PEP-427-escaped directory from the bare package name and returns `null` when absent
  **or ambiguous** (a stale dist beside the current one).
- `server/src/tts/install-ort-helpers.test.ts` — `planOrtSwap('nvidia', …).marker ===
  { action: 'write' }`; cpu/amd/apple all get `{ action: 'delete' }`; the skip variant
  carries no `ortPackage`.
- `server/src/tts/ort-marker-apply.test.ts` — `applyOrtMarkerWrite` writes at the
  installed version, no-ops on a delete plan, and throws when the version can't be
  read; `applyOrtMarkerDelete` removes the marker on both delete and swap plans and
  never throws on a venv with no site-packages.
- `server/src/tts/ort-ensure-marker.test.ts` — all five venv states from the table
  above, plus idempotency and "never throws on a nonexistent venv" / "never creates a
  site-packages tree on a half-built venv."
- `server/src/tts/bootstrap-venv-helpers.test.ts` — the seam test asserting **ordering**
  at `installForProfile`: delete before the first overlay install, write only after a
  successful nvidia swap, never on cpu, and delete (not write) when the swap fails.
- `server/src/upgrade/apply-ort-marker.test.ts` — the same ordering assertions against
  `pipInstall`, exercised through the new `createApplySteps` injection seam — this is
  the test that would have caught round 3's Critical (the design doc's own framing):
  `apply.test.ts` stubs `pipInstall` wholesale, so without this seam the real body
  shipped with zero coverage.
- `server/src/tts/install-whisper-steps.test.ts` — `whisperPipInstallArgs` passes `-c`
  and never `-U`.
- `server/src/spawn-windows-hide.test.ts` — widened to glob every pip-spawning `.mjs`
  under `server/tts-sidecar/scripts/` and root `scripts/`, on top of the pre-existing
  hardcoded floor; `install-ort.mjs`'s pip spawn, `install-whisper.mjs`,
  `ensure-python312.mjs` and `run-sidecar-tests.mjs` are all now covered.

Every assertion above is mutation-checked (change the assertion's own line, confirm it
fails, revert) per the implementation plan's Task 1–11 steps.

**Not applicable:** pytest (no Python behaviour changes — every predicate here is
Node-side `.mjs`/TypeScript); e2e (no router/redux/layout seam).

### On-box acceptance

The design doc's §On-box acceptance names six criteria; one (self-heal on an
existing box) was run end-to-end on real hardware during implementation and is
**discharged**, not owed. The other five, plus one addition the spec doesn't name,
are owed — six rows total. See `docs/testing/ort-marker-onbox-acceptance.md` for
the full evidence and per-criterion procedures, and
`docs/testing/onbox-acceptance-register.md` for the register rows: a fresh NVIDIA
bootstrap (A39), the reported bug itself — in-app Qwen3 install (A40), an AMD box
(Blocked — no hardware), a clobbered venv (A41), the Pinokio update path (E9), and
the in-app upgrade path (A42, an addition not in the spec's own six — Task 8 wired
it and nothing proves it on real hardware). Apple Silicon is **not** a separate
criterion: it takes the same skip/delete branch as cpu and amd, already covered by
the AMD row's mechanism.

### Manual acceptance walkthrough

No UI surface — this is a sidecar-venv/server-boot mechanism. The walkthrough is
therefore a shell + log walkthrough, not a browser one:

1. **Fresh state check.** On a bootstrapped NVIDIA box with no marker yet, run
   `server/tts-sidecar/.venv/Scripts/python.exe -m pip check` (or the posix
   equivalent). Expect it to report `onnxruntime` as required-but-missing by
   `faster-whisper`, `kokoro-onnx` and `qwen-tts` — this is the root condition, not a
   regression.
2. **Boot the server** (`cd server && npm run dev`, or `npm start`). Expect a log line
   before `[server] listening`: `[ort-marker] recorded onnxruntime <version> as
   provided by onnxruntime-gpu.`
3. **Re-run `pip check`.** Expect `No broken requirements found.` and exit code 0.
4. **Inspect the marker.** `onnxruntime-<version>.dist-info/` should exist beside
   `onnxruntime_gpu-<version>.dist-info/` in site-packages, with `INSTALLER` reading
   `castwright-ort-marker` and `RECORD` at 0 bytes.
5. **Re-boot the server.** Expect no `[ort-marker] recorded …` line the second time —
   `ensureOrtMarker` is idempotent (`noop`).
6. **Install Qwen3 or Whisper from the app UI (or re-run bootstrap/upgrade).** Expect
   no `WinError 5`, and `pip check` to stay green afterward.

## Out of scope

- **The "actionable message" half of #2192's acceptance criterion.** #2192 also asked
  that a failed in-app install "either succeed, or fail with an actionable message —
  never a raw `WinError 5`." This design delivers prevention, not translation: there is
  no `WinError`/errno handling in `routes/qwen-install.ts` or
  `tts/qwen-install-bootstrap.ts`, so a lock on any *other* venv DLL (ctranslate2,
  torch) would still surface a raw pip traceback. Filed separately rather than left
  implied — see the design doc's "What this does not deliver."
- **The split-venv `SIDECAR_DIR`/`SIDECAR_VENV_DIR` inconsistency.** `install-qwen3.mjs`
  and `install-whisper.mjs` resolve the venv as `SIDECAR_DIR/.venv` while the rest of
  this change (and most of the codebase) honours `SIDECAR_VENV_DIR`. Pre-existing and
  untouched — filed as its own issue per the design doc's Risks section.
- **`pip freeze` now lists both `onnxruntime==<v>` and `onnxruntime-gpu==<v>`.** Nothing
  in this repo runs `pip freeze` today; a future support-bundle feature that did would
  need to account for this.

## Ship notes

(Filled in when status flips to `stable`.)
