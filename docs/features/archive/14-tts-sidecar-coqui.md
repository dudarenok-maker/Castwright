---
status: stable
shipped: 2026-05-18
owner: null
---

# Coqui XTTS sidecar

> Status: KNOWN: operational dependency
> Key files: `server/src/tts/sidecar.ts`, `server/src/tts/index.ts`, `server/src/tts/retry.ts`, `server/src/tts/text-normalize.ts`, `server/src/tts/synthesise-chapter.ts`, `server/tts-sidecar/`
> URL surface: none
> OpenAPI ops: `POST /api/voices/:voiceId/sample`, `POST /api/books/:bookId/generation`

## What this covers

Default local TTS provider. A separate process (Python-based Coqui XTTS v2 server) listens at `LOCAL_TTS_URL` and accepts text + voice id, returning raw 16-bit PCM. The Node analysis backend encodes the PCM to MP3 (LAME VBR V2 via system ffmpeg), caches the result under `server/audio/voices/{voiceId}-{modelKey}-<paramHash>.mp3`, and serves it back to the client. This keeps inference free and offline.

## Invariants to preserve

- `LOCAL_TTS_URL` env var; default `http://localhost:6006` when unset. Configurable in `server/.env`.
- Sidecar request shape: `{ model: 'xtts_v2', voice, text, lang }` (see `server/src/tts/sidecar.ts`). Response is raw PCM bytes; sample rate and bit depth fixed.
- MP3 encoding is server-side; the client receives a `.mp3` URL it can play through a stock `<audio>` element.
- Cache key: `voiceId + modelKey`. Re-requesting the same combination returns the cached file with `cached: true` in the `VoiceSample` response (`src/lib/api.ts:276-281, 518-530`).
- `VoiceSample` shape: `{ url, durationSec, cached, modelKey }` — `durationSec` is computed from PCM byte count, not from the upstream response.
- Sidecar abstraction lives in `server/src/tts/sidecar.ts`. Adding a Piper or Kokoro sidecar means adding a new provider class in `server/src/tts/index.ts` that targets a different endpoint; the client interface (`POST /api/voices/.../sample` with `modelKey`) does not change.
- **`/synthesize` MUST offload to `asyncio.to_thread`** (`server/tts-sidecar/main.py`). XTTS inference is CPU-bound Python and blocks the event loop if run inline — `/health` then can't respond, and the Node-side proxy timeout flips the UI pill to "Sidecar unreachable" the moment generation starts even though the sidecar is healthy. Pinned by `tests/test_smoke.py::test_health_responsive_during_busy_synth`.
- **Coqui preloads at process startup** (`@app.on_event("startup")`) so the first user `/synthesize` doesn't pay the 30–60s model-load cost on top of the synth. Opt out with `PRELOAD_COQUI=0`. Without preload, the first generate looks like a 120s hang on the Generate screen (stall banner fires at 30s).
- **Device, fp16, and DeepSpeed are env-driven at first load** (`CoquiEngine._resolve_runtime_options` in `server/tts-sidecar/main.py`). `COQUI_DEVICE` (default `auto`) picks `cuda` vs `cpu`; `COQUI_HALF` and `COQUI_DEEPSPEED` default ON when device resolves to `cuda` and are **forced off on cpu** (fp16 ops crash on CPU torch; deepspeed-inference is CUDA-only). The chosen config is logged on the startup line (`Loading Coqui model=… on device=… half=… deepspeed=…`) so the user can confirm GPU mode from `logs/tts.log`. Pinned by `tests/test_smoke.py::test_resolve_runtime_options_*`.
- **Group text is scrubbed by `normaliseForTts` before each provider call** (`server/src/tts/synthesise-chapter.ts`, helper at `server/src/tts/text-normalize.ts`). Two transforms, both idempotent: title-case any run of ≥3 capital letters (apostrophes count), and replace em/en-dashes with `, `. Without this, XTTS spells multi-word all-caps openers letter-by-letter (chapter 1 "ONE" → ~1.15s of "oh-en-ee") and loops on em-dashes — together they produced ~60s of garbled audio at the top of chapter 2 of the canonical Keeper manuscript on the first generation pass. Pinned by `text-normalize.test.ts` (unit) and `synthesise-chapter.test.ts` "scrubs all-caps openers and em-dashes…" (end-to-end). 2-letter caps like `MR`/`OK` are deliberately untouched so valid abbreviations stay intact.

