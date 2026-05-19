---
status: stable
shipped: 2026-05-19
owner: null
---

# Voice preview while editing the character

> Status: stable
> Key files: `src/components/voice-preview-button.tsx`, `src/modals/profile-drawer.tsx`, `src/lib/play-sample-with-auto-load.ts`, `src/lib/api.ts`
> URL surface: indirect — opens via the profile drawer at any `#/books/:bookId/<view>` route with an open profile (`ui.stage.openProfileId`).
> OpenAPI ops: `POST /api/voices/{voiceId}/sample` (raw-speaker branch — `rawEngine` + `rawSpeaker` + `text` body)

## Benefit / Rationale

- **User:** faster voice-picking feedback loop. Today the user assigns a voice, regenerates a sample chapter, judges, then optionally re-assigns. Preview cuts that cycle from minutes to seconds because every candidate row in the override picker carries a "Play sample" affordance that auditions the raw voice against a custom sample line WITHOUT committing the assignment.
- **Technical:** zero new redux state. Preview state is local to `VoicePreviewButton` (loading flag + transient error) and to the drawer (sample text + expanded toggle). Sample text is persisted across drawer opens via `localStorage` keyed `voice-preview-sample-text`. The synth path reuses the existing `playBaseVoiceSampleWithAutoLoad` helper so the sidecar lifecycle (evict analyzer → load sidecar → synth) is shared with the Voices view and the cast row pill.
- **Architectural:** locks in the "preview is read-only" invariant. The cast assignment dropdown is the single source of truth for the per-engine override; preview rows speak the candidate voice in-place but never call `api.setVoiceOverride`. Pairs with BACKLOG Could #28 (third-consumer lifecycle tracking) if/when that activates — the drawer becomes the third surface that exercises the JIT warm-up path.

## Architectural impact

- **New seams / extension points added:**
  - `src/components/voice-preview-button.tsx` — single-button preview affordance keyed by `(engine, name)`. Accepts `voice`, `modelKey`, `text`, optional `ariaLabel`, optional `testId`. No internal state beyond the in-flight `SampleStatus` and the inline error.
  - `BaseVoiceSampleArgs.text?: string` (in `src/lib/api.ts`) — optional preview line forwarded to `POST /api/voices/:carrier/sample` alongside `rawEngine` + `rawSpeaker`. Server already supported `text` on the raw-sample branch (see `server/src/routes/voice-sample.ts:148`), so the wire format is unchanged — only the client now forwards it.
  - `ModelVoiceOverridePicker` (in `src/modals/profile-drawer.tsx`) gains five preview-related props: `previewText`, `onPreviewTextChange`, `previewExpanded`, `onPreviewExpandedChange`, `previewModelKey`. Hoisted so the textarea + every row read from one source of truth.

- **Invariants preserved:**
  - **CLAUDE.md "preview is read-only":** preview rows never call `api.setVoiceOverride`. The override select remains the only commit path; clicking a candidate's Play button leaves the select's value unchanged. Asserted in `src/modals/profile-drawer.test.tsx` ("clicking Play on a SECOND candidate forwards the new voice (read-only audition, no commit)").
  - **`useTtsLifecycle` is a pure consumer (plan 30):** this plan does NOT modify `src/lib/use-tts-lifecycle.ts`. Preview synth uses the standalone `playBaseVoiceSampleWithAutoLoad` orchestrator that already runs alongside the lifecycle hook.
  - **No new redux slice (plan 26 + project rule):** preview state stays in the component tree. Sample-text persistence uses `localStorage` directly, mirroring the lightweight per-user prefs already in the drawer (e.g. evidence preview limit is constant, not state).

- **Migration story:** none. localStorage key is brand-new; first read yields the default sample text.

- **Reversibility:** removing the feature is a single revert. The optional `text` field on `BaseVoiceSampleArgs` is backwards-compatible (server defaults to `RAW_SAMPLE_TEXT` when omitted).

## Invariants to preserve

- `BaseVoiceSampleArgs` in `src/lib/api.ts:317-327` carries the optional `text?: string` field. Forwarded by `realGetBaseVoiceSample` (line 2114-2124) into the POST body alongside `rawEngine` + `rawSpeaker`.
- `VoicePreviewButton`'s `useSamplePlayback` hook (`src/components/voice-preview-button.tsx:60`) shares the singleton audio element with every other preview surface — clicking a second candidate implicitly cancels the first via `use-sample-playback.ts:96` (src-swap drains awaiters with `cancelled: true`). The button does NOT need to manually `stop()` siblings.
- Sample text persistence: `loadInitialPreviewText` in `src/modals/profile-drawer.tsx` reads `voice-preview-sample-text` from `localStorage`; the `useEffect` watcher writes on every change. Private-browsing failures fall back silently to in-memory state.
- The preview list is rendered AFTER the override-picker `<select>` in the drawer DOM order, so a screen reader walks selection → audition (read-only) → assignment description. The select remains the only commit path.
- Default sample text (`DEFAULT_PREVIEW_TEXT` in `src/modals/profile-drawer.tsx`): `"The quick brown fox jumps over the lazy dog. The sun shone over the field."` — pangram + follow-on, covers consonant + vowel inventory and a held sentence at typical reading pace.

