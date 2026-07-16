# Manuscript view: visual scene-change separator — design

- **Issue:** #1679
- **Status:** approved (design)
- **Date:** 2026-07-17
- **Scope:** server (analyzer + EPUB/MOBI parser) + OpenAPI schema + frontend (manuscript view)

## Problem

The manuscript / script-review view renders consecutive scenes with **no
visual boundary**. A scene break in the source (`* * *`, dinkus `⁂`, `<hr>`)
shows as ordinary flowing text, so the reader/editor cannot see where one
scene ends and the next begins.

This is not only a polish gap — it hid a real analyzer bug. On *Ночной дозор*
(Night Watch), first-person «я» material was mis-attributed across characters,
and it was hard to spot precisely because the scenes **looked merged
together**. Scene boundaries are where attribution context resets (a new scene
can change who is present/speaking), so making them visible directly aids
spotting mis-attribution across a seam.

## Key finding that shapes the design

There is **no "scene" concept anywhere in the data model today**, and the
scene-break signal is **destroyed during analysis**:

- `Sentence` carries no section/scene marker; the parser splits only on
  *chapter* headings.
- When stage-2 chunking encounters a word-free separator line (`***`), it is
  dropped entirely — **zero sentences, no `excludeFromSynthesis` residue**
  (locked by the 2026-06-19 Night Watch ch7 regression test in
  `server/src/analyzer/stage2-chunk.test.ts`).
- The raw `sourceText` is available frontend-side, but there is **no positional
  mapping** from raw text back to individual sentences.

So the issue's premise ("read-only display; the server keeps the separator;
the view just shows it") is not true yet. Something must **carry** the
boundary from where it is known (analysis time) to the view.

### EPUB/MOBI reality (`stripHtml`)

- `<p>* * *</p>` centered-asterisk breaks → the `* * *` text **survives** as a
  word-free line. Detectable.
- `<hr>` thematic breaks → caught by the generic tag-strip and **erased
  entirely**. Not detectable today — and `<hr>` is the most common EPUB
  scene-break representation.
- CSS-styled empty-paragraph breaks → collapse to a blank gap; lost (out of
  scope regardless).

## Decisions

1. **Signal source: server-preserved metadata.** Detect scene breaks
   server-side at analysis time and persist them as additive per-sentence
   metadata. (Frontend re-derivation from `sourceText` was rejected — see
   Alternatives.)
2. **Detection scope: explicit word-free separator lines only.** A scene break
   is any body line that normalizes to zero words (`* * *`, `***`, `⁂`,
   `• • •`, `---`/`―`). Blank-gap detection is out of scope: markdown-normalized
   bodies separate every paragraph with a blank line, so a gap carries no
   reliable scene-break signal.
3. **Divider style: hairline + ornament.** Two short faint hairline rules
   flanking a centered Lora-serif `✦`, with generous vertical spacing. Reads as
   a literary scene break; uses existing `--ink` token at low opacity, no new
   color token, no hex literals.

## Design

### 1. Detection (server, analysis time)

A scene break = a **word-free separator line** in the chapter body — reusing
the exact "word-free chunk" notion the chunker already relies on for its skip
logic, so there is no new glyph taxonomy to maintain. Two pieces:

- **`stripHtml` (EPUB/MOBI path, `server/src/parsers/html-utils.ts`):** convert
  `<hr>` to a canonical word-free separator line **before** the generic
  tag-strip, so `<hr>`-style breaks survive into the body instead of being
  erased. Asterisk-paragraph breaks already survive; this closes the biggest
  real-world gap. (MOBI shares `stripHtml`, so it is covered too.)
- **Stage-2 assembly:** locate word-free separator lines in the chapter body
  relative to the ordered sentence list, and mark the sentence that immediately
  follows each break. The separator line itself still produces **no sentence**
  (unchanged — the ch7 regression test stays green); we only record that it was
  there.

**Mechanism choice deferred to the plan.** Two candidate seams, both running at
analysis time against the authoritative body (before any client edits or
audio-tag round-trips — which is why this is robust here and would be fragile
on the client): (a) emit a scene-break event from the body-splitter tied to the
next word-bearing chunk's first sentence; or (b) a post-assembly alignment pass
correlating separator-line positions with sentence ordinals. The plan selects
and justifies one.

### 2. Data model

Add one optional field to the `Sentence` schema:

