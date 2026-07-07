---
status: draft
date: 2026-07-08
topic: srv-36 scoreBook hardening — incremental per-character writes, resumability, and user-visible progress
revision: 3 — post adversarial review (rounds 1 and 2); see "Round-N review fix" callouts
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

0. **Run start (new, round-2 review fix):** `scoreBook` calls `readCentroids(bookDir)` once
   into an in-memory map before the character loop begins. Today's `scoreBook` never reads
   `centroids.json` — it only ever builds `centroidRows` fresh and overwrites at the end
   (`aggregate.ts:486-504`). Both the retry-cap counting above and the "reuse a persisted
   audition centroid, skip resynthesis" optimization below depend on this prior state being
   loaded; without it neither works (the round-2 review's finding #5).
1. Upserts that character's row into `centroids.json` (`writeCentroids` becomes a per-character
   upsert — read-modify-write against the map loaded in step 0, not a single end-of-run batch
   write).
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

**Retry cap for `null` returns — a separate, small persisted artifact, and an explicitly
absorbing terminal state (round-1 AND round-2 review fix — both rounds found real gaps here).**

`auditionCentroid` returning `null` cannot distinguish "sidecar down right now" from "this
character's voice can never synthesize" (an orphaned `qwen-<uuid>.pt`, a missing voice ref).
Left uncapped, a permanently broken character pins its chapters in "incomplete" forever, with
the Resume button re-running the same doomed synthesis every click.

- **New artifact, not a `centroids.json` field.** Round 1's draft proposed a `pending`-status
  row inside `centroids.json` itself; round 2 correctly flagged that this (a) breaks
  `CharacterCentroid`'s existing all-required-fields contract for every other reader (the repair
  route reads `cleanMean` unconditionally) and (b) never specified whether the counter survives
  a degrade, so it silently reset every cycle. Fix: track attempts in a **separate** small
  artifact, `render-integrity.pending-attempts.json` (sibling to `centroids.json`, same
  `audioDir`), shape `Record<characterId, number>` — write/read helpers `readPendingAttempts`/
  `writePendingAttempts` in a new `pending-attempts-io.ts`, same `writeJsonAtomic` pattern as
  every other srv-36 artifact. `centroids.json` itself is **untouched in shape** — every row
  written to it is still a fully-resolved `CharacterCentroid` exactly as today; a character with
  no row in `centroids.json` yet is simply "not resolved," full stop, same as today.
