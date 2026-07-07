---
status: stable
shipped: 2026-07-07
owner: null
---

# fs-51 — Per-book performance-QA report

> Status: stable
> Key files: `server/src/audio/qa-report.ts`, `server/src/routes/qa-report.ts`,
> `src/components/qa-report-card.tsx`, `src/hooks/use-qa-report.ts`,
> `src/lib/qa-report-export.ts`
> URL surface: `#/books/<id>/listen` (Listen view), `#/books/<id>/generate` (Generation view)
> OpenAPI ops: `GET /api/books/{bookId}/qa-report`

## Benefit / Rationale

- **User:** every book now ships a visible, exportable "quality gate" receipt —
  acoustic, transcript (ASR), voice-match, and cast-continuity signals the
  pipeline already computed, surfaced as one honest card instead of buried in
  per-chapter waveforms or not shown at all.
- **Technical:** one new read-only aggregation endpoint composes four existing
  signal sources with zero new persisted state — display and export can never
  diverge from each other since both read the same `GET`.
- **Architectural:** locks in the "never show a false pass" invariant — a gate
  that never ran, had nothing to check, or was checked incompletely must never
  render as clean. This required two real correctness fixes to existing code
  (splice and QA-repair re-records were silently spreading a stale verdict
  forward instead of writing the fresh one), not just new aggregation code.

Design spec: `docs/superpowers/specs/2026-07-05-fs51-qa-report-design.md`.
Implementation plan: `docs/superpowers/plans/2026-07-05-fs51-qa-report.md`
(13 tasks, executed via `superpowers:subagent-driven-development`, each task
individually reviewed with fix rounds where findings were real, plus a final
Opus whole-branch review).

## Architectural impact

- **New seams:** `STOCHASTIC_ENGINES` exported from `aggregate.ts` (was
  private) so the report's own eligibility computation can reuse the same
  "which engines can drift" definition without redefining it.
  `VerdictRow.chapterId?: number` — new optional field, absent on legacy
  (pre-fs-51) verdict files, used to distinguish `attribution: 'full'` vs.
  `'legacy-unattributed'`. `ChapterSegment.qaRetries?: number` /
  `asrRetries?: number` — new optional counters, incremented in
  `synthesise-chapter.ts`'s generation-time re-record loops and in
  `chapter-qa-repair.ts`'s repair loop.
- **Invariants preserved:** the endpoint computes everything fresh on every
  call — no new book-level aggregate is persisted to disk. Voice-drift
  eligibility (`chaptersEligible`) is computed directly from `segments.json`,
  independent of `scoreBook`'s own early-return control flow, so it can never
  be confused with "the gate never ran."
- **Real bug fixed as part of this work (in scope, not deferred):**
  `chapter-splice.ts`'s manual re-record path, and `chapter-qa-repair.ts`'s
  repair path, both used to spread a segment's **pre-re-record**
  `qa`/`suspect`/`asr`/`asrSuspect` verdict forward via `{...segments[j]}`
  instead of writing the fresh, just-computed one. A chapter successfully
  repaired could still show `suspect: true`; a chapter that FAILED to repair
  could have its `suspect: true` silently cleared to `undefined` by the
  shared `buildSynthReplacements` helper once its contract widened to always
  attach a `freshVerdict`. Both are now fixed and regression-tested — the
  qa-repair case specifically pins that a failed (not-accepted) repair still
  persists `suspect: true`, not `undefined`.
- **Deliberate behavior change:** a manual splice re-record via
  `chapter-splice.ts` now runs the same signal-QA/ASR gates a normal
  generation-time render does for that one sentence (previously skipped
  entirely) — an accepted latency cost, not a bug, since there is no way to
  produce an honest fresh verdict without running the gates that produce it.
- **Migration:** none. Legacy books (rendered before this shipped) have
  `render-integrity.json` files with no `chapterId` — the report detects this
  and sets `attribution: 'legacy-unattributed'`; per-mismatch chapter linking
  is unavailable until the chapter is next touched, but coverage counts
  (`chaptersEligible`/`chaptersScored`) are computed fresh from `segments.json`
  regardless of file vintage, so they're accurate immediately.
- **Reversibility:** the route and its consuming UI can be reverted
  independently of the two verdict-persistence fixes (Tasks 3/4), which are
  real correctness fixes worth keeping regardless.

## Invariants to preserve

1. **Never a false pass.** `voiceDrift.chaptersEligible === 0` means "nothing
   to check," never "not run" — computed independently in
   `server/src/audio/qa-report.ts` from `segments.json`'s
   `characterSnapshots`, not derived from `scoreBook`'s output.
2. **`chaptersEmbedFailed` is only ever attributed when the gate demonstrably
   ran elsewhere in the book** (`chaptersScored > 0`) — `qa-report.ts`'s
   `chaptersEmbedFailed = chaptersScored > 0 ? eligible - scored : 0`. A
   whole-book embed failure with zero `chaptersScored` anywhere must degrade
   to "not run," never to a false "embed failed" count.
3. **`QaReportCard`'s `VoiceMatchRow` and `qa-report-export.ts`'s
   `voiceMatchLine` must share identical branch priority**: an embed
   shortfall (`chaptersScored < chaptersEligible`) leads ahead of the
   character-shortfall ("N of N characters checked") branch, even when
   `charactersChecked === charactersOnRoster` — otherwise a full-roster book
   with one failed chapter reads as falsely clean.
