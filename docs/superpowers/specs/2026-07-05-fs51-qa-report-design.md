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
  writers of `segments.json` (`chapter-splice.ts`, `chapter-qa-repair.ts`)
  because `finalizeChapterAudioWrite` reads config *live* and rebuilds the
  segments file from scratch — reintroducing the exact false-clean risk the
  design exists to prevent. Also: `chaptersEligible` can't be sourced from
  `deriveBookOutline` (it reads only verdict files, never `segments.json`,
  where engine/eligibility data lives) — conflated with a different function
  (`scoreBook`) that has no return value at all. And the voice-match
  headline ("N characters checked") had no defined source, so an
  all-too-short-reference book could still read as a clean pass. Round 2's
  fix: moved coverage-stamping to the point where each gate's ground truth
  is actually known (per-segment inside the render/re-record loops, and
  inside `aggregate.ts`/`scoreBook` for voice-drift) instead of a shared
  downstream writer; moved eligibility computation into the report's own
  aggregation code; added an explicit `charactersChecked` field and put the
  coverage caveat in the headline, not a footnote; added a legacy-book
  attribution state for pre-existing `render-integrity.json` files written
  before `chapterId` existed.
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
than no receipt at all. Two rounds of adversarial review against this exact
constraint reshaped the coverage-tracking design below — see the `revised:`
frontmatter for what each round found and fixed.

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

### Design principle: each gate stamps its own coverage, at its own point of truth

Round 2 found that a single coverage flag stamped generically at
`finalizeChapterAudioWrite` (a function shared by three callers — the
generation path, `chapter-splice.ts`, and `chapter-qa-repair.ts`) can't be
trusted: that function reads config *live* and rebuilds the segments file
from scratch on every call, so a post-render splice or repair would
re-stamp (or lose) the original render-time coverage fact for content it
didn't even touch. The fix is architectural: **coverage is recorded by the
code that already knows it firsthand, at the moment it runs** — never
reconstructed downstream from a shared writer that wasn't there when the
gate actually fired.

1. **Signal-QA + SEG-ASR** — stamped **per segment**, inside whichever
   render/re-record loop actually (re)synthesizes that segment:
   `synthesise-chapter.ts`'s loop for generation, and
   `chapter-qa-repair.ts`'s own re-record loop for repairs (confirmed as a
   *separate* implementation from `synthesise-chapter.ts`'s, not a shared
   call — see the retry-counter note below). Each segment record gets its
   existing gate-config flags recorded at the exact moment it was rendered,
   alongside the `qaRetries`/`asrRetries` counters (same write, same
   reasoning). A segment that isn't touched by a later splice/repair simply
   keeps its prior record unchanged — there is nothing to "carry forward"
   because nothing rewrote it. **Whether `chapter-splice.ts`'s "re-record"
   segments are produced by re-invoking `synthesise-chapter.ts`'s loop or
   by some other path is not confirmed by this spec — verify at
   implementation time; if splice has its own separate synthesis call, it
   needs the same per-segment stamp as the repair path does.**