- **The cycle, made explicit:**
  1. `scoreBook` run start: `readCentroids` (see the new step below) and `readPendingAttempts`
     once, both into in-memory maps.
  2. For a stochastic character with no resolved row in `centroids.json` yet: cheap recompute
     (always). If still too-thin/bimodal, call `auditionCentroid`.
     - **Success** (`kind: 'audition'`): write the resolved row to `centroids.json`;
       **delete** that character's entry from the pending-attempts map (so a character that
       later needs the fallback again — e.g. re-render with new content — starts a fresh count,
       not a stale high one).
     - **`null`** (transient failure): read `prior = pendingAttempts[characterId] ?? 0`. If
       `prior + 1 < 3`: write `pendingAttempts[characterId] = prior + 1`; character stays
       unresolved this run (nothing in `centroids.json`), genuinely retried next trigger.
       Otherwise (`prior + 1 >= 3` — a small, conservative, arbitrarily-chosen bound; not
       claimed to match any other specific retry constant elsewhere in this codebase): write a
       **terminal** `referenceKind: 'too-short'` row to `centroids.json` (today's existing
       degrade shape, unchanged), **and delete** the character's pending-attempts entry (the
       counter's job is done; nothing left to count).
  3. For a character that already has a **`too-short`** row in `centroids.json` (whether from
     genuine too-thin data or from a spent cap): the cheap in-book recompute **still runs every
     time** (harmless, and lets a character upgrade if new chapters add real anchors — unchanged
     from §2's upgrade guarantee above). But `auditionCentroid` is **never called again** for a
     character already sitting on a `too-short` row — that is what makes the state absorbing.
     This is the same behavior a genuinely-too-thin-from-the-start character already gets today;
     the cap just reaches the same terminal state instead of hitting it on attempt 1.
  4. `writePendingAttempts` is called once at the end of the run with the updated map (a single
     write, not per-character — the map is small and short-lived by construction).

  A *success* at any point before the cap is a clean exit from the cycle (step 2's success
  branch); the pending-attempts entry never lingers past a resolved outcome either way.

> **Round-1 review fix:** the original draft treated every `null` as indefinitely retriable with
> no cap. Confirmed with the user: cap retries, then degrade to `inconclusive`/`too-short`,
> matching today's graceful-degrade behavior (see the design session's "Permanent-failure
> policy" decision).
>
> **Round-2 review fix:** round 1's cap didn't specify whether `pendingAttempts` survived a
> degrade — without persistence the counter reset every run and the character oscillated
> too-short→pending→too-short forever, never actually stopping. Round 2 also flagged that
> stuffing a partial `pending` shape into `centroids.json` broke its existing contract for other
> readers. Both are fixed above: a dedicated artifact (no schema pollution) and an explicit,
> traced absorbing state (step 3: a `too-short` row — capped or genuine — permanently skips
> `auditionCentroid`, full stop).

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
  It owns the **`qa.speaker.enabled` guard** (moved here from `afterChapterFinalized`'s line 136
  — see the round-2 fix below), the `scoringInFlight` check/set/delete, the `scoreBook(...)`
  call (§1/§3's new per-character callback wired in here), and the post-run
  `reconcileResidentQwenTiers(ctx.keep)` — unchanged from today's logic, just callable from more
  than one place and now internally self-gating regardless of caller.
- **`afterChapterFinalized`** keeps its existing `writeAttempted` call, then calls
  `triggerScoring({ ...ctx, justFinalizedSlugs: [ctx.justFinalized.slug] })` — behaviorally
  identical to today.
- **The new route** calls `triggerScoring({ bookId, bookDir, chapters, justFinalizedSlugs: [] })`.

> **Round-2 review fix — `justFinalizedSlugs` must be an explicit empty array, not omitted.**
> The original draft omitted it, relying on `scoreBook`'s back-compat default (treat every
> chapter as just-finalized) — but that stamps the "attempted" sentinel on **every** chapter
> regardless of whether its embeddings exist yet, reopening exactly the GH #1436 race (a chapter
> still mid-render gets falsely marked "attempted," reading as a transient false "embed failed").
> An **explicit empty array** means only condition (b) in `scoreBook`'s per-chapter loop
> (`aggregate.ts:367` — "this chapter's embeddings sibling is independently present on disk
> right now") can stamp a chapter, which correctly skips anything still mid-render.
>
> **Belt-and-suspenders: the route also refuses to run while the book has an active generation
> job.** The empty-array fix prevents *false attempted stamps*, but a resume click during active
> generation would still needlessly compete with real chapter synthesis for sidecar time. The
> route checks the same in-progress signal `queue-boot.ts`'s orphan-reset sweep uses (a book
> with a workspace queue entry in `in_progress` state) and returns `409 Conflict` if the book is
> currently generating — resume is specifically for the "book is done rendering, a run got
> killed, nothing left to auto-retrigger it" case; it isn't meant to run alongside a live render.

**`keep` derivation — round-2 review fix.** The original draft claimed the resume route reuses
"the same way the run-start reconcile computes it today" — but that computation
(`computeUsedQwenTiers(cast.characters, engine, resolveForEngine('qwen').modelKey)`,
`generation.ts:734`) takes `engine`/`modelKey` from the **HTTP request body of a live generation
POST** (`generation.ts:595`, `body.modelKey`) — there is no equivalent live value for a resume
call with no active render. Reusing the function *shape* while inventing new *inputs* for it
is not "the same," so the spec now says precisely what those inputs are for the resume path:
`projectDefaultEngine`/`runDefaultQwenModelKey` are read from the **most recently rendered
chapter's `segments.json`** (`chapterTitle`/`modelKey` fields — the same `cd.modelKey` `scoreBook`
Phase 1 already reads for the audition-centroid tier selection, `aggregate.ts` "Prefer the
PER-CHARACTER stamp... fall back to the chapter-level modelKey" comment). This is a
best-effort proxy for "what tier does this book actually use," not a claim of run-start
fidelity — acceptable because, per the belt-and-suspenders guard above, resume never runs
concurrently with an in-flight sibling chapter render, so the run-start reconcile's specific
"don't evict a tier an in-flight sibling needs" concern (`generation.ts:726-732`'s superset
tradeoff) doesn't apply here; a book with no chapters rendered yet has nothing to derive from
and skips the reconcile (mirrors `qwenInUse` being false today).

