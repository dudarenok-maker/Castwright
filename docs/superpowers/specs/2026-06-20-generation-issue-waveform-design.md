# Generation issue-waveform — design

- **Date:** 2026-06-20
- **Status:** draft
- **Area:** frontend (generation view + mini-player) + server (chapter-audio route / OpenAPI)
- **Suggested branch:** `feat/frontend-generation-issue-waveform`

## Problem

A rendered chapter can carry per-sentence audio-QA flags — a **too-long**
sentence, an internal **pause** (long near-silent run), or an ASR
**language mismatch** ("fluent but wrong words"). Today the generation view
collapses all of these into a single chapter-level **"Suspect" badge**
(srv-27): it tells the user _that_ a chapter has a problem but never _where_
inside the chapter the problem is, and the bottom preview player gives no way
to jump to and listen to the flagged moment.

The user wants the same waveform shown on the Listen section brought into the
generation view, with the flagged regions painted a distinct colour, and that
same highlight carried into the bottom preview player so they can scrub
straight to a flagged region and listen.

## Scope

**In:** per-segment audio/ASR QA flags (too-long, pause, language mismatch) —
the only "suspect" signal that is both per-region _and_ tied to playable
rendered audio. (The chapter-level audio-QA verdict and the analysis-stage
low-confidence attribution are explicitly out — different granularity /
different surface.)

## Why this is cheap: the data and surfaces already exist

- **Data is already on disk.** Every rendered chapter writes
  `<slug>.segments.json`. Each segment (`ChapterSegment`,
  `server/src/tts/synthesise-chapter.ts`) carries `startSec` / `endSec`
  (exact time range in the chapter) **and**, when the gates ran, `qa.reasons`
  + `suspect` (segment-qa, plan 179) and `asr` + `asrSuspect` (ASR content-QA,
  srv-31 / plan 186). So "where" and "why" are both recorded per sentence.
- **The RMS envelope is time-proportional.** `computePeaks`
  (`server/src/audio/compute-peaks.ts`) emits a 240-bin RMS envelope whose
  bins are sample-count proportional = time proportional at a single sample
  rate. So a segment's `[startSec, endSec]` maps to a contiguous bar range by
  simple arithmetic — no per-segment audio analysis needed.
- **Both target surfaces already fetch `getChapterAudio`.** The generation
  view's `ChapterSegmentStrip` (`src/views/generation.tsx`) lazy-fetches it for
  the "Narrative order" strip; the `MiniPlayer` (`src/components/mini-player.tsx`)
  fetches it for the scrubber. Both already receive `segments` (`start`/`end`)
  + `peaks` + `durationSec`.

**The only gap:** the `chapter-audio` route maps each segment to
`{ start, end, characterId, sentenceId }` and **drops `suspect` / `reasons`**.
Surfacing those two fields lights up everything downstream.

## Design

### Component 1 — Server: expose per-segment issues

`server/src/routes/chapter-audio.ts` (both the `current` and `previous`
mappers) + `openapi.yaml`.

The on-disk segment already holds the QA data; the route just stops dropping
it. Add to each published wire segment:

- `suspect?: boolean` — `Boolean(seg.suspect || seg.asrSuspect)`
- `reasons?: string[]` — short, user-facing labels derived from the segment's
  QA verdicts:
  - segment-qa "too long" → `"Long sentence"`
  - segment-qa long internal silence → `"Long pause"`
  - `asrSuspect` (WER drift) → `"Wrong words"`

  (Map from the existing `qa.reasons` strings + the `asr` verdict; keep the
  raw reason available for the tooltip if a clean short label isn't derivable.)

Add the two **optional** fields to `ChapterAudio.segments[]` in `openapi.yaml`
and regenerate `src/lib/api-types.ts` (`npm run openapi:types`). Optional →
legacy / pre-QA / splice renders simply omit them and show no issue
highlight (graceful, matches the existing `peaks: []` fallback contract).

### Component 2 — Shared `Waveform` gets an issue overlay

`src/components/waveform.tsx`. Add an optional prop:

```
issues?: Array<{ startFrac: number; endFrac: number; reason: string }>
```

`startFrac`/`endFrac` are `startSec/durationSec` and `endSec/durationSec`
(computed by the caller, so the component stays presentational). Each issue
maps to bar indices `floor(startFrac * N)` .. `ceil(endFrac * N)`; those bars
render in **amber** (Tailwind `amber-*`, matching the existing srv-27 Suspect
badge `bg-amber-100 / text-amber-800` — no raw hex) regardless of the
play-progress fill, with a per-region `title` carrying the reason + a
`m:ss–m:ss` range. When `issues` is empty/undefined the component renders
exactly as today — **the Listen view is untouched.**

Single issue colour by design (the user's "different colour"); the specific
reason lives in the tooltip, not in the bar colour.

### Component 3 — Generation row: waveform on every done chapter

`src/views/generation.tsx`. On **every `done` chapter** (consistency — the
user explicitly wants no per-chapter visual difference in the list), render the
shared `Waveform` fed by the already-fetched `peaks`, with the `issues` derived
from the chapter's flagged segments. Clean chapters show a plain waveform;
flagged chapters show the same waveform with amber issue bars. This sits
alongside the existing chapter row; the existing "Narrative order" character
strip is retained unchanged (it answers "who/order"; the waveform answers
"where/loudness/issues").

### Component 4 — MiniPlayer: waveform scrubber + jump-to-issue

`src/components/mini-player.tsx`.

- **Waveform scrubber.** Replace the thin 1-px scrubber with the shared
  `Waveform` (the player already fetches `peaks` + `segments` + `durationSec`),
  preserving click-to-seek: map click-x → fraction → `el.currentTime`, same
  math as the current `onScrub`. The progress fill drives the
  `progress`/`active` props.
- **Amber issue bars** from the same `issues` mapping as the row.
- **`⚠ ‹ prev / next ›` control** that seeks the playhead to the previous/next
  issue segment's `startSec`. Hidden when the chapter has no issues.
- **Auto-seek on open:** when the previewed chapter has ≥1 issue, land the
  playhead on the first issue's `startSec` (via the existing `pendingSeekRef`
  path) instead of 0:00.

Responsive: the waveform scrubber must still fit the 412-px mobile layout
(the existing 5-column grid). Keep the jump control compact / `min-h-[44px]`
touch target.

### Component 5 — Tests

- **Unit (`waveform.test.tsx`):** issue-fraction → amber-bar-index mapping
  (boundaries: a region at the very start, very end, and a sub-bar-width
  region still paints ≥1 bar); empty `issues` renders identically to today.
- **Server (`chapter-audio.test.ts`):** a segments fixture with `suspect` /
  `asrSuspect` / `qa.reasons` publishes `suspect: true` + the mapped
  `reasons[]`; a clean segment omits both fields.
- **Generation (`generation.test.tsx`):** a done chapter with a flagged
  segment renders the waveform with amber issue bar(s) + reason tooltip; a
  clean done chapter renders the waveform with none.
- **MiniPlayer (`mini-player.test.tsx`):** the `⚠ next` button seeks to the
  next issue's `startSec`; the jump control is absent on a clean chapter;
  opening a suspect chapter auto-seeks to the first issue.
- **E2E (`e2e/`):** open a suspect chapter's preview from the generation view,
  click "next issue", assert the playhead moved to the flagged region.

## Files touched

- `server/src/routes/chapter-audio.ts` — pass `suspect` + mapped `reasons`
  through both segment mappers.
- `openapi.yaml` — add optional `suspect` / `reasons` to
  `ChapterAudio.segments[]`; regenerate `src/lib/api-types.ts`.
- `src/components/waveform.tsx` — optional `issues` overlay prop.
- `src/views/generation.tsx` — render the waveform (with issues) on every done
  chapter.
- `src/components/mini-player.tsx` — waveform scrubber + issue bars + jump
  control + auto-seek.
- Paired tests listed above.

## Acceptance

- A chapter with a too-long sentence / long pause / ASR mismatch shows, in the
  generation list, the waveform with the flagged region(s) in amber; hovering a
  region names the reason and timecodes.
- Every done chapter shows a waveform (consistent look across the list and the
  preview); only flagged chapters show amber regions.
- Opening that chapter's bottom preview lands on the first flagged region;
  `⚠ next/prev` jumps between flagged regions; clicking the waveform seeks.
- A clean chapter shows a plain waveform with no amber and no jump control.
- The Listen view's waveform is visually unchanged.
- `npm run verify` is green.

## Non-goals

- No new endpoint — reuse `getChapterAudio`.
- No per-reason colour coding (single amber issue colour; reason in tooltip).
- No mid-render / live issue display (only `done` chapters have segments + QA).
- No change to the chapter-level "Suspect" badge or its gating, and no change
  to the Listen view.
- No re-record / repair UI from the waveform (jump-and-listen only; repair
  stays in the existing fix-character / QA-repair flows).
