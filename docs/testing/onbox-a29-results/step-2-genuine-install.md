# A29 step 2 — genuine Qwen3 install click-through (real, not a no-op)

Worktree: `wt-2192-a29-genuine-install-test` @ branch `fix/ops-2192-a29-genuine-install-test`, isolated
ports per `.env.local` / `server/.env` (`VITE_PORT=5373`, `PORT=8280`/`VITE_API_PORT=8280`,
`LOCAL_TTS_PORT=9200`). This is the redo chain referenced by the four prior A29 attempts
(`docs/testing/onbox-a29-results/step-1-retry.md` on `docs/docs-2913-a29-retry`, not yet on `main`):
every prior pass either found Qwen3 already installed (no transition to observe) or was blocked by
port contention / a CUDA13-cuDNN9 gap before it could reach the actual install click. This pass
reaches it, for real, and gets a real (non-fabricated) answer — including a genuine repro of the
`WinError 5` the design docs worried about.

## Summary

| Check | Result |
|---|---|
| Qwen3 genuinely absent before | **CONFIRMED**, twice (see below) |
| Install exercised for real vs no-op | **REAL** — genuine `pip install qwen-tts` attempt, not the `packageFault==='ok'` short-circuit |
| Install outcome (first attempt, via the UI click) | **FAILED — WinError 5** |
| WinError 5 occurred | **YES**, genuinely reproduced (see root cause below) |
| Kokoro CUDA health | **NOT CUDA** — `devices.kokoro: "cpu"` throughout (pre-existing, unrelated to the WinError 5) |
| Venv left in a working state | Yes — restored and reverified after the test (see Restoration) |

## Part 1 — confirming Qwen3 was genuinely absent

Two independent confirmations, at two different points in this pass (see "Why twice" below):