`POST /api/books/:bookId/resume-scoring` calls `triggerScoring(...)`, which safely no-ops
(no duplicate run, quick return) if a run is already active for that book, via the same
`scoringInFlight` map both paths now share through the extracted helper. No new job/queue
machinery beyond the existing in-progress check reused above. This is the explicit
user-triggered path for the "book is fully rendered, a run got killed, nothing will
auto-retrigger it" case — by design, no automatic boot-time reconciliation (kept out of scope;
see Out of scope).

### 5. Redefine "fully scored" at chapter granularity, and add a `charactersPending` signal

`scoredChapterIds` currently means "a verdict file exists at all" (`verdicts-io.ts:121-122`) —
was all-or-nothing because verdict files were only ever written once, complete. Now that verdict
files can contain a subset of a chapter's expected characters, a chapter is "fully scored" only
once its verdict file's rows cover every stochastic character *actually appearing in that
chapter*.

**Round-1 review fix:** the original draft proposed computing this via
`resolveConfiguredEngineByChar` — but that returns a **book-wide** character→engine map, not a
per-chapter roster ("which characters appear in *this* chapter"). Taken literally as written, no
chapter would ever satisfy "covers every stochastic character in the book," so `scoredChapterIds`
would be permanently empty.

**Round-2 review fix — the "leave `deriveBookOutline` untouched" constraint from round 1 was
itself wrong and is retracted.** `qa-report.ts`'s existing segments loop (`qa-report.ts:92-98`)
has the per-chapter *roster* half (which characters appear in a chapter), but collapses it into
flat, chapter-agnostic sets (`stochasticCharacterIds`, `eligibleChapterIds`) — it doesn't retain
a per-chapter map. The other half — which characters *actually have verdict rows* in a given
chapter — lives only in the verdict files, read exclusively by `deriveBookOutline`, which today
returns only file-level presence (`scoredChapterIds`), not per-chapter character coverage.
Computing "fully scored" needs both halves in one place, so both get a small, scoped extension
rather than the round-1 "computed elsewhere, nothing touched" claim:

- `qa-report.ts`'s segments loop additionally builds `rosterByChapter: Map<number, Set<string>>`
  (one line added to the existing loop it already runs — no new I/O).
- `deriveBookOutline` (`verdicts-io.ts`) additionally builds
  `verdictCharactersByChapter: Map<number, Set<string>>` from the **same** per-chapter verdict-row
  read it already does (`verdicts-io.ts:110-135` already iterates every row — this just also
  collects `row.characterId` into a per-chapter set alongside the existing mismatch/inconclusive/
  too-short bookkeeping). No new file read; the same I/O this function already performs.
- `qa-report.ts` computes `scoredChapterIds` as: for each chapter, is
  `verdictCharactersByChapter.get(chapterId)` a superset of `rosterByChapter.get(chapterId)`?
  This replaces `deriveBookOutline`'s current "verdict file exists" test for that specific
  purpose (the raw per-chapter presence check `deriveBookOutline` does elsewhere — `issues`,
  `inconclusiveChapterIds` — is unaffected, still file-presence-driven as today).

