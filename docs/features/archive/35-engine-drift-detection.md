---
status: stable
shipped: 2026-05-16
owner: null
---

# 35 — Per-chapter engine drift detection

Surfaces chapters whose existing audio was rendered with a different TTS
engine than the project's current selection, so the user can decide
whether to regenerate for book-wide voice consistency.

## Why

After landing the Kokoro v1 engine (plan 14a) and making it the default,
existing books with Coqui-rendered audio carried voices that wouldn't
match anything new generated under Kokoro. Listening end-to-end would
expose an audible engine change mid-book. The signal was completely
silent — no badge, no warning, no notion that the rendered audio's
engine and the project's active engine had diverged.

This plan adds a chapter-level drift signal: stamp each rendered chapter
with the engine that produced it, compare against the active engine on
read, and surface the mismatch in the Generation view.

## Status

> Status: stable

## Invariants

1. **Each chapter audio render writes `audioModelKey` and
   `audioRenderedAt` into `state.json`** (`finalize-chapter-write.ts`). The
   stamp is the engine the audio ACTUALLY rendered in — derived from the
   per-character render snapshots, NOT blindly the request `modelKey`. See
   the per-character reconciliation section below; before that fix this field
   was the request default, which produced a false drift badge on any chapter
   whose speakers all rendered on a non-default engine.

2. **Legacy chapters are lazy-backfilled from
   `audio/<slug>.segments.json`** by
   `backfillAudioModelKeysFromSegments()` in
   `server/src/workspace/scan.ts`. The helper runs on both the library
   scan path and the per-book `findBookBy` lookup, so the first read
   after deployment upgrades the on-disk shape. Once a chapter is
   stamped the helper is a no-op for it. The same loop also backfills
   the per-chapter `duration` string from `segments.json:durationSec`
   when state.json's value is missing or `'00:00'` — covers chapters
   rendered before the generation route's state.json write block landed
   (or via a code path that updates the engine-drift fields without
   `duration`). Backfill is sticky: an existing non-placeholder
   `duration` is never overwritten — regeneration is the only path
   allowed to change it.

3. **An existing `audioModelKey` is never overwritten by the backfill**
   — only missing fields are filled. The render path is authoritative
   for fresh writes. The same applies to `duration`: any non-placeholder
   value already on the chapter is sticky and wins.

4. **Drift is one-way: the chapter holds the OLD engine, the project
   holds the NEW engine.** The signal fires when those differ. When the
   user regenerates a drifted chapter the new render overwrites the
   stamp with the active engine, clearing the badge.

5. **Drift signal is per-chapter and chapter-wide** — not per-character.
   The pre-existing per-character drift (revisions.ts) is untouched and
   continues to detect within-engine voice swaps.

6. **Excluded chapters are excluded from drift counts.** Drift only
   matters for chapters that will be played as part of the book.

7. **Sticky generation (plan 31) is preserved.** Mid-generation engine
   switches let the current chapter finish on its original engine.
   That chapter's `audioModelKey` reflects what was actually rendered,
   not what the user picked at scan time — so the post-switch drift
   detection is naturally correct.

8. **The SSE `chapter_complete` tick carries `audioModelKey`** so the
   slice can stamp the chapter immediately. Without that, drift wouldn't
   appear until the user reloaded.

9. **`updatedAt` is NOT bumped by the backfill.** It's a lossless metadata
   migration, not a user-driven change.

10. **Bulk regenerate of every drifted chapter is a single action.** The
    drift banner carries a "Regenerate all" button that dispatches
    `chaptersActions.regenerateChapterIds` with the full set of drifted
    chapter ids. The middleware (`generation-stream-middleware.ts`)
    closes any live handle and opens a fresh stream with `chapterIds`
    - `force=true`, queueing the bulk run as one SSE rather than 27
      sequential clicks. Excluded chapters are filtered out by the slice
      reducer defensively even though the banner-derived list already
      excludes them — see invariant 6.

## Critical files

- `server/src/workspace/scan.ts` — `BookStateJson.chapters[]` schema,
  `backfillAudioModelKeysFromSegments`, both call sites
  (`scanBook` and `findBookBy`)
- `server/src/routes/generation.ts` — render write path stamps the
  fields; `chapter_complete` SSE tick carries `audioModelKey`
- `openapi.yaml` — Chapter schema (`audioModelKey`, `audioRenderedAt`)
  - GenerationTick schema (`audioModelKey` on `chapter_complete`)
- `src/lib/types.ts` — frontend `BookStateJson.chapters[]` mirror
- `src/store/chapters-slice.ts` — `hydrateFromBookState` propagates
  the field; `applyGenerationTick` captures it on `chapter_complete`
- `src/views/generation.tsx` — per-row drift caption (replaces the
  static word/line/speaker meta when drifted); top-of-view banner
  counting drifted chapters; banner "Regenerate all" button + the
  `ConfirmDialog` mount that confirms and dispatches the bulk action
