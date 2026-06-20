# Generation issue-waveform — design

- **Date:** 2026-06-20
- **Status:** draft
- **Area:** frontend (generation view + app-wide mini-player + shared waveform) + server (chapter-audio route / OpenAPI)
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
same highlight carried into the bottom player so they can scrub straight to a
flagged region and listen — hearing a little **before and after** the issue,
which is how you actually judge whether audio is wrong.

## Scope

**In:** per-segment audio/ASR QA flags (too-long, pause, language mismatch) —
the only "suspect" signal that is both per-region _and_ tied to playable
rendered audio. The analysis-stage low-confidence attribution is out (different
granularity / different surface). The **chapter-level** audio-QA verdict
(whole-chapter near-silent / duration drift / LUFS) is in only as a
**fallback surface** (see Component 6) so a badge never points at a blank
waveform.

## Verified premises (adversarial review, 2026-06-20)

Both load-bearing claims were checked against the **write** path, not just the
read path:

- **Data is genuinely persisted.** `finalizeChapterAudioWrite`
  (`server/src/audio/finalize-chapter-write.ts:188`) writes `segments` as the
  full `ChapterSegment[]` — `qa.reasons`, `suspect`, `asr`, `asrSuspect` all
  included, not stripped. The route just doesn't republish them.
- **Timebase aligns.** The peaks file is computed from the **same** chapter
  `pcm` the segments' `startSec`/`endSec` index into
  (`writeChapterPeaksFile(pcm, …)`, line 202); loudnorm/encode preserves
  duration. So `startSec/durationSec → bar` is valid, lead/title/post silence
  included.

So a segment's `[startSec, endSec]` maps to a contiguous bar range by simple
arithmetic — no per-segment audio analysis needed. `computePeaks`
(`server/src/audio/compute-peaks.ts`) emits a 240-bin RMS envelope; the shared
`Waveform` reduces it to 48 bars. The coarse bar resolution is **acceptable by
design** because the highlight is a context-padded bounding box, not a
razor-precise sliver (see Component 2).

**The only server gap:** the `chapter-audio` route maps each segment to
`{ start, end, characterId, sentenceId }` and **drops `suspect` / `reasons`**.

## Design

### Component 0 — A shared "issues" derivation

A small pure helper (e.g. `src/lib/chapter-issues.ts`) turns a `ChapterAudio`
(`segments[]` + `durationSec`) into the padded issue ranges every surface
consumes, so the row, the player, and their tests share one source of truth:

```
ISSUE_CONTEXT_PAD_SEC = 2   // lead-in / lead-out so you hear before & after

deriveIssues(audio): Array<{
  startSec, endSec,          // raw flagged segment span (for the jump target math)
  startFrac, endFrac,        // PADDED + clamped → [max(0,start-PAD), min(dur,end+PAD)] / dur
  seekSec,                   // max(0, startSec - PAD) — where prev/next + auto-seek land
  reasons: string[],         // verbatim from the segment (see Component 1)
}>
```

The **pad bounds the issue inside the coloured region** (the flagged sentence
always sits within the amber band with margin) and makes the jump land *before*
the issue so playback runs up into it and through its tail. Precision of
*playback* is preserved (seek is continuous, below); only the *visual* band is a
forgiving bounding box.

### Component 1 — Server: expose per-segment issues

`server/src/routes/chapter-audio.ts` (both the `current` and `previous`
mappers) + `openapi.yaml`. The on-disk segment already holds the QA data; the
route just stops dropping it. Add to each published wire segment:

