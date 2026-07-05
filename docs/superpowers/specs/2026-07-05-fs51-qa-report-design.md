---
status: draft
date: 2026-07-05
topic: fs-51 — per-book performance-QA report (visible + exportable acoustic+ASR+drift summary)
issue: fs-51 (#973)
depends_on: none (see "Correcting the srv-36 dependency" below — the issue's stated dependency is stale)
relates_to: srv-36 Phase 1 (#665, shipped — supplies the voice-match row) · srv-31 (ASR content-QA / SEG-ASR gate) · plan 179 (signal-QA) · srv-27 (audio-qa.ts loudness/duration gate) · revisions.ts (config-drift)
revised: 2026-07-05 (round 1 adversarial pass — code-grounded against origin/main via `assumption-checker`). Fixed: presence-based gate detection was Contradicted by two real book shapes (an all-Kokoro book runs the voice-drift gate but writes no verdict file; the acoustic gate is conditional on `maxSegmentRerecords > 0`, not always-on as originally written) — replaced with per-chapter gate-config stamping + coverage ratios. `deriveBookOutline()` cannot supply `chapterId`/`chaptersScored`/`uncheckedCharacters` as originally assumed — scoped in as a small required extension, not a zero-touch reuse. "Lines" was silently counting segment-groups, not sentences — redefined against `sentenceIds`. Added retry-counter carry-forward requirement across the splice/QA-repair re-write paths. Removed a fabricated brand quote ("an empty screen is an invitation to act" does not exist in `brand/`) in favour of the real empty-state example. Clarified that voice-drift severity (`severe`/`inconclusive`/`null`) and config-drift severity (`mild`/`moderate`/`severe`) are different scales, not one shared vocabulary. Clarified config-drift's "since render" time semantics against the other three rows' "during render" semantics.
---

# fs-51 — Per-book performance-QA report

## Context

The generation pipeline already runs four independent QA/drift checks per
book — signal-QA, ASR content-QA ("SEG-ASR"), srv-36 acoustic voice-drift
("SEG-SPK"), and cast-config drift — but none of it is aggregated or shown to
the user. Each check's output is either ephemeral (SSE ticks), buried in a
per-chapter waveform, or sitting in an on-disk file nobody reads
(`deriveBookOutline()` for srv-36 is built and tested but has zero
production callers). fs-51 turns these into one per-book report: visible in
the app, exportable, and — per the brand's own "Proof, not promises" claim —
the literal evidence for Castwright's core quality claim: *every line is
acoustically checked, transcript-verified, and drift-checked before a chapter
is assembled, automatically, every time.* This report is where that promise
gets shown, not just stated. It's `moscow:must` for the beta→full-product
spine specifically because it's a brand differentiator, not just a debugging
aid.

**The report must never show a false pass.** Because its entire reason to
exist is "proof, not promises," a receipt that reads clean for a check that
either never ran or had nothing to check is worse than no receipt at all.
This constraint is why the gate-detection design below is more involved than
a naive "is there output on disk" check — see "Gate coverage is stamped, not
inferred."

**Correcting the srv-36 dependency.** The GitHub issue says fs-51 "depends on
srv-36 (drift-threshold calibration)." That framing is stale: it was written
the same day as srv-36's own spec, which explicitly decouples the two —
srv-36 Phase 1 (the acoustic ECAPA voice-match check) has since shipped and
is calibrated (`status: stable`, referenced as shipped in the Phase 2 spec).
fs-51 is not blocked on anything. It ships against the QA signals that
already exist; srv-36's voice-match row is one of those signals, with
per-chapter coverage reported explicitly rather than a single "did it run"
guess. srv-36 Phase 2 (cross-book/series consistency) is still `status:
draft`, has no production code, and is out of scope here entirely.

## Architecture

One new read endpoint aggregates everything, computed fresh on every call —
nothing new is persisted as a running summary:

```
GET /api/books/:bookId/qa-report → BookQaReport
```

It reads four existing sources, per chapter:

1. **Signal-QA** (`<slug>.segments.json`, plan 179) — near-silent/truncated/
   runaway-duration flags, via the existing `loadSegmentsFiles()`
   (`server/src/audio/segments-io.ts`). Conditional on
   `maxSegmentRerecords > 0` — **not** always-on, corrected from an earlier
   draft of this spec.
2. **ASR content-QA / SEG-ASR** (`<slug>.segments.json`, srv-31) — transcript
   drift flags, same file, gated by `SEG_ASR_ENABLED`.
3. **Voice drift / SEG-SPK** (`<slug>.render-integrity.json`, srv-36 Phase 1)
   — via a **small required extension** to
   `server/src/audio/render-integrity/verdicts-io.ts`. `deriveBookOutline()`
   exists and is tested, but its `VerdictRow` carries no `chapterId` (every
   chapter's rows are flattened into one array) and its return shape has no
   per-chapter scored/eligible counts — both are needed for this report's
   `voiceDrift` section (see schema below). This is not the zero-touch reuse
   an earlier draft assumed; it's a small, additive change to an already-
   shipped module (add `chapterId` to `VerdictRow`; add
   `chaptersEligible`/`chaptersScored` to the aggregate return), not a
   rewrite. Gated by `SEG_SPK_ENABLED`.
4. **Config drift** (the server-side equivalent of `revisions-slice`'s
   `DriftEvent[]`) — cast/voice reassignment drift, severity mild/moderate/
   severe. Always on, no gate. **Different time axis from the other three**:
   this compares the render-time snapshot against the *live* cast right now,
   so it answers "has anything changed since this book was rendered," not
   "did anything go wrong during the render." The report keeps this row
   clearly separated from the other three for that reason.

**Gate coverage is stamped, not inferred.** An earlier draft of this spec
inferred whether a gate ran from whether its output was present on disk
(`seg.asr != null`; a `render-integrity.json` file exists). That's
unreliable for two real book shapes, confirmed against the code: an
all-Kokoro book runs the voice-drift gate (it's enabled) but writes no
verdict file, because `aggregate.ts` returns early when there are zero
stochastic-engine characters to score — presence-based detection would
wrongly report "not run." And the acoustic gate isn't always-on at all (see
point 1 above) — an earlier draft gave it no "not run" state, so a disabled
acoustic gate would have rendered as a perfect score.

The fix: at the same finalize step that already writes `segments.json`
(`server/src/audio/finalize-chapter-write.ts`), stamp a small
`qaGatesUsed: { acoustic: boolean, asr: boolean, voiceDrift: boolean }`
object onto each chapter record, reflecting the actual registry config
(`qa.seg.*`/`qa.asr.enabled`/`qa.speaker.enabled`) active *at that chapter's
render time* — not a guess from output shape, and not today's live config
(which may have changed since). The report aggregates this per-chapter
across the book into a coverage ratio (`chaptersGateOn` /
`chaptersRendered`) for each of the three optional gates, so:
- `0 / chaptersRendered` → the gate never ran for this book → "not run"
  copy.
- `chaptersRendered / chaptersRendered` → full coverage → normal receipt.
- Anything in between (the gate was toggled mid-book, or a chapter was
  regenerated after a setting change) → an explicit partial-coverage caveat,
  never silently rounded to either extreme.

For voice-drift specifically, `chaptersGateOn` alone still isn't sufficient
honesty — a chapter can have the gate on and have nothing to score (no
stochastic-engine characters). The `voiceDrift` schema section therefore
separately tracks `chaptersEligible` (gate-on chapters that contain at least
one stochastic-engine character) and `chaptersScored` (eligible chapters
that actually produced verdict rows), so "0 mismatches" can never quietly
mean "nothing was checked."

**Two schema additions**, both stamped at the same existing finalize step
(not new persisted aggregates — just two more fields on data already being
written):
- `qaGatesUsed` (above), per chapter.
- An integer `qaRetries` / `asrRetries` field on each segment record in
  `segments.json`, incremented in the existing re-record loop in
  `synthesise-chapter.ts` (where `segmentQaByIndex`/`segmentAsrByIndex`
  already get refreshed each round). This is what makes "N lines
  re-recorded" an honest attempt-count instead of a "still flagged" proxy —
  without it, only the final verdict survives and a retry that *fixed* a
  line would be invisible.
  **Carry-forward requirement**: `segments.json` isn't only written by the
  main generation path — the splice and QA-repair routes
  (`chapter-splice.ts`, `chapter-qa-repair.ts`) also call
  `finalizeChapterAudioWrite` and re-persist the file. Whichever path writes
  `qaRetries`/`asrRetries` must read the segment's *prior* count (if the
  file already exists) and add to it, not start from the current
  operation's local counter — otherwise a repair or splice silently resets
  a segment's retry history to zero, making "N lines re-recorded" go
  *down* after a repair, which is the same false-clean failure mode as the
  gate-detection issue above.

The endpoint is the single source of truth for both display and export — no
separate export endpoint. Both the Listen-view card and the live
Generation-view panel call the same `GET`, so display and export can never
diverge from each other. (This does not by itself guarantee the report
matches "what the gate actually did" in every edge case — that guarantee
comes from the coverage-stamping design above, not from the single-endpoint
structure alone.)

## Report schema

```
BookQaReport {
  bookId, generatedAt, chaptersRendered, chaptersTotal,
  acoustic: {
    chaptersGateOn, linesChecked, linesRerecorded, chaptersFlagged
  },
  asr: {
    chaptersGateOn, linesVerified, linesFlaggedDrift
  },
  voiceDrift: {
    chaptersGateOn, chaptersEligible, chaptersScored,
    mismatches: [{ characterId, chapterId, severity, fixable }],
    inconclusiveCount, uncheckedCharacterIds: string[]
  },
  configDrift: { counts: { mild, moderate, severe }, events: DriftEvent[] },
}
```

**Field definitions** (to remove any ambiguity about what each count means):
- `*.chaptersGateOn` — number of `chaptersRendered` where that gate's config
  was actually active at render time (from the stamped `qaGatesUsed`, not
  inferred from output). `0` → not-run copy; equal to `chaptersRendered` →
  full-coverage copy; anything else → partial-coverage copy (see UX
  section).
- `acoustic.linesChecked` / `linesRerecorded` — **counted in sentences, not
  segment-groups.** A `ChapterSegment` can bundle multiple sentences
  (`sentenceIds: number[]`); the report sums `sentenceIds.length` across the
  relevant segments rather than counting segments themselves, so "lines"
  means what a reader thinks it means. `linesRerecorded` sums
  `sentenceIds.length` for segments where `qaRetries > 0`.
- `acoustic.chaptersFlagged` — chapters containing at least one segment
  still `suspect` after every retry attempt was exhausted.
- `asr.linesVerified` — sentences (via `sentenceIds`, same convention as
  above) in segments where `seg.asr` is present, independent of verdict.
- `asr.linesFlaggedDrift` — sentences in segments where the final ASR
  verdict is `'drift'` (`asrSuspect === true`).
- `voiceDrift.chaptersEligible` — of the gate-on chapters, those containing
  at least one stochastic-engine (Qwen/Coqui) character. A chapter voiced
  entirely by Kokoro is gate-on but not eligible — this is what
  distinguishes "nothing to check here" from "not run."
- `voiceDrift.chaptersScored` — eligible chapters that actually produced
  verdict rows. In practice this should equal `chaptersEligible`; the
  report tracks them separately so a shortfall is visible rather than
  silently absorbed.
- `voiceDrift.mismatches` — rows where `verdict === 'voice-mismatch'` and
  `severity === 'severe'`. **Not the same severity scale as `configDrift`**:
  voice-drift severity is `'severe' | 'inconclusive' | null`
  (three-valued, from `VerdictRow`), config-drift severity is
  `'mild' | 'moderate' | 'severe'` — the UI renders each with its own
  colour mapping (see UX section), never a shared legend.
- `voiceDrift.inconclusiveCount` — verdicts that landed in the inconclusive
  band (typically short quotes below the minimum-duration gate). Shown as
  its own line, not folded into either "mismatch" or "clean."
- `voiceDrift.uncheckedCharacterIds` — characters excluded from scoring
  because their reference audio was too short to embed
  (`referenceKind === 'too-short'`, from the extended `deriveBookOutline`).
  Surfaced explicitly so "0 mismatches" can't be read as "everyone passed"
  when some characters were never checkable.

`openapi.yaml` gets the new `BookQaReport` schema + the `GET
/api/books/{bookId}/qa-report` path; `npm run openapi:types` regenerates
`src/lib/api-types.ts` from it, per the existing convention.

## UX/UI presentation — the brand moment

This is the surface where Castwright's core quality claim becomes evidence,
not marketing copy — "we promised, we delivered" made literal and specific
to *this* book. That governs every choice below, including the harder edges
introduced by the coverage-stamping design above: **an honest partial
receipt is more on-brand than a clean-looking one that's actually
incomplete.**

**Frame it as a receipt, not a stats table.** The card's hero line follows
the brand's own headline rule (medium-weight sentence, one bold span
carrying the meaning), driven by the real numbers:
- Clean book, full coverage: *"Every line **held**."*
- Issues found: *"**3** lines needed a second take."*
- Mid-generation (Generation view): *"Checking as it renders — **6 of 12**
  chapters done so far."* — candid about partial coverage, never a
  premature verdict.

Subhead adapted from the brand's canonical "Proof, not promises" line rather
than invented fresh: *"Checked, verified, and matched against every
character's own voice — automatically, before this book reached you."*

**Four parallel receipts, not a numbered sequence** — these are independent
gates, not ordered steps, so no 01/02/03 markers. Each row's off/partial
copy is an invitation, not an apology or a warning, matching the brand's own
empty-state example (*"No books yet. Drop in an EPUB, PDF, or paste a
chapter — we'll find the cast."* — `brand-guidelines.md`):

| Row | Full coverage | Partial coverage | Not run |
|---|---|---|---|
| Acoustic | "342 lines checked, 0 needed a second take." | "Checked for 8 of 12 chapters — the rest were rendered before this pass was on." | "Not run for this book." |
| Transcript (SEG-ASR) | "342 lines verified against what Whisper heard, 0 flagged." | Same partial pattern as above. | "Not run for this book — turn on transcript verification before your next render." |
| Voice match (SEG-SPK) | "18 characters checked against their own reference take, 0 mismatches." Plus, when non-empty: "N characters had too little reference audio to check" and/or "N chapters inconclusive — usually short quotes." | Same partial pattern, plus: "N chapters had no stochastic voices to check" when `chaptersEligible < chaptersGateOn`. | "Not run for this book — flip on render-integrity checking to catch mismatches automatically." |
| Cast continuity (config drift) | Severity-coded counts. Framed explicitly as *"since this book was rendered"* (not a render-time result like the other three). Reuses the `Pill` component with its own `severe→danger, moderate→warning, mild→neutral` mapping — the same component, a different severity vocabulary from voice-match, never conflated. A flagged line deep-links into the existing `drift-report.tsx` modal rather than duplicating its compare view. | *(always on — no gate, so no partial-coverage state applies)* | *(always on)* |

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
voice. For a fully-covered, clean book:

```
The Coalfall Commission — Castwright quality gate
Every line held.
· Acoustic — 342 lines checked, 0 needed a second take
· Transcript — 342 lines verified, 0 flagged
· Voice match — 18 characters checked, 0 mismatches
· Cast continuity — 0 changes since render
```

A partial-coverage book states its coverage plainly in the same export
rather than omitting the caveat to look cleaner — the export is exactly
what's on screen, never a flattering summary of it.

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
  partial coverage explicit rather than implying a full-book verdict, on
  top of (and independent from) each gate's own `chaptersGateOn` coverage.
- A gate toggled mid-book, or a chapter regenerated after a setting change
  → reported as partial coverage (see UX table), never silently rounded to
  "on" or "off."
- Mixed-engine chapters and Kokoro-voiced characters are already excluded
  from voice-drift scoring upstream (`STOCHASTIC_ENGINES` filter in
  `aggregate.ts`); the report reflects that via `chaptersEligible`, not as
  a special case.
- No staleness/re-fetch logic beyond "derive on read" — a regenerated
  chapter's files are simply the new ground truth on the next call.

## Testing

- **Server**: unit tests for the aggregation function against fixture
  `segments.json`/`render-integrity.json`/state.json combinations — all
  gates on, all off, partial-book render, an all-Kokoro book (gate on, zero
  eligible chapters), and a book with `inconclusive`/too-short-reference
  characters. A route test for the endpoint. A regression test that the
  re-record loop actually increments `qaRetries`/`asrRetries`, **and** that
  a subsequent splice/QA-repair write preserves rather than resets those
  counts.
- **Frontend**: component tests for `QaReportCard` across the full-coverage/
  partial-coverage/not-run/no-data/mid-generation permutations for each
  gate independently, including the voice-match "eligible vs scored vs
  unchecked" breakdown.
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
