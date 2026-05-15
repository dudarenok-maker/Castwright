# Profile drawer

> Status: stable
> Key files: `src/modals/profile-drawer.tsx` (incl. `ModelVoiceOverridePicker`), `src/store/cast-slice.ts` (`updateCharacter`), `src/store/voices-slice.ts` (`setOverride`, `hydrateBaseVoices`), `src/lib/tts-voice-mapping.ts` (`resolveTtsVoiceForCharacter`), `src/lib/api.ts` (`setVoiceOverride`), `src/store/ui-slice.ts` (`setOpenProfileId`), `server/src/routes/voices.ts` (`applyOverrideToCastFiles`)
> URL surface: `?profile=<characterId>` inside `#/books/:bookId/:view` and `#/books/:bookId/confirm`
> OpenAPI ops: `POST /api/voices/:voiceId/sample`, `PUT /api/voices/:voiceId/override`

## What this covers

Edit drawer for a single character. Lets the user adjust identity (name, role, gender, age range), tone (warmth, pace, authority, emotion sliders), description text, and evidence quotes. Triggers live recomputation of the mapped TTS voice and a per-character sample preview. The drawer is URL-addressable via `?profile=` so a deep link reopens it. Reachable from both the ready-stage Cast view and the confirm-stage "Meet the cast" cards so identity / gender / age can be corrected before generation starts.

## Invariants to preserve

