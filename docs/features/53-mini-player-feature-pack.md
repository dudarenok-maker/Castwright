---
status: active
shipped: null
owner: null
---

# Mini-player feature pack (playback speed + markers + sleep timer)

> Status: active
> Key files: `src/components/mini-player.tsx`, `src/views/listen.tsx`, `src/store/listen-progress-slice.ts`, `src/lib/sleep-timer.ts`, `server/src/routes/book-state.ts`
> URL surface: indirect — mini-player is mounted by `src/components/layout.tsx` whenever `stage.kind === 'ready'` AND `ui.currentTrack != null`; markers sidebar lives inside `#/books/<id>/listen`.
> OpenAPI ops: `PUT /api/books/{bookId}/listen-progress` (request body extended with optional `playbackRate` + `markers`); `ListenProgress` + new `ListenMarker` schemas.

## Benefit / Rationale

Three table-stakes audiobook-player affordances shipped together because they touch the same surface (mini-player toolbar + listen-progress persistence) and the same slice extension. Splitting into three PRs would mean three round-trip slice migrations + three server-validator passes for what's structurally one change.

- **User (playback speed):** standard audiobook player feature; users expect 0.75× — 2× as basic controls. Today only 1.0× is available, forcing browser zoom-and-pinch or per-chapter regeneration workarounds.
- **User (markers / bookmarks):** today re-record candidates have nowhere to live — the user has to remember a timestamp manually. Markers give a per-book scratchpad of "fix this later" annotations without leaving the listen view.
- **User (sleep timer):** standard audiobook listener pattern; most listeners fall asleep mid-chapter and want playback to stop at a natural boundary. Parity with standalone audiobook apps.
- **Technical:** all three reuse the plan-47 persistence seam (`.audiobook/listen-progress.json` + the slice's per-book Map) instead of opening fresh on-disk JSON files. The sleep timer is per-session by design; the other two persist via the existing debounced-PUT path.
- **Architectural:** the sleep-timer state machine (`src/lib/sleep-timer.ts`) is a pure JS module with NO React dependencies. The mini-player owns the timer reference; the player's own onTimeUpdate + onEnded handlers feed the machine. This keeps the React component readable and the state transitions unit-testable in isolation.

## Architectural impact

**New seams / extension points:**

- `src/lib/sleep-timer.ts` — pure state machine; takes `now` as a seam so tests don't have to mock `Date.now()`.
- `src/store/listen-progress-slice.ts` — extended with `playbackRate?: number`, `markers?: ListenMarker[]`, and a one-shot `pendingSeek` channel for the marker-click → mini-player seek path. New reducers: `setPlaybackRate`, `addMarker`, `editMarker`, `deleteMarker`, `requestSeek`, `consumeSeek`. New selector: `selectPendingSeek`. New helper: `getPlaybackRate(record)` returns 1.0 when the field is absent (lazy-migration for pre-plan-53 on-disk records).
- `server/src/routes/book-state.ts` — PUT validator gains optional `playbackRate` (range 0.25 – 4.0) and `markers` (each validated through `validateMarker`). Bad `kind` → 400 with `markers[N]: marker.kind must be one of: note, rerecord`. Marker shape: `{ id, chapterId, sec, label, kind, createdAt }`.
- `openapi.yaml` — `ListenProgress` extended; new `ListenMarker` schema with `kind: enum [note, rerecord]`. Regenerated `src/lib/api-types.ts` reflects both.
- `src/lib/api.ts` — `ListenProgress` type + `mockPutListenProgress` extended with the two optional fields; `PutListenProgressArgs` exported for the mini-player's typed call sites.

**Invariants preserved from plan 47 (the listen-progress predecessor):**

- The PUT debounce stays at 5 s wall-clock + 5 s minimum position (`onTimeUpdate` only fires the position save once per 5 s of wall time, and never below 5 s into the chapter). The new `playbackRate` save happens out-of-band on the picker click and is NOT subject to this debounce — the user expects an instant on-disk update after a rate change.
- `onLoadedMetadata` still applies the resume bookmark via `pendingSeekRef`. The new code path (marker-click on the currently-playing chapter) re-uses the same ref for the case where the audio isn't yet loaded; for the loaded case it sets `el.currentTime` directly.
- No `redux-persist`; the slice stays in-memory only, the server file at `.audiobook/listen-progress.json` is authoritative.
- The `update` reducer now PRESERVES `playbackRate` + `markers` across position-only updates so the debounced PUT (which carries only `chapterId` + `currentSec`) doesn't accidentally drop the user's chosen rate or marker list between saves.

**Migration story:**

- On-disk records written before plan 53 have neither `playbackRate` nor `markers`. The slice + server treat both as optional; `getPlaybackRate()` returns 1.0 when missing. No re-write at hydrate — the next PUT round-trip drops the new fields onto disk naturally.

**Reversibility:**

- All three features are additive. Reverting the plan would leave pre-plan-53 records intact on disk; the fields would just be dropped on the next PUT. The sleep timer is per-session memory only, so a revert has no on-disk footprint.

## Invariants to preserve

Numbered list of structural rules a refactor must not break.

1. The PUT debounce in `src/components/mini-player.tsx` onTimeUpdate handler stays gated on `(now - lastSavedAtRef.current >= 5000)` AND `(t > 5)`. Position-only updates never carry `playbackRate` or `markers` — those flow through their dedicated handlers (`onChangePlaybackRate`, `commitMarkerDraft`).
2. `pendingSeekRef` in the mini-player is consumed exactly once per chapter-mount in `onLoadedMetadata`, capped at `d - 1` so a resume parked near the end doesn't immediately trigger `onEnded`. Plan 53 reuses the same ref for the marker-click-but-audio-not-loaded path.
3. The sleep-timer state machine's transitions are exhaustively: `idle → countdown` (startCountdown), `idle → end-of-chapter` (startEndOfChapter), `countdown → fired` (tick past firesAt), `end-of-chapter → fired` (notifyChapterEnded), `* → idle` (cancel). `tick` is a no-op on non-countdown states; `notifyChapterEnded` is a no-op on non-end-of-chapter states. The mini-player flips `* → idle` after consuming the fire (so a fresh play click isn't instantly re-paused).
4. The `requestSeek` / `consumeSeek` action pair in the listen-progress slice uses a monotonic `requestId`, NOT payload equality, to determine consumption. Two marker clicks at the same sec must still fire two seeks; `consumeSeek` with a stale `requestId` is a no-op.
5. Marker kind enum is exactly `'note' | 'rerecord'`. Frontend `LISTEN_MARKER_KINDS` and server `LISTEN_MARKER_KINDS` carry the same literal; openapi.yaml `enum: [note, rerecord]` matches. Adding a kind requires touching all three.
6. The mini-player's `M` keyboard shortcut never fires when the active element is an `INPUT`, `TEXTAREA`, or `contentEditable` — typing M in the marker label field doesn't trip a recursive marker-drop.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/sleep-timer.test.ts`) — 13 tests covering: `startCountdown` stamps `firesAt`; `tick` is a no-op before `firesAt`, transitions to `fired` at/past `firesAt`; `notifyChapterEnded` transitions only the `end-of-chapter` state; `cancel` before fire is a no-op on the eventual fire path; `remainingMs` counts down and clamps to 0; the preset list is the documented `[15, 30, 45, 60]`.
- Vitest unit (`src/store/listen-progress-slice.test.ts`) — extended with: `playbackRate` hydrate roundtrip + default-1.0 fallback + `update` preserves rate across position updates + `setPlaybackRate` writes / seeds; `addMarker` / `editMarker` / `deleteMarker` + missing-id no-op + `update` preserves markers; `LISTEN_MARKER_KINDS` matches the documented enum; `requestSeek` / `consumeSeek` with monotonic requestId + stale-id no-op.
- Vitest server (`server/src/routes/book-state.test.ts`) — extended with 6 cases: PUT round-trips `playbackRate`; 400 when rate is out of range or non-numeric; PUT round-trips `markers`; 400 when a marker carries an unknown `kind`; 400 when `markers` isn't an array; 400 when a marker is missing a required field.
- Playwright e2e (`e2e/mini-player-features.spec.ts`) — 5 specs: picker selects 1.5× and the `<audio>` element's `playbackRate` reflects it; rehydrate-from-slice path adopts a pre-primed 1.5× rate; add marker + sidebar appearance + click-to-seek; end-of-chapter mode pauses on the audio onEnded event; countdown preset installs the remaining-time pill + cancel restores idle.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cold boot at `#/`** → click "Solway Bay" library card → navigates to `#/books/sb/listen`.
2. **Click "Play from the start"** → mini-player mounts at the bottom of the screen, chapter 1 audio starts playing, speed-toggle reads "1.0×".
3. **Click the speed toggle, pick 1.5×** → the popover closes, the toggle label flips to "1.5×", and the audio noticeably speeds up. Reload the page (without closing the player) → on next play, the rate is still 1.5×.
4. **Drop a marker via the Add button** → inline form appears under the player; type "re-record this", click Save. The "Markers" panel above the chapters list appears with the new entry under the current chapter's header. Click the trash-style ×, the marker disappears.
5. **Drop a second marker, click its label in the panel** → the audio element seeks to that marker's position (visible as a jump in the play timestamp inside the player strip).
6. **Open the sleep-timer menu, pick "End of chapter"** → the clock-icon button gets a small "End of ch" pill next to it. Skip to the last ~5 seconds of a chapter (via the scrubber) and let it play out → at the chapter end, the player pauses and the sleep pill disappears.
7. **Open the sleep-timer menu, pick "15 min"** → a countdown pill appears showing mm:ss remaining. Click the toggle again, click "Cancel timer" → the pill disappears, the player keeps playing.
8. **Hit `M` while the player is mounted** → the inline marker form opens (same as the button). Hit `Esc` → the form closes without saving.

## Out of scope

- Per-chapter loudness normalization, AAC/Opus output, manuscript diff viewer, and the other listening-UX items in `docs/BACKLOG.md` Could #1, #2, #6, #7, #8, #10 are independent rounds.
- Custom keyboard shortcut config (only `M` for now); plan 30's keybinding surface is the place to extend if needed.
- Marker labels rich text / colour tagging; current shape is plain string + 2-kind enum.
- Server-side schema migration / on-disk version bump — pre-plan-53 records are lazily upgraded on the next PUT without explicit migration code.

## Ship notes

(Filled in when status flips to `stable`.)
