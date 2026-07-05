---
status: draft
date: 2026-07-05
topic: fs-51 — per-book performance-QA report (visible + exportable acoustic+ASR+drift summary)
issue: fs-51 (#973)
depends_on: none (see "Correcting the srv-36 dependency" below — the issue's stated dependency is stale)
relates_to: srv-36 Phase 1 (#665, shipped — supplies the voice-match row) · srv-31 (ASR content-QA / SEG-ASR gate) · plan 179 (signal-QA) · srv-27 (audio-qa.ts loudness/duration gate) · revisions.ts (config-drift)
revised: |
  2026-07-05 round 1 (adversarial pass, code-grounded via `assumption-checker`).
  Fixed: presence-based gate detection was Contradicted by two real book
  shapes (an all-Kokoro book runs the voice-drift gate but writes no verdict
  file; the acoustic gate is conditional on `maxSegmentRerecords > 0`, not
  always-on) — replaced with per-chapter gate-config stamping + coverage
  ratios. `deriveBookOutline()` cannot supply `chapterId`/`chaptersScored`/
  `uncheckedCharacters` as originally assumed. "Lines" was silently counting
  segment-groups, not sentences. Added retry-counter carry-forward across
  splice/QA-repair. Removed a fabricated brand quote. Clarified voice-drift
  vs. config-drift severity are different scales, and config-drift's
  "since render" vs. the other rows' "during render" time semantics.

  2026-07-05 round 2 (adversarial pass on the round-1 revision). Round 1's
  fix was itself Contradicted: a single `qaGatesUsed` object "stamped at
  finalize" can't reflect render-time config on the two *post-render*
  writers of `segments.json` (`chapter-splice.ts`, `chapter-qa-repair.ts`).
  Also: `chaptersEligible` can't be sourced from `deriveBookOutline` (it
  reads only verdict files, never `segments.json`), and the voice-match
  headline ("N characters checked") had no defined source. Round 2's fix:
  moved coverage-stamping into `aggregate.ts`/`scoreBook` (per chapter) and
  `synthesise-chapter.ts`/`chapter-qa-repair.ts` (per segment) — the code
  that already knows each gate's ground truth, rather than a shared
  downstream writer.

  2026-07-05 round 3 (adversarial pass, final automated round per the
  review-gate cap). Found the round-2 fix still didn't work: `scoreBook`
  has book-level early returns (`chapterData.length === 0`,
  `stochasticChars.size === 0`) that fire *before* any per-chapter
  recording loop, so an all-Kokoro book, a never-run book, and a legacy
  book all produce zero coverage records — indistinguishable. Also found
  splice/QA-repair spread a segment's *pre-re-record* `qa`/`asr`/`suspect`
  verdict forward via `{ ...segments[j] }` rather than writing a fresh one,
  and `charactersOnRoster` had no defined population. Per the review-gate
  cap (initial + 2 re-reviews = 3 total), this round did not get another
  automated pass — the user was shown the findings directly and asked how
  to proceed; they asked for the fixes to be applied manually. This
  revision does that: eligibility is now computed directly by the report's
  own aggregation (reading `segments.json`'s character/engine snapshots via
  the same `STOCHASTIC_ENGINES` classification `aggregate.ts` already uses)
  instead of being routed through `scoreBook`'s control flow, which
  resolves the coverage ambiguity without needing scoreBook to change its
  early-return behaviour at all. `charactersOnRoster` is now defined as the
  same stochastic-character population used to compute eligibility — tied
  to rendered content, not live cast.json. Splice and QA-repair are now
  required to write a fresh per-segment verdict from the newly-rendered
  audio instead of spreading the prior one forward.
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
either never ran, had nothing to check, or was checked incompletely is worse
than no receipt at all. Three rounds of adversarial review against this exact
constraint reshaped the coverage-tracking design below — see the `revised:`
frontmatter for what each round found and fixed, including the round-3
findings that were resolved manually after the review-gate cap was reached.

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

### Design principle: each gate stamps its own coverage, at its own point of truth — except where that point of truth has an early exit

Round 2 established that coverage must be recorded by the code that already
knows it firsthand, not reconstructed downstream. Round 3 found the one
place that principle breaks: `aggregate.ts`'s `scoreBook` has **book-level**
early returns (zero rendered chapters; zero stochastic-engine characters
anywhere in the book) that fire *before* the per-chapter loop that would
record a coverage fact — so for exactly the cases where honesty matters most
(an all-Kokoro book, or a book where the gate never ran), scoreBook never
gets far enough to say which one happened.

**The fix: don't ask scoreBook to answer a question its control flow can't
reach.** Eligibility — "does this book have any stochastic-engine
characters at all" — is computed **directly by the report's own
aggregation code**, reading each chapter's `segments.json` character/engine
snapshot through the same `STOCHASTIC_ENGINES` classification `aggregate.ts`
already uses (imported, not reimplemented, so there is exactly one
definition of "stochastic," not two that can drift apart). This fully
decouples the eligibility signal from whether `scoreBook` happened to run:

- `voiceDrift.chaptersEligible === 0` (computed independently, from
  `segments.json`) → **"No stochastic-voiced characters in this book —
  nothing for this check to do."** Its own honest state, shown regardless
  of whether the gate is on or off, because it's moot either way — this is
  not a "not run" claim, it's a "there was nothing to check" fact.
- `chaptersEligible > 0` — there *was* something to check, so if the gate
  was on, `scoreBook` (which only book-level-returns when
  `stochasticChars.size === 0`, which is false here) will have entered its
  per-chapter loop and produced verdict files for at least some chapters.
  `voiceDrift.chaptersScored` (from `deriveBookOutline`, reading actual
  `render-integrity.json` files with the added `chapterId`) being `0` here
  genuinely means "the gate was off" — the ambiguity is gone, because the
  zero-eligible case is no longer folded into the same `0/0` reading.
- A narrower, legitimate residual case remains: a chapter can be eligible
  but skipped by `scoreBook`'s per-chapter (not book-level) check for a
  missing embeddings sibling (a transient/failed embed, not a config
  question). This surfaces as its own small `chaptersEmbedFailed` count
  rather than being folded into either "not run" or "clean" — see schema.

`voiceDrift.charactersOnRoster` uses the **same population** this
eligibility computation already establishes: distinct stochastic-engine
characters present in the book's rendered chapters. Not live `cast.json`
(which would inflate the denominator with Kokoro-voiced or cut characters
that can't drift in the first place, or drift out of sync with what was
actually rendered) and not scoreBook's internal-only bookkeeping — the
report's own independently-computed set, reused for both `chaptersEligible`
and `charactersOnRoster` so they can never disagree with each other.

`deriveBookOutline()` (`server/src/audio/render-integrity/verdicts-io.ts`)
still gets its one small additive change: `chapterId` on `VerdictRow` (the
existing per-chapter processing loop in `aggregate.ts` needs the chapter id
threaded from `ChapterData` — today that struct carries only `slug`, so
this is a small, real edit, not a zero-touch one). It stays a pure reader of
`render-integrity.json`; the eligibility computation is not part of it.

### Segments must carry a fresh verdict after any re-record, not a spread-forward one

Round 3 found that both `chapter-splice.ts` and `chapter-qa-repair.ts`
re-record a segment's audio but then either discard the fresh verdict
(`splice` calls `synthesiseChapter` per segment but takes only the PCM,
rebuilding segment metadata via `{ ...segments[j], ... }` — spreading the
**pre-re-record** segment's `qa`/`asr`/`suspect`/`asrSuspect` fields
forward) or never compute one at all (`chapter-qa-repair.ts` patches
`render-integrity.json`'s voice-drift verdict in place but never touches
the segment's own `qa`/`asr`/`suspect` fields in `segments.json`). Left
alone, this doesn't just poison coverage bookkeeping — it poisons the
*result* rows: a chapter successfully repaired can still report `suspect:
true` and drag down `acoustic.chaptersFlagged` / `asr.linesFlaggedDrift`
after the fix already landed. That's a "we claimed to catch it and did,
but we're still showing it as broken" failure — a smaller credibility
problem than a false pass, but still a real one for a "proof, not promises"
surface, and one this work should close rather than carry forward.

**Requirement, in scope for this work, not deferred to the report layer:**
- `chapter-splice.ts`'s per-segment re-record call must pass through the
  same signal-QA/ASR gate options used at generation time and use the
  **returned** segment's fresh `qa`/`asr` fields for the spliced-in record,
  instead of spreading the original segment's verdict forward.
- `chapter-qa-repair.ts` must, after selecting a winning re-recorded take,
  write that take's fresh `qa`/`asr`/`suspect`/`asrSuspect` verdict onto the
  segment record in `segments.json` — today it only patches
  `render-integrity.json`'s voice-drift row and pushes to the repair
  route's own SSE `repaired[]`/`stillSuspect[]` arrays, never the
  segment's own QA fields.

Both routes already have the "new audio + the winning take" in hand at the
point this needs to happen; this is writing down a verdict that's already
computed, not adding new QA logic.

### Retry counters

An integer `qaRetries` / `asrRetries` field on each segment record in
`segments.json`, incremented wherever a segment is actually re-recorded:
`synthesise-chapter.ts`'s loop for generation, and `chapter-qa-repair.ts`'s
own re-record loop for repairs — confirmed-separate code paths, so both
need their own increment. `chapter-splice.ts` needs no extra increment
logic beyond the fresh-verdict fix above: once it's writing a real,
freshly-computed segment record instead of a spread of the original, that
record's own `qaRetries` (from whatever synthesis path produced it) already
reflects that segment's own history correctly.

This is what makes "N lines re-recorded" an honest attempt-count instead of
a "still flagged" proxy — without it, only the final verdict survives and a
retry that *fixed* a line would be invisible.

### Config drift's own time axis

Config drift (the server-side equivalent of `revisions-slice`'s
`DriftEvent[]`) compares the render-time snapshot against the *live* cast
right now — it answers "has anything changed since this book was rendered,"
not "did anything go wrong during the render." The report keeps this row
visually and structurally separate from the other three for that reason.

### Legacy books

Books rendered before this ships have `render-integrity.json` files with no
`chapterId`. The report detects this (verdict data exists but carries no
`chapterId`) and sets `voiceDrift.attribution: 'legacy-unattributed'` —
severity counts and a flat mismatch list still show, without per-chapter
linking, plus a note that re-rendering or repairing a chapter restores full
attribution for it. This is a distinct signal from `chaptersEligible`/
`chaptersScored` (which are computed fresh from `segments.json` regardless
of file vintage), so a legacy book's coverage numbers are still accurate —
only the per-mismatch chapter linkage is unavailable until touched.

The endpoint is the single source of truth for both display and export — no
separate export endpoint. Both the Listen-view card and the live
Generation-view panel call the same `GET`, so display and export can never
diverge from each other.

## Report schema

```
BookQaReport {
  bookId, generatedAt, chaptersRendered, chaptersTotal, totalLines,
  acoustic: {
    linesChecked, linesRerecorded, chaptersFlagged
  },
  asr: {
    linesVerified, linesFlaggedDrift
  },
  voiceDrift: {
    attribution: 'full' | 'legacy-unattributed',
    chaptersEligible, chaptersScored, chaptersEmbedFailed,
    charactersOnRoster, charactersChecked,
    mismatches: [{ characterId, chapterId, severity: 'severe', fixable }],
    inconclusiveCount, uncheckedCharacterIds: string[]
  },
  configDrift: { counts: { mild, moderate, severe }, events: DriftEvent[] },
}
```

**Field definitions:**
- `totalLines` — sum of `sentenceIds.length` across every segment in every
  rendered chapter; the denominator for the acoustic/ASR coverage fractions
  below. **Known limitation**: pre-108 (legacy) segment records can carry
  absent/empty `sentenceIds`, which silently undercounts rather than
  overcounts — a "0 of 0" quiet gap on old books, not a false pass. Not
  blocking for v1.
- `acoustic.linesChecked` / `linesRerecorded` — sums of `sentenceIds.length`
  across segments where `seg.qa != null` (present only when the signal-QA
  gate actually ran for that segment — an existing field, not a new stamp;
  see the "segments must carry a fresh verdict" requirement above for why
  this is trustworthy after a splice/repair). `linesChecked` vs. `totalLines`
  is the acoustic coverage fraction.
- `acoustic.chaptersFlagged` — chapters containing at least one segment
  still `suspect` after every retry attempt was exhausted **and** after any
  splice/repair has written its fresh verdict.
- `asr.linesVerified` / `linesFlaggedDrift` — same sentence-sum convention,
  gated on `seg.asr != null`; `linesVerified` vs. `totalLines` is this
  row's coverage fraction.
- `voiceDrift.chaptersEligible` — chapters containing at least one
  stochastic-engine (Qwen/Coqui) character, computed by the report's own
  aggregation directly from `segments.json` (the `STOCHASTIC_ENGINES`
  classification, imported from `aggregate.ts`), independent of whether
  `scoreBook` ran. `0` means "no stochastic-voiced characters in this
  book" — its own honest state, not a "not run" claim.
- `voiceDrift.chaptersScored` — of the eligible chapters, those with actual
  verdict rows in `render-integrity.json` (via the `chapterId`-extended
  `deriveBookOutline`). With eligibility computed independently (above),
  `chaptersEligible > 0` and `chaptersScored === 0` unambiguously means
  "the gate was off for this book."
- `voiceDrift.chaptersEmbedFailed` — eligible chapters `scoreBook` skipped
  for a missing/failed embeddings sibling — a narrow, legitimate residual
  case distinct from both "off" and "clean," surfaced rather than folded
  into either.
- `voiceDrift.charactersOnRoster` / `charactersChecked` — the same
  stochastic-character population used for `chaptersEligible`, and that
  population minus `uncheckedCharacterIds` (too-short reference audio).
  Tied to what was actually rendered, not live `cast.json` — a Kokoro-only
  character is correctly absent from this denominator (it cannot drift),
  not an undercount.
- `voiceDrift.mismatches` — rows where `verdict === 'voice-mismatch'`
  (severity is always `'severe'` by construction of that filter — not a
  meaningful third value here). **Not the same severity scale as
  `configDrift`**: voice-drift's underlying `VerdictRow.severity` is
  `'severe' | 'inconclusive' | null`, config-drift's is `'mild' |
  'moderate' | 'severe'` — the UI renders each with its own colour mapping,
  never a shared legend.
- `voiceDrift.inconclusiveCount` — a **chapter** count (matching the UX
  copy's "N chapters inconclusive"), not a raw verdict-row count: chapters
  containing at least one inconclusive verdict (typically short quotes
  below the minimum-duration gate).
- `voiceDrift.uncheckedCharacterIds` — characters excluded from scoring
  because their reference audio was too short to embed
  (`referenceKind === 'too-short'`).

`openapi.yaml` gets the new `BookQaReport` schema + the `GET
/api/books/{bookId}/qa-report` path; `npm run openapi:types` regenerates
`src/lib/api-types.ts` from it, per the existing convention.

## UX/UI presentation — the brand moment

This is the surface where Castwright's core quality claim becomes evidence,
not marketing copy — "we promised, we delivered" made literal and specific
to *this* book. That governs every choice below, including the harder edges
the coverage design surfaces: **an honest partial receipt is more on-brand
than a clean-looking one that's actually incomplete — the coverage caveat
belongs in the headline, never demoted to a footnote.**

**Frame it as a receipt, not a stats table.** The card's hero line follows
the brand's own headline rule (medium-weight sentence, one bold span
carrying the meaning), driven by the real numbers:
- Clean book, full coverage: *"Every line **held**."*
- Issues found: *"**3** lines needed a second take."*
- Mid-generation (Generation view): *"Checking as it renders — **6 of 12**
  chapters done so far."*

Subhead adapted from the brand's canonical "Proof, not promises" line rather
than invented fresh: *"Checked, verified, and matched against every
character's own voice — automatically, before this book reached you."*

**Four parallel receipts, not a numbered sequence** — independent gates, not
ordered steps, so no 01/02/03 markers. Off/partial copy is an invitation,
never an apology, matching the brand's own empty-state example (*"No books
yet. Drop in an EPUB, PDF, or paste a chapter — we'll find the cast."* —
`brand-guidelines.md`):

| Row | Full coverage | Partial coverage | Not run | Other honest states |
|---|---|---|---|---|
| Acoustic | "342 lines checked, 0 needed a second take." | "290 of 342 lines checked — the rest were rendered before this pass was on." | "Not run for this book." | — |
| Transcript (SEG-ASR) | "342 lines verified against what Whisper heard, 0 flagged." | Same fraction pattern as above. | "Not run for this book — turn on transcript verification before your next render." | — |
| Voice match (SEG-SPK) | "18 of 18 characters checked against their own reference take, 0 mismatches." | Leads with the fraction whenever `charactersChecked < charactersOnRoster` or `chaptersScored < chaptersEligible`: "12 of 18 characters checked — 6 had too little reference audio to check, 0 mismatches among the rest." Plus, when nonzero: "N chapters inconclusive — usually short quotes." | "Not run for this book — flip on render-integrity checking to catch mismatches automatically." (Only shown when `chaptersEligible > 0`.) | `chaptersEligible === 0`: **"No stochastic-voiced characters in this book — nothing for this check to do."** Distinct from "not run"; never phrased as a shortfall. |
| Cast continuity | Severity-coded counts, framed as *"since this book was rendered"* (not a render-time result like the other three). Reuses the `Pill` component with its own `severe→danger, moderate→warning, mild→neutral` mapping — a different severity vocabulary from voice-match, never conflated. A flagged line deep-links into the existing `drift-report.tsx` modal. | *(always on — no coverage question)* | *(always on)* | — |

A legacy-unattributed voice-drift result still shows severity counts, plus:
*"Chapter detail isn't available for this render — re-rendering or
repairing a chapter restores it."*

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
  shadow-card`, matching `LoudnessReport`).

**Export doubles as word-of-mouth.** The text export is written to be
legible pasted verbatim into a Discord message or forum post — a real,
unforced "proof receipt," in the same benchmark-forward register the brand
already trusts from the maintainer voice. For a fully-covered, clean book:

```
The Coalfall Commission — Castwright quality gate
Every line held.
· Acoustic — 342 lines checked, 0 needed a second take
· Transcript — 342 lines verified, 0 flagged
· Voice match — 18 of 18 characters checked, 0 mismatches
· Cast continuity — 0 changes since render
```

A partial-coverage book states its coverage fractions plainly in the export
rather than omitting them to look cleaner. The JSON export is the
`BookQaReport` object re-serialized verbatim.

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
  blocks the Listen or Generation view.
- Partially-generated book → `chaptersRendered`/`chaptersTotal` makes
  partial coverage explicit, on top of (and independent from) each gate's
  own coverage fraction.
- A gate toggled mid-book, or a chapter regenerated after a setting change
  → reported as a partial coverage fraction, never silently rounded to "on"
  or "off," because coverage is tracked per line/chapter rather than as one
  book-level flag.
- A book with no stochastic-engine characters at all → `chaptersEligible
  === 0`, its own honest state, never conflated with "not run."
- Mixed-engine chapters and Kokoro-voiced characters are already excluded
  from voice-drift scoring upstream; the report computes the same
  exclusion itself (via the shared `STOCHASTIC_ENGINES` constant) rather
  than depending on `scoreBook` having reached a particular chapter.
- Legacy books (rendered before this ships) get `attribution:
  'legacy-unattributed'` for per-mismatch chapter linking; their coverage
  counts remain accurate regardless, since those are computed fresh.
- No staleness/re-fetch logic beyond "derive on read" — a regenerated
  chapter's files are simply the new ground truth on the next call, and are
  trustworthy ground truth per the fresh-verdict requirement above.

## Testing

- **Server**: unit tests for the aggregation function against fixture
  combinations — all gates on, all off, partial coverage (gate toggled
  mid-book), an all-Kokoro book (`chaptersEligible === 0`), a book with
  `inconclusive`/too-short-reference characters, a book with an
  embeddings-failure chapter, and a legacy book with no `chapterId`. A
  route test for the endpoint. A regression test that both
  `synthesise-chapter.ts`'s and `chapter-qa-repair.ts`'s re-record loops
  independently increment `qaRetries`/`asrRetries`. **A regression test
  that a chapter successfully repaired (or spliced) no longer reports
  `suspect`/`asrSuspect` from the pre-fix take** — this is the fresh-verdict
  requirement's own paired test, not optional polish. A test confirming
  `chaptersEligible`/`charactersOnRoster` are computed identically
  regardless of whether `scoreBook` ran, early-returned, or was never
  triggered.
- **Frontend**: component tests for `QaReportCard` across the full-coverage/
  partial-coverage/not-run/no-stochastic-characters/legacy-unattributed/
  no-data/mid-generation permutations for each row independently, including
  the voice-match "roster vs. checked vs. unchecked" headline.
- **E2E**: one Playwright spec covering the Listen-view card and both export
  buttons, backed by a new mock `BookQaReport` fixture in `src/data/`
  (mocks are the default e2e mode).

## Out of scope

- srv-36 Phase 2 (cross-book/series voice consistency) — still `status:
  draft`, no production code exists. No consistency row until it ships.
- Any change to when/whether the underlying gates run — this report only
  aggregates and presents existing signals (the one exception being the
  fresh-verdict-on-re-record fix above, which corrects an existing
  correctness gap the report's own honesty requirement surfaces, not a
  behavioural change to the gates themselves).
- A dedicated "QA history over time" view (trend across regenerations) —
  the report reflects the book's current render state only.
- Backfilling `chapterId` onto already-rendered books' existing
  `render-integrity.json` files — they stay `legacy-unattributed` for
  per-mismatch chapter linking until next touched. Their coverage counts
  are unaffected, since those are computed fresh from `segments.json`.
