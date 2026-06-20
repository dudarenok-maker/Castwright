# Generation issue-waveform — design

- **Date:** 2026-06-20
- **Status:** draft
- **Area:** frontend (generation view + app-wide mini-player + shared waveform + layout) + server (chapter-audio route / OpenAPI)
- **Suggested branch:** `feat/frontend-generation-issue-waveform`

## Problem

A rendered chapter can carry per-sentence audio-QA flags — a **too-long**
sentence, an internal **pause** (long near-silent run), or an ASR
**language mismatch** ("fluent but wrong words"). Today the generation view
collapses all of these into a single chapter-level **"Suspect" badge**
(srv-27): it tells the user _that_ a chapter has a problem but never _where_
inside the chapter the problem is, and the bottom player gives no way to jump
to and listen to the flagged moment.

The user wants the same waveform shown on the Listen section brought into the
generation view, with the flagged regions painted a distinct colour, and that
same highlight carried into the bottom player so they can scrub straight to a
flagged region and listen — hearing a little **before and after** the issue,
which is how you actually judge whether audio is wrong.

## Scope

**In:** per-segment audio/ASR QA flags (too-long, pause, language mismatch) —
the only "suspect" signal that is both per-region _and_ tied to playable
rendered audio. The analysis-stage low-confidence attribution is out. The
**chapter-level** audio-QA verdict (whole-chapter near-silent / duration drift
/ LUFS) is in only as a **distinct fallback surface** (Component 5) so a badge
never points at a blank waveform.

## Verified premises (two adversarial passes, 2026-06-20)

Re-confirmed against the **write** path and independently re-checked:

- **Data is persisted.** `finalizeChapterAudioWrite`
  (`server/src/audio/finalize-chapter-write.ts:188`) writes `segments` as the
  full `ChapterSegment[]` — `qa.reasons`, `suspect`, `asr`, `asrSuspect`
  included.
- **Timebase aligns.** The peaks file is computed from the **same** chapter
  `pcm` the segments' `startSec`/`endSec` index into
  (`writeChapterPeaksFile(pcm, …)`, line 202); loudnorm/encode preserves
  duration. So `startSec/durationSec → bar` is valid, silences included.
- **Client already has the rest.** `ChapterAudio` carries
  `segments[].start/end` + `peaks` + `durationSec` (`openapi.yaml`), and the
  frontend `Chapter` carries `audioQa` (`src/lib/types.ts:334`) on the wire.

`computePeaks` emits a 240-bin RMS envelope; the shared `Waveform` reduces it
to 48 bars. The coarse bar resolution is acceptable because the highlight is a
context-padded, **merged** bounding box, not a razor sliver (Component 0).

**Two real server-side gaps** (not "just stop dropping it"): the
`chapter-audio` route declares its **own narrow** `ChapterSegmentsFile.segments[]`
mirror (`server/src/routes/chapter-audio.ts:101-115`) that omits the QA fields,
and it maps segments in **two** places (`current` ~`:210`, `previous` ~`:252`).
Both the type and both mappers must change.

## Design

### Component 0 — Shared, merged issue derivation

A pure helper `src/lib/chapter-issues.ts` (justified: three consumers — the
row, the player, and their tests — share one non-trivial padding/merge math):

```
ISSUE_CONTEXT_PAD_SEC = 2   // lead-in / lead-out so you hear before & after

deriveIssues(audio): IssueRegion[]   // memoised by the callers
```

Steps:
1. Take each segment with `suspect === true`, raw span `[startSec, endSec]`,
   `reasons[]`.
2. **Pad** each by `PAD` each side, clamped to `[0, durationSec]`.
3. **Merge** overlapping/abutting padded ranges into one region —
   concatenating their `reasons[]`, keeping the **earliest** `seekSec`. _(Fix
   2B: adjacent flags — a long-pause sentence next to the too-long one that
   caused it — must not produce overlapping bands or two jump-stops a hair
   apart.)_
