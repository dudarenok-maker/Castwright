---
status: draft
date: 2026-07-08
topic: srv-36 scoreBook hardening — incremental per-character writes, resumability, and user-visible progress
revision: 2 — post adversarial review (round 1); see "Round-1 review fixes" note below each revised section
---

# scoreBook hardening — incremental writes, resumability, and progress visibility

_Design spec · 2026-07-08_

Backlog: srv-36 follow-up (no issue filed yet — filed as part of this work's PR gate).

This spec is **design/plan only** — implementation is a separate handover.

## Problem

`scoreBook()` (`server/src/audio/render-integrity/aggregate.ts`) is the srv-36 render-integrity
aggregator: it builds a per-character voice centroid from anchor-eligible embeddings, then
scores every rendered chapter's embedding rows against those centroids and writes one
`<slug>.render-integrity.json` verdict file per chapter. Two problems surfaced debugging a real
run (a 2-chapter Russian book, 13 characters, only 3 with enough in-book dialogue to build a
centroid without help):

1. **All-or-nothing visibility.** Phase 3 (resolve every stochastic character's reference,
   `aggregate.ts:489-501`) runs to completion — sequentially, one character fully awaited before
   the next starts — before Phase 4 (score + write verdict files, `aggregate.ts:508-571`) writes
   anything at all. A character with too few in-book anchors (fewer than `CENTROID_MIN_N`=10,
   `centroid.ts:19`) falls back to the Option-B "audition centroid"
   (`audition-centroid.ts`) — up to 8 *live TTS renders* to build a synthetic reference. For a
   cast with many minor characters (10 of 13 in the reference case, 1-4 lines each), that's
   dozens of sequential live syntheses sharing the same GPU as real chapter generation — tens of
   minutes before *anything* is written, even for characters (narrator, etc.) that resolved in
   milliseconds. The Quality Gate card reads "0 of N eligible chapters scored (N couldn't be
   embedded)" the entire time — indistinguishable from a genuine failure, with zero indication
   anything is happening.

2. **No resilience to interruption.** `scoreBook`'s only state is an in-memory `Promise` in
   `generation.ts`'s `scoringInFlight` map (`generation.ts:109`). A server restart mid-run kills
   it with no trace — no error, no retry, no record it ever started. The *only* thing that
   re-triggers `scoreBook` is the next chapter-completion event (`generation.ts:163`). On an
   already-fully-rendered book, there is no next event — a killed run just never resumes.
   Confirmed live: chapter 2's run got killed by a restart; the *next* run (triggered by chapter
   3 finishing) re-attempted from scratch and was still mid-flight, unwritten, when checked.

Separately, this surfaced a real correctness bug worth fixing alongside: `resolveCharacterReference`
(`aggregate.ts:194-221`) folds a `null` return from `auditionCentroid` (transient sidecar
failure — "bail entirely," per that function's own doc comment) into the *same* bucket as a
genuine `'too-short'` (ran fine, still not enough data) — both currently produce
`referenceKind: 'too-short'`, permanently. A transient GPU hiccup during the fallback synth
silently and permanently marks a character "can't be checked," with no retry, ever.

## Approaches considered

**Core storage mechanism** for incremental per-character writes:

- **A (chosen): merge into the existing per-chapter verdict files.** Keep today's
  one-file-per-chapter model (`<slug>.render-integrity.json`). The instant a character's
  reference resolves, read-modify-write every chapter it appears in, replacing that character's
  rows. `centroids.json` becomes the natural resume checkpoint — no new state file. Smallest
  blast radius: fs-51/GH-1436's attempted-sentinel, `deriveBookOutline`, and the repair route's
  assumptions about one-file-per-chapter all stay intact.
- **B (rejected): one shard file per character.** Replace per-chapter verdict files with one
  file per *character* (rows for every chapter they appear in), written once, atomically, when
  that character resolves — never needs read-modify-write. Rejected: bigger structural change,
  diverges from the per-chapter model several other code paths depend on (repair route,
  attempted sentinel, `deriveBookOutline`), and adds more small files per book for the same
  benefit Approach A gets more cheaply.

**Scope**: three problem buckets were on the table — incremental writes, surviving interruption,
and reducing the audition-centroid's actual render cost (e.g. a smaller target pool for very
minor characters). **Chosen: incremental writes + resumability only.** Render-cost reduction is
explicitly out of scope for this pass (see Out of scope) — it's a separate, orthogonal lever.

