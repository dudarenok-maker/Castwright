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
   `audioRenderedAt` into `state.json`** (`server/src/routes/generation.ts`
   post-render block). The stamp matches the `modelKey` passed to the
   generation route for that run.

2. **Legacy chapters are lazy-backfilled from
   `audio/<slug>.segments.json`** by
   `backfillAudioModelKeysFromSegments()` in
   `server/src/workspace/scan.ts`. The helper runs on both the library
   scan path and the per-book `findBookBy` lookup, so the first read
   after deployment upgrades the on-disk shape. Once a chapter is
   stamped the helper is a no-op for it.

3. **An existing `audioModelKey` is never overwritten by the backfill**
   — only missing fields are filled. The render path is authoritative
   for fresh writes.

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

## Critical files

- `server/src/workspace/scan.ts` — `BookStateJson.chapters[]` schema,
  `backfillAudioModelKeysFromSegments`, both call sites
  (`scanBook` and `findBookBy`)
- `server/src/routes/generation.ts` — render write path stamps the
  fields; `chapter_complete` SSE tick carries `audioModelKey`
- `openapi.yaml` — Chapter schema (`audioModelKey`, `audioRenderedAt`)
  + GenerationTick schema (`audioModelKey` on `chapter_complete`)
- `src/lib/types.ts` — frontend `BookStateJson.chapters[]` mirror
- `src/store/chapters-slice.ts` — `hydrateFromBookState` propagates
  the field; `applyGenerationTick` captures it on `chapter_complete`
- `src/views/generation.tsx` — per-row drift caption (replaces the
  static word/line/speaker meta when drifted); top-of-view banner
  counting drifted chapters

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

## Out of scope

- **Bulk "Regenerate all drifted chapters" action**: the existing
  per-chapter regenerate path handles this at the user's pace. If demand
  emerges, add a separate banner button later.
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
