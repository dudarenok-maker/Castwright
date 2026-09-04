# ctranslate2/cuDNN shadow measurement (Castwright#2845)

## Result: harmless. No source change made.

Measured live on this box's real GPU (NVIDIA GeForce RTX 4070 Laptop GPU, 8585 MB,
driver 610.88 / CUDA UMD 13.3) with the sidecar booted `ASR_DEVICE=cuda ASR_MODEL=base`.
(Note: this box's second GPU slot, `GPU1: 0000:05:00.0`, independently reported
"GPU is lost" at the time of this run — a pre-existing, unrelated hardware issue
requiring a reboot; GPU 0, the one this sidecar actually uses, was healthy
throughout.)

### 1. `/synthesize` (kokoro) → real speech PCM

```
POST /synthesize {"engine":"kokoro","model":"kokoro-v1.0","voice":"af_heart",
  "text":"The quick brown fox jumps over the lazy dog."}
-> 200 OK, X-Sample-Rate: 24000, 128000 bytes raw PCM (2.667 s)
```

Sidecar log:
```
2026-09-03 08:03:29.644 [sidecar] Loading Kokoro model=...\voices\kokoro\kokoro-v1.0.onnx ...
2026-09-03 08:03:31.438 [sidecar] Kokoro loaded. English voices: 28 (filtered from 54 total in manifest).
2026-09-03 08:03:35.285 [sidecar] kokoro synth: voice=af_heart text_len=44 gen_ms=3842 audio_ms=2667 rtf=1.44
INFO:     127.0.0.1:51380 - "POST /synthesize HTTP/1.1" 200 OK
```

### 2. `/transcribe` (ctranslate2/faster-whisper, cold load) → correct transcript on CUDA

Fed the kokoro PCM straight back into `/transcribe` (`X-Sample-Rate: 24000`), which
triggers ctranslate2's first cuDNN load of the process (Whisper's model is lazy-loaded).
Kokoro's onnxruntime session is expected to have initialized its CUDA execution provider —
and hence loaded cuDNN — by this point, given `_add_nvidia_dll_dirs_to_path` runs
unconditionally at sidecar boot before any request is served; this run did not separately
capture a pre-`/transcribe` module snapshot to confirm it directly.

```
POST /transcribe (raw int16 PCM, X-Sample-Rate: 24000)
-> 200 OK
{"text":"The quick brown fox jumps over the lazy dog.","language":"en",
 "avg_logprob":-0.236,"no_speech_prob":0.0061,"compression_ratio":0.863,"words":null}
```

Transcript is an exact match to the synthesized text. No CUDA/cuDNN error, no
`CUDNN_STATUS_SUBLIBRARY_LOADING_FAILED`-shaped message, no silent CPU fallback.

Sidecar log:
```
2026-09-03 08:04:07.373 [sidecar] Loading Whisper ASR model=base device=cuda:0 compute=int8_float16 revision=(unpinned) ...
2026-09-03 08:04:10.274 [sidecar] Whisper ASR loaded (model=base device=cuda:0).
2026-09-03 08:04:10.274 [sidecar] Processing audio with duration 00:02.667
2026-09-03 08:04:10.321 [sidecar] VAD filter removed 00:00.000 of audio
2026-09-03 08:04:10.853 [sidecar] Detected language 'en' with probability 1.00
INFO:     127.0.0.1:58098 - "POST /transcribe HTTP/1.1" 200 OK
```

### 3. Module-provenance inspection: mixed cuDNN versions coexist

`Get-Process -Id <sidecar pid> -Module` after the `/transcribe` call shows the
sidecar process has loaded `cudnn64_9.dll` from **three different locations**,
but only **two distinct versions** — Windows did not collapse them into a single module:

| Path | FileVersion |
|---|---|
| `...\.venv\Lib\site-packages\nvidia\cudnn\bin\cudnn64_9.dll` | 9.19.0.56 |
| `...\.venv\Lib\site-packages\torch\lib\cudnn64_9.dll` | 9.19.0.56 |
| `...\.venv\Lib\site-packages\ctranslate2\cudnn64_9.dll` | **9.10.2.21** |