## Design

### 1. Interleave Phase 3 and Phase 4 per character

Today, Phase 3's loop (`for (const charId of stochasticChars)`, `aggregate.ts:489`) fully
resolves every character before Phase 4 scores and writes anything. This design inlines Phase
4's per-character work into that same loop: the instant `resolveCharacterReference` resolves for
a character, before moving to the next one, `scoreBook`:

1. Upserts that character's row into `centroids.json` (`writeCentroids` becomes a per-character
   upsert, not a single end-of-run batch write).
2. Computes that character's verdict rows against every `chapterData` entry it appears in and
   merges them into each affected chapter's verdict file via a new
   `mergeVerdictRows(path, characterId, rows)`: read the existing file if present, drop any
   existing rows for `characterId` (idempotent — safe to re-run), append the new rows, write
   atomically (reusing `writeJsonAtomic`, same as today's `writeVerdicts`).
3. Invokes an injectable `onCharacterScored?(characterId, index, total)` callback — the seam
   `generation.ts` uses to emit SSE progress (see §3).

Phase 3 and Phase 4 as separate named phases go away; it becomes one per-character loop that
resolves-and-writes before advancing. No change to *what* gets computed — only *when* it's
persisted.

**Processing order — cheap-first.** `stochasticChars` is iterated in first-chapter-appearance
order today (`aggregate.ts:456-459`), which is arbitrary with respect to cost — an expensive
too-thin character can sort before a cheap in-book one, delaying the first write for no reason.
Before the loop starts, sort characters by whether `anchorVecsByChar.get(charId).length >=
CENTROID_MIN_N` (already computed in Phase 2, no new cost) — characters already clearing the
floor process first. This isn't a correctness requirement, just what makes "narrator/oduvan
resolve in milliseconds while ren is still on its 6th synthetic render" actually show up that
way in the UI instead of by accident of chapter order.

> **Round-1 review fix:** the original draft didn't specify iteration order, so the "cheap
> characters resolve first" benefit claimed in the Problem section wasn't actually guaranteed.

### 2. Resume policy: cheap recompute always, expensive resynthesis only when needed

Every `scoreBook` invocation (a normal chapter-done retrigger, or the new manual resume action,
§4) processes every stochastic character again — it does **not** unconditionally skip characters
already in `centroids.json`. Instead, the cost split is:

- **Always recompute the cheap in-book centroid fresh** from currently-available anchor
  vectors — pure local math (`buildCentroid`), no TTS calls, negligible cost. If this now
  clears `CENTROID_MIN_N` and isn't bimodal, use it — even if a prior run had this character on
  the synthetic audition fallback. This means a character automatically **upgrades** from
  audition→in-book the moment enough real chapters render, with no special-cased logic.
- **Only skip the expensive step** — `auditionCentroid`'s live synthesis — when the cheap
  in-book check still comes back too-thin/bimodal *and* a valid persisted audition centroid
  already exists for that character in `centroids.json` (`referenceKind: 'audition'`). In that
  case, reuse the persisted centroid/spread stats wholesale; no new renders.
- **A persisted audition centroid is treated as valid indefinitely for v1** (no staleness
  detection). This is safe because a character's already-rendered audio doesn't change between
  `scoreBook` runs on the same book state; a voice recast already invalidates/regenerates
  embeddings upstream, which is out of scope here (existing recast handling elsewhere covers
  it).
- **A `null` return from `auditionCentroid`** (transient sidecar failure) leaves the character
  **unresolved this run** — nothing written to `centroids.json`, nothing merged into any verdict
  file. It stays "pending" and genuinely retries the live synthesis on the next trigger. This is
  the correctness fix from the Problem section: today this case is silently folded into
  permanent `'too-short'`; after this change, a real `'too-short'` outcome (ran fine, still not
  enough data) gets persisted as such immediately — but a `null` gets a bounded number of
  retries first (see below), not unconditional forever-pending status.

**Retry cap for `null` returns (round-1 review fix — see below).** `auditionCentroid` returning
`null` cannot distinguish "sidecar down right now" from "this character's voice can never
synthesize" (an orphaned `qwen-<uuid>.pt`, a missing voice ref). Left uncapped, a permanently
broken character would pin its chapters in "incomplete" forever, with the Resume button
re-running the same doomed synthesis every click — strictly worse than today's graceful
`inconclusive` degrade. Fix: extend each `CharacterCentroid` row (`centroids-io.ts`) with an
optional `pendingAttempts?: number`. On a `null` return, upsert a placeholder row `{
characterId, status: 'pending', pendingAttempts: prior + 1 }` (no `centroid`/`referenceKind` —
distinguishable from a resolved row). Once `pendingAttempts` reaches a cap (**3**, matching the
existing `maxAsrRerecords`-style small-retry-budget convention elsewhere in this codebase), the
next `null` instead persists `referenceKind: 'too-short'` (today's existing degrade path) and
stops being offered a "still pending" state — same terminal behavior as a character that was
too-short from the start, just reached via a bounded number of failed attempts instead of
immediately. A *success* at any point before the cap resets `pendingAttempts` implicitly (the
row is overwritten with a real resolved row).

> **Round-1 review fix:** the original draft treated every `null` as indefinitely retriable with
> no cap, which the adversarial review correctly flagged as the single most dangerous assumption
> in the spec — it can permanently brick a book's Voice Match report on one bad voice file, with
> a Resume button that never actually helps. Confirmed with the user: cap retries, then degrade
> to `inconclusive`/`too-short`, matching today's graceful-degrade behavior (see the design
> session's "Permanent-failure policy" decision).

### 3. New SSE events

Three new SSE `type` values, alongside the existing `progress`/`chapter_complete`/`warning`/etc.
(`generation.ts`), all carrying `bookId` so a client viewing a different book ignores them:

- `scoring_started` — `{ type, bookId, charactersOnRoster }`, fired once when a `scoreBook` call
  begins.
- `scoring_progress` — `{ type, bookId, charactersChecked, charactersOnRoster, characterId }`,
  fired once per character via the `onCharacterScored` callback from §1.
- `scoring_complete` — `{ type, bookId, charactersChecked, charactersOnRoster, mismatchCount }`,
  fired once when the loop finishes.

Wired at the existing `scoreBook(...)` call site in `generation.ts` (`generation.ts:163`).

### 4. New route: manual resume — via an extracted shared helper

**Round-1 review fix:** the original draft said the new route reuses "the same `scoringInFlight`
map, no new call sites" while also being a new call site — those can't both be true as written.
The real `scoreBook` invocation + single-flight tracking + post-run VRAM reconcile is inlined
inside `afterChapterFinalized` (`generation.ts:111-182`), entangled with `ctx.justFinalized` and
`ctx.keep` that a route handler doesn't have. Resolving this requires an actual (small)
refactor, not just routing through the existing map:

- **Extract `triggerScoring(ctx: { bookId, bookDir, chapters, justFinalizedSlugs?, keep })`** out
  of `afterChapterFinalized`'s body (`generation.ts:154-181`) into its own exported function.
  It owns the `scoringInFlight` check/set/delete, the `scoreBook(...)` call (§1/§3's new
  per-character callback wired in here), and the post-run `reconcileResidentQwenTiers(ctx.keep)`
  — unchanged from today's logic, just callable from more than one place.
- **`afterChapterFinalized`** keeps its existing `writeAttempted` call, then calls
  `triggerScoring({ ...ctx, justFinalizedSlugs: [ctx.justFinalized.slug] })` — behaviorally
  identical to today.
- **The new route** calls `triggerScoring({ bookId, bookDir, chapters })` — `justFinalizedSlugs`
  omitted, matching `scoreBook`'s existing back-compat default ("omit to treat every chapter in
  `chapters` as just-finalized," `aggregate.ts:299-302`) — appropriate here since a manual resume
  has no single "just finished" chapter to scope to. **`keep` is computed the same way the
  run-start reconcile computes it today** (the existing full-cast-tier derivation already used
  once at generation-run start) — reused, not reimplemented, so the resume path gets the same
  post-audition VRAM-hygiene reconcile the chapter-finalize path already has. This closes the
  VRAM-leak gap the adversarial review flagged: without it, a base tier pulled by the resume
  path's audition-centroid fallback would linger resident with nothing to evict it.

`POST /api/books/:bookId/resume-scoring` calls `triggerScoring(...)`, which safely no-ops
(no duplicate run, quick return) if a run is already active for that book, via the same
`scoringInFlight` map both paths now share through the extracted helper. No new job/queue
machinery. This is the explicit user-triggered path for the "book is fully rendered, a run got
killed, nothing will auto-retrigger it" case — by design, no automatic boot-time reconciliation
(kept out of scope; see Out of scope).

### 5. Redefine "fully scored" at chapter granularity — in `qa-report.ts`, not `deriveBookOutline`

`scoredChapterIds` currently means "a verdict file exists at all" (`verdicts-io.ts:121-122`) —
was all-or-nothing because verdict files were only ever written once, complete. Now that verdict
files can contain a subset of a chapter's expected characters, a chapter is "fully scored" only
once its verdict file's rows cover every stochastic character *actually appearing in that
chapter*.

**Round-1 review fix:** the original draft proposed computing this via
`resolveConfiguredEngineByChar` — but that returns a **book-wide** character→engine map, not a
per-chapter roster ("which characters appear in *this* chapter"). Taken literally as written, no
chapter would ever satisfy "covers every stochastic character in the book," so `scoredChapterIds`
would be permanently empty. The fix: **this computation belongs in `qa-report.ts`, which already
does it correctly** for `eligibleChapterIds` (`qa-report.ts:92-98` — for each chapter, read its
own `characterSnapshots` keys, keep the ones classified stochastic book-wide). Reuse that exact
per-chapter roster: a chapter is fully scored when the verdict rows' `characterId` set is a
superset of that chapter's own eligible-character roster. `deriveBookOutline`
(`verdicts-io.ts`) is untouched — it stays a dumb per-chapter file reader; the roster-aware
"fully scored" judgment is computed where the roster data already lives.

**Reconciling with `chaptersEmbedFailed`.** A chapter can now be attempted, have some (not all)
characters' rows written, and have one or more characters still genuinely `pending` (§2) — this
is neither "scored" nor "embed failed" (embeddings succeeded; scoring is incomplete, not
broken). `chaptersEmbedFailed`'s computation (`qa-report.ts:122`,
`attemptedEligibleCount - chaptersScored`) must exclude a chapter from the embed-failed count
while any of its roster characters are still `pending` — only a chapter with zero pending
characters and still not fully scored counts as genuinely embed-failed. The existing
`charactersOnRoster`/`charactersChecked`/`uncheckedCharacterIds` fields (`qa-report.ts:42-46`)
already carry enough information for the frontend to distinguish "still in progress" from
"actually failed"; no new top-level fields are needed on `AudioQaReport.voiceDrift` — this
section's fix just makes sure `chaptersEmbedFailed` doesn't fire prematurely while characters
are mid-resolution.

### 6. Frontend: three-state Voice Match row

`generation-stream-runner.ts` handles the three new SSE types the same way `warning`/
`chapter_complete` are handled today:

- `scoring_started` → `notificationsActions.pushToast({ kind: 'info', message: 'Checking
  character voices in the background — N to verify.', dedupeKey: 'voice-match-scoring' })` +
  `changeLogActions.appendLogEvent(buildScoringStartedEvent(...))` for the Activity feed + a
  small live-progress field (alongside where `progress` ticks already live).
- `scoring_progress` → updates that live counter only (no per-tick toast — too noisy).
- `scoring_complete` → `refetchQaReport()` via the existing `useRefetchOnNewEvent` mechanism
  (already wired for `chapter_complete`/`generation_run_complete`) + one Activity feed entry
  ("Voice-match scoring complete — K mismatches").

`ACTIVITY_FEED_TYPES` (`generation.tsx`) gains the two new change-log event kinds.

`qa-report-card.tsx`'s `VoiceMatchRow` gains a third state (today has 2: not-eligible, scored):

1. **Live, in progress** (SSE progress state present for this book): "⏳ Checking character
   voices — X of Y done."
2. **Static, incomplete, no active run** (fetched report shows `charactersChecked <
   charactersOnRoster`, no live SSE progress for this book — e.g. after a page load/reconnect
   post-restart): today's factual "X of Y characters checked so far" line + an inline **Resume
   scoring** button calling the new route. Disabled/shows "already running" if the click races
   an active run (the route's no-op response).
3. **Complete**: unchanged — "N of M eligible chapters scored, K mismatches."

## Testing

- `server/src/audio/render-integrity/aggregate.test.ts` (extend): per-character writes land
  mid-loop, cheap-first-ordered (assert `centroids.json`/verdict files update using an injected,
  controllable synth/embed fn between characters, and that an already-≥floor character's row
  lands before a too-thin character's); a second `scoreBook` call doesn't re-invoke the expensive
  synth fn for an already-audition-resolved character with no new anchors, but *does* upgrade a
  character from audition→in-book once new anchors clear the floor; a `null` `auditionCentroid`
  return leaves the character as a `pending`-status row (not a resolved one) and increments
  `pendingAttempts`; after 3 consecutive `null`s the 4th call persists `referenceKind:
  'too-short'` instead of retrying again; a success at any point before the cap resets to a
  resolved row.
- `server/src/audio/qa-report.test.ts` (extend): a chapter with some-but-not-all characters
  resolved reports accurate `charactersChecked`/`charactersOnRoster` but is excluded from
  `chaptersScored` until fully covered against *that chapter's own* roster (not the book-wide
  set — a test with characters split across chapters should confirm chapter A can be "fully
  scored" while chapter B, containing a different character, isn't); a chapter with a `pending`
  (not yet capped) character is excluded from `chaptersEmbedFailed`, not miscounted into it.
- New test for the extracted `triggerScoring` helper: both call sites (chapter-finalize,
  resume route) produce identical `scoreBook` + `reconcileResidentQwenTiers` behavior; the
  resume-route path's `keep` matches the run-start tier derivation.
- New route test for `POST /api/books/:bookId/resume-scoring`: triggers `scoreBook` via
  `triggerScoring`; no-ops without starting a duplicate run when one's already in flight.
- SSE emission test at the `scoreBook` call site: `scoring_started` → N × `scoring_progress` →
  `scoring_complete`, in order, correct counts.
- `generation-stream-runner` test: the three new SSE types drive the right toast/change-log/
  progress-state dispatches; `scoring_complete` triggers `refetchQaReport`.
- `qa-report-card.test.tsx`: all three `VoiceMatchRow` states render correctly; clicking Resume
  calls the new endpoint.
- E2E (crosses router/redux/SSE seams — testing-discipline rule): a Playwright spec driving the
  mock generation stream with a `scoring_progress`/`scoring_complete` sequence, asserting the
  Quality Gate card and Activity feed update live, and that the Resume button appears/works in
  the static-incomplete state.

## Out of scope

- **Reducing the audition-centroid's render cost** (smaller target pool for very minor
  characters, parallelizing across characters, etc.) — a separate, orthogonal lever explicitly
  deferred; this pass only changes *when* results are persisted and *whether* a run survives
  interruption, not how expensive the fallback synthesis itself is.
- **Boot-time reconciliation** (auto-resuming a stalled run on server startup, mirroring
  `queue-boot.ts`'s orphaned-generation sweep) — considered and explicitly rejected in favor of
  the manual Resume button; simpler, and avoids surprising the user with unrequested background
  GPU work right after a restart.
- **Staleness detection for persisted audition centroids** — a recast/re-render already
  invalidates a character's embeddings upstream by existing mechanisms; this design doesn't add
  a second invalidation path on top.
