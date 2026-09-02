# ctranslate2/cuDNN shadow measurement (Castwright#2861)

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
triggers ctranslate2's first cuDNN load of the process (Whisper's model is lazy-loaded,
after onnxruntime/kokoro has already loaded its own cuDNN 9.19.0.56 copy via
`_add_nvidia_dll_dirs_to_path`).

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

### 3. Module-provenance inspection: TWO distinct `cudnn64_9.dll` modules coexist

`Get-Process -Id <sidecar pid> -Module` after the `/transcribe` call shows the
sidecar process has **two separate loaded modules both named `cudnn64_9.dll`**,
at different full paths, with different versions — Windows did not collapse them
into a single module:

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
duplicated under `ctranslate2\` — because ctranslate2 only bundles the single
`cudnn64_9.dll` entry-point stub, not the full cuDNN component set; its runtime
loader resolves the rest through whichever `cudnn64_9.dll` gets loaded first in
its own process, or ctranslate2 links narrowly against the entry stub only. What
matters for this measurement is that ctranslate2's forward pass completed
correctly end-to-end on CUDA with a correct transcript, so whichever component
set it actually used at runtime worked.

### Interpretation

Windows' loader identifies a already-loaded module by its **normalized full
path**, not by base name, when the loading component resolves the DLL via an
explicit path (as ctranslate2 does for its own bundled copy — it ships
`cudnn64_9.dll` inside its own package directory and loads it from there, not
via a bare-name `PATH` search). `_add_nvidia_dll_dirs_to_path`'s PATH prepend
only affects **bare-name** `LoadLibrary`/`dlopen` resolution (which is what
onnxruntime's lazily-dlopened cuDNN engine plugins need — the bug it was built
to fix). ctranslate2 never does a bare-name search for its own `cudnn64_9.dll`,
so the PATH-prepend candidate never gets a chance to shadow it: both DLLs load
side by side as distinct modules, ctranslate2 gets its own pinned 9.10.2.21, and
the onnxruntime-consuming engines (Kokoro/Coqui/Qwen) still get 9.19.0.56 from
the PATH prepend. There is no shadow in practice on this measurement.

### Conclusion

**No fix needed.** The `install-ort.mjs:396-414` PASS-3 review note's concern
(cross-minor cuDNN version gap 9.10→9.19 between ctranslate2's bundled copy and
the PATH-prepended onnxruntime copy) does not manifest as a runtime shadow on
this real hardware: ctranslate2 loads and uses its own bundled cuDNN 9.10.2.21
via its own absolute package path, unaffected by `_add_nvidia_dll_dirs_to_path`'s
PATH prepend, and transcription is correct. `_add_nvidia_dll_dirs_to_path` is
left untouched, per the ticket's explicit instruction not to weaken it.