## Acceptance walkthrough

Run server with `VITE_USE_MOCKS=false`. Sidecar autostart since plan
[43](43-auto-start-sidecar.md) means the Node server spawns the sidecar
on `app.listen` when `autoStartSidecar` is enabled (default true) — no
second terminal needed. To run it manually instead, toggle the preference
off in `#/account` and `npm run tts:sidecar` in a second terminal.

1. **Sidecar up, first preview** — open profile drawer, click Preview. Within ~2–5 s, audio plays. MP3 appears under `server/audio/voices/`. Response: `cached: false`.
2. **Sidecar up, second identical preview** — `cached: true` instantly; no sidecar round-trip.
3. **Switch `modelKey` to `gemini-3.1-flash` and back** — first request for each model key is uncached; switching back to `coqui-xtts-v2` returns cached again.
4. **Sidecar down** — kill the sidecar process. Click Preview. Request fails with a useful error ("Sample synthesis failed: …" surfaced from `src/lib/api.ts:524-529`). UI shows the error; user can restart the sidecar and retry.
5. **Sidecar mid-flight crash during chapter generation** — kill the sidecar mid-stream. The generation SSE stream surfaces `chapter_failed` ticks with `errorReason` carrying the upstream message. Already-completed chapters keep their MP3s.
6. **Disk full** — fill the audio cache disk. Request fails at the cache-write step; the SSE stream surfaces the I/O error.
7. **Health stays green during synth** — start a long chapter (the Coalfall Commission Ch 1, 10+ lines on the narrator). The Generate-screen sidecar pill stays green throughout the synth call. If it flips to red the moment generation starts, `/synthesize` is blocking the event loop — check it still uses `asyncio.to_thread`. Pytest pin: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest`.
8. **First synth is fast** — after a clean `npm run tts:sidecar`, the first chapter's first group lands a synth response within seconds, not minutes. The preload at startup is what makes this true.
9. **GPU mode is live (NVIDIA boxes only)** — after the README's "GPU install" + `COQUI_DEVICE=cuda` / `COQUI_HALF=1` / `COQUI_DEEPSPEED=1` in `server/.env`, restart the sidecar. The first startup log line shows `device=cuda half=True deepspeed=True`, followed by `DeepSpeed inference enabled.` and `Model cast to fp16.`. While a chapter synth is in flight, `nvidia-smi` shows the venv's `python.exe` holding ~2–3 GB VRAM with >50% GPU-Util, and `logs/tts.err.log` reports `Real-time factor: 0.1–0.3` per group (down from 2.5–3.7 on CPU). A 30-minute chapter drops from ~90 min wall time to ~5 min.

## Failure paths

Every sidecar synth call passes through the bounded-retry wrapper
`withTtsRetry` (`server/src/tts/retry.ts`). Classification happens at the
sidecar boundary in `SidecarTtsProvider.synthesize` — each thrown error
carries a `transient: boolean` flag (and supplementary `status` /
`cause` / `poisoned` fields) that the retry helper reads to decide
whether to back off and retry, or surface immediately.

Default retry schedule: 1 primary attempt + 2 retries, backoffs at 500 ms
and 2 s. Caller-driven `AbortSignal` short-circuits both the sleep and
any pending retry. Persistent failures re-throw the LAST transient error
so the SSE `chapter_failed` tick carries the actual upstream message,
not a meta "retries exhausted" wrapper.

| Failure mode                            | Annotated as                              | Retry?  | User-visible behaviour                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED` / `ETIMEDOUT` / DNS fail | `transient: true, cause: 'network'`       | Yes (×2) | "Local TTS sidecar not reachable at \<url\>. Start it with `npm run tts:sidecar`." Brief blips (sidecar restarting, network flapping) absorbed transparently; persistent down → all 3 attempts fail → message surfaces in `chapter_failed`. |
| HTTP 503 with `{ poisoned: true }` body | `transient: false, status: 503, poisoned: true` | **No** | Surfaces immediately. The CUDA context is corrupted process-wide; only a sidecar restart clears it (see `server/tts-sidecar/main.py` `_schedule_poison_exit`). UI renders "needs restart" framing.                          |
| HTTP 503 (model loading, transient)     | `transient: true, status: 503`            | Yes (×2) | Most common at the very first synth call after sidecar boot — the model-load takes 30-60 s, the proxy gives up earlier. Backoff usually catches it on attempt 2. |
| HTTP 502 (reverse proxy mid-restart)    | `transient: true, status: 502`            | Yes (×2) | Same retry shape as 503. |
| HTTP 504 (gateway timeout)              | `transient: true, status: 504`            | Yes (×2) | Same retry shape as 503. |
| HTTP 408 (request timeout)              | `transient: true, status: 408`            | Yes (×2) | Treated like 5xx — the request didn't reach the model or the response stalled; safe to retry. |
| HTTP 4xx (any other 400/401/403/404/…)  | `transient: false, status: 4xx`           | **No** | Client-side; the request shape itself is wrong. Surfaces immediately; the UI shows the upstream status text. |
| Empty 200 response (no audio bytes)     | Plain `Error`, no `transient` flag        | **No** | "Local TTS sidecar returned an empty audio body." Surfaces immediately — silent retry would just replay the same shape. |
| AbortError (caller-driven stop)         | `name: 'AbortError'` (no `transient` flag)| **No** | Passed through unchanged so the queue tears down cleanly. The retry helper's signal check also tears down any pending sleep mid-backoff. |
| Disk full at cache-write step           | I/O error from fs.writeFile (downstream)  | n/a | Not a sidecar-side failure — the synth succeeded but the chapter cache write didn't. SSE stream surfaces the I/O error on `chapter_failed`. |