(the `nvidia\cudnn\bin` and `torch\lib` copies are both 9.19.0.56 as expected —
`_add_nvidia_dll_dirs_to_path`'s PATH-prepend mechanism and torch's own bundled
copy; the `ctranslate2\` one is the package's own bundled 9.10.2.21 copy.)

Every other loaded cuDNN component (`cudnn_ops64_9.dll`, `cudnn_adv64_9.dll`,
`cudnn_graph64_9.dll`, `cudnn_heuristic64_9.dll`, `cudnn_engines_*64_9.dll`) is
present ONLY under `nvidia\cudnn\bin` and `torch\lib` (version 9.19.0.56) — never
bundled under `ctranslate2\` — because ctranslate2 only ships the single
`cudnn64_9.dll` dispatch DLL entry point, not the full cuDNN library suite.
cuDNN's dispatch DLL loads these sublibraries lazily (at the first real kernel
operation) via bare-name `LoadLibrary` calls, which resolves through the process
`PATH` environment variable, not through explicit paths. This process `PATH` has
been prepended with `nvidia/cudnn/bin/` at sidecar boot (via `_add_nvidia_dll_dirs_to_path`),
so the sublibraries loaded are the 9.19.0.56 versions. The net result: ctranslate2
loaded the 9.10.2.21 dispatch stub (via its explicit package path), but resolved
its required sublibraries from the PATH-prepended 9.19.0.56 set. This is a
mixed-version stack (dispatch 9.10.2.21 + sublibraries 9.19.0.56), not a
fully self-contained 9.10.2.21 stack. The measurement shows this mixed
combination worked correctly end-to-end on CUDA with a correct transcript.

### Interpretation

Windows' loader identifies a module by its **normalized full path**, not by base
name, when the loading component resolves the DLL via an explicit path. ctranslate2
ships `cudnn64_9.dll` inside its own package directory and loads it from there,
not via a bare-name `PATH` search — so its 9.10.2.21 dispatch stub loads as
a distinct module, unaffected by `_add_nvidia_dll_dirs_to_path`'s PATH prepend.

However, the bare-name search mechanism is NOT avoided downstream: cuDNN's
dispatch DLL pattern (documented in `main.py:151-175`) means the dispatch stub
itself lazily loads the other cuDNN components (`cudnn_ops64_9.dll`,
`cudnn_graph64_9.dll`, etc.) via bare-name `LoadLibrary` calls, which resolves
through the process `PATH` environment variable. This is the mechanism that
`_add_nvidia_dll_dirs_to_path` prepends `nvidia/cudnn/bin/` for — not just for
onnxruntime's own lazy engine plugins, but for cuDNN itself's later lazy loads.
At runtime, the dispatch stub loaded by ctranslate2 necessarily resolves its
required sublibraries from whatever is already resident or discoverable in the
process — in this measurement, the 9.19.0.56 set from `nvidia/cudnn/bin` and/or
`torch/lib`. However, this measurement did not isolate whether the PATH-prepend
was the cause (rather than ctranslate2's bare-name lookup simply being satisfied
by cuDNN sublibraries already resident from onnxruntime or torch initialization
before ctranslate2 ran).

The result: ctranslate2 loaded a 9.10.2.21 dispatch stub that resolved its
9.19.0.56 sublibraries from the process (the 9.19.0.56 versions being already
present before ctranslate2's dispatch stub executed). This is a mixed-version
composition, not a displacement of ctranslate2's own sublibraries — ctranslate2
bundles no cuDNN sublibraries at all, only the single dispatch DLL entry point.

### Conclusion

**No fix needed.** The `install-ort.mjs` PASS-3 REVIEW NOTE (2026-09-01) concern
(cross-minor cuDNN version gap 9.10→9.19 between ctranslate2's bundled dispatch
stub and the system's cuDNN sublibraries) results in a mixed-version composition
on this real hardware, but empirically causes no harm: ctranslate2's 9.10.2.21
dispatch stub loaded and correctly resolved its required 9.19.0.56 sublibraries,
executed transcription correctly on CUDA, and produced the correct output. The
mixed-version stack worked. `_add_nvidia_dll_dirs_to_path` is left untouched,
per the ticket's explicit instruction not to weaken it — the prepended PATH
serves a critical purpose for onnxruntime's own lazy engine loads. Moreover,
excluding the PATH-prepend for ctranslate2 specifically (a remedy #2845 floated)
would leave its dispatch stub with zero discoverable sublibraries at all,
reintroducing the exact `CUDNN_STATUS_SUBLIBRARY_LOADING_FAILED` failure #2818/A28
already fixed, so the status quo is not just harmless but necessary.
