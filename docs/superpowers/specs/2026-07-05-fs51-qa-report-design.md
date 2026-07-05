---
status: draft
date: 2026-07-05
topic: fs-51 — per-book performance-QA report (visible + exportable acoustic+ASR+drift summary)
issue: fs-51 (#973)
depends_on: none (see "Correcting the srv-36 dependency" below — the issue's stated dependency is stale)
relates_to: srv-36 Phase 1 (#665, shipped — supplies the voice-match row) · srv-31 (ASR content-QA / SEG-ASR gate) · plan 179 (signal-QA) · srv-27 (audio-qa.ts loudness/duration gate) · revisions.ts (config-drift)
---

# fs-51 — Per-book performance-QA report

## Context

The generation pipeline already runs four independent QA/drift checks per
book — signal-QA, ASR content-QA ("SEG-ASR"), srv-36 acoustic voice-drift
("SEG-SPK"), and cast-config drift — but none of it is aggregated or shown to
the user. Each check's output is either ephemeral (SSE ticks), buried in a
per-chapter waveform, or sitting in an on-disk file nobody reads
(`deriveBookOutline()` for srv-36 is fully built and tested but has zero
callers). fs-51 turns these into one per-book report: visible in the app,
exportable, and — per the brand's own "Proof, not promises" claim — the
literal evidence for Castwright's core quality claim: *every line is
acoustically checked, transcript-verified, and drift-checked before a chapter
is assembled, automatically, every time.* This report is where that promise
gets shown, not just stated. It's `moscow:must` for the beta→full-product
spine specifically because it's a brand differentiator, not just a debugging
aid.

**Correcting the srv-36 dependency.** The GitHub issue says fs-51 "depends on
srv-36 (drift-threshold calibration)." That framing is stale: it was written
the same day as srv-36's own spec, which explicitly decouples the two —
srv-36 Phase 1 (the acoustic ECAPA voice-match check) has since shipped and
been calibrated (merged `372eeeae`, PR #987; cutoffs tuned 2026-06-22,
27/27 held-out flags confirmed real drift, 0 false positives). fs-51 is not
blocked on anything. It ships against the QA signals that already exist;
srv-36's voice-match row is one of those signals, present when the gate ran
for a given book and absent (not zero) when it didn't. srv-36 Phase 2
(cross-book/series consistency) is still `status: draft` and out of scope
here entirely.

## Architecture

One new read endpoint aggregates everything, computed fresh on every call —
nothing new is persisted as a running summary:

```
GET /api/books/:bookId/qa-report → BookQaReport
```

It reads four existing sources, per chapter:

1. **Signal-QA** (`<slug>.segments.json`, plan 179) — near-silent/truncated/
   runaway-duration flags, via the existing `loadSegmentsFiles()`
   (`server/src/audio/segments-io.ts`).
2. **ASR content-QA / SEG-ASR** (`<slug>.segments.json`, srv-31) — transcript
   drift flags, same file, gated by `SEG_ASR_ENABLED`.
3. **Voice drift / SEG-SPK** (`<slug>.render-integrity.json`, srv-36 Phase 1)
   — via `deriveBookOutline()` (`server/src/audio/render-integrity/verdicts-io.ts`),
   already implemented and unit-tested, currently uncalled from any route.
   Gated by `SEG_SPK_ENABLED`.
4. **Config drift** (the server-side equivalent of `revisions-slice`'s
   `DriftEvent[]`) — cast/voice reassignment drift, severity mild/moderate/
   severe. Always on, no gate.

**Gate-enabled detection is presence-based, not config-based.** Whether
`asr`/`voiceDrift` show real numbers or the "not enabled" state is decided by
whether the relevant per-segment/per-chapter data exists for *that book's
render* (`seg.asr != null` anywhere; `<slug>.render-integrity.json` exists
for any rendered chapter) — not by reading the current value of
`SEG_ASR_ENABLED`/`SEG_SPK_ENABLED`. A book rendered before a gate was
flipped on correctly shows "not enabled for this book" even if the gate is
on globally today.

**One schema addition**: an integer `qaRetries` / `asrRetries` field on each
segment record in `segments.json`, incremented in the existing re-record
loop in `synthesise-chapter.ts` (where `segmentQaByIndex`/`segmentAsrByIndex`
already get refreshed each round) and written at the same finalize step that
already persists `segments.json`
(`server/src/audio/finalize-chapter-write.ts`). This is what makes "N lines
re-recorded" an honest attempt-count instead of a "still flagged" proxy —
without it, only the final verdict survives and a retry that *fixed* a line
would be invisible.

The endpoint is the single source of truth for both display and export — no
separate export endpoint. Both the Listen-view card and the live
Generation-view panel call the same `GET`, so "numbers reconcile with the
underlying gate output" holds by construction rather than by convention.

## Report schema

```
BookQaReport {
  bookId, generatedAt, chaptersRendered, chaptersTotal,
  acoustic:    { linesChecked, linesRerecorded, chaptersFlagged },
  asr:         { enabled, linesVerified, linesFlaggedDrift },
  voiceDrift:  { enabled, chaptersScored, mismatches: [{ characterId, chapterId, severity, fixable }] },
  configDrift: { counts: { mild, moderate, severe }, events: DriftEvent[] },
}
```

`asr.enabled` / `voiceDrift.enabled` are `false` when the gate didn't run for
this book (see presence-based detection above) — the UI shows an explicit
"not run for this book" line rather than a bare `0`, so a clean gate result
is never confused with a gate that never fired. `acoustic` and `configDrift`
have no enable flag; they always run.

**Field definitions** (to remove any ambiguity about what each count means):
- `acoustic.linesRerecorded` — segments where `qaRetries > 0` (the signal-QA
  gate required at least one retry, regardless of the final verdict).
- `acoustic.chaptersFlagged` — chapters containing at least one segment still
  `suspect` after every retry attempt was exhausted.
- `asr.linesVerified` — segments where `seg.asr` is present (ASR actually
  ran against that line), independent of the verdict.
- `asr.linesFlaggedDrift` — segments where the final ASR verdict is `'drift'`
  (`asrSuspect === true`), i.e. still flagged after every retry.

`openapi.yaml` gets the new `BookQaReport` schema + the `GET
/api/books/{bookId}/qa-report` path; `npm run openapi:types` regenerates
`src/lib/api-types.ts` from it, per the existing convention.

## UX/UI presentation — the brand moment

This is the surface where Castwright's core quality claim becomes evidence,
not marketing copy — "we promised, we delivered" made literal and specific
to *this* book. That governs every choice below.

**Frame it as a receipt, not a stats table.** The card's hero line follows
the brand's own headline rule (medium-weight sentence, one bold span
carrying the meaning), driven by the real numbers:
- Clean book: *"Every line **held**."*
- Issues found: *"**3** lines needed a second take."*
- Mid-generation (Generation view): *"Checking as it renders — **6 of 12**
  chapters done so far."* — candid about partial coverage, never a premature
  verdict.

Subhead adapted from the brand's canonical "Proof, not promises" line rather
than invented fresh: *"Checked, verified, and matched against every
character's own voice — automatically, before this book reached you."*

**Four parallel receipts, not a numbered sequence** — these are independent
gates, not ordered steps, so no 01/02/03 markers:

| Row | Copy pattern (on) | Copy pattern (off) |
|---|---|---|
| Acoustic | "342 lines checked, 0 needed a second take." | *(always on)* |
| Transcript (SEG-ASR) | "342 lines verified against what Whisper heard, 0 flagged." | "Not run for this book — turn on transcript verification before your next render." |
| Voice match (SEG-SPK) | "18 characters checked against their own reference take, 0 mismatches." | "Not run for this book — flip on render-integrity checking to catch mismatches automatically." |
| Cast continuity (config drift) | Severity-coded counts, reusing the exact `Pill` colours (`danger`/`warning`/`neutral`) already established in `drift-report.tsx`; a flagged line deep-links into that same modal rather than duplicating its compare view. | *(always on)* |

Off-state copy is an invitation, not an apology or a warning — matches the
brand's empty-state register ("an empty screen is an invitation to act").

**Deliberate restraint, twice over:**
- **No deep-purple on the voice-match row.** Deep purple's defined job is
  cross-book/library reuse (`visual-system.md` §Colours); this check is
  chapter-to-chapter *within* one book, so using it here would dilute the
  token. It's the correct color once srv-36 Phase 2 (cross-book consistency)
  ships — reserved, not used yet.
- **No new gradient spend.** The signature 4-stop gradient is already used
  on this page (the cover-art hero in `listen-header.tsx`); per the brand's
  own scarcity rule ("no more than three uses per page... scarcity is what
  keeps it recognisable"), this card stays in the existing disciplined
  white-card chrome (`bg-white rounded-3xl border border-ink/10
  shadow-card`, matching `LoudnessReport`). The card earns attention through
  confident, specific copy and structural clarity, not another decorative
  flourish.

**Export doubles as word-of-mouth.** The text export is written to be
legible pasted verbatim into a Discord message or forum post — a real,
unforced "proof receipt" a reader could show someone, in the same
benchmark-forward register the brand already trusts from the maintainer
voice:

```
The Coalfall Commission — Castwright quality gate
Every line held.
· Acoustic — 342 lines checked, 0 needed a second take
· Transcript — 342 lines verified, 0 flagged
· Voice match — 18 characters checked, 0 mismatches
· Cast continuity — 0 changes since render
```

The JSON export is the `BookQaReport` object re-serialized verbatim.

## Frontend surfaces

One shared presentational component (`QaReportCard`) + one fetch hook
(`useQaReport(bookId)`):

- **Listen view** (`src/views/listen.tsx`) — mounted as a new sibling
  section (not folded into the existing `LoudnessReport`, which stays as the
  acoustic-only detail view). Fetched once on mount.
- **Generation view** (`src/views/generation.tsx`) — same component,
  refetched whenever a `chapter_complete` event lands (already tracked in
  this view's activity feed) rather than on a blind poll interval.

## Export mechanics

Client-side only, reusing the existing Blob-download pattern from
`share-card-modal.tsx` (`downloadJson`-style helper). JSON export
re-serializes the already-fetched `BookQaReport`; text export is a small
formatter producing the shape shown above from the same object. No server
round-trip beyond the one `GET` — display data and exported data are
identical by construction.

## Error handling & edge cases

- Report fetch failure → quiet "QA report unavailable" inline state; never
  blocks the Listen or Generation view. This is a value-add surface, not a
  gate on anything.
- Partially-generated book → `chaptersRendered`/`chaptersTotal` makes
  partial coverage explicit rather than implying a full-book verdict.
- Mixed-engine chapters and Kokoro-voiced characters are already excluded
  from voice-drift scoring upstream (`STOCHASTIC_ENGINES` filter in
  `aggregate.ts`); the report just reflects that, no special-casing needed.
- No staleness/re-fetch logic beyond "derive on read" — a regenerated
  chapter's files are simply the new ground truth on the next call.

## Testing

- **Server**: unit tests for the aggregation function against fixture
  `segments.json`/`render-integrity.json`/state.json combinations (all
  gates on, all off, partial-book render); a route test for the endpoint; a
  regression test that the re-record loop actually increments
  `qaRetries`/`asrRetries`.
- **Frontend**: component tests for `QaReportCard` across the
  enabled/disabled/no-data/mid-generation permutations, including the
  off-state copy and the severity-coded cast-continuity row.
- **E2E**: one Playwright spec covering the Listen-view card and both export
  buttons, backed by a new mock `BookQaReport` fixture in `src/data/`
  (mocks are the default e2e mode).

## Out of scope

- srv-36 Phase 2 (cross-book/series voice consistency) — still `status:
  draft`, no production code exists. No consistency row until it ships.
- Any change to when/whether the underlying gates run — this report only
  aggregates and presents existing signals.
- A dedicated "QA history over time" view (trend across regenerations) —
  the report reflects the book's current render state only.