**New signal: `charactersPending` — round-2 review fix for the Resume-button-never-goes-away
bug.** A capped (§2) character permanently persists a `too-short` row, which — same as a
genuinely-too-thin-from-the-start character always has — keeps it out of `charactersChecked`
forever (`qa-report.ts`'s existing `uncheckedCharacterIds` semantics, unchanged). Round 2
correctly flagged that if the Resume button (§6) gates on `charactersChecked <
charactersOnRoster`, it would show — uselessly, forever — for a book whose only "unchecked"
characters are already terminal, since clicking Resume can't help a character that's stopped
being reattempted. The Resume button needs a *narrower* signal: is there a stochastic character
with **no row in `centroids.json` at all** (genuinely incomplete — either never yet attempted,
or mid-retry-cycle under the §2 cap)? A terminal `too-short` character (capped or genuine) *has*
a row, so it's correctly excluded. `qa-report.ts` adds one more read — `readCentroids(bookDir)`
(already exported, `centroids-io.ts`) — and computes
`charactersPending = stochasticCharacterIds - keys(centroids)`, exposed as a new field:
`AudioQaReport.voiceDrift.charactersPending: string[]`. This is the one new top-level field this
design adds (round 1 claimed none were needed; round 2's finding showed that claim was false
for exactly this case).

**Reconciling with `chaptersEmbedFailed`.** A chapter can now be attempted, have some (not all)
characters' rows written, and have one or more characters still in `charactersPending` — this is
neither "scored" nor "embed failed" (embeddings succeeded; scoring is incomplete, not broken).
`chaptersEmbedFailed`'s computation (`qa-report.ts:122`, `attemptedEligibleCount -
chaptersScored`) must exclude a chapter from the embed-failed count while any of its own
`rosterByChapter` characters are in the book-level `charactersPending` set — only a chapter with
zero pending roster characters and still not fully scored counts as genuinely embed-failed.

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
2. **Static, incomplete, resumable** (fetched report shows `charactersPending.length > 0` —
   §5's new field, **not** `charactersChecked < charactersOnRoster` — and no live SSE progress
   for this book, e.g. after a page load/reconnect post-restart): today's factual "X of Y
   characters checked so far" line + an inline **Resume scoring** button calling the new route.
   Shows "already running" if the click races an active run, or a plain error if the route
   returns 409 (book currently generating — see §4's guard).
3. **Complete**: `charactersPending.length === 0` — unchanged copy, "N of M eligible chapters
   scored, K mismatches." **A book with one or more permanently-capped characters also reaches
   this state** (round-2 review fix): those characters sit in `uncheckedCharacterIds` exactly as
   a genuinely-too-thin character always has — visible in the existing mismatch/unchecked
   detail, not hidden — but the row itself reads "complete," with no dead-end Resume button,
   because there's genuinely nothing left to resume.

## Testing

- `server/src/audio/render-integrity/aggregate.test.ts` (extend): per-character writes land
  mid-loop, cheap-first-ordered (assert `centroids.json`/verdict files update using an injected,
  controllable synth/embed fn between characters, and that an already-≥floor character's row
  lands before a too-thin character's); `scoreBook` calls `readCentroids` at run start and a
  second call doesn't re-invoke the expensive synth fn for an already-audition-resolved
  character with no new anchors, but *does* upgrade a character from audition→in-book once new
  anchors clear the floor; a `null` `auditionCentroid` return writes to the new
  `pending-attempts.json` artifact (not `centroids.json`, which stays untouched for that
  character) and increments its count; after 3 consecutive `null`s the 4th call persists a
  terminal `referenceKind: 'too-short'` row to `centroids.json` AND clears the character's
  pending-attempts entry; a **5th call for that same character never invokes the synth fn
  again** (the absorbing-state assertion the round-2 review specifically asked for); a success
  at any point before the cap writes a resolved row and clears any pending-attempts entry.
- `server/src/audio/qa-report.test.ts` (extend): a chapter with some-but-not-all characters
  resolved reports accurate `charactersChecked`/`charactersOnRoster` but is excluded from
  `chaptersScored` until `verdictCharactersByChapter` is a superset of that chapter's own
  `rosterByChapter` (not the book-wide set — a test with characters split across chapters should
  confirm chapter A can be "fully scored" while chapter B, containing a different character,
  isn't); a chapter with a character present in `charactersPending` is excluded from
  `chaptersEmbedFailed`, not miscounted into it; a chapter whose only "unchecked" character is
  terminally capped (present in `uncheckedCharacterIds`, absent from `charactersPending`) IS
  counted as fully scored / not embed-failed — the capped-vs-still-pending distinction is the
  crux of this whole round's fix, so this case gets its own explicit test.
- New test for the extracted `triggerScoring` helper: both call sites (chapter-finalize, resume
  route) produce correct `scoreBook` + `reconcileResidentQwenTiers` behavior; `triggerScoring`
  itself no-ops when `qa.speaker.enabled` is off (assert both callers inherit this without
  duplicating the check); the resume-route path derives `keep` from the most recently rendered
  chapter's `segments.json` `modelKey` (not a live request value, since none exists).
- New route test for `POST /api/books/:bookId/resume-scoring`: triggers `scoreBook` via
  `triggerScoring` with `justFinalizedSlugs: []` (assert a chapter mid-render — segments.json
  present, embeddings.json absent — does NOT get a false "attempted" stamp from this call);
  no-ops without starting a duplicate run when one's already in flight; returns `409` when the
  book has an `in_progress` queue entry (active generation).
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
