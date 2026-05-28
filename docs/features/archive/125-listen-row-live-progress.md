---
status: stable
shipped: 2026-05-28
owner: null
---

# Listen-view chapter row mirrors the live playhead

> Status: stable
> Key files: `src/store/listen-progress-slice.ts`, `src/components/mini-player.tsx`, `src/components/listen/listen-player-region.tsx`
> URL surface: `#/books/<id>/listen`
> OpenAPI ops: none (ephemeral, in-memory only — no on-disk shape change)

Extends [47 — listen-progress](47-listen-progress.md) and
[53 — mini-player feature pack](53-mini-player-feature-pack.md).

## Benefit / Rationale

- **User:** the actively-playing chapter row's elapsed time + waveform now track the real audio, agreeing with the bottom mini-player to the second. Before, the row ran a decorative animation (`progress += 0.012` every 800 ms) that drifted far from the true playhead — the bug report showed a row reading `0:29 / 00:45` while the player read `0:44 / 0:44`, plus a frozen "Resume at 0:10" pill.
- **Technical:** completes the intent the slice's `update` reducer already documented ("so the Listen pill's MM:SS stays fresh during continuous playback") via a dedicated ephemeral channel, without churning the persisted resume bookmark or the disk-save cadence.
- **Architectural:** introduces a narrowed-selector pattern (`selectLivePlaybackFor`) so a ~2 Hz live tick re-renders only the one playing row — preserving the re-render-economy reason the mini-player originally avoided dispatching per-tick.

## Architectural impact

- **New seam:** `ListenProgressState.livePlayback: LivePlayback | null` — a single global ephemeral record (one `<audio>` element plays at a time), with `setLivePlayback` / `clearLivePlayback` actions and the `selectLivePlaybackFor(bookId, chapterId)` selector. **Not persisted** (no redux-persist, no disk write); distinct from the `byBook` resume bookmark.
- **Invariants preserved:**
  - The persisted resume bookmark (`byBook[bookId]`) and its disk-save path (debounced PUT, 5 s gate + ≤5 s noise floor in `mini-player.tsx`) are untouched. `listen-progress.json` shape is unchanged (plan 47 invariant).
  - OpenAPI remains the type source of truth — no contract change (plan 24).
  - RTK Immer reducers (plan 26) — `setLivePlayback`/`clearLivePlayback` mutate drafts.
- **Migration story:** none — the field is ephemeral and initialises to `null`.
- **Reversibility:** revert the three-file diff; nothing on disk or in the API depends on it.

## Invariants to preserve

- `selectLivePlaybackFor` returns the **stored** `livePlayback` reference (not a fresh object) when `bookId` + `chapterId` match, else a stable `null` — `listen-progress-slice.ts`. Returning a fresh object would re-render every chapter row on every unrelated dispatch.
- The mini-player's live dispatch is throttled by `lastLiveDispatchRef` (≥500 ms), **separate** from `lastSavedAtRef` (the 5 s disk-save gate) — `mini-player.tsx` `onTimeUpdate`. The live tick has **no** ≤5 s noise floor (the row must track from 0:00); the disk save keeps its noise floor.
- The live dispatch carries `durationSec = totalSec` (`audio.durationSec || parseDuration(chapter.duration)`) — the same resolved total the player renders — so the row matches the player's total exactly while playing.
- `ChapterListenRow` gates `showResume` on `!isPlaying` — the "Resume at" pill is suppressed on the actively-playing chapter and still shows on other bookmarked, idle rows — `listen-player-region.tsx`.
- The chapter-mount-effect cleanup dispatches `clearLivePlayback()` so a stale live record can't outlive the audio element.

## Test plan

### Automated coverage

- Vitest unit (`src/store/listen-progress-slice.test.ts`) — `setLivePlayback` stores / replaces; `clearLivePlayback` nulls; `selectLivePlaybackFor` returns the stored reference on match, `null` for other book/chapter/empty/absent-slice; live writes leave `byBook` untouched.
- Vitest unit (`src/components/mini-player.test.tsx`) — `onTimeUpdate` publishes `livePlayback` with `currentSec` + resolved `durationSec`; throttle skips a second tick within 500 ms and fires past it (mocked `Date.now`); unmount clears the record. Existing plan-47 PUT-cadence assertions stay green (disk path untouched).
- Vitest unit (`src/components/listen/listen-player-region.test.tsx`) — a playing row shows `formatTime(currentSec) / formatTime(durationSec)` (e.g. `0:44 / 0:44`, matching the player, not the `00:45` metadata); the playing row hides its Resume pill; a bookmarked idle row still shows it.
- Playwright e2e (`e2e/listen-resume.spec.ts`) — clicking a bookmarked chapter's play button hides its "Resume at" pill (walks click → `currentTrack` redux → row `!isPlaying` gate in a real browser; deterministic because the gate keys on `currentTrack`, not the audio playhead). The three prior resume-pill specs remain green.

### Manual acceptance walkthrough

1. **`#/books/<id>/listen`, click a chapter to play** → the row's elapsed time advances in lock-step with the bottom mini-player; the waveform fills proportionally to real progress; the row total equals the player's total to the second.
2. **Resume pill** is gone from the actively-playing row, and still shows on any other bookmarked, idle row.
3. **Scrub via the player** → the row tracks within ~0.5 s.
4. **Switch chapters** → the previous row reverts to its static metadata duration; the new row live-syncs.

## Out of scope

- Unifying the *idle* (not-playing) row's duration label with the player's PCM-exact value — idle rows keep the canonical `chapter.duration` metadata string (consistent with the book runtime totals). Only the actively-playing row mirrors the player exactly.
- Share-clip default playhead still centres on the last-saved resume bookmark (`byBook`), not the live tick — unchanged from plan 69.

## Ship notes

Shipped 2026-05-28 on branch `fix/frontend-plan-125`. Three-file change + paired tests across all four affected harnesses (slice unit, mini-player unit, row unit, e2e). No on-disk / OpenAPI change. Replaced the prototype-era decorative row animation (`setInterval` `progress += 0.012`) with a throttled live playhead published from the mini-player via the new ephemeral `livePlayback` slice channel; suppressed the Resume pill on the playing row; matched the playing row's total to the player's resolved duration.
