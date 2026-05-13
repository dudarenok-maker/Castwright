# Coqui XTTS sidecar

> Status: KNOWN: operational dependency
> Key files: `server/src/tts/sidecar.ts`, `server/src/tts/index.ts`, `server/tts-sidecar/`
> URL surface: none
> OpenAPI ops: `POST /api/voices/:voiceId/sample`, `POST /api/books/:bookId/generation`

## What this covers

Default local TTS provider. A separate process (Python-based Coqui XTTS v2 server) listens at `LOCAL_TTS_URL` and accepts text + voice id, returning raw 16-bit PCM. The Node analysis backend wraps the PCM in a WAV header, caches the result under `server/audio/voices/{voiceId}-{modelKey}.wav`, and serves it back to the client. This keeps inference free and offline.

## Invariants to preserve

- `LOCAL_TTS_URL` env var; default `http://localhost:6006` when unset. Configurable in `server/.env`.
- Sidecar request shape: `{ model: 'xtts_v2', voice, text, lang }` (see `server/src/tts/sidecar.ts`). Response is raw PCM bytes; sample rate and bit depth fixed.
- WAV wrapping is server-side; the client receives a `.wav` URL it can play through a stock `<audio>` element.
- Cache key: `voiceId + modelKey`. Re-requesting the same combination returns the cached file with `cached: true` in the `VoiceSample` response (`src/lib/api.ts:276-281, 518-530`).
- `VoiceSample` shape: `{ url, durationSec, cached, modelKey }` — `durationSec` is computed from PCM byte count, not from the upstream response.
- Sidecar abstraction lives in `server/src/tts/sidecar.ts`. Adding a Piper or Kokoro sidecar means adding a new provider class in `server/src/tts/index.ts` that targets a different endpoint; the client interface (`POST /api/voices/.../sample` with `modelKey`) does not change.
- **`/synthesize` MUST offload to `asyncio.to_thread`** (`server/tts-sidecar/main.py`). XTTS inference is CPU-bound Python and blocks the event loop if run inline — `/health` then can't respond, and the Node-side proxy timeout flips the UI pill to "Sidecar unreachable" the moment generation starts even though the sidecar is healthy. Pinned by `tests/test_smoke.py::test_health_responsive_during_busy_synth`.
- **Coqui preloads at process startup** (`@app.on_event("startup")`) so the first user `/synthesize` doesn't pay the 30–60s model-load cost on top of the synth. Opt out with `PRELOAD_COQUI=0`. Without preload, the first generate looks like a 120s hang on the Generate screen (stall banner fires at 30s).
- **Device, fp16, and DeepSpeed are env-driven at first load** (`CoquiEngine._resolve_runtime_options` in `server/tts-sidecar/main.py`). `COQUI_DEVICE` (default `auto`) picks `cuda` vs `cpu`; `COQUI_HALF` and `COQUI_DEEPSPEED` default ON when device resolves to `cuda` and are **forced off on cpu** (fp16 ops crash on CPU torch; deepspeed-inference is CUDA-only). The chosen config is logged on the startup line (`Loading Coqui model=… on device=… half=… deepspeed=…`) so the user can confirm GPU mode from `logs/tts.log`. Pinned by `tests/test_smoke.py::test_resolve_runtime_options_*`.

## Acceptance walkthrough

Run server with `VITE_USE_MOCKS=false`. Start the sidecar separately (`npm run tts:sidecar` per `CLAUDE.md`).

1. **Sidecar up, first preview** — open profile drawer, click Preview. Within ~2–5 s, audio plays. WAV appears under `server/audio/voices/`. Response: `cached: false`.
2. **Sidecar up, second identical preview** — `cached: true` instantly; no sidecar round-trip.
3. **Switch `modelKey` to `gemini-3.1-flash` and back** — first request for each model key is uncached; switching back to `coqui-xtts-v2` returns cached again.
4. **Sidecar down** — kill the sidecar process. Click Preview. Request fails with a useful error ("Sample synthesis failed: …" surfaced from `src/lib/api.ts:524-529`). UI shows the error; user can restart the sidecar and retry.
5. **Sidecar mid-flight crash during chapter generation** — kill the sidecar mid-stream. The generation SSE stream surfaces `chapter_failed` ticks with `errorReason` carrying the upstream message. Already-completed chapters keep their WAVs.
6. **Disk full** — fill the audio cache disk. Request fails at the cache-write step; the SSE stream surfaces the I/O error.
7. **Health stays green during synth** — start a long chapter (the Coalfall Commission Ch 1, 10+ lines on the narrator). The Generate-screen sidecar pill stays green throughout the synth call. If it flips to red the moment generation starts, `/synthesize` is blocking the event loop — check it still uses `asyncio.to_thread`. Pytest pin: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest`.
8. **First synth is fast** — after a clean `npm run tts:sidecar`, the first chapter's first group lands a synth response within seconds, not minutes. The preload at startup is what makes this true.
9. **GPU mode is live (NVIDIA boxes only)** — after the README's "GPU install" + `COQUI_DEVICE=cuda` / `COQUI_HALF=1` / `COQUI_DEEPSPEED=1` in `server/.env`, restart the sidecar. The first startup log line shows `device=cuda half=True deepspeed=True`, followed by `DeepSpeed inference enabled.` and `Model cast to fp16.`. While a chapter synth is in flight, `nvidia-smi` shows the venv's `python.exe` holding ~2–3 GB VRAM with >50% GPU-Util, and `logs/tts.err.log` reports `Real-time factor: 0.1–0.3` per group (down from 2.5–3.7 on CPU). A 30-minute chapter drops from ~90 min wall time to ~5 min.

## KNOWN: scaffolded behavior

- No auto-start of the sidecar; user must run it manually before analysis.
- Health-check endpoint exists at `GET /health` and is proxied as `GET /api/sidecar/health`. The Generate screen polls it for the status pill.
- No automatic retry; transient failures (e.g. sidecar restart mid-flight) require manual user action (click Retry).
- Document the failure paths explicitly; do not assert "audio always plays."

## Out of scope

- Sidecar-internal model swapping (Coqui vs Piper vs Kokoro) — each gets its own model key prefix and provider.
- GPU vs CPU performance tuning beyond the documented env knobs — the sidecar's `COQUI_DEVICE` / `COQUI_HALF` / `COQUI_DEEPSPEED` cover the common path; bespoke kernel tuning is out of scope. The Node side reads no device info.
- Streaming PCM — the sidecar returns a whole utterance per call.