## Test plan

### Automated coverage

- Vitest unit (`src/components/voice-preview-button.test.tsx`) — asserts:
  - Click routes through `playBaseVoiceSampleWithAutoLoad` with the candidate `engine`, `speakerName`, `modelKey`, and `text`.
  - Parent text edits are forwarded on the next click (no stale closure).
  - Two separate buttons against different candidates each invoke their own voice — no shared-state leak.
  - Helper rejection renders an inline `role="alert"` error.
  - Optional `ariaLabel` override is honoured.
- Vitest unit (`src/modals/profile-drawer.test.tsx`, new "voice-preview while editing" describe block) — asserts:
  - Candidate list + textarea start collapsed; toggle expands them.
  - Clicking a row routes through the helper with the user-edited sample text.
  - Auditioning two candidates fires two helper calls; `onSave` is never called (read-only).
  - Switching the engine tab swaps which catalog the candidate list shows.
  - Sample text persists to `localStorage` under `voice-preview-sample-text`.
- Playwright e2e (`e2e/voice-preview-while-editing.spec.ts`) — drives goToConfirm → open drawer → expand preview → edit sample text → click candidate A → click candidate B → assert override-picker still reads `auto` → close+reopen drawer → assert sample text persists. Covers the browser-level src-swap-cancel seam of `useSamplePlayback`.

### Manual acceptance walkthrough

1. **Boot** `npm run dev` (mock mode on) → URL `#/`, library renders.
2. **Open any book** → URL `#/books/:bookId/cast`, cast view renders.
3. **Click a character card** → drawer slides in from the right, URL gains `&profile=:characterId`.
4. **Scroll to "Model voice" card** → engine tabs visible, override `<select>` defaults to `Auto`.
5. **Click "+ Preview Coqui candidates"** (or whichever engine tab is active) → list of candidate rows expands beneath the select, sample-text textarea defaults to the pangram + follow-on.
6. **Edit the sample text** → e.g. `"Halloran takes the bridge."`; the new value persists into `localStorage` immediately.
7. **Click "Play sample" on row A** → button flips to a spinner labelled "Synthesising…", then to "Stop" once audio starts. Audio plays through speakers in under 3 s for a warm sidecar.
8. **Click "Play sample" on row B** → row A's audio stops mid-flight (singleton playback drains); row B's preview synthesises and plays.
9. **Verify** the override `<select>` still reads `Auto` — no cast assignment was committed.
10. **Close the drawer** (click Discard) → no `setVoiceOverride` call fired.
11. **Re-open the same character** → preview section starts collapsed; toggling it open shows the same edited sample text (loaded from `localStorage`).

## Out of scope

- **Per-character voice-preview pinning** — saving a preferred preview line per character (rather than one global line). That's BACKLOG Could #11 (per-book editorial notes) territory.
- **Preview-while-cast-view** — auditioning candidates from the cast tile directly without opening the drawer. The current cast row Play button still auditions the assigned voice; preview lives behind the drawer's override picker so it's contextual to the assignment.
- **Bulk preview (audition every candidate in sequence)** — would need a queue + auto-advance. Skipped because the user's pick-three-and-judge workflow is faster click-driven.

## Ship notes

Shipped 2026-05-19 on branch `feat/frontend-voice-preview-while-editing` (PR forthcoming). Wave 2.S5 of the v1.4.0 alpha-launch pre-cutover slate.

- Default sample text: `"The quick brown fox jumps over the lazy dog. The sun shone over the field."` (pangram + follow-on).
- localStorage key: `voice-preview-sample-text` (single global key, shared across characters).
- New component: `src/components/voice-preview-button.tsx` + paired test `src/components/voice-preview-button.test.tsx`.
- Drawer changes: 5 new props on `ModelVoiceOverridePicker`, ~70 lines of JSX for the candidate-preview section.
- API surface: `BaseVoiceSampleArgs` gained optional `text?: string`; server already accepted it on the raw-sample branch.
- E2E: 1 new spec (`e2e/voice-preview-while-editing.spec.ts`) covering the audition-A-then-B-without-commit flow.