```
sceneBreakBefore?: boolean   // true on the first sentence after a scene break
```

- **OpenAPI** `Sentence` schema (source of truth) + regenerate
  `src/lib/api-types.ts` via `npm run openapi:types`.
- **Persisted** in `state.json` so it survives reloads without re-analysis.
- Purely additive — absent behaves exactly as today. A break at the very
  *start* of a chapter is dropped (nothing precedes it; the chapter heading is
  already the boundary).

### 3. Rendering (frontend, `src/views/manuscript.tsx`)

**Force a segment boundary at each scene break.** In the `segments` useMemo,
start a new segment when a sentence has `sceneBreakBefore`, *even if the speaker
is unchanged*. This is the key simplifying move: a break can otherwise fall
mid-segment (narrator prose on both sides), which would force divider-drawing
inside `SegmentRow`. By splitting the segment, the divider always renders at a
segment boundary — one code path — and it visually reinforces the break (the
narration becomes two blocks).

- Each segment derives `sceneBreakBefore: boolean` from its first sentence. The
  render loop draws the **hairline + ✦** divider immediately *above* any segment
  whose flag is true (never above the first segment in the chapter).
- **Divider markup:** a centered flex row — two `flex-1` hairline rules at low
  `--ink` opacity flanking a Lora-serif `✦`, with generous vertical padding.
- **No boundary handle at a scene-break seam.** The drag-to-reassign
  `BoundaryHandle` between two segments split *only* by a scene break is
  suppressed — moving attribution across a scene break is not a meaningful edit,
  and the divider occupies that gap instead.
- **Virtualization:** the divider lives inside the segment's virtual row (above
  its content), so `measureElement` captures its true height automatically — no
  `estimateSize` retune. Identical behavior on the flat (<60 segment) path.
- **Excluded chapters** render nothing (unchanged early-return).

### 4. Edge cases

- Break before the chapter's first sentence → dropped (no leading divider).
- Manual **split** of a flagged sentence → the reducer carries
  `sceneBreakBefore` to the first resulting piece so the divider does not vanish
  on edit. **Boundary-drag** reassigns `characterId` only (never deletes
  sentences), so the flag is untouched.
- A run of consecutive separators (`* * *` then `⁂`) collapses to a single break
  (only the next word-bearing sentence is flagged).

## Testing

- **Server unit:** `stripHtml` converts `<hr>` to a surviving word-free line;
  stage-2 assembly sets `sceneBreakBefore` on the correct following sentence and
  on nothing else; the existing ch7 "no sentence for `***`" test stays green.
  Fixture: a small body with a `* * *` mid-chapter.
- **Frontend unit** (`manuscript.test.tsx`): a segment with `sceneBreakBefore`
  renders the divider; segments split at a break even for same-speaker prose; no
  divider above segment 0; no boundary handle at the seam.
- **E2E** (`e2e/`): one spec asserting the divider is visible in the manuscript
  view for a fixture book with a scene break (crosses the redux/layout seam the
  e2e bar calls for). Add a scene break to the Coalfall fixture (or its Russian
  variant) rather than inventing a new manuscript.
- **Regression plan:** new `docs/features/` doc (cross-cutting: server + schema
  + frontend); tag the issue `needs-plan`.

## Re-analysis implication (stated honestly)

The flag only populates when a book is **(re-)analyzed** — existing analyzed
books show no dividers until then. Acceptable and aligned: Night Watch, the
motivating case, is already slated for re-analysis under the analyzer fix. No
backfill/migration is attempted.

## Alternatives considered and rejected

- **Frontend re-derivation from `sourceText`** — greedy sentence↔raw-text
  alignment on the client is brittle under audio-tag rewrites and
  re-segmentation, and duplicates on every render what the server can compute
  once at analysis time.
- **Blank-gap detection** — no reliable signal in markdown-normalized bodies;
  would put a divider between every paragraph or need a fragile threshold.
- **Chapter-level break-list** instead of a per-sentence flag — the flag renders
  naturally in the existing segment loop and survives sentence-id remaps; a
  side list would need its own remap bookkeeping.

## Out of scope

- Reading-experience (listen) view — this is a manuscript/editorial affordance.
- Any change to attribution data or to synthesis (the separator remains
  non-spoken, exactly as today).
- CSS-styled/blank-gap scene breaks in EPUBs.
