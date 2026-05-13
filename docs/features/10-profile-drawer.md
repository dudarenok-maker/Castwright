# Profile drawer

> Status: stable
> Key files: `src/modals/profile-drawer.tsx`, `src/store/cast-slice.ts` (`updateCharacter`), `src/lib/tts-voice-mapping.ts` (`resolveTtsVoiceForCharacter`), `src/store/ui-slice.ts` (`setOpenProfileId`)
> URL surface: `?profile=<characterId>` inside `#/books/:bookId/:view`
> OpenAPI ops: `POST /api/voices/:voiceId/sample`

## What this covers

Edit drawer for a single character. Lets the user adjust identity (name, role, gender, age range), tone (warmth, pace, authority, emotion sliders), description text, and evidence quotes. Triggers live recomputation of the mapped TTS voice and a per-character sample preview. The drawer is URL-addressable via `?profile=` so a deep link reopens it.

## Invariants to preserve

- Opening the drawer dispatches `setOpenProfileId(characterId)`; the URL gains `?profile=<id>` (per `01-hash-router.md`).
- `setOpenProfileId` is guarded to `ready` stage only (`src/store/ui-slice.ts:99-102`). Dispatching from any other stage is a no-op.
- Tone fields are integers in `[0, 100]`. Gender enum: `'male' | 'female' | 'neutral'`. Age range: `'child' | 'teen' | 'adult' | 'elderly'`.
- Evidence list shows the first **3** quotes by default; "Show more evidence" toggle reveals any quotes beyond 3. Each quote: `{ quote: string; note?: string }`. The array is **sorted longest-first server-side** by `sortEvidence` in `server/src/routes/analysis.ts` so the first quote is both the prominent UI excerpt and the voice-cloning sample source. The drawer does NOT re-sort — it trusts the persisted order.
- Evidence drives the voice sample: `server/src/routes/voice-sample.ts` `buildSampleText` consumes the longest quote (typically index 0) for the ~12-second cloning preview. The analyzer skill (`skills/audiobook-character-analysis.md`) asks for ≥3 quotes per character with one ~180–280 char excerpt, so the longest is intentionally substantial. Short rosters fall back to a `<Name> said: …` pad; empty evidence falls back to the generic "Hello. I'm …" script.
- `resolveTtsVoiceForCharacter` recomputes the mapped TTS voice live as the user edits gender/age. The mapping logic lives only in `src/lib/tts-voice-mapping.ts` and its server twin in `server/src/routes/voice-sample.ts` — keep them in sync.
- Preview / sample requests POST `/api/voices/<voiceId>/sample` with `{ modelKey, voice, text?, characterHint }` (`src/lib/api.ts:92-108, 518-530`). `characterHint` includes `description`, `role`, `gender`, `ageRange`, `evidence[]`, `tone`.
- `VoiceSample` response shape: `{ url, durationSec, cached, modelKey }`. UI plays the URL via `<audio>` and shows the cached badge if `cached: true`.
- The drawer never directly mutates `cast.characters`; it dispatches `castActions.updateCharacter({ id, patch })` so the change is funneled through one reducer (Immer-friendly).

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a book's cast view.

1. **Click a character card** → drawer slides in; URL becomes `#/books/<id>/cast?profile=<characterId>`.
2. **Reload the page** → drawer reopens automatically from the URL on hydration.
3. **Edit name** → cast slice updates; the character card's title updates in the background.
4. **Drag warmth slider** to 80 → `tone.warmth = 80` in slice; the sample-preview button stays enabled.
5. **Verify evidence order**: the first 3 quotes are visible by default, longest first. When the character has ≥4 quotes, **toggle "Show more evidence"** to reveal the rest; toggling off collapses back to the first 3. State persists for the session (not URL-encoded).
   - Spot-check: the topmost quote is the longest in the array (server enforces this via `sortEvidence`).
6. **Click "Preview voice"** → POST `/api/voices/<voiceId>/sample` fires with the current `characterHint`. Response plays inline; second click within minutes returns `cached: true` and shows a "cached" badge.
7. **Switch TTS model in the engine picker** (see `13-tts-engine-picker.md`) → next preview includes the new `modelKey` and bypasses cache for that key.
8. **Edit gender from `'male'` to `'female'`** → `resolveTtsVoiceForCharacter` recomputes; the displayed mapped voice name updates. Preview fetches a new sample for the new voice.
9. **Close drawer** → `setOpenProfileId(null)`; URL drops `?profile=`.

## Out of scope

- Voice library browsing while the drawer is open (separate view).
- Cross-character bulk edits — covered by `11-batch-character-regenerate.md`.
- Audio waveform of the preview — `<audio>` element only in v1.