- `src/modals/confirm-dialog.tsx` — destructive-action confirm reused
  for the bulk regen flow (variant="danger")
- `src/store/chapters-slice.ts` — `regenerateChapterIds` reducer that
  re-queues an explicit list of chapter ids; mirrors `regenerateChapter`
  but takes an arbitrary, possibly non-contiguous set
- `src/store/generation-stream-middleware.ts` — `regenerateChapterIds`
  appears in both `TRIGGER_TYPES` and `REGEN_TYPES` so the action
  drives reconcile AND closes any in-flight handle before opening a
  fresh stream with the new spec

## Acceptance walkthrough

### Setup

1. Pick a book with at least 2-3 generated chapters. Note the engine
   currently set on the project (visible in the engine label above the
   chapter list).

### Drift via picker swap

2. Switch the engine via the picker (e.g. Coqui → Kokoro). Don't
   regenerate anything.
3. The top-of-view banner appears: "**N chapters generated with a
   different engine.** Current engine is Kokoro v1. Drifted chapters
   keep their original voices until you regenerate them — use Regenerate
   on each chapter row to refresh, or stay on a single engine for
   book-wide consistency."
4. Each drifted chapter row replaces its "X words · Y lines · Z
   speakers" caption with an amber "⚠ Generated with Coqui XTTS v2 ·
   current engine is Kokoro v1".

### Clearing drift by regenerating

5. Click Regenerate on one drifted chapter row, choose scope = `this`,
   confirm. The chapter re-renders with the active engine. On
   completion, the `chapter_complete` SSE tick carries the new
   `audioModelKey`, the row caption returns to the normal word/line/
   speaker stats, and the banner count decrements by 1.

### Clearing all drift in one click

6. Click "Regenerate all" on the drift banner. A `ConfirmDialog`
   (danger variant) opens with the count, source engine(s), and target
   engine. If a generation run is already alive, the body also carries
   a "This will interrupt the current run" line.
7. Confirm. Every drifted row flips state (head id → in_progress,
   the rest → queued); a fresh SSE opens with `chapterIds` + `force=true`
   carrying the full list. As each chapter completes, its
   `audioModelKey` matches the active engine and the banner count
   decrements. The banner disappears at zero.
8. Cancel from the dialog closes it without dispatching anything; no
   chapter state changes.

### Switching engines back

6. Switch the project engine back to the original. Every chapter that
   was rendered with the original engine now matches; drift disappears.
   Chapters rendered with the new engine in step 5 now drift. Drift is
   symmetric.

### Legacy backfill

7. Take a book whose `state.json` has chapters without `audioModelKey`
   but whose `audio/*.segments.json` files exist with `modelKey`. Open
   the book in the app. After the first scan/`getBookState` call:
   - The `state.json` on disk now has `audioModelKey` and
     `audioRenderedAt` on every chapter whose segments file carried
     them.
   - The chapter rows surface drift (or not) based on the comparison
     against the active engine.

### Edge cases

8. Excluded chapters with mismatched engines do NOT contribute to the
   banner count and do NOT show the row caption — drift only applies
   to chapters that participate in the book.
9. Chapters that have never been rendered (no audio, no segments file)
   have no `audioModelKey` and silently contribute zero drift.
10. The sticky-generation contract (plan 31): while generation is
    actively running, a user can change the picker, but the in-flight
    chapter finishes on its original engine and stamps that engine.
    The drift detector then correctly flags it the next time the user
    looks at the chapter list.

## Per-character engine reconciliation (false-drift fix, 2026-06-07)

This plan (chapter-wide drift) predated plan 108 (per-character engine
routing). The chapter stamp was the generation request's DEFAULT engine, so a
chapter whose speakers all rendered on a different engine than the project
default got a wrong stamp — classically a narration-only chapter whose narrator
carries `ttsEngine: 'qwen'`, regenerated while the project default was Kokoro:
it renders 100% on Qwen but stamped `kokoro-v1`, firing a false "Generated with
Kokoro · current engine is Qwen" badge once the project engine was set to Qwen.
The audio was correct; only the stamp lied.

Reconciliation invariants:

A. **The stamp reflects the rendered engine, not the request default.**
   `finalize-chapter-write.ts` computes a per-engine breakdown from the render
   `characterSnapshots` (each character's `renderedFallbackEngine ?? voiceEngine`)
   via `engineBreakdownFromSnapshots`, then stamps `audioModelKey` with
   `effectiveAudioModelKey`: the single engine's canonical key when the chapter
   is UNIFORM, else the request key (a single key can't represent a mixed
   chapter). Both helpers live in `server/src/audio/engine-breakdown.ts`; the
   engine→key map is the shared `canonicalModelKeyForEngine` (`model-keys.ts`),
   which also replaced generation.ts's local copy.

B. **A new per-chapter `audioEngines` map carries the breakdown** — distinct
   speaking characters per engine, e.g. `{ kokoro: 1, qwen: 6 }`. Stamped on
   render, returned on the `chapter_complete` SSE tick, persisted in
   `state.json`, and lazy-backfilled from `characterSnapshots` by
   `backfillAudioModelKeysFromSegments` (scan.ts) for legacy chapters.

C. **Mixed-engine chapters show a breakdown, not a drift warning.** A chapter
   with >1 engine in `audioEngines` is intentional (narrator on Kokoro +
   dialogue on Qwen). The Generation view (`generation.tsx`,
   `isMixedEngineChapter`) renders a neutral "Voices: Kokoro (1), Qwen (6)"
   caption (`formatEngineBreakdown`, `tts-models.ts`) and excludes the chapter
   from the drift banner / bulk-regen set. Uniform chapters keep the existing
   amber drift caption, now driven by the corrected stamp.

D. **Existing wrong stamps are repaired by
   `scripts/repair-audio-engine-stamp.mjs`** (dry-run default, `--apply`): it
   recomputes the effective engine from `characterSnapshots` and corrects
   `audioModelKey` only where it disagrees, plus backfills `audioEngines`.
   First run (2026-06-07) corrected 2 stamps (The Floodmark CH12/13, narrator-only
   Qwen chapters mis-stamped Kokoro) and set 355 breakdowns library-wide.

## Modal fidelity contract (drift-report-fidelity, 2026-05-19)

The per-character Drift Report modal (`src/modals/drift-report.tsx`) was
previously joining drift events against the static `initialChapters`
fixture, scoped to one book, and rendering only a prose "what changed"
description. Three follow-up bugs landed together:

1. **Chapter title comes from the event, not a fixture.** Every drift
   event carries `chapterTitle: string` (required) stamped server-side
   in `revisions.ts` from `seg.chapterTitle` → scan title → "Chapter N"
   fallback chain. The modal reads it directly — no chapters-slice
   lookup, which would only ever hold the active book's titles.

2. **Drift Report is multi-book.** Every drift event carries
   `bookId: string`, and the slice's `drift` field is a flat list
   across concurrently-active books. The modal groups events by
   `bookId` for rendering (one section per book, book title pulled
   from `selectEffectiveMeta(bookId)` in layout.tsx) and the header
   summary reads "{N} chapter(s) flagged across {M} books" when M > 1.
   See `selectDriftByBook` in `revisions-slice.ts`. The per-book
   `Book / <title>` sub-header always renders — even when only one
   book has drift — because the modal can be opened from any view and
   the title bar doesn't name the source book.

3. **Side-by-side profile comparison.** Each event carries `snapshot`
   (CharacterSnapshot at render time, from `<slug>.segments.json`) and
   `current` (live cast profile at poll time). The modal renders a
   `ProfileCompareCard` with rows for Voice, Gender, Age range,
   Warmth, Pace, Authority, Emotion, Attributes — both columns visible,
   the row matching `event.factor` highlighted with a `←` marker. Tone
   rows render as inline bars (reusing the pattern from
   `src/modals/profile-drawer.tsx`); attributes diff renders kept items
   muted, added items badged `+`, removed items struck-through.

### Multi-book invariants

a. **Drift event ids include `bookId`** (`drift:<bookId>:<chapterId>:<characterId>:<factor>`)
   so they stay globally unique across concurrently-active books.

b. **`applyPoll({bookId, ...response})` only replaces that book's
   events** — events from other books survive the poll. Same for
   `hydrateFromBookState({bookId, ...})`. Stamps `bookId` defensively
   onto incoming events that don't carry one (older deploys).

c. **`persistence-middleware` filters drift by active bookId before
   writing each book's revisions.json.** The flat slice list spans books,
   but each on-disk file must carry only its own events — otherwise
   re-hydration on book switch would replay another book's events.

d. **Cast slice and chapters slice stay single-book scoped.** The modal
   reads display-name + avatar color from the cast slice when the
   event belongs to the active book; for cross-book events it falls
   back to `event.current.name` and the narrator color slot.

e. **Polling is active-book only today.** Background polling of
   non-active books (so freshly-detected drift on Book B surfaces while
   the user is in Book A) is a follow-up — see BACKLOG.

## Out of scope

- **Per-character engine drift inside chapters**: the existing
  per-character drift pipeline (revisions.ts) covers within-engine voice
  swaps; cross-engine swaps are caught at chapter level by this signal.
  Going per-character per-engine would be noisy.
- **Dismissal mechanism**: drift is computed from on-disk state every
  render. There's no "snooze" — to make a drift go away the user either
  regenerates the chapter, switches engines back, or ignores the
  signal.
- **"Engine unknown" badge** for chapters with no segments file (rare
  pre-2025 renders that predate segments writing): silent rather than
  nag.