4. Each merged region exposes `{ startFrac, endFrac, seekSec, reasons[] }`
   where `seekSec = max(0, rawStartSec − PAD)` (jump/auto-seek land *before*
   the issue).

**Degenerate guard (Fix 3B):** if a (merged) padded region would cover
≈the whole track (`2·PAD ≥ durationSec`, or the issue itself spans most of the
chapter), emit **no** distinct band — fall through to the Component 5
whole-track treatment so we never paint a meaningless full wash.

### Component 1 — Server: expose per-segment issues

`server/src/routes/chapter-audio.ts` + `openapi.yaml`.

- **Widen the route's local `ChapterSegmentsFile['segments']` type** to include
  the optional `qa` / `suspect` / `asr` / `asrSuspect` fields (or import the
  canonical `ChapterSegment`), then read them in **both** the `current` and
  `previous` mappers. _(Fix A4/B1 — the fields exist on disk but aren't typed
  in the route's local mirror.)_
- Add to each published wire segment:
  - `suspect?: boolean` — `Boolean(seg.suspect || seg.asrSuspect)`
  - `reasons?: string[]` — `seg.qa?.reasons` (when `seg.suspect`) **plus
    `seg.asr?.reasons` ONLY when `seg.asrSuspect === true`.** _(Fix A3 — the
    deepest bug: `seg.asr.reasons` carries non-issue noise like "Not scored —
    under the N-char ASR floor" / "Transcript untrustworthy" for **inconclusive**
    ASR; including it verbatim would surface fake issues on a segment that's
    suspect for an unrelated reason.)_
- The **`previous` mapper is load-bearing, not cosmetic parity:** the preserved
  `previous.segments.json` is a renamed prior **full** render, so it carries
  real per-segment QA — surfacing it lights up issues in the A/B revision-diff
  audition.

Add the two **optional** fields to `ChapterAudio.segments[]` in `openapi.yaml`;
regenerate `src/lib/api-types.ts`. Optional → legacy / pre-QA renders omit them
and show no highlight (graceful, matches the `peaks: []` contract).

### Component 2 — Shared `Waveform` gets an issue overlay (+ a11y)

`src/components/waveform.tsx`. Add optional `issues?: IssueRegion[]` (padded +
merged by Component 0). Each region maps to bars
`floor(startFrac·N)`..`ceil(endFrac·N)`, rendered **amber** (Tailwind `amber-*`,
matching the srv-27 badge — no raw hex).

**Accessibility (Fix B6 — the `verify` gate runs axe-core `test:a11y`):** amber
must NOT be the *sole* signal. The bars stay decorative `aria-hidden`, and the
semantics ride on **non-colour, focusable** affordances:
- a visible **`⚠ N issue(s)`** label/glyph beside the waveform (text, not
  colour);
- the `⚠ prev/next` control (Component 4) is a real `<button>` whose
  `aria-label` names the destination (`"Jump to issue at 0:42 — long sentence"`);
- an off-screen (`sr-only`) list "Issue at m:ss: <reason>" per region.

Reason text still appears in a hover `title` for sighted mouse users, but it is
no longer the only channel. Empty/undefined `issues` → renders exactly as today.

### Component 3 — Generation row: waveform on every done chapter

`src/views/generation.tsx`. On **every `done` chapter** (the user's call — no
per-chapter visual difference), render the shared `Waveform` from the
already-fetched `peaks` with `useMemo`'d `deriveIssues(audio)`. Keep the
existing **"Narrative order" character strip** unchanged (who/order) alongside
the waveform (where/issues) — surgical, removes no diagnostic, and the data is
already fetched by `ChapterSegmentStrip` (no new request; ~48 extra spans/row,
acceptable, memoised).

**Peakless-but-`done` chapters (Fix A8 + #7):** when `peaks` is empty
(legacy / pre-plan-56), do **not** paint the decorative seeded `BARS` shape
(it would be a fake waveform with fake amber). Keep the **existing
narrative-order strip only** for those rows. Real peaks → real waveform +
issues; no peaks → strip-only.

### Component 4 — App-wide player: waveform scrubber + jump-to-issue

`src/components/mini-player.tsx` + `src/components/layout.tsx`. **One app-wide
player:** `layout.tsx:1377` mounts a single `MiniPlayer` whenever
`stage.kind === 'ready'` (so it rides across the `generate`/`listen`/`cast`/
`manuscript` views). Decision: affordances **everywhere**, with auto-seek
gated.

- **Waveform scrubber.** Replace the thin scrubber with the shared `Waveform`,
  but **overlay the existing continuous progress fill + `scrubber-thumb`** on
  top of the bar layer (Fix A6 — bars alone drop position feedback to ~2%
  granularity; keep the fine fill, and preserve the `scrubber-thumb` testid so
  player tests don't break). Click-to-seek stays **continuous**
  (`clientX/width → fraction → el.currentTime`, the current `onScrub` math at
  `mini-player.tsx:578-585` — unchanged).
- **New wiring (Fix A7 — the player does NOT read `audio.segments` today).**
  Read `audio.segments`, run `deriveIssues`, hold a **current-issue index**;
  `⚠ ‹ prev / next ›` seeks to the adjacent region's `seekSec` via a direct
  `el.currentTime` set (the skip-button pattern). Hidden when no issues.
- **Context-gated auto-seek (Fix A1/A5/B5 — the central gate).** `layout.tsx`
  already computes `view = stage.kind==='ready' ? stage.view : null`
  (`:174`). Pass `autoSeekToIssues = (view === 'generate')`. **Generate &
  listen are both `kind:'ready'` — the discriminator is `stage.view`, not the
  kind.** `cast`/`manuscript` inherit `false`. Trigger **once per chapter-open**
  (in the `onLoadedMetadata` path), never on a view toggle for an
  already-loaded chapter — otherwise it would yank the playhead mid-listen.
  **Priority:** in the `generate` context with ≥1 issue, the first issue's
  `seekSec` **wins over** the resume bookmark (QA intent); elsewhere the resume
  bookmark wins and there is no auto-seek.
- **Out of scope:** the Listener-preview surface (`preview-listener.tsx`) has
  **no** MiniPlayer (layout returns it before the player block) and feeds its
  own `Waveform` a decorative `progress` with no `peaks` — it stays decorative,
  untouched.

**Mobile (Fix B9/B10).** The 412 px grid already `hidden md:block`s the title /
marker / sleep / volume controls to fit. Desktop shows `‹ prev / next ›`; on
phone collapse to a **single compact `⚠` next-issue button** (cycles through
regions) occupying one freed slot, ≥44 px. The generation-row waveform is
full-width (fine on phone). Note the **Listen-row** waveform is already
`hidden md:block` (`listen-player-region.tsx`), so amber-in-Listen is
desktop-only in v1 (not unhiding the phone Listen waveform here).

### Component 5 — Chapter-level-suspect fallback (distinct surface)

When `chapter.audioQa?.status === 'suspect'` **and** no segment carries a
per-region issue (whole-chapter near-silent / duration drift / LUFS), render a
**thin amber baseline underline** beneath the waveform (visually distinct from
the full-height per-segment bars — _user's call: keep, but don't let the two
amber semantics read identically_), with a tooltip + `sr-only` text from
`chapter.audioQa.reasons` (already on the wire — no new data). This keeps the
badge and the waveform consistent without inventing a fake region.

### Component 6 — Tests

Honest about what jsdom can and can't cover (Fix B4):
- **Unit (`chapter-issues.test.ts`):** pad/clamp; **merge** of two issues within
  `2·PAD` into one region (reasons concatenated, earliest `seekSec`);
  `seekSec = max(0, startSec−PAD)`; the **degenerate** `2·PAD ≥ duration` case
  emits no band.
- **Unit (`waveform.test.tsx`):** issue-fraction → amber-bar mapping; empty
  `issues` renders identically; no amber when `peaks` empty; `aria-hidden` bars
  + the visible `⚠ N issues` affordance present.
- **Server (`chapter-audio.test.ts`):** a `suspect` + `qa.reasons` segment whose
  ASR is **inconclusive** publishes only the segment-QA reasons (no ASR noise);
  an `asrSuspect` segment includes the ASR reasons; a clean segment omits both
  fields; the `previous` mapper carries them too.
- **Generation (`generation.test.tsx`):** flagged done chapter → amber bars +
  accessible reason; clean done chapter → plain waveform; peakless done chapter
  → strip-only (no waveform); chapter-level-only suspect → baseline underline,
  not bars.
- **MiniPlayer (`mini-player.test.tsx`):** `⚠ next` sets `currentTime` to the
  next region's `seekSec` (direct-set, unit-testable like skip-fwd/back); jump
  control absent on a clean chapter; **resume-vs-auto-seek priority** — in
  `generate` with a resume bookmark present, first-issue wins; in `listen`,
  bookmark wins and no auto-seek. (Continuous waveform **click**-seek uses
  `getBoundingClientRect`, which is zero in jsdom — that path is **e2e-only**,
  same gap the current scrubber already has.)
- **E2E (`e2e/`):** open a suspect chapter's preview from the generation view →
  click "next issue" → playhead lands just before the region; one case added to
  `e2e/responsive/coverage.spec.ts` at a phone viewport for the compact `⚠`
  jump.

## Files touched

- `server/src/routes/chapter-audio.ts` — widen local segment type; pass
  `suspect` + gated `reasons` through both mappers.
- `openapi.yaml` — optional `suspect` / `reasons` on `ChapterAudio.segments[]`;
  regenerate `src/lib/api-types.ts`.
- `src/lib/chapter-issues.ts` (new) — padded + merged issue derivation, `PAD`.
- `src/components/waveform.tsx` — `issues` overlay + a11y affordances.
- `src/views/generation.tsx` — waveform on every (peakful) done chapter, keep
  narrative strip, Component 5 baseline underline, memoised derivation.
- `src/components/mini-player.tsx` — waveform scrubber (progress fill + thumb
  overlay), issue bars, `⚠` jump, context-gated auto-seek, mobile compact jump.
- `src/components/layout.tsx` — pass `autoSeekToIssues = (stage.view==='generate')`.
- Paired tests above.

## Acceptance

- A chapter with a too-long sentence / long pause / ASR mismatch shows, in the
  generation list, the waveform with the flagged region(s) in amber, bounding
  the issue with ~2 s of margin each side (where the chapter is long enough),
  adjacent flags **merged** into one band; the reason is reachable by hover
  **and** by the accessible `⚠`/`sr-only` text.
- A segment that is suspect for a segment-QA reason but whose ASR was
  inconclusive shows **only** the segment-QA reason — no "Not scored" noise.
- Every peakful done chapter shows a waveform; peakless done chapters keep the
  strip only.
- In the generation preview, opening a flagged chapter lands the playhead
  **just before** the first issue (over any resume bookmark); `⚠ next/prev`
  jumps to just before each region; clicking the waveform seeks continuously.
- In the **Listen** view the waveform + amber + `⚠` jump appear (desktop), but
  opening a chapter still **resumes the last position** (auto-seek suppressed).
- A whole-chapter-only suspect shows the thin amber baseline underline (reasons
  in tooltip + `sr-only`), never a blank "where is it?".
- `npm run verify` is green (incl. `test:a11y`).

## Non-goals

- No new endpoint — reuse `getChapterAudio`.
- No per-reason colour coding (single amber; reasons in tooltip + `sr-only`).
- No mid-render / live issue display (only `done` chapters have segments + QA).
- No change to the Listen view's **resume** behaviour (the amber overlay + jump
  are additive there); no unhiding the phone Listen waveform in v1.
- No issue overlay on the decorative Listener-preview (`preview-listener.tsx`)
  waveform (no real peaks, no player).
- No re-record / repair UI from the waveform (jump-and-listen only).
- No higher-resolution (240-bin) waveform — the merged, context-padded bounding
  box makes 48 bars sufficient.