2. **Voice drift (srv-36)** — stamped **per chapter, inside
   `aggregate.ts`'s `scoreBook`**, the single existing choke point for this
   gate. Today, `scoreBook` silently `continue`s when a chapter has zero
   stochastic-engine characters or produces zero verdict rows — this spec
   requires it to also record a small coverage fact for *every* chapter it
   processes, even in those empty cases: `{ chapterId, eligible: boolean,
   scored: boolean }`, alongside the file(s) it already writes. This is an
   additive change to code that already has the answer at hand, not a
   reconstruction after the fact — it avoids duplicating the
   `STOCHASTIC_ENGINES` eligibility filter anywhere else (a real risk the
   round-2 review flagged: computing eligibility a second time, in the
   report's own code, from `segments.json`, would diverge from
   `aggregate.ts`'s own filter over time).
3. **Config drift** — unchanged; always-on, no coverage question. Different
   time axis from the other three rows (see below).

`deriveBookOutline()`
(`server/src/audio/render-integrity/verdicts-io.ts`) gets one small,
additive change: `chapterId` on `VerdictRow` (the chapter id is already in
scope where `scoreBook` writes these rows — confirmed low-risk). It stays a
pure reader of `render-integrity.json`/the new per-chapter coverage
records; it does **not** grow a dependency on `segments.json` or the
eligibility filter, which stays owned by `aggregate.ts` alone.

**Legacy books.** Books rendered before this ships have `render-integrity.json`
files with no `chapterId` and no coverage records. The report detects this
(`chapterId` absent on any row, or no coverage record for a chapter with
existing verdict data) and sets `voiceDrift.attribution: 'legacy-unattributed'`
rather than guessing — the UI shows severity counts and a flat mismatch list
without per-chapter linking, plus a note that re-rendering or repairing a
chapter restores full attribution for it.

### Config drift's own time axis

Config drift (the server-side equivalent of `revisions-slice`'s
`DriftEvent[]`) compares the render-time snapshot against the *live* cast
right now — it answers "has anything changed since this book was rendered,"
not "did anything go wrong during the render." The report keeps this row
visually and structurally separate from the other three for that reason.

### Retry counters

An integer `qaRetries` / `asrRetries` field on each segment record in
`segments.json`, incremented at the same two points that now stamp gate
coverage (above): `synthesise-chapter.ts`'s re-record loop, **and**
`chapter-qa-repair.ts`'s own re-record loop — these are confirmed-separate
code paths, so both need their own increment, not one shared increment
with a "carry-forward" concern. `chapter-splice.ts` needs no extra work
here: it assembles a chapter's segment array via object-spread
(`{ ...segments[j], ... }`) for kept/gain/re-record segments, so an
existing `qaRetries` value on a spread-from segment survives automatically.

This is what makes "N lines re-recorded" an honest attempt-count instead of
a "still flagged" proxy — without it, only the final verdict survives and a
retry that *fixed* a line would be invisible.

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
    chaptersEligible, chaptersScored,
    charactersOnRoster, charactersChecked,
    mismatches: [{ characterId, chapterId, severity, fixable }],
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
  overcounts — a "0 of 0" quiet gap on old books, not a false pass. Worth a
  follow-up if it turns out to matter in practice; not blocking for v1.
- `acoustic.linesChecked` / `linesRerecorded` — sums of `sentenceIds.length`
  (not segment-group counts) across segments whose per-segment coverage
  stamp shows the signal-QA gate was on. Comparing `linesChecked` against
  `totalLines` is the acoustic coverage fraction — a partial number here
  (e.g. `290 of 342`) means the gate was off for part of the book, without
  needing a separate chapter-level on/off flag.
- `acoustic.chaptersFlagged` — chapters containing at least one segment
  still `suspect` after every retry attempt was exhausted.
- `asr.linesVerified` / `linesFlaggedDrift` — same sentence-sum convention,
  gated on the per-segment ASR coverage stamp; `linesVerified` vs.
  `totalLines` is this row's coverage fraction.
- `voiceDrift.chaptersEligible` — chapters (from `aggregate.ts`'s own
  per-chapter coverage record) containing at least one stochastic-engine
  (Qwen/Coqui) character. A chapter voiced entirely by Kokoro is not
  eligible — this is what distinguishes "nothing to check here" from "not
  run."
- `voiceDrift.chaptersScored` — eligible chapters whose coverage record
  shows `scored: true`. In practice this should equal `chaptersEligible`;
  tracked separately so a shortfall is visible rather than silently
  absorbed. `chaptersEligible === 0` and `chaptersScored === 0` together
  mean "not run for this book" (the gate never produced a coverage record
  at all); `chaptersEligible > 0` with `chaptersScored < chaptersEligible`
  means partial coverage.
- `voiceDrift.charactersOnRoster` / `charactersChecked` — roster size vs.
  roster minus `uncheckedCharacterIds` (too-short reference audio). The UI
  headline always states both when they differ (see UX section) — never a
  bare "N characters checked" that could be roster size in disguise.
- `voiceDrift.mismatches` — rows where `verdict === 'voice-mismatch'` and
  `severity === 'severe'`. **Not the same severity scale as `configDrift`**:
  voice-drift severity is `'severe' | 'inconclusive' | null` (from
  `VerdictRow`), config-drift severity is `'mild' | 'moderate' | 'severe'`
  — the UI renders each with its own colour mapping, never a shared legend.
- `voiceDrift.inconclusiveCount` — verdicts in the inconclusive band
  (typically short quotes below the minimum-duration gate) — its own line,
  never folded into "mismatch" or "clean."
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

| Row | Full coverage | Partial coverage | Not run |
|---|---|---|---|
| Acoustic | "342 lines checked, 0 needed a second take." | "290 of 342 lines checked — the rest were rendered before this pass was on." | "Not run for this book." |
| Transcript (SEG-ASR) | "342 lines verified against what Whisper heard, 0 flagged." | Same fraction pattern as above. | "Not run for this book — turn on transcript verification before your next render." |
| Voice match (SEG-SPK) | "18 of 18 characters checked against their own reference take, 0 mismatches." | Leads with the fraction whenever `charactersChecked < charactersOnRoster` or `chaptersScored < chaptersEligible`: e.g. "12 of 18 characters checked — 6 had too little reference audio to check, 0 mismatches among the rest." Plus, when nonzero: "N chapters inconclusive — usually short quotes." | "Not run for this book — flip on render-integrity checking to catch mismatches automatically." |
| Cast continuity | Severity-coded counts, framed as *"since this book was rendered"* (not a render-time result like the other three). Reuses the `Pill` component with its own `severe→danger, moderate→warning, mild→neutral` mapping — a different severity vocabulary from voice-match, never conflated. A flagged line deep-links into the existing `drift-report.tsx` modal. | *(always on — no coverage question)* | *(always on)* |

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
  or "off," because coverage is tracked per segment/chapter rather than as
  one book-level flag.
- Mixed-engine chapters and Kokoro-voiced characters are already excluded
  from voice-drift scoring upstream (`STOCHASTIC_ENGINES` filter in
  `aggregate.ts`); the report reflects that via `chaptersEligible`, computed
  once, inside the same code that owns that filter.
- Legacy books (rendered before this ships) get `attribution:
  'legacy-unattributed'` for voice-drift rather than a guess at chapter
  linkage.
- No staleness/re-fetch logic beyond "derive on read" — a regenerated
  chapter's files are simply the new ground truth on the next call.

## Testing

- **Server**: unit tests for the aggregation function against fixture
  combinations — all gates on, all off, partial coverage (gate toggled
  mid-book), an all-Kokoro book (voice-drift on, zero eligible chapters), a
  book with `inconclusive`/too-short-reference characters, and a legacy
  book with no `chapterId`/coverage records. A route test for the endpoint.
  A regression test that both `synthesise-chapter.ts`'s and
  `chapter-qa-repair.ts`'s re-record loops independently increment
  `qaRetries`/`asrRetries`, and that a splice preserves existing values via
  its spread-based assembly. A test that `aggregate.ts`/`scoreBook` writes
  a coverage record for a chapter even when it has zero stochastic
  characters or zero verdict rows.
- **Frontend**: component tests for `QaReportCard` across the full-coverage/
  partial-coverage/not-run/legacy-unattributed/no-data/mid-generation
  permutations for each row independently, including the voice-match
  "roster vs. checked vs. unchecked" headline.
- **E2E**: one Playwright spec covering the Listen-view card and both export
  buttons, backed by a new mock `BookQaReport` fixture in `src/data/`
  (mocks are the default e2e mode).

## Open implementation-time questions (not resolved by this spec)

- Whether `chapter-splice.ts`'s "re-record" segments are produced via
  `synthesise-chapter.ts`'s loop (in which case per-segment coverage
  stamping there covers splice for free) or a separate synthesis call (in
  which case that call needs its own stamp, mirroring `chapter-qa-repair.ts`).
- Whether `chapter-qa-repair.ts`'s repair action re-triggers
  `aggregate.ts`'s `scoreBook` for voice-drift re-scoring after a repair, or
  only reads the existing `render-integrity.json` — affects whether a
  repaired chapter's voice-drift coverage record updates or stays stale
  until the next full re-render.

These are flagged rather than guessed at, per this spec's own "no false
pass" rule — the implementation plan should resolve them against the actual
call graph before writing the stamping code.

## Out of scope

- srv-36 Phase 2 (cross-book/series voice consistency) — still `status:
  draft`, no production code exists. No consistency row until it ships.
- Any change to when/whether the underlying gates run — this report only
  aggregates and presents existing signals.
- A dedicated "QA history over time" view (trend across regenerations) —
  the report reflects the book's current render state only.
- Backfilling `chapterId`/coverage records onto already-rendered books'
  existing `render-integrity.json` files — they stay
  `legacy-unattributed` until next touched.
