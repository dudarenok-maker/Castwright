# Wave-5-lineage ORT step A — A36 + A37 (this brief's "A37/A38"), Castwright#2621

Row ids at claim time: **A36** (fresh NVIDIA bootstrap, this brief's "A37") and
**A37** (in-app Qwen3 install, this brief's "A38") — matched by title per the
"ROW IDs CHANGED 2026-08-23" section of #2621, re-confirmed against
`docs/testing/onbox-acceptance-register.md` on this branch before starting.

Promotion gate: PR #2617 merged `2cbcdd73` (2026-08-23T07:00Z), #2600 closed —
verified by re-reading `install-ort.mjs` / `main.py` on this branch before
running anything.

Worktree: `C:\Claude\Projects\wt-2623-ort-acceptance`, branch
`docs/docs-2623-ort-acceptance`.

---

## A36 — ORT marker, fresh NVIDIA bootstrap

### What was executed

A genuine from-scratch `bootstrap-venv.mjs` run against a **throwaway venv**
(never the live sidecar venv):

```
$ SIDECAR_VENV_DIR=...\open-engine-scratch\claude-2621-...\a36-venv ACCELERATOR=nvidia \
  node scripts\bootstrap-venv.mjs "C:\Users\dudar\AppData\Local\Programs\Python\Python312\python.exe"
[bootstrap-venv] creating venv at ...\a36-venv
[bootstrap-venv] pre-installing torch from the nvidia index (https://download.pytorch.org/whl/cu128)
... (torch 2.11.0+cu128, torchaudio 2.11.0+cu128 installed)
[bootstrap-venv] swapping ONNX runtime → the nvidia GPU build
Successfully uninstalled onnxruntime-1.29.0
Collecting onnxruntime-gpu<1.27,>=1.26
Successfully installed onnxruntime-gpu-1.26.0
Collecting nvidia-cudnn-cu12~=9.0
Collecting nvidia-cublas-cu12~=12.8.0
Successfully installed nvidia-cublas-cu12-12.8.5.5 nvidia-cuda-nvrtc-cu12-12.9.86 nvidia-cudnn-cu12-9.24.0.43
[bootstrap-venv] done
EXIT=0
```

**Marker present + version:** `onnxruntime-1.26.0.dist-info` in site-packages,
`INSTALLER` = `castwright-ort-marker`, matching the version `onnxruntime-gpu`
actually installed (1.26.0). **DISCHARGED.**

**`pip check`:**

```
$ a36-venv\Scripts\python.exe -m pip check
No broken requirements found.
```

Exit 0. **DISCHARGED.**

**`[ort-preload]` startup log, round 1 (fix exactly as shipped, no `[cuda]`
extras):**

```
2026-08-23 17:37:16.686 [sidecar] [ort-preload] Failed to load cufft64_11.dll: Could not find module 'cufft64_11.dll' ...
2026-08-23 17:37:16.687 [sidecar] [ort-preload] Failed to load cudart64_12.dll: Could not find module 'cudart64_12.dll' ...
2026-08-23 17:37:16.687 [sidecar] [ort-preload] onnxruntime.preload_dlls() ran but at least one CUDA/cuDNN DLL failed to load (see lines above) -- the CUDA execution provider may silently fall back to CPU.
```

This is the **"failed"** bullet from the register's A36 note, and it directly
confirms the brief's amendment hypothesis: `install-ort.mjs`'s `extraRuntimeSteps`
installs `nvidia-cudnn-cu12` + `nvidia-cublas-cu12` but not `nvidia-cufft-cu12`
or `nvidia-cuda-runtime-cu12`, on the assumption the box's system CUDA 12.4
toolkit supplies `cufft64_11.dll` / `cudart64_12.dll` via `PATH`. **That
assumption is FALSE on this box** — both DLLs failed to load from anywhere.

**Kokoro execution provider, round 1:** `GET /health` → `"devices":
{"kokoro": "cpu", ...}`, `"devices_state": "error"` — real `InferenceSession`
construction fell back to CPU (confirmed via the sidecar's own loaded-session
device report, not just `get_available_providers()`).
`get_available_providers()` independently checked and, as always, listed
`CUDAExecutionProvider` regardless — the proven-nothing signal the brief
warns about.

### Two-branch experiment (per the 2026-08-23 amendment)

**Round 2 — installed the `[cuda]` extras into the throwaway venv only**
(`nvidia-cuda-runtime-cu12-12.9.79`, `nvidia-cufft-cu12-11.4.1.4`,
`nvidia-curand-cu12-10.3.10.19`, `nvidia-nvjitlink-cu12-12.9.86`; `nvidia-cuda-nvrtc-cu12`
already present from torch's own pull), then restarted the sidecar against
the same throwaway venv:

```
2026-08-23 17:43:58.493 [sidecar] [ort-preload] onnxruntime.preload_dlls() loaded the CUDA/cudnn/cublas/cufft DLLs; all 11 expected files were found under nvidia/<pkg>/bin.
```

Clean success line — every DLL genuinely resolved from this installer's own
`nvidia/<pkg>/bin`, not a PATH/torch fallback. **Hypothesis 2 fixes the
`preload_dlls()` DLL-search problem completely.**

**But Kokoro still fell back to CPU** even with this clean preload:
`POST /load {"engine":"kokoro"}` → `{"status":"ready"}`, then `GET /health`
→ `"devices": {"kokoro": "cpu", ...}`. No exception, no `[ort-preload]`
warning at load time — a **silent** fallback, worse than round 1's explicit
failure because nothing in the sidecar's own logs flags it.

### Root cause found — a THIRD cause, distinct from both named hypotheses

Isolated with a bare Python repro against the same throwaway venv (mirrors
exactly what `main.py`'s `_lifespan` does — call `onnxruntime.preload_dlls()`
once, then construct `Kokoro(...)`):

```python
import onnxruntime as ort
ort.preload_dlls()
from kokoro_onnx import Kokoro
k = Kokoro(model_path, voices_path)
print(k.sess.get_providers())
# -> ['CPUExecutionProvider']          (no ONNX_PROVIDER set — sidecar's real path)
```

```python
# same preload_dlls(), but with ONNX_PROVIDER=CUDAExecutionProvider set:
# -> ['CUDAExecutionProvider', 'CPUExecutionProvider']   (real CUDA session)
```

A raw `onnxruntime.InferenceSession(kokoro-v1.0.onnx, providers=['CUDAExecutionProvider','CPUExecutionProvider'])`
constructed directly (bypassing `kokoro_onnx` entirely) also succeeds on
CUDA — `sess.get_providers()` → `['CUDAExecutionProvider', 'CPUExecutionProvider']`,
with onnxruntime's own `MemcpyTransformer` log confirming CUDA nodes were
actually added to the graph. **CUDA execution genuinely works on this box,
with these packages, once `preload_dlls()` has run.**

The difference is entirely inside `kokoro_onnx/__init__.py` (the installed
`kokoro-onnx==0.5.0`, pinned by `requirements/nvidia-cuda.txt`):

```python
providers = ["CPUExecutionProvider"]
gpu_enabled = importlib.util.find_spec("onnxruntime-gpu")   # <- always None
if gpu_enabled:
    providers: list[str] = rt.get_available_providers()
...
self.sess = rt.InferenceSession(model_path, providers=providers)
```

`importlib.util.find_spec("onnxruntime-gpu")` checks for an **importable
module** named `onnxruntime-gpu`. No such module exists — the pip
distribution `onnxruntime-gpu` installs into the `onnxruntime` package
namespace, same as plain `onnxruntime`. Confirmed directly:

```
>>> importlib.util.find_spec('onnxruntime-gpu')
None
>>> importlib.util.find_spec('onnxruntime') is not None
True
```

So `gpu_enabled` is **always falsy**, regardless of what's installed, and
`kokoro_onnx.Kokoro()`'s own auto-detection **always** constructs with
`providers=["CPUExecutionProvider"]` explicitly — this is not a fallback
after a failed CUDA attempt, CUDA is never even offered to onnxruntime. The
only escape hatch is the `ONNX_PROVIDER` env var, which nothing in this
codebase sets.

Compounding it: `main.py`'s `KokoroEngine._ensure_loaded` tries
`Kokoro(self._model_path, self._voices_path, providers=providers)` when
`KOKORO_ORT_PROVIDERS` is set, but this installed `kokoro-onnx` version's
`Kokoro.__init__` **has no `providers` parameter at all** — that call raises
`TypeError`, which the code catches and falls back to the broken
no-args auto-detect path above. So even setting `KOKORO_ORT_PROVIDERS`
server-side would not currently reach onnxruntime.

**This is why A36's GPU-provider check has failed on every wave (3, 4, and
now this one) even as the underlying DLL-search defects (#2534, #2600) got
fixed one at a time: the real blocker was never (only) DLL discoverability.**
`preload_dlls()` genuinely works once the right packages are present — but
`kokoro-onnx` never asks onnxruntime for CUDA in the first place.

### Disposition

**A36: STILL OWED.** Marker mechanics and `pip check` discharge cleanly.
Hypothesis 2 (`[cuda]` extras) is **confirmed correct and necessary** — round
1's DLL-search failure is real and round 2's clean preload proves the extras
fix it. But the GPU-provider criterion still fails, on a **newly identified,
distinct root cause** inside `kokoro-onnx==0.5.0`'s own provider
auto-detection (not `install-ort.mjs`, not `preload_dlls()`). Per the
brief: this is reported, not fixed, and the diff is not widened to patch it.

**Not in scope to fix — for the follow-up:** either (a) set `ONNX_PROVIDER`
explicitly wherever the sidecar spawns `kokoro_onnx.Kokoro()` (env-var-only
workaround, no dependency change), or (b) fix/replace the `providers=` path
in `main.py`'s `KokoroEngine._ensure_loaded` so `KOKORO_ORT_PROVIDERS`
actually reaches an installed `kokoro-onnx` version whose constructor accepts
it, or (c) upgrade `kokoro-onnx` past whatever release fixes the
`find_spec("onnxruntime-gpu")` check. (b) and (c) both need re-verification
against the shipped `Kokoro.__init__` signature; (a) is the smallest, most
directly verified-safe change per what was tested here.

---

## A37 — the reported bug: in-app Qwen3 install

### What was executed

Started this worktree's own app (`npm run dev`, `SIDECAR_VENV_DIR` pointed at
the same A36 throwaway venv — a disposable copy, not the live one):

```
[frontend]   VITE v8.0.16  ready in 5332 ms
[frontend]   ➜  Local:   http://127.0.0.1:5293/
[server] 2026-08-23 17:54:03.608 [server] listening on http://localhost:8200
[server] 2026-08-23 17:54:03.693 [sidecar] already listening on :9000 (protocol v1), skipping spawn (current sidecar honoured)
```

Frontend bound `5293` and API bound `8200` — both confirmed from the
server's own log output, matching this worktree's assigned ports.

### Blocked: box-wide sidecar port contention (same structural issue wave-4
recorded, independently reproduced here)

`server/src/tts/spawn-sidecar.ts` hardcodes `DEFAULT_PORT = 9000`
(`sidecar-owner.ts`'s `SIDECAR_PORT` too) — `LOCAL_TTS_PORT=9120` from this
worktree's `.env.local` is read only by `tts-sidecar/start.ps1`, never by the
Node server that actually spawns/adopts the sidecar for the running app (the
"six-consumer inconsistency" prior waves already flagged). At startup my
server found **another process already listening on :9000** and adopted it
instead of spawning its own — so `SIDECAR_VENV_DIR` never took effect for
the running app; every TTS call in this session would have gone to whoever
already owns that port.

I identified that pre-existing sidecar (PID 7380, started 17:42:59, actively
`ESTABLISHED` with a live client at the time I checked) rather than assuming
it was safe to use. Per this campaign's standing rule — never stop or
disrupt another agent's live process, never leave a running server touched —
I did **not** click Install against it: `qwen_install_state` there already
read `"ready"`, and the connection was actively in use, meaning a UI
"Install" click could trigger the server's `onInstalled` → sidecar-restart
path against a session I do not own and cannot safely interrupt. I only ran
read-only `GET /health` against it (`devices: {"kokoro": "cuda", "coqui":
"cuda", "qwen": "cuda"}` — noted only as context: some venv on this box
*does* reach real CUDA sessions for all three engines, which is consistent
with A36's root-cause diagnosis being an environment-specific gap rather
than a hardware/driver problem, but I did not — and should not — inspect
that other process further to explain why).

I did not attempt to force a second sidecar onto a different port (no
supported override exists — `SIDECAR_NEVER_ADOPT=1` would only retry the
same hardcoded `:9000`, colliding with the already-bound port rather than
opening a fresh one) and did not restart or kill the existing one.

### Disposition

**A37: STILL OWED — blocked by box-wide sidecar port contention**, same
structural class as the wave-4 step-5c finding (`docs/testing/onbox-wave4-results/step-5c-a40.md`)
and not a defect in the code under test. Neither the Qwen3 install
click-through nor the Kokoro-afterward check could be safely run this
session. **Not attempted, not failed.**

**Worth filing separately:** `server/src/tts/spawn-sidecar.ts` /
`sidecar-owner.ts`'s hardcoded `9000` vs. `LOCAL_TTS_PORT`'s per-worktree
value is a real inconsistency that makes any two worktrees' apps unable to
run isolated TTS sessions simultaneously — this run is the third piece of
evidence for it (wave-3, wave-4 step-5c, this run).

---

## Live sidecar venv — byte-verification

`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv` — never
written to. Two readings, taken before and after all A36/A37 work in this
session:

| | file count | total bytes | onnxruntime dist-info INSTALLER markers |
|---|---|---|---|
| Reading 1 | 56542 | 6483355726 | `castwright-ort-marker`, `pip` |
| Reading 2 (after) | 56542 | 6483355726 | `castwright-ort-marker`, `pip` |

Identical. **Unchanged.**

## pip check, every venv built this run

Only one venv was built: the A36 throwaway (`...\open-engine-scratch\claude-2621-...\a36-venv`).
`pip check` → `No broken requirements found.` (shown above under A36).

## Cleanup

All processes this run spawned (A36's two sidecar rounds on `:9121`, this
worktree's `npm run dev` tree on `:5293`/`:8200`) were stopped before
finishing. The throwaway venv, the copied Kokoro model weights under this
worktree's `voices/kokoro/`, and all scratch logs are left in place for
inspection but are disposable — nothing under source control references
them.
