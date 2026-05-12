# Gemini cloud TTS

> Status: stable (opt-in, free-tier)
> Key files: `server/src/tts/index.ts` (Gemini provider), `server/src/routes/voice-sample.ts`
> URL surface: none
> OpenAPI ops: `POST /api/voices/:voiceId/sample`, `POST /api/books/:bookId/generation`

## What this covers

Opt-in cloud TTS path that uses the Gemini free-tier audio synthesis endpoint. Same client API as the local Coqui sidecar — only the routing changes based on the `modelKey` prefix. Useful when the user wants better prosody than Coqui or doesn't want to run a local sidecar.

## Invariants to preserve

- `GEMINI_API_KEY` env var is required for any `gemini-*` model key; absence surfaces as an error at sample request time, not at server startup (the server still boots fine without it for users running only local TTS).
- Optional env vars `GEMINI_TTS_MODEL_25` and `GEMINI_TTS_MODEL_31` override the upstream Gemini model id mapping for `gemini-2.5-flash` and `gemini-3.1-flash` respectively. Defaults are baked into the provider.
- Output is WAV-wrapped and cached identically to the local sidecar: `server/audio/voices/{voiceId}-{modelKey}.wav`. Cache key includes the model key so different Gemini models don't collide.
- Rate-limit / quota errors from the free tier surface as user-readable error messages in the sample request response, not silent failures.
- Provider selection is purely by `modelKey` prefix (see `13-tts-engine-picker.md` invariants). No global toggle.

## Acceptance walkthrough

Run server with `VITE_USE_MOCKS=false`, `GEMINI_API_KEY=<key>` in `server/.env`.

1. **Configure key, switch engine to Gemini, click Preview** → `POST /api/voices/<voiceId>/sample` with `modelKey: 'gemini-2.5-flash'`. Within a few seconds, audio plays. WAV cached on disk.
2. **Repeat with `gemini-3.1-flash`** → separate cache entry; first call uncached, second cached.
3. **Burst many requests** to hit the free-tier rate limit (e.g. 30 in a minute) → request surfaces an error like "Sample synthesis failed: Rate limit exceeded". Other model keys keep working.
4. **Unset `GEMINI_API_KEY`, restart server, request a Gemini sample** → error surfaces immediately with a useful message ("GEMINI_API_KEY required"). Switching back to `coqui-*` still works (sidecar permitting).
5. **Override env**: set `GEMINI_TTS_MODEL_31=models/gemini-3.1-flash-tts-preview-XX` → subsequent Gemini 3.1 requests use the overridden upstream id without code changes.
6. **Chapter generation with Gemini** — start a generation run with `modelKey: 'gemini-2.5-flash'`; chapters synthesise via Gemini and write WAVs to disk; rate-limit pauses surface as chapter-failed ticks with a retry-after hint where available.

## Out of scope

- Per-character Gemini voice selection — the server picks a voice based on `characterHint`; the algorithm lives in `server/src/routes/voice-sample.ts`.
- Streaming audio from Gemini — current implementation waits for the full utterance.
- Cost tracking — the free tier is free; no metering UI.