- Opening the drawer dispatches `setOpenProfileId(characterId)`; the URL gains `?profile=<id>` (per `01-hash-router.md`).
- `setOpenProfileId` is accepted on the `ready` and `confirm` stages (where `openProfileId` lives on the stage variant). Dispatching from any other stage is a no-op.
- Tone fields are integers in `[0, 100]`. Gender enum: `'male' | 'female' | 'neutral'`. Age range: `'child' | 'teen' | 'adult' | 'elderly'`.
- Evidence list shows the first **3** quotes by default; "Show more evidence" toggle reveals any quotes beyond 3. Each quote: `{ quote: string; note?: string }`. The array is **sorted longest-first server-side** by `sortEvidence` in `server/src/routes/analysis.ts` so the first quote is both the prominent UI excerpt and the voice-cloning sample source. The drawer does NOT re-sort — it trusts the persisted order.
- Evidence drives the voice sample: `server/src/routes/voice-sample.ts` `buildSampleText` consumes the longest quote (typically index 0) for the ~12-second cloning preview. The analyzer skill (`skills/audiobook-character-analysis.md`) asks for ≥3 quotes per character with one ~180–280 char excerpt, so the longest is intentionally substantial. Short rosters fall back to a `<Name> said: …` pad; empty evidence falls back to the generic "Hello. I'm …" script.
- `resolveTtsVoiceForCharacter` recomputes the mapped TTS voice live as the user edits gender/age. The mapping logic lives only in `src/lib/tts-voice-mapping.ts` and its server twin in `server/src/routes/voice-sample.ts` — keep them in sync.
- Preview / sample requests POST `/api/voices/<voiceId>/sample` with `{ modelKey, voice, text?, characterHint }` (`src/lib/api.ts:92-108, 518-530`). `characterHint` includes `description`, `role`, `gender`, `ageRange`, `evidence[]`, `tone`.
- `VoiceSample` response shape: `{ url, durationSec, cached, modelKey }`. UI plays the URL via `<audio>` and shows the cached badge if `cached: true`.
- **JIT TTS auto-load on Play** (`src/lib/play-sample-with-auto-load.ts`) — the Play button funnels through `playSampleWithAutoLoad`, NOT a direct `api.getVoiceSample` call. The helper probes `/api/sidecar/health`, evicts the analyzer (via `api.unloadAnalyzer` — and only when `/api/ollama/health` reports `modelResident: true`), loads the sidecar (`api.loadSidecar`), then synthesizes. Mirrors `generation.tsx` `handleLoadTts` so the "model lifecycle is button-driven, not eager" rule (CLAUDE.md) is preserved — the user's Play click is the load consent. Status sequence emitted via `onStatus`: `evicting` → `loading-tts` → `synthesizing`. Concurrent clicks share a single in-flight prep promise so a Drawer + Cast row click doesn't double-evict. An inline eviction banner ("Analyzer unloaded to free VRAM for TTS.") surfaces only when the analyzer was actually resident. The same helper backs `src/views/cast.tsx` per-row Play. Tested by `src/lib/play-sample-with-auto-load.test.ts`.
- The drawer never directly mutates `cast.characters`; it dispatches `castActions.updateCharacter({ id, patch })` so the change is funneled through one reducer (Immer-friendly).
- **Model-voice override picker** (`ModelVoiceOverridePicker`, `src/modals/profile-drawer.tsx:699-766`; rendered at `:319-347`) — sits beneath the Preview voice block and lets the user pin a specific base voice for this character, bypassing the attribute-driven match.
  - The `<select>` round-trips through string values: `AUTO` or `${engine}|${name}`. Selected value is derived from `voice.overrideTtsVoice` — when null, the dropdown shows "Auto — currently Coqui · &lt;Name&gt;" (or whatever engine the auto resolution picked).
  - Options group by engine via `<optgroup>` and are sourced from `state.voices.baseVoices`, hydrated by `api.getBaseVoices()` on Voices-view mount (see plan 22). The drawer is read-only on that hydrate — it does not trigger the fetch itself; until the catalog loads the picker is disabled and shows "Loading base voice catalog…".
  - `onChange` is optimistic and uses **deferred rollback**: dispatch `voicesActions.setOverride({ voiceId, override })` first (slice mutation no-ops when no library Voice exists yet for this character), then `await api.setVoiceOverride(voiceId, override)`; on failure, restore the previous override value from the closed-over `voice.overrideTtsVoice` and surface the error inline (`src/modals/profile-drawer.tsx:328-346`).
  - **Engine-mismatch warning** — when `currentOverride.engine !== activeEngine` (project's current synth engine, derived from `ui.ttsModelKey`), the picker renders: "⚠ Engine mismatch — this &lt;Engine&gt; voice won't be used while the project is on &lt;Engine&gt;." The override is still written and persists; `pickVoiceForEngine` (`server/src/tts/voice-mapping.ts`) ignores it at synth time until the engines match.
  - **Server propagation** — `PUT /api/voices/:voiceId/override` walks every confirmed-cast `cast.json` and writes (or `delete`s, for `override: null`) the `overrideTtsVoice` field on every character whose `voiceId` matches (`server/src/routes/voices.ts:295-331`, `applyOverrideToCastFiles`). The same character recurring across a series stays in sync; one PUT updates them all atomically and 404s if no character matches.
- **Merge / downgrade controls** — the Cast roster section renders two cohabiting affordances when `onMerge` is wired:
  - A picker (`Merge <name> into another character…`) for folding one identity into another real character. Hidden when `mergeCandidates` is empty.
  - Two direct buttons ("Unknown male" / "Unknown female") for downgrading the current character into a standing background bucket. Available even when the cast has no other candidates because `POST /api/books/:bookId/cast/merge` synthesises the bucket on the fly using `makeBucket()` from `server/src/analyzer/fold-minor-cast.ts` when the target id (`unknown-male` / `unknown-female`) isn't on `cast.json` yet.
  - Downgrade buttons are hidden for the buckets themselves (`unknown-male`/`unknown-female`) and for the narrator (`narrator`). Picker and buttons share `mergeBusy` / `mergeError` so two folds can't fire concurrently. On success the layout dispatches `castActions.applyMerge` with the server's recomputed roster and closes the drawer.

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
9. **Override the model voice via the picker**:
   - Open the drawer. The picker shows "Auto — currently &lt;Engine · Name&gt;" matching the current resolution.
   - Pick a different speaker (e.g. flip the auto match → Coqui · Asya Anara). Network: `PUT /api/voices/<voiceId>/override` with `{ override: { engine: 'coqui', name: 'Asya Anara' } }`; response 204. The mapped-voice line above and the cast card's swatch update immediately (optimistic).
   - Reload the page → override persists; the picker re-opens to the same selected value (read back through the library Voice's `overrideTtsVoice`).
   - **Cross-book propagation**: open a different book that contains a character with the same `voiceId` (e.g. a series recurrence) → that character's profile drawer shows the same override pre-selected (server's `applyOverrideToCastFiles` updated both `cast.json` files).
   - **Engine mismatch**: switch the project engine via the engine picker (plan 13) so it no longer matches the override's engine. Re-open the drawer → the warning line "⚠ Engine mismatch…" appears. Click Preview voice → the synth uses the project-engine auto resolution, not the cross-engine override.
   - Select "Auto" to clear. Network: `PUT /api/voices/<voiceId>/override` with `{ override: null }`. The picker returns to "Auto — currently &lt;Engine · Name&gt;"; server-side the field is `delete`d from each cast.json entry (not stored as null).
10. **Downgrade a descriptor-named speaker** (real backend only — mock returns an empty cast):
   - From the "Meet the cast" confirmation view, click a card like *Rescuer* (≥3 lines so the auto-fold left it alone).
   - In the drawer, scroll to **Cast roster** → click **Unknown male** or **Unknown female**.
   - Network: `POST /api/books/:bookId/cast/merge` with `{ sourceId, targetId: 'unknown-male' | 'unknown-female' }`. Response is the recomputed roster; the source disappears and the bucket gains the source's name in its `aliases` list.
   - Drawer closes; URL drops `?profile=`. The roster card for the bucket now reflects the merged line/scene count.
   - Re-open the bucket's profile → the downgrade buttons are HIDDEN for it (a bucket can't be downgraded into itself).
11. **Close drawer** → `setOpenProfileId(null)`; URL drops `?profile=`.

## Out of scope

- Voice library browsing while the drawer is open (separate view).
- Cross-character bulk edits — covered by `11-batch-character-regenerate.md`.
- Audio waveform of the preview — `<audio>` element only in v1.
