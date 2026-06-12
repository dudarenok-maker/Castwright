---
status: stable
shipped: 2026-05-28
owner: null
---

# Reused-voice drawer parity + Reused/lifecycle status split

> Status: stable (frontend-only fix; extends archived plans 117 + 10 + 108)
> Key files: `src/lib/voice-status.ts`, `src/views/cast.tsx`, `src/modals/profile-drawer.tsx`, `src/components/voice-engine-picker.tsx`, `src/components/primitives.tsx`
> URL surface: `#/books/<id>/cast` (cast table Status column + profile drawer)
> OpenAPI ops: none (pure presentation — no contract change)

## Benefit / Rationale

A character whose voice was **reused/matched from a prior book in the series**
carries its bespoke Qwen voice on the matched library `Voice`
(`voice.ttsVoice = { provider: 'qwen', name: 'qwen-…' }`), NOT on its own
`Character.ttsEngine` / `overrideTtsVoices` — the reuse reducers
(`applyVoiceMatches` / `applyManualMatch` in `cast-slice.ts`) only write
`voiceId` + `matchedFrom` + `voiceState: 'reused'`. The cast row resolved this
correctly (via `resolveDisplayTtsVoice`, which trusts `voice.ttsVoice` when the
character isn't Qwen-pinned), but the **profile drawer** re-derived the voice
from the *project* engine + the character's *empty* Qwen override → it showed
"Qwen · No voice designed yet", disabled the Play button, and rendered a
hardcoded "Default (Kokoro)" engine label even on a Qwen project.

- **User:** opening the drawer on a reused Qwen character now shows the actual
  reused voice (`Qwen · qwen-narrator-… · Designed voice`), an enabled 12 s
  sample, and a truthful "Default (<project engine>)" label — matching the cast
  row. The Status now shows the lifecycle (Designed/Generated/Tuned/Locked)
  **and** a small "Reused" badge together, instead of "Reused" hiding the
  lifecycle. The preset (Coqui/Kokoro/Gemini) Model-voice picker no longer
  renders for a character that effectively synthesises via Qwen, so the drawer
  stops showing preset speaker tabs under an "Active engine: Qwen" header.
- **Technical:** one shared resolver (`resolveVoiceStatus`) backs both the cast
  Status column and the drawer header, so they can't drift again.
- **Architectural:** provenance ("reused from a prior book", keyed off
  `matchedFrom`) and lifecycle (`voiceState`/Qwen design state) are now two
  orthogonal outputs instead of one collapsed `voiceState` pill.

## Architectural impact

- **New seam:** `src/lib/voice-status.ts` — `resolveVoiceStatus(character,
  voice)` returns `{ lifecycle, reused }`. Replaces the cast view's private
  `resolveStatusPill` and the drawer's inline `voiceState` pill ladder.
- **New presentational primitive:** `ReusedBadge` (`primitives.tsx`) — a small
  `data-testid="reused-badge"` provenance chip, deliberately lighter than
  `Pill` so it reads as a secondary marker.
- **Drawer fix:** `designedVoiceId` now seeds from the matched voice
  (`voice.overrideTtsVoices.qwen.name` → `voice.ttsVoice.name` when the matched
  voice is Qwen) when the character's own override is empty, and that effective
  voice is injected into `editedCharacter.overrideTtsVoices.qwen` so the card
  line + sample resolve it. Save semantics are unchanged — the staged voice is
  only persisted when the user explicitly pins the Qwen engine.
- **Picker fix:** `VoiceEnginePicker` takes a `defaultEngineLabel` prop instead
  of hardcoding "Kokoro" in the "Default (…)" option.
- **Preset-picker gate:** the `ModelVoiceOverridePicker` is gated on
  `effectiveEngine !== 'qwen'` (the per-character override folded over the
  project default) instead of the live `engineChoice`, so a default-engine
  character on a Qwen project no longer shows inert preset speaker tabs.
- **Invariants preserved:** OpenAPI is untouched (no new fields). The reuse
  reducers are untouched — this is a read-side display fix. Plan 117's Qwen
  lifecycle (Needs voice / Designed / Generated) is preserved verbatim inside
  `resolveVoiceStatus`.
- **Reversibility:** delete `voice-status.ts` + `ReusedBadge`, restore the
  inline pills; the drawer seed change is a one-line revert.

## Invariants to preserve

- `resolveVoiceStatus` (`src/lib/voice-status.ts`) routes to the Qwen lifecycle
  when `c.ttsEngine === 'qwen'` **OR** `voice.ttsVoice.provider === 'qwen'` —
  the latter is what catches a reused-but-not-pinned character.
- The Reused badge is keyed off `matchedFrom` (not `voiceState === 'reused'`)
  so it survives a later tune/lock.
- The drawer's `designedVoiceId` falls back to the matched Qwen voice
  (`src/modals/profile-drawer.tsx`) so the card never reads "No voice designed
  yet" for a character the cast row shows a Qwen voice for.
- `VoiceEnginePicker`'s "Default (…)" option label is driven by
  `defaultEngineLabel`, never hardcoded.
- The preset `ModelVoiceOverridePicker` (`src/modals/profile-drawer.tsx`) is
  gated on `effectiveEngine !== 'qwen'`, NOT `engineChoice !== 'qwen'`, so it
  shows iff the character will synthesise with a preset engine.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/voice-status.test.ts`) — `resolveVoiceStatus` across
  preset/Qwen lifecycles, the reused-Qwen-via-matched-voice case, and the
  `matchedFrom`-keyed badge (incl. survives tune/lock + coexists with
  lifecycle).
- Vitest (`src/views/cast.test.tsx`) — lifecycle pill + Reused badge render as
  separate coexisting markers; a reused Qwen row shows "Generated" + the Reused
  badge together.
- Vitest (`src/modals/profile-drawer.test.tsx`) — "ProfileDrawer reused Qwen
  voice (drawer/table parity)": the card surfaces the reused voiceId (not "No
  voice designed yet"), the Play button is enabled, the lifecycle pill + Reused
  badge both render, the engine default option reads "Default (Qwen)", the
  preset Model-voice picker is hidden for the effective-Qwen character, and it
  still renders for a default-engine character on a Kokoro project.

### Manual acceptance walkthrough

Real backend on a Qwen project with a series whose later book reuses prior cast
(e.g. The Drowning Bell reusing The Tidewatcher’s Oath / the Coalfall Commission voices).

1. Open `#/books/<id>/cast` → reused rows show `Qwen · qwen-<name>-…` in the
   Voice column and a lifecycle pill + a small "Reused" badge in Status.
2. Click a reused row to open the drawer → Voice-profile card reads
   `Qwen · qwen-<name>-… · Designed voice` (NOT "No voice designed yet"); the
   "Play 12 s sample" button is enabled and plays the reused voice.
3. The engine dropdown's first option reads "Default (Qwen)".
4. The Voice-profile header shows the lifecycle pill (e.g. Generated/Designed)
   next to the "Reused" badge.

## Out of scope

- Propagating the reused engine/voice onto `Character.ttsEngine` /
  `overrideTtsVoices` at reuse time (would make the drawer + table read from the
  same field). Deferred — the read-side resolver is sufficient and avoids
  touching the reuse reducers / cast.json shape.
- The cast row's `resolveDisplayTtsVoice` still shows a reused Qwen voice even
  when the project engine is a preset (a degenerate cross-engine-reuse case);
  the drawer's preset-picker gate tracks the *effective* synth engine, so the
  two can disagree in that rare case. Not chased here.

## Ship notes

Shipped 2026-05-28 on branch `fix/frontend-reused-voice-drawer-status`.
Frontend-only; no OpenAPI/contract change. Delivered exactly as specified plus
the folded-in preset-picker gate (`effectiveEngine !== 'qwen'`) that the
original draft had parked under "Out of scope". Paired tests landed in the same
change (`src/lib/voice-status.test.ts`, `src/views/cast.test.tsx`,
`src/modals/profile-drawer.test.tsx`).