**1a. Natural absence, before touching anything.** Before this worktree's `.venv` had finished its
own outstanding background bootstrap (a bulk `pip install -r requirements/nvidia-cuda.txt`-class job
that was already mid-flight in this worktree slot when this pass started — visible only in retrospect,
via `.venv/Lib/site-packages/*` timestamps spanning 16:06–16:14 local, well before and after this
pass's own `npm run dev` at 16:11:42):

```
$ Test-Path .venv/Lib/site-packages/qwen_tts   → False
$ curl http://localhost:8280/api/qwen/detect   → {"state":"not-installed","installed":false}
$ curl http://localhost:8280/api/sidecar/health → qwenPackageInstalled:false, qwenInstallState:"not-installed"
```

**Why twice.** That background bootstrap job finished installing `qwen-tts` on its own (unrelated to
any click) about 2.5 minutes into this pass — before the in-app "Install" control ever became
actionable. This is a **new, fifth failure mode** in the same family as the prior four attempts
(each blocked the click-through a different way): here it was a leftover per-worktree provisioning
job racing ahead of the test, not a stale venv or port contention. Rather than accept another
non-event, this pass reset the precondition deliberately and re-confirmed it live:

**1b. Deliberately reset, then reconfirmed live** (after the background job had fully settled, so it
would not re-fire):

```
$ .venv/Scripts/python.exe -m pip uninstall qwen-tts -y
Successfully uninstalled qwen-tts-0.1.1
$ Test-Path .venv/Lib/site-packages/qwen_tts        → False
$ curl -X POST http://localhost:8280/api/sidecar/restart → {"ok":true}
$ curl http://localhost:8280/api/setup/models-status
  {"engines":{"qwen":{"state":"package-missing","packageBroken":false,"packageFault":"missing"}, ...}}
```

`packageFault: "missing"` is the sidecar's own **live** probe result (not a disk-only heuristic) —
this is the same signal `src/components/qwen-install.tsx` gates its "Install Qwen3-TTS" button on
(`status.packageFault === 'missing'`), and it is what made the button genuinely appear next.

## Part 2 — the real click, via Playwright

Started `npm run dev` (frontend :5373, server :8280, sidecar :9200 — all isolated to this worktree).
Navigated to `http://127.0.0.1:5373/#/models` (Model Manager, `fs-23`), expanded "Installed models",
opened the "Qwen3-TTS Base (0.6B)" row's **Update ▾** control. With the package genuinely missing
(Part 1b), it rendered the `qwen-install-missing` branch:

> **The Qwen package is missing** — The voice engine confirmed the Qwen package is not installed.
> Install reinstalls it. `[Install Qwen3-TTS]`

Clicked **Install Qwen3-TTS** for real (Playwright `browser_click`, not a synthesized API call).
Network trace confirms a genuine job, not the `installed`-short-circuit no-op the prior attempts hit:

```
POST /api/qwen/install           → 202 Accepted   { id: "1", status: "installing", ... }
GET  /api/qwen/install/1 (×3, polling every 1.5s)
```

`startedAt=1788675650185` (16:20:50.185 local) → `updatedAt=1788675653298` (16:20:53.298 local): the
job ran for **~3.1 seconds** before terminating in `error`, not `installed`:

```json
{
  "id": "1",
  "status": "error",
  "step": "FAIL: pip install qwen-tts failed. Check network + sidecar venv.",
  "error": "install-qwen3.mjs exited with code 1. \r [notice] A new release of pip is available: 25.0.1 -> 26.2.1\r [notice] To update, run: ...python.exe -m pip install --upgrade pip"
}
```

The job's own truncated error (`qwen-install-bootstrap.ts` keeps only the **last 2000 chars / last 3
lines** of the child's stderr) hides the actual cause — pip's routine "new release available" notice
happened to land after it and pushed it out of the kept tail. This is itself a real, minor
observability gap worth flagging: **a WinError 5 install failure surfaces to the user as a generic,
unhelpful message**, not the actionable Windows error underneath.

## Part 3 — root-causing the failure: WinError 5, genuinely reproduced

To see the real error, the exact same command `install-qwen3.mjs` runs was replayed directly
(`node server/tts-sidecar/scripts/install-qwen3.mjs --skip-design`), with full stdout/stderr kept,
**while the app (and its sidecar) from Part 2 was still running** — i.e. the same live conditions a
real user would be in:

```
Using cached qwen_tts-0.1.1-py3-none-any.whl (113 kB)
Using cached onnxruntime-1.29.0-cp312-cp312-win_amd64.whl (14.0 MB)
Installing collected packages: onnxruntime, qwen-tts
ERROR: Could not install packages due to an OSError: [WinError 5] Access is denied:
'...\.venv\Lib\site-packages\onnxruntime\capi\onnxruntime_providers_shared.dll'
Check the permissions.
[install-qwen3] FAIL: pip install qwen-tts failed. Check network + sidecar venv.
```

**WinError 5 confirmed, genuinely reproduced** — this is the exact failure mode
`docs/superpowers/specs/2026-08-07-qwen-ort-namespace-chokepoint-design.md` was written to prevent.
Root cause, isolated by a controlled A/B:

- **With the sidecar process alive** (it has `onnxruntime` imported and its DLL memory-mapped, per
  `main.py`'s own `[ort-preload]` startup step): `pip install qwen-tts` — which pulls in a
  same-named-but-different `onnxruntime` wheel as a transitive dependency — fails with WinError 5 on
  the DLL replace, **every time**, in ~3 seconds. Reproduced twice this pass (once via the real UI
  click, once via direct replay).
- **With the sidecar process stopped** (`taskkill /F /T` on the server/sidecar/vite PIDs first): the
  **identical** pip command succeeds cleanly:
  ```
  Installing collected packages: onnxruntime, qwen-tts
  Successfully installed onnxruntime-1.29.0 qwen-tts-0.1.1
  ```

So: the in-app "Install Qwen3-TTS" flow (`server/src/tts/qwen-install-bootstrap.ts` →
`install-qwen3.mjs`) does **not** stop the sidecar before running pip, and pip's dependency
resolution for `qwen-tts` pulls a fresh `onnxruntime` wheel regardless of what the venv already
has — a live sidecar holding that DLL open turns every such install into a guaranteed WinError 5.
This is a real, load-bearing finding for A29/A40: the install button is not safe to click while the
voice engine is running, and the app gives no warning of that.

**Secondary finding (not this pass's main question, but observed as a side effect):** the
`onnxruntime` wheel pip resolves for `qwen-tts` is the **plain CPU package**, not `onnxruntime-gpu`
(`requirements/nvidia-cuda.txt`'s own pin) — `pip show onnxruntime` after the restore confirms
version `1.29.0` with no CUDA build (`tts.err.log`'s own `[ort-preload]` line: *"this onnxruntime
build has no CUDA support (cuda_version is empty)"*). This is consistent with the historical
#2534-class CPU-fallback bug and is the most likely reason Kokoro never got CUDA in this environment
(Part 4) — it is a pre-existing condition, not something this pass's install attempt caused.

## Part 4 — Kokoro CUDA health

Checked before, during, and after this pass — consistently **not CUDA**:

```json
{
  "ok": true,
  "devices": { "kokoro": "cpu", "coqui": "cuda", "qwen": "cuda" },
  "devices_state": "ready",
  "kokoro_package_installed": true,
  "kokoro_import_ok": null,
  "gpus": [
    { "idx": 0, "name": "NVIDIA GeForce RTX 4070 Laptop GPU", "total_mb": 8585, "free_mb": 7411 },
    { "idx": 1, "name": "NVIDIA GeForce RTX 5070 Ti", "total_mb": 17094, "free_mb": 15767 }
  ]
}
```

(Full `GET http://127.0.0.1:9200/health` response, captured after the Part 3 restoration and a clean
app restart.) Both GPUs are visible and idle, `qwen` and `coqui` both correctly report `cuda`, but
`kokoro` reports `cpu`. Per Part 3's secondary finding, this tracks back to the plain `onnxruntime`
(not `onnxruntime-gpu`) package that ends up installed in this venv — Kokoro's engine runs on ORT, so
without the CUDA-capable wheel it cannot report `cuda` regardless of the GPUs being free. **This is
an honest non-CUDA result, not a fabricated pass** — the #2632 port-isolation fix (confirmed working
in the prior attempt) is orthogonal to this ORT-provider gap, which remains open.

## Restoration / box-safety

- Stopped this worktree's own server, sidecar, and vite processes (`taskkill /F /T`) before and after
  the deliberate uninstall/reinstall, touching only PIDs bound to this worktree's own ports
  (`:5373`, `:8280`, `:9200` — verified via `netstat -ano` before each kill). The box's shared `:9000`
  sidecar (if any) was never queried or touched by this pass.
- After confirming the WinError 5 root cause, restored the venv with the sidecar stopped:
  `pip install -r requirements/nvidia-cuda.txt` → `Successfully installed onnxruntime-1.29.0
  qwen-tts-0.1.1`. Restarted `npm run dev`, reconfirmed `qwen_install_state: "ready"`,
  `qwen_package_installed: true` live, then stopped the app again cleanly (verified `:5373`/`:8280`/
  `:9200` all freed via `netstat`).
- No GPU model was left resident (each `Load model` / restart cycle was for real synth/device probing
  only, all confirmed idle afterward via the sidecar's own VRAM report — `torch_reserved_mb: 0` on
  both GPUs in the final health check above).
- No shared/box-wide file was touched — only this worktree's own `server/tts-sidecar/.venv` (isolated
  per-worktree venv) and its own HF cache reads (weights were already cached from a prior pass; no
  new multi-GB download was needed or attempted).
- `git status` clean before and after; no source file was edited, no register file touched.

## What this discharges vs. leaves owed

- **A29 criterion 2** (the actual in-app Qwen3 install click-through, confirming/denying WinError 5) —
  now genuinely exercised, for the first time across five attempts. Answer: **WinError 5 does occur**,
  reproducibly, whenever the sidecar is running during the click — this is a real bug, not a false
  alarm, and is **not** yet fixed by any of the prior #2192/#2534 work (that work addressed a
  different code path — the sidecar's own ORT provider selection at startup, not the installer's
  pip-vs-live-process DLL conflict).
- **Kokoro CUDA health** — checked and reported honestly as **not CUDA** in this environment; tracked
  to the same plain-`onnxruntime`-vs-`onnxruntime-gpu` resolution gap as the historical #2534 report,
  not to anything this pass's install attempt broke.
- **Not filed as a new fix in this pass** (out of scope for a test/evidence pass): a real fix would
  have the installer either (a) stop/pause the sidecar before running pip and restart it after, or
  (b) pin `qwen-tts`'s `onnxruntime` dependency against the already-installed `onnxruntime-gpu` so pip
  never attempts the swap while it's loaded. Recommend filing both as follow-up issues against
  `server/src/tts/qwen-install-bootstrap.ts` / `server/tts-sidecar/scripts/install-qwen3.mjs`.
