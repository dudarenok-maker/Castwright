# ctranslate2/cuDNN shadow measurement (Castwright#2845)

## Result: not applicable. ctranslate2 does not consume cuDNN. No source change made.

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
cold-loads Whisper's ctranslate2-backed model for the first time this process (the
model is lazy-loaded on first use). `_add_nvidia_dll_dirs_to_path` runs unconditionally
at sidecar boot, before any request is served, so by the time this request lands the
process `PATH` already carries the prepended `nvidia/<pkg>/bin` directories.

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

### 3. Module-provenance inspection: inert bundled cuDNN copy coexists with active set

`Get-Process -Id <sidecar pid> -Module` after the `/transcribe` call shows the
sidecar process has loaded `cudnn64_9.dll` from **three different locations**,
but only **two distinct versions** — Windows did not collapse them into a single module:

| Path | FileVersion |
|---|---|
| `...\.venv\Lib\site-packages\nvidia\cudnn\bin\cudnn64_9.dll` | 9.19.0.56 |
| `...\.venv\Lib\site-packages\torch\lib\cudnn64_9.dll` | 9.19.0.56 |
| `...\.venv\Lib\site-packages\ctranslate2\cudnn64_9.dll` | **9.10.2.21** |

(the `nvidia\cudnn\bin` copy is the one `_add_nvidia_dll_dirs_to_path` puts on
`PATH`, and `torch\lib` is torch's own bundled copy — both report 9.19.0.56, as
expected since `NVIDIA_CUDNN_CONSTRAINT` pins the installed copy to match torch's
bundled line; this doesn't establish which mechanism actually loaded either one
into this process, only which package each file belongs to. The `ctranslate2\`
one is that package's own bundled 9.10.2.21 copy.)

**ctranslate2's own compiled code does not reference cuDNN at all.** Binary inspection
of `server/tts-sidecar/.venv/Lib/site-packages/ctranslate2/ctranslate2.dll` and
`_ext.cp312-win_amd64.pyd` (`grep -a -i -o "cudnn" <file> | wc -l` — the `-o`/`wc -l`
combination is required for a true occurrence count; `grep -c` alone reports matching
*lines* in a binary, which undercounts) found **zero** occurrences of "cudnn" in
either file. The same command against "cublas" on `ctranslate2.dll` finds **35**
occurrences, including symbol names like `cublasCreate_v2`, `cublasGemmEx`,
`CUBLAS_STATUS_*`, `cublas64_12.dll`, etc.) — confirming the method finds real
references when they exist, and that ctranslate2 uses **cuBLAS**, not cuDNN, for
its GPU matrix operations. `ctranslate2.dll`'s import-name strings are
`cublas64_12.dll`, `nvcuda.dll`, MKL, and CRT libraries — `cudnn64_9.dll` is not
among them; it is not statically imported, delay-loaded, or referenced by name
anywhere in ctranslate2's compiled code.

The bundled `cudnn64_9.dll` in the ctranslate2 package directory is loaded into
the process anyway — but only because `ctranslate2/__init__.py` (lines 20-21)
unconditionally globs and `ctypes.CDLL`-loads *every* `.dll` file in its own
package directory at import time, regardless of whether ctranslate2's code ever
calls into it:

```python
for library in glob.glob(os.path.join(package_dir, "*.dll")):
    ctypes.CDLL(library)
```

So the 9.10.2.21 copy is resident in the process, at a module the loader treats as
distinct from the other two `cudnn64_9.dll` copies (Windows' loader keys on
normalized full path, and this one is loaded via that absolute directory-glob path,
never via a bare-name `PATH` search) — but it is never invoked. It is loaded and
inert.

Every other loaded cuDNN component (`cudnn_ops64_9.dll`, `cudnn_adv64_9.dll`,
`cudnn_graph64_9.dll`, `cudnn_heuristic64_9.dll`, `cudnn_engines_*64_9.dll`) is
present ONLY under `nvidia\cudnn\bin` and `torch\lib` (version 9.19.0.56) — never
bundled under `ctranslate2\`, which ships only the single dispatch-DLL entry
point, not the full cuDNN library suite. **This measurement does not establish,
and does not need to establish, which component actually loaded or used those
sublibraries.** Both onnxruntime (Kokoro's execution provider) and torch are
present in this process, and both are genuine cuDNN consumers in general — a
separate binary check found **1773** occurrences of "cudnn" in
`torch/lib/torch_cuda.dll`, and torch's own `torch/lib/` directory bundles a
complete cuDNN sublibrary set alongside its own `cudnn64_9.dll`. A
`Get-Process -Module` snapshot shows what is loaded, not what called what or in
which order — it cannot attribute the loaded sublibraries to one component over
the other, and this run did not separately capture a pre-`/transcribe` module
snapshot that might have narrowed it further. That attribution is orthogonal to
this ticket's question, which is specifically about ctranslate2.

### Interpretation

Windows' loader identifies a module by its **normalized full path**, not by base
name. ctranslate2 loads its bundled `cudnn64_9.dll` via an absolute path (the
directory-glob load in `__init__.py`), not via a bare-name `PATH` search — so it
loads as a module distinct from the other two copies, unaffected by
`_add_nvidia_dll_dirs_to_path`'s PATH prepend. But that distinction turns out not
to matter for the ticket's concern: ctranslate2's compiled code never calls into
any cuDNN export at all, from this file or any other, so there is no cross-version
interaction for the PATH prepend (or anything else) to cause. The rest of the
process's cuDNN activity — whichever of onnxruntime or torch is responsible for
it — is real, but it is not ctranslate2's.

### Conclusion

**No fix needed.** ctranslate2 does not consume cuDNN in this build at all —
confirmed independently of the process-level measurement, via direct inspection
of its compiled code (zero cuDNN references, a full cuBLAS reference set,
`cudnn64_9.dll` absent from its import names). The original concern (#2845) —
whether a cross-minor cuDNN version gap (9.10 vs. 9.19) could affect
ctranslate2/Whisper transcription — does not apply: there is no gap in practice
for ctranslate2 specifically, because ctranslate2 never reads from a cuDNN
sublibrary at any version. The real-hardware `/transcribe` round trip (step 2)
also succeeded correctly on CUDA with no error and no silent CPU fallback,
consistent with this.

What the rest of the process does with cuDNN (onnxruntime, torch, or both) is
real activity but is outside ctranslate2's own code path and outside this
ticket's scope — `_add_nvidia_dll_dirs_to_path` exists for that activity, not
for ctranslate2, and is left untouched per the ticket's explicit instruction.

**Forward-looking caveat**: this conclusion is specific to ctranslate2 4.8.0's
current build. If a future version of ctranslate2 adds cuDNN-based GPU kernels,
this analysis would need re-checking at that time — the binary-inspection method
above is cheap to re-run.