4. **A re-record (splice or QA-repair) must write a fresh verdict, never
   spread the pre-re-record one forward.** `SegmentReplacement.freshVerdict`
   is applied at all three segment-construction sites in
   `spliceChapterSegments` (`server/src/audio/splice-chapter.ts`) — a fix
   applied only to two of the three sites would silently regress this.
5. **A gain-only replacement (same audio content, different volume) must
   never set `freshVerdict`** — its content didn't change, so the prior
   verdict is still valid. Only `buildSynthReplacements`-produced
   (re-record) replacements set it.

## Test plan

### Automated coverage

- Vitest server (`server/src/audio/render-integrity/verdicts-io.test.ts`) —
  `chapterId` persistence, `scoredChapterIds`/`inconclusiveChapterIds`.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`,
  `synthesise-chapter-asr.test.ts`) — `qaRetries`/`asrRetries` increment on a
  retry that recovers, for both the signal-QA and ASR loops independently.
- Vitest server (`server/src/audio/build-synth-replacement.test.ts`,
  `splice-chapter.test.ts`) — `freshVerdict` carried from synth output onto
  the replacement, applied at all three segment-construction sites.
- Vitest server (`server/src/routes/chapter-splice-fresh-verdict.test.ts`) —
  route-level: the splice route's re-record passes real QA/ASR gate options
  (including `nameAllowlist`/`language`, matching generation's shape) and
  persists the fresh verdict, not the stale one.
- Vitest server (`server/src/routes/chapter-qa-repair.test.ts`) — the
  accepted take's verdict is written onto the segment; **a failed (never
  accepted) repair still persists `suspect: true`, not `undefined`** — the
  regression test for the cross-task verdict-clobber bug this work found and
  fixed.
- Vitest server (`server/src/audio/qa-report.test.ts`) — full coverage,
  all-Kokoro book (`chaptersEligible === 0`), sentence-count vs. segment-group
  counting, legacy-unattributed attribution, and `chaptersEmbedFailed`
  distinguishing "gate off" from "isolated embed failure" (both directions
  tested).
- Vitest server (`server/src/routes/qa-report.test.ts`) — 200/404/500
  (try/catch parity with sibling routes).
- Vitest frontend (`src/lib/api.qa-report.test.ts`,
  `src/hooks/use-qa-report.test.ts`, `src/lib/qa-report-export.test.ts`,
  `src/components/qa-report-card.test.tsx`) — client fetch + error shape,
  hook success/error paths, text-export formatting across coverage states,
  and the card's full branch-priority matrix (embed-failure-leads,
  no-stochastic-characters distinct from not-run, inconclusive-count shown).
- Vitest frontend (`src/views/listen.test.tsx`, `src/views/generation.test.tsx`)
  — card mounted on both views; Generation view refetches on both a new
  `chapter_complete` entry and a new `generation_run_complete` entry
  (independent, non-interfering triggers).
- Playwright e2e (`e2e/qa-report.spec.ts`) — the Listen-view card renders and
  both export buttons trigger real browser downloads with the expected
  filenames.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, the default for `npm run dev`).

1. Open a book's Listen view (`#/books/<id>/listen`) → the "Quality gate" card
   appears below the player region, above the download section, headlined
   "Every line held." for the clean mock fixture.
2. Click "Copy as text" → a `.txt` file downloads named
   `<book-title>-qa-report.txt` containing the four-row summary.
3. Click "Download as JSON" → a `.json` file downloads with the raw
   `BookQaReport` object.
4. Open a book's Generation view mid-render (`#/books/<id>/generate`) → the
   same card appears near the progress summary and refetches when a chapter
   completes.

## Out of scope

- **srv-36 Phase 2** (cross-book/series voice consistency) — still
  `status: draft`, no production code. No consistency row until it ships; the
  card explicitly avoids deep-purple on the voice-match row to reserve that
  token for when it does.
- **Any change to when/whether the underlying gates run** — this report only
  aggregates and presents existing signals, except the fresh-verdict-on-
  re-record fix above, which corrects a pre-existing correctness gap the
  report's own honesty requirement surfaced.
- **A "QA history over time" view** — the report reflects the book's current
  render state only, not a trend across regenerations.
- **Backfilling `chapterId` onto already-rendered books'
  `render-integrity.json` files** — they stay `legacy-unattributed` for
  per-mismatch chapter linking until next touched.
- **Re-enabling per-chapter `chapter_complete` dispatch during a live run** —
  discovered mid-implementation that the live generation-stream middleware no
  longer dispatches this event (rolled into one `generation_run_complete`
  event per run instead). The Generation-view card refetches on both event
  types so it works with today's real event stream; re-enabling per-chapter
  dispatch (if ever wanted) needs no further card-side changes.
- **Surfacing `acoustic.chaptersFlagged`** on the card/text export (currently
  reaches only the raw JSON export) — noted by the final whole-branch review
  as a cheap, honesty-reinforcing follow-up, not required for v1.

## Ship notes

Shipped 2026-07-07. Branch `feat/server-fs51-qa-report`, 20 commits (13 SDD
tasks + fix rounds), from `f3f8f170` through `2821b2c8`. All 13 tasks
individually reviewed (several with a fix round for a real finding); a final
Opus whole-branch review found no Critical/Important code defects — the
"never show a false pass" constraint was independently verified to hold
end-to-end across the task interactions (verdict-writing, coverage
computation, both re-record paths, and the card/export branch priority).
Closes #973.
