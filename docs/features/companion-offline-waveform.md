---
status: active
---

# Companion offline waveform persistence

**Area:** Android companion (app). **Type:** bug fix.

## Problem

Chapter waveforms in the companion player were fetched live from the server
(`GET /api/books/:id/chapters/:id/audio` → `peaks`) and cached only in an
in-memory `Map` on `_PlayerScreenState`. So they vanished offline, on chapter
switch, and whenever the player screen was recreated (navigate away/back,
return from Android Auto, app restart) — defaulting to a plain grey bar. They
reappeared only while connected, for the one chapter being viewed, then
disappeared again.

## Fix

Peaks are now an offline-persisted asset, mirroring how chapter audio +
metadata are already stored offline:

- **drift `Chapters.peaks` column** (schema v4 → v5; JSON-encoded `List<double>`,
  the same upgrade shape as `durationSec` at v3).
- **`DriftLocalLibrary`**: `savePeaks(uuid, peaks)`, `loadPeaks(uuid)`,
  `chaptersMissingPeaks()` (downloaded chapters — `fingerprint` present,
  `chapterId > 0` — with no peaks yet).
- **`SyncController` owns the policy**: `peaksFor(bookId, uuid, chapterId)`
  reads local-first, fetching + persisting only on a miss; `downloadBook`
  persists peaks for each chapter as it downloads; `backfillMissingPeaks()`
  fills every locally-missing chapter, re-entrancy guarded so overlapping
  connect + reconnect sweeps don't double-fetch.
- **Wiring**: the player reads via `sync.peaksFor`; the runtime injects
  `api.getChapterPeaks`, runs `backfillMissingPeaks()` one-shot on initial
  connect and again on each auto-sync reconnect.

## Invariants

- Peaks survive offline, chapter switch, screen recreation, and app restart.
- A chapter downloaded while online then taken offline still shows its waveform.
- Switching chapters offline keeps showing the waveform for any chapter with
  persisted peaks; none revert to grey.
- The backfill is idempotent: a no-op once every downloaded chapter has peaks,
  and a no-op offline (the fetch returns empty and nothing is persisted).

## Manual acceptance walkthrough

1. Connect to the local server, download a book.
2. Open the player, page through every chapter while online → each shows a waveform.
3. Force-quit the app. Re-open offline (server unreachable / airplane mode).
4. Open the player → every chapter still shows its waveform (no grey bar).
5. Switch chapters offline → waveform persists per chapter; none revert to grey.
6. (Backfill) Install over an old build that has audio but no persisted peaks
   (or clear peaks), then reconnect → within one connect, all downloaded
   chapters gain waveforms.

## Tests

- `apps/android/test/data/drift_local_library_test.dart` — `savePeaks`/`loadPeaks`
  round-trip + null-when-unsaved; `chaptersMissingPeaks` scope (audio-only,
  `chapterId > 0`, peaks-null).
- `apps/android/test/data/sync_controller_test.dart` — `peaksFor` local-first vs
  fetch-and-persist vs offline-empty; `downloadBook` persists peaks;
  `backfillMissingPeaks` fills/skips/counts + re-entrancy guard.
- Player + runtime wiring are device glue (no unit harness — consistent with the
  rest of `companion_runtime`); covered by the above + the manual walkthrough.
