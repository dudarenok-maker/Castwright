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

## Acceptance walkthrough

Run server with `VITE_USE_MOCKS=false`. Start the sidecar separately (`npm run tts:sidecar` per `CLAUDE.md`).

1. **Sidecar up, first preview** — open profile drawer, click Preview. Within ~2–5 s, audio plays. WAV appears under `server/audio/voices/`. Response: `cached: false`.
2. **Sidecar up, second identical preview** — `cached: true` instantly; no sidecar round-trip.
3. **Switch `modelKey` to `gemini-3.1-flash` and back** — first request for each model key is uncached; switching back to `coqui-xtts-v2` returns cached again.
4. **Sidecar down** — kill the sidecar process. Click Preview. Request fails with a useful error ("Sample synthesis failed: …" surfaced from `src/lib/api.ts:524-529`). UI shows the error; user can restart the sidecar and retry.
5. **Sidecar mid-flight crash during chapter generation** — kill the sidecar mid-stream. The generation SSE stream surfaces `chapter_failed` ticks with `errorReason` carrying the upstream message. Already-completed chapters keep their WAVs.
6. **Disk full** — fill the audio cache disk. Request fails at the cache-write step; the SSE stream surfaces the I/O error.

## KNOWN: scaffolded behavior

- No auto-start of the sidecar; user must run it manually before analysis.
- No health-check endpoint; the only way to know the sidecar is up is to issue a request and see if it succeeds.
- No automatic retry; transient failures (e.g. sidecar restart mid-flight) require manual user action (click Retry).
- Document the failure paths explicitly; do not assert "audio always plays."

## Out of scope

- Sidecar-internal model swapping (Coqui vs Piper vs Kokoro) — each gets its own model key prefix and provider.
- GPU vs CPU performance — the sidecar uses whatever it's configured with; the server doesn't care.
- Streaming PCM — the sidecar returns a whole utterance per call.