Classification is pinned by `server/src/tts/sidecar.test.ts`; the
wrapper itself is pinned by `server/src/tts/retry.test.ts`; the
end-to-end shape (two 503s then a 200 → one successful chapter group)
is pinned by `synthesise-chapter.test.ts`'s
"does NOT retry a poisoned-CUDA 503" / "retries on transient throw"
cases.

## Out of scope

- Sidecar-internal model swapping (Coqui vs Piper vs Kokoro) — each gets its own model key prefix and provider.
- GPU vs CPU performance tuning beyond the documented env knobs — the sidecar's `COQUI_DEVICE` / `COQUI_HALF` / `COQUI_DEEPSPEED` cover the common path; bespoke kernel tuning is out of scope. The Node side reads no device info.
- Streaming PCM — the sidecar returns a whole utterance per call. Tracked as `[BACKLOG Could #25]`.

## Ship notes

- **Shipped:** 2026-05-18.
- **What closed the scaffolding:** the three KNOWN-scaffolded items at landing-time are all addressed —
  - Auto-start of the sidecar shipped earlier as plan [43 — Auto-start TTS sidecar](43-auto-start-sidecar.md); the per-user `autoStartSidecar` preference (default ON) means `start-app.bat` brings up TTS in one shot.
  - Automatic retry shipped via the provider-agnostic `withTtsRetry` helper in `server/src/tts/retry.ts` wired into `synthesise-chapter.ts:241` — pinned by `retry.test.ts` (10 cases) and end-to-end retry behaviour by `synthesise-chapter.test.ts`.
  - Failure-path documentation is the **Failure paths** table above; the boundary classification is now pinned by the new `server/src/tts/sidecar.test.ts` (10 cases) so a future refactor that flips a transient↔non-transient mapping fails fast at the boundary instead of in chapter orchestration.
- **What remains intentionally out of scope:** streaming PCM (the sidecar still returns a whole utterance per call; streaming is `[BACKLOG Could #25]`).
