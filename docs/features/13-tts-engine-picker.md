# TTS engine picker

> Status: stable
> Key files: `src/lib/tts-models.ts`, `src/store/ui-slice.ts` (`setTtsModelKey`)
> URL surface: none (state lives in `ui.ttsModelKey`)
> OpenAPI ops: indirect — every sample/generation request carries `modelKey`

## What this covers

Two-tier engine + model selector. The user picks an engine (Local or Gemini), then a model within that engine; the selection persists in `ui.ttsModelKey` and is forwarded to every voice-sample preview and chapter-generation request. The engine prefix in the `modelKey` (e.g. `coqui-`, `gemini-`) tells the server which provider to route to.

## Invariants to preserve

- `TTS_ENGINES` list in `src/lib/tts-models.ts:26-44` is exactly two groups, in this order:
  - `'local'` — label `'Local (free)'`, models: `[{ id: 'coqui-xtts-v2', label: 'Coqui XTTS v2', hint: 'Default · 30 baked voices' }]`.
  - `'gemini'` — label `'Gemini (cloud)'`, models: `[{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash TTS' }, { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash TTS', hint: 'Preview' }]`.
- `DEFAULT_TTS_MODEL = 'coqui-xtts-v2'` (`tts-models.ts:51`). Local-first is intentional (see project memory `feedback_local_zero_cost`).
- `engineForModelKey` prefix routing: `coqui-` → `'coqui'`, `piper-` → `'piper'`, `kokoro-` → `'kokoro'`, else `'gemini'` (`tts-models.ts:56-61`). Mirror exists server-side in `server/src/tts/index.ts` — keep in sync.
- `engineGroupForModelKey` returns `'local'` for any non-Gemini engine, `'gemini'` otherwise (`tts-models.ts:66-68`). Used by the picker to pre-select the engine dropdown when hydrating from a saved `modelKey`.
- Switching engine in the UI resets the model to the engine group's first option. Switching model within the same group does not change the engine selection.
- The picker writes only through `setTtsModelKey`; no other reducer mutates `ttsModelKey`.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true` for the UI parts; `VITE_USE_MOCKS=false` with TTS sidecar + Gemini key for the end-to-end parts.

1. **Cold boot** → `ui.ttsModelKey === 'coqui-xtts-v2'`; engine dropdown shows "Local (free)"; model dropdown shows "Coqui XTTS v2".
2. **Switch engine to Gemini** → engine dropdown shows "Gemini (cloud)"; model dropdown shows "Gemini 2.5 Flash TTS" by default (first option in the group). `ui.ttsModelKey === 'gemini-2.5-flash'`.
3. **Switch model to Gemini 3.1 Flash TTS** → `ui.ttsModelKey === 'gemini-3.1-flash'`; engine dropdown stays on "Gemini (cloud)".
4. **Open the profile drawer and click Preview** (see `10-profile-drawer.md`) → request body includes `modelKey: 'gemini-3.1-flash'`; sample plays.
5. **Switch back to Local** → engine resets to "Local (free)"; model resets to "Coqui XTTS v2" (the only local model). `ui.ttsModelKey === 'coqui-xtts-v2'`.
6. **Hydration from a saved modelKey** — set `ui.ttsModelKey = 'gemini-3.1-flash'` via DevTools, reload the relevant view → engine pre-selects "Gemini (cloud)" and model pre-selects "3.1 Flash TTS" (via `engineGroupForModelKey`).
7. **Add a new local model** (hypothetical: `piper-en-us-medium`) → with no source code changes beyond appending to `TTS_ENGINES.models`, the picker should show it under Local. Confirm the routing function returns `'piper'`.

## Out of scope

- Per-character TTS model overrides — v1 uses one model per book.
- Auto-fallback when an engine is unreachable — surfaces an error per `14-tts-sidecar-coqui.md`.
- A/B comparison UI for the same line across models.