- `suspect?: boolean` — `Boolean(seg.suspect || seg.asrSuspect)`
- `reasons?: string[]` — the segment's **raw** reason strings, concatenated
  from `seg.qa?.reasons` (segment-qa) and `seg.asr?.reasons` (ASR), passed
  through **verbatim**. (No short-label remapping: the reason strings are full
  sentences and string-matching them to coin `"Long sentence"` is brittle —
  show the real reason in the tooltip instead. _Adversarial fix #3._)

Add the two **optional** fields to `ChapterAudio.segments[]` in `openapi.yaml`
and regenerate `src/lib/api-types.ts` (`npm run openapi:types`). Optional →
legacy / pre-QA / splice renders simply omit them and show no issue highlight
(graceful, matches the existing `peaks: []` fallback contract).

### Component 2 — Shared `Waveform` gets an issue overlay

`src/components/waveform.tsx`. Add an optional prop:

```
issues?: Array<{ startFrac: number; endFrac: number; reason: string }>
```

(fed by Component 0 — already padded/clamped). Each issue maps to bar indices
`floor(startFrac * N)` .. `ceil(endFrac * N)`; those bars render in **amber**
(Tailwind `amber-*`, matching the existing srv-27 Suspect badge
`bg-amber-100 / text-amber-800` — no raw hex) regardless of the play-progress
fill, with a per-region `title` carrying the reason + a `m:ss–m:ss` range.
Single issue colour by design (the user's "different colour"); the reason lives
in the tooltip.

**Empty-peaks guard (_adversarial fix #7_):** the component already falls back
to a decorative seeded bar shape when `peaks` is empty. Painting amber onto a
*fake* shape would mislead, so the **caller** only passes `issues` when real
`peaks` are present; with no peaks, no amber (the chapter-level badge still
conveys "suspect" textually). When `issues` is empty/undefined the component
renders exactly as today.

### Component 3 — Generation row: waveform on every done chapter

`src/views/generation.tsx`. On **every `done` chapter** (consistency — the user
explicitly wants no per-chapter visual difference in the list or the preview),
render the shared `Waveform` fed by the already-fetched `peaks`, with `issues`
from Component 0. The existing **"Narrative order" character strip is retained
unchanged** (it answers "who/order"; the waveform answers "where/loudness/
issues") — both strips, the surgical choice that removes no existing
diagnostic. The data is already fetched by `ChapterSegmentStrip`'s
`getChapterAudio` call, so the waveform adds no new request.

### Component 4 — App-wide player: waveform scrubber + jump-to-issue

`src/components/mini-player.tsx`. **This is a single, app-wide player** —
`layout.tsx:1378` mounts ONE `MiniPlayer` at the bottom of every stage,
including the **Listen view**. The decision (confirmed) is to show the new
affordances **everywhere**, with one guard:

- **Waveform scrubber** replaces the thin 1-px scrubber (the player already
  fetches `peaks` + `segments` + `durationSec`). Click-to-seek stays
  **continuous** — `clientX / width → fraction → el.currentTime`, exactly the
  current `onScrub` math — so seek precision is unaffected by the 48-bar
  visual. The progress fill drives the `progress`/`active` props.
- **Amber issue bars** (Component 0) — shown in both the generation preview and
  Listen.
- **`⚠ ‹ prev / next ›` control** that seeks the playhead to the previous/next
  issue's `seekSec` (= `startSec − PAD`), so you land *before* the flagged
  audio. Hidden when the chapter has no issues. Shown in both contexts.
- **Auto-seek-before-first-issue is context-gated (_adversarial fix #1/#2_).**
  The MiniPlayer already hijacks `pendingSeekRef` to resume the listener's last
  position. Auto-seek must NOT fight that in Listen. `layout.tsx` derives the
  context from `ui.stage` and passes a prop (e.g. `autoSeekToIssues`):
  **true only in the generation/preview context**, false in Listen. In Listen
  the resume bookmark wins; in preview the player opens on the first issue's
  `seekSec`.

Responsive: the waveform scrubber must still fit the 412-px mobile grid; the
jump control stays compact with a `min-h-[44px]` touch target.

### Component 5 — Chapter-level-suspect fallback (_adversarial fix #4_)

A chapter can be "Suspect" from **whole-chapter** signals (near-silent,
duration drift, LUFS) that have no per-segment location — so the waveform would
show the badge's chapter but **no amber**, reading as "it says suspect, where?"
When `chapter.audioQa?.status === 'suspect'` **and** no segment carries
`suspect`/`asrSuspect` (no per-region issues), render a subtle **whole-track
amber baseline tint** under the waveform with a tooltip carrying
`chapter.audioQa.reasons` (already on the wire — no new data). This keeps the
badge and the waveform consistent without inventing a fake region.

### Component 6 — Tests

- **Unit (`chapter-issues.test.ts`):** padding/clamp math — an issue near 0:00
  clamps `startFrac` to 0; near the end clamps `endFrac` to 1; a sub-bar-width
  issue still yields ≥1 amber bar; `seekSec = max(0, startSec − PAD)`.
- **Unit (`waveform.test.tsx`):** issue-fraction → amber-bar-index mapping;
  empty `issues` renders identically to today; no amber when `peaks` is empty.
- **Server (`chapter-audio.test.ts`):** a segments fixture with `suspect` /
  `asrSuspect` / `qa.reasons` / `asr.reasons` publishes `suspect: true` + the
  verbatim merged `reasons[]`; a clean segment omits both fields.
- **Generation (`generation.test.tsx`):** a done chapter with a flagged segment
  renders amber bars + reason tooltip; a clean done chapter renders a plain
  waveform; a chapter-level-only suspect renders the baseline tint, not bars.
- **MiniPlayer (`mini-player.test.tsx`):** `⚠ next` seeks to the next issue's
  `seekSec` (before the segment, not at it); jump control absent on a clean
  chapter; **auto-seek fires in the preview context and is suppressed in Listen
  (resume bookmark wins).**
- **E2E (`e2e/`):** open a suspect chapter's preview from the generation view,
  click "next issue", assert the playhead moved to just before the flagged
  region.

## Files touched

- `server/src/routes/chapter-audio.ts` — pass `suspect` + verbatim `reasons`
  through both segment mappers.
- `openapi.yaml` — add optional `suspect` / `reasons` to
  `ChapterAudio.segments[]`; regenerate `src/lib/api-types.ts`.
- `src/lib/chapter-issues.ts` (new) — padded-issue derivation + `PAD` constant.
- `src/components/waveform.tsx` — optional `issues` overlay prop.
- `src/views/generation.tsx` — waveform (with issues) on every done chapter +
  chapter-level-suspect baseline tint; keep the narrative-order strip.
- `src/components/mini-player.tsx` — waveform scrubber + issue bars + jump
  control + context-gated auto-seek.
- `src/components/layout.tsx` — derive + pass `autoSeekToIssues` from `ui.stage`.
- Paired tests listed above.

## Acceptance

- A chapter with a too-long sentence / long pause / ASR mismatch shows, in the
  generation list, the waveform with the flagged region(s) in amber, **bounding
  the issue with ~2 s of margin each side**; hovering names the real reason and
  the timecodes.
- Every done chapter shows a waveform (consistent look across the list and the
  player); only flagged chapters show amber regions.
- In the generation preview, opening a flagged chapter lands the playhead
  **just before** the first issue; `⚠ next/prev` jumps to just before each
  region; clicking the waveform seeks continuously.
- In the **Listen** view the same waveform + amber bars + `⚠` jump appear, but
  opening a chapter still **resumes the last listened position** (auto-seek
  suppressed).
- A chapter flagged suspect only at the whole-chapter level shows the amber
  baseline tint (with reasons in the tooltip), never a blank "where is it?".
- A clean chapter shows a plain waveform with no amber and no jump control.
- `npm run verify` is green.

## Non-goals

- No new endpoint — reuse `getChapterAudio`.
- No per-reason colour coding (single amber issue colour; reasons in tooltip).
- No mid-render / live issue display (only `done` chapters have segments + QA).
- No change to the chapter-level "Suspect" badge or its gating, and no change
  to the Listen view's **resume** behaviour (the waveform/affordances are
  additive there; the resume bookmark still wins on open).
- No re-record / repair UI from the waveform (jump-and-listen only; repair
  stays in the existing fix-character / QA-repair flows).
- No higher-resolution (240-bin) waveform variant — the context-padded bounding
  box makes 48 bars sufficient.
