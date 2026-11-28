---
status: stable
shipped: 2026-11-21
owner: null
issue: 1393
refs: [1388, 1395, 1839, 4066, 4075, 4079, 4235, 4445, 4497]
date: 2026-11-20
---

# Plan 293: Qwen tier keep set for the generation-path reconcile (#1393)

> Status: stable (Stage 1 shipped on branch `fix/server-1393-qwen-keep-set`; Stage 2 not planned, see D1)
> Key files: `server/src/routes/generation.ts`, `server/src/tts/qwen-tier-needs.ts` (new), `server/src/tts/ensure-sidecar-loaded.ts`, `server/src/tts/synthesise-chapter.ts`, `src/store/queue-thunks.ts`
> URL surface: indirect (server-side GPU residency; the queue stamp is client-visible)
> OpenAPI ops: none (`modelKey` on a queue entry is already accepted, `routes/queue.ts:126`)
> Refs: #1393 (this issue), #4445 (owner decision: generation reconciles skip while other work is live), PR #4497 (implements #4445; a precondition)

Precise per-book Qwen tier needs, and what is left of the cross-book race. The
approved design (three adversarial assumption-checker passes, the last
"ready for owner approval") is this document; the owner decisions of
2026-11-20 are in section 9. **This is the plan of record; no code is written
by the design thread.** The handover brief for the implementation thread is
the comment on #1393.

Design thread only. Every `file:line` below was read at `main` @ `01350809`
unless it says "#4497". Paths are under `server/src/` unless they start with
`server/tts-sidecar/` or `src/`. Line numbers drift: re-read before editing.

**Precondition: PR #4497 merged, AND the transport guard of section 5.0 green
on its merged head.** On-box acceptance rows are NOT added by this docs PR;
the implementing PR adds them (section 5.8; CLAUDE.md Before-shipping step 3).

## Design history

### Revision 3 changelog

| Pass-2 item | Resolution |
|---|---|
| State change: #4497 now counts designs and mints | §0 item 1 describes head `ba658ab7`. The precondition is no longer prose: §5.0 is a test that drives every design and mint transport against Stage 1's reconcile. Task 4 |
| 1. §3.5 had the wrong mechanism | Rewritten. Both pre-pass re-derives are 0.6B `clone-voice` distils that reload and never fail. The cost is a 0.6B reload next to the 1.7B. Owner decision: accepted. The ask that #4497 count re-derives is removed. §1.2's reason and on-box row (c) changed |
| 2. Default resolver deps can call the sidecar | §5.1: parity fixtures carry no library-backed voice, and the test makes any network call fail |
| 3. Variant clause over-kept on 1.7B | §2.1 step 5 is tier-aware. New parity case H11 |
| 4. Unstamped entries: never drain, version skew, own entry, boot race | §2.6 rewritten: an unstamped pending entry is evaluated at the request's key (no indefinite fall-back); the stamp is skipped until the session model is trustworthy. R12 changed, R13 and Q4 added. D8 |
| 5. Awaited span before `registerJob` | §3.4 adds `:872`, `:878`, `:897` |
| 6. Post-score reconcile re-reads | Owner decision. Task reinstated (Task 7); S1 back; §6's "cut" note removed |
| 7. D7 incomplete | D7 adds: the enqueuing client decides, and the boot-race note |
| 8. 1.7B batch in the ensure→lock gap | §3.0 row 1 priced as "batch retried" |
| 9. Workload answer covered designs only | §3.0 and D1 state the assumption about mints |

**Final-pass fixes (no design change):** G2's claim narrowed to literal
paths, with its rule and blind spots (§5.0); post-score recompute drops the
finished chapter and does not use the own-score-pass fall-back (§2.7), with
strict-subset tests S3 and S4; parity fixtures must miss all three pre-pass
selectors (§5.1); the bulk-design gap is priced (§3.0); `paused` noted as a
dead queue status (§7).

### Revision 2 changelog

Pass 1 re-priced a wrong eviction (§3.0), made the variant shape an over-keep,
corrected "exactly two derivations" (§1.3), added queue-entry stamping (§2.6),
reworded the startup window as narrowed (§3.4), made the single-book
acceptance reversal an owner decision (D6), cited the second
`evictQwenForCoquiPhase` call site (§8), and recorded the two defaults
(§0 item 4).

## 0 · What changed since the issue's last comment (read this first)

1. **The reported cross-book race has an owner decision and an open PR.**
   #4445 (owner decision, 2026-11-20): the generation-path reconciles skip
   any eviction while another job is active; the 8 GB co-residency risk is
   accepted. PR #4497 (open, head `ba658ab7`, four commits) implements it:
   both generation-path reconciles skip while `otherTierWorkActive(bookId)`,
   meaning a render on another book, any splice or QA repair, another book's
   score pass, **or any live voice design or variant mint**. The last term
   is the fourth commit: a counter `inFlightByPurpose {design, mint}` in
   `tts/design-voice-core.ts`, incremented before the `try` and decremented
   in the `finally` of `postDesignAndCacheAudition`, read through
   `isDesignOrMintActive()` in the leaf gate (unregistered counts as zero).
   The run's own book is excluded. `main` has none of this
   (`routes/generation.ts:229`, `:1230`).
   **This spec does not assume the counter covers every transport.** On
   `main` the design and mint calls in `routes/qwen-voice.ts` (`:2383`,
   `:2396`, `:2426`) go through a local wrapper (`:2356-2373`) that calls
   `postDesignAndCacheAudition`, and two of the three pass no `purpose`.
   Whether that holds on #4497's merged head is for #4497's review. Stage 1
   checks it with a test (§5.0), whatever the answer.
2. **A job is now one chapter** (`routes/generation.ts:511-517`,
   `:1327-1333`). The rest of the run lives in `.queue.json`
   (`workspace/queue-io.ts:39-89`). Between one chapter's `deregisterJob`
   and the next one's `registerJob` nothing is registered for the book.
3. **The splice count is in the leaf gate**
   (`routes/chapter-job-coordination.ts:21`, #4066).
4. **Two defaults bound how often any of this is reached.**
   `generationWorkers` defaults to 1 (`workspace/user-settings.ts:525`).
   `qa.speaker.enabled` defaults to off (`config/registry.ts:402-410`).

What #1393 still owes:

- **Stage 1 (must):** the keep set becomes the tiers the book's unfinished
  chapters will really use. Fixes blind-spots A and B. The main fix.
- **Stage 2: not planned (D1, decided 2026-11-20).** Would replace #4497's
  skip with a tier union. Designed here for the record only.

## 1 · The gating question: how does the in-flight tier leave `synthesiseChapter`?

**Recommendation: it does not. The keep set is computed before the synth
starts, by a pure helper built from the same single-definition primitives
`synthesiseChapter` routes with, and a parity test pins the helper to the
synth calls `synthesiseChapter` really makes.** The parity test covers synth
calls only; what it cannot see is in §3.5.

### 1.1 Why "real render facts" cannot be the source

- Render facts are written at finalize (`audio/finalize-chapter-write.ts:536`;
  `audio/character-snapshots.ts:68-71` derives `modelKey` from configuration).
- A finished chapter needs no resident tier (Correction 2, constraint 2).

The chapters with facts on disk must not count, and the chapters that must
count have no facts yet. The keep set is a **plan** with two properties:
**speaking-only** (blind-spot A) and **fallback-aware** (blind-spot B).
D0 (approved 2026-11-20).

### 1.2 Options weighed

| | A. Callback out of `synthesiseChapter` | B. Extract the router into a shared pure module | C. Pre-synth helper + parity test (recommended) |
|---|---|---|---|
| Source | `resolveGroup` (`tts/synthesise-chapter.ts:2339`) for every group | `routeFor` (`:1392`), `applyQwenFallback` (`:1417`), `resolveGroup` moved out | New pure helper composed from `resolveCharacterEngine`, `resolveCharacterQwenTier`, `computeQwenKokoroFallbackSet`, `buildCastResolver`, `buildSentenceGroups` |
| Exactness for synth calls | Exact for one chapter | Exact | Exact on every parity row, never below (§2.1 step 5) |
| Sees the pre-pass's 0.6B re-derives | Only if published after the pre-pass | No | No (§3.5) |
| Known when | After the readiness poll (up to 210 s, `tts/ensure-sidecar-loaded.ts:61`) and the pre-pass (`:2058-2155`) | At registration | At registration |
| Pending chapters | Cannot supply them | Yes | Yes |
| Change to `synthesiseChapter` | New opt; early `resolveGroup`, which can throw (`:1499-1506`, `:1524`) | Large refactor of the most-tested function | One two-line export (narrator id) |

Option A fails on timing and scope. Option B moves ~200 lines of
closure-bound logic (`castById` is mutated per chapter at `:2054`).

Option C is acceptable because of where its errors land. For synth calls it
cannot under-predict (step 5). The one thing it does not predict, a pre-pass
re-derive, cannot be broken by an eviction: it reloads the base and proceeds
(§3.5). And the work an eviction *can* break, a design or a mint, is counted
by #4497 and checked by §5.0, not by this helper.

### 1.3 Relation to `scoreBook`'s `usedQwenTiers`, and how many derivations exist

`scoreBook` returns `usedQwenTiers` (`audio/render-integrity/aggregate.ts:744`,
`:1212-1216`) from chapters on disk. It stays, unchanged, for the resume
route (`routes/generation.ts:228`), where there is no run.

After this change there are **two derivations and one fall-back**: on disk
(`scoreBook`, resume route only); to be synthesised (the new helper,
generation path); and `computeUsedQwenTiers(fullCast)`, **kept** as the value
the generation path falls back to when a term is unknown (§2.2).

## 2 · The keep set

### 2.1 Chapter needs: `chapterQwenTierNeeds`

New pure module `tts/qwen-tier-needs.ts`. No fs, no network, no `await`.

Inputs: `sentences`, `cast` (hydrated, and after the non-English engine
forcing at `routes/generation.ts:945-954`), `castIdHistory`, `defaultEngine`,
`runQwenModelKey` (the run key canonicalised to Qwen), `qwenUnavailable`,
`includesTitleBeat`.

Output: `{ keep06: boolean; keep17: boolean }`.

1. `qwenUnavailable` → `{false, false}` (`synthesise-chapter.ts:1507-1531`).
2. `groups = buildSentenceGroups(sentences)` (`:911`).
3. Speakers = each group's `characterId` resolved through `buildCastResolver`.
   An unresolved group adds the narrator (`:2356-2366`). `includesTitleBeat`
   adds the narrator (`:2244`). Narrator id as `:1566-1568` resolves it
   (export that expression); no narrator row → the stub of `:2161-2165`.
4. For each speaker: skip unless `resolveCharacterEngine(c, defaultEngine) ===
   'qwen'`. Let `tier = resolveCharacterQwenTier(c, runQwenModelKey)`. Set
   the flag for `tier` unless step 5 says the character sends no Qwen synth.
5. A character sends no Qwen synth when it is in
   `computeQwenKokoroFallbackSet(speakers, defaultEngine)`
   (`tts/qwen-fallback-set.ts:37`, base voice empty), with one exception:
   **on the 0.6B tier**, a character with any entry under
   `overrideTtsVoices.qwen.variants` is kept. The render judges fallback on
   the post-variant voice (`:1508`), and on 0.6B a tagged line's voice is
   `` `${baseVoice}__${emotion}` `` (`tts/voice-mapping.ts:92`), non-empty
   even when the base is empty. **On the 1.7B tier there is no exception:**
   the render passes `groupIs17b` (`:2382-2389`) and
   `pickEmotionVariantVoice` returns the base (`voice-mapping.ts:88`), so an
   empty base falls back on every line. Whether a 0.6B variant is stale is
   decided by the async `dropStaleVariants` (`:1367`); the helper does not
   call it and keeps the tier whenever a slot exists. That is an over-keep,
   on 0.6B only, on purpose.

### 2.2 Run needs (Stage 1)

Computed in `routes/generation.ts` after the analysis cache is loaded
(`:1135`) and `targetChapters` is known (`:1157`), replacing the full-cast
call at `:1033-1035` as the normal answer:

```
P = targetChapters
  ∪ { chapters of THIS book with a queue entry whose status is queued |
      in_progress | paused | awaiting_confirm, other than this POST's OWN
      entry (skipped by id; with no entry id, a target chapter's
      in_progress entry stands in for it) }
runNeeds = OR over P of chapterQwenTierNeeds(analysis.chapters[id], …,
                                             includesTitleBeat: true)
```

- A target chapter is evaluated at the request's model key. The POST's own
  queue entry is never consulted for it.
- A pending entry is evaluated at its stamped `modelKey`, or at the
  request's key when it has none (§2.6).
- `done` and `failed` entries, other books' entries, and chapters that are
  neither a target nor queued contribute nothing (constraint 2).
- A pending chapter with no cached sentences contributes nothing (`:1540`).

`runNeeds` is stored on the job as `RunningJob.tierNeeds`. The job also keeps
a closure that recomputes `runNeeds` from a fresh queue read, for §2.7.

```
K(book) = runNeeds ∪ ⋃ tierNeeds of this book's registered, NON-aborted jobs
```

**Unknown resolves to today's behaviour.** `K` falls back to
`computeUsedQwenTiers(fullCast)` whenever a term is not known: the queue
file cannot be read; a same-book job has no `tierNeeds` (only the test fake,
`:644-670`); the helper throws; or, at run start, this book's own score pass
is in flight (`scoringInFlight.has(bookId)`), because its audition renders on
the tiers of characters in *rendered* chapters (`aggregate.ts:1176`).

**A run that needs no Qwen tier does not reconcile** (as `:230` already
behaves). D3 (accepted).

### 2.3 Why pending chapters are in the set

Without them each chapter POST would evict the tier a later chapter of the
same book needs (`:1204-1215` promises "the in-use tier stays warm across
the book"). With `P` as defined both tiers stay until the last chapter using
one of them has finished.

### 2.4 The cross-job union (Stage 2: NOT PLANNED, D1)

```
keep = K(book)
     ∪ ⋃ tierNeeds of every OTHER book's registered, non-aborted render job
     ∪ ⋃ declared needs of every registered, non-aborted splice / QA repair
```

with one overriding rule: **if any live consumer's needs are not declared,
skip the eviction entirely** (#4497's behaviour). Not-declared consumers:
another book's score pass, a splice or repair before its declaration (§2.5),
a job with no `tierNeeds`, and every live design or mint (never unioned; an
eviction breaks them, §3.0).

Renders are read from `inFlightByChapter` inside `routes/generation.ts`;
splices and repairs from `routes/chapter-job-coordination.ts`, which
`generation.ts` already imports. **No fourth leaf gate; nothing under `gpu/`
gains an import.**

### 2.5 Splice and QA-repair needs (Stage 2: NOT PLANNED)

Same helper, `includesTitleBeat: false`. Neither can declare at
registration: splice registers at `routes/chapter-splice.ts:339` and forces
engines at `:399-440`; QA repair registers at `routes/chapter-qa-repair.ts:336`
and loads sentences at `:429-430`. `registerSplice` gains a later
declaration; the window before it is not-declared.

### 2.6 Queue entries carry their model (owner decision), and what an unstamped one means

Today an entry may have no `modelKey` (`workspace/queue-io.ts:48`, `:138`)
and the dispatcher then sends the session model at dispatch time:
`e.modelKey ?? ui.ttsModelKey` (`src/store/queue-dispatcher-middleware.ts:286`).

**The stamp.** The enqueue thunk `enqueueQueueEntries`
(`src/store/queue-thunks.ts:106`) sets `modelKey` to the caller's override,
or to the session `ui.ttsModelKey` **only when the session model is
trustworthy**:

- `ui.ttsModelKey` starts as `DEFAULT_TTS_MODEL` (`src/store/ui-slice.ts:221`)
  and becomes the user's value only after redux-persist rehydrates it
  (`src/store/index.ts:95-100`; there is no `PersistGate`, `:257-265`) or
  after the account settings seed it (`ui-slice.ts:610-614`). The silent
  auto-resume enqueue (`src/store/generation-stream-middleware.ts:247`) can
  fire in between.
- So the thunk stamps the session model only when the `ui` slice has
  rehydrated **and** (`ui.ttsModelKeyExplicit` is true **or**
  `account.hydrated` is true, `src/store/account-slice.ts:28`). Otherwise it
  sends no `modelKey` and the entry is unstamped, exactly as today. A wrong
  stamp would be permanent; a missing one is not.
- An explicit override is always stamped. The server already persists a
  recognised `modelKey` (`routes/queue.ts:126`). No OpenAPI change.

**Unstamped entries will keep existing**, from four sources: entries on disk
before this change; the boot window above; a newer client's key that an
older server does not recognise and drops (`routes/queue.ts:123-126`); and
any non-UI caller. A legacy entry in `awaiting_confirm` or `paused` does not
drain on its own (`queue-io.ts:30-36`: the dispatcher never claims it and
the boot sweep leaves it alone), so "wait for them to drain" is not a plan.

**So an unstamped pending entry is evaluated at the request's model key.**
It is not treated as unknown, and it does not force the full-cast fall-back.
The request's key is the best available estimate: it came from the same
dispatcher, and for an unstamped entry the dispatcher will send its session
model, which is what an unstamped current entry also sent.

- *When the estimate is wrong:* the current entry carried an override (a
  regenerate at a chosen tier) while the unstamped pending one will run at
  the session model, or a different browser claims the pending one. The keep
  set is then wrong for that chapter's tier in one direction or the other.
  Cost: one cold reload, or one tier left resident until the next chapter
  POST recomputes. Designs and mints are not exposed (they are #4497's).
- *Why not the full-cast fall-back:* with a parked legacy entry it would
  last indefinitely and leave blind-spots A and B unfixed for that book,
  silently.

This choice has an alternative (owner decision D8).

**A behaviour change comes with stamping** (owner decision D7).

### 2.7 The post-score reconcile re-reads the book's needs (owner decision)

`afterChapterFinalized` currently captures `keep: usedQwenTiers` at the
chapter's POST (`:2083`) and the reconcile uses it minutes later (`:228-230`).
With a narrowed keep, a stale capture could evict a tier a chapter queued in
the meantime needs, or one a same-book sibling is rendering on (PR #1395's
Finding 2, the reason the full-cast keep exists).

So the post-score reconcile computes its keep when it runs: it calls the
job's recompute closure (§2.2: a fresh `.queue.json` read, the POST's cast
and analysis), and hands the reconciler a function (§3.3) that unions the
result with the needs of this book's registered, non-aborted jobs at the
moment it is called.

Two differences from the run-start computation:

- **The just-finished job's own entry is not in `P`.** At post-score time
  the chapter that triggered the pass is rendered, so by constraint 2 that
  render needs no tier. The recompute's `P` is the book's still-pending
  queue entries with only the finished job's own entry left out, by entry id
  (`job.queueEntryId`; for a back-compat job with none, the finished
  chapter's `in_progress` entries, even if the queue file still shows it
  `in_progress`), plus whatever live same-book jobs declare. A re-queue of
  the finished chapter, even a claimed `in_progress` one, is in `P` at its
  stamp.
- **§2.2's own-score-pass fall-back does not apply here.** This reconcile
  runs *inside* this book's score pass (`routes/generation.ts:179-245`:
  the pass is in `scoringInFlight` until its `finally`), so that condition
  is always true at this point and would turn the post-score keep back into
  the full cast every time. The other fall-backs of §2.2 (unreadable queue,
  a same-book job with no `tierNeeds`, a helper throw) do apply.

The resume route is unchanged. Scoring is off by default, so this path is rarely taken; it is
kept because a narrowed, stale keep would reopen a closed finding.

## 3 · Semantics that must be stated

### 3.0 What a wrong eviction costs

| What is evicted | While this is live | Result |
|---|---|---|
| Either tier | A render's synth | The `/unload` waits on `_synth_lock` (`server/tts-sidecar/main.py:7657`, `:7197`); the next call reloads cold. If the unload lands in a 1.7B batch's gap between its re-ensure and its lock, **the whole batch fails** (`main.py:9011-9023`) and Node retries it as a transient 5xx (`tts/sidecar.ts:461-473`). Price: a reload, sometimes plus one retried batch |
| 0.6B (`/unload {engine:'qwen'}`) | A voice design | `QwenEngine.unload()` nulls `_design` with `_base` (`main.py:7658-7660`). The design fails |
| 1.7B (`/unload {model:'1.7b'}`) | A variant mint | The bare call does not wait for `_base17_in_flight` (`main.py:7192-7202`); the mint raises (`:8375-8380`) |
| 0.6B | A pre-pass re-derive | It reloads the base and proceeds (§3.5) |
| 0.6B | The gap between two characters of a bulk "Design full cast" | Nothing is in flight, so #4497's counter reads zero (it is held per call, around `postDesignAndCacheAudition`) and the reconcile runs. `unload()` drops the warm VoiceDesign model; the next character's design reloads it (~4–5 GB). Nothing fails. A render already drops VoiceDesign at its first synth, so this adds a reload only when the reconcile lands before that |

- **Designs and mints are protected by #4497, not by the keep set.** They
  have no chapter and no speakers. §5.0 is the check.
- **Workload.** The owner's answer was about designs: rarely or never on one
  book while another renders. It did not cover variant mints. This spec
  assumes nothing about how often a mint overlaps a render; a mint during
  cast review on one book while another renders is plausible. It does not
  need an assumption: #4497 counts mints the same way as designs, and §5.0
  drives the mint transport too.

### 3.1 Unregistered and default

- **No provider registered:** contribute nothing. This design adds no
  registered provider.
- **A live consumer whose needs are not known:** today's behaviour for as
  long as it is live: the full-cast superset for the run's own book (§2.2),
  #4497's skip for other work (§2.4). A consumer that declares
  `{false,false}` blocks nothing.

### 3.2 Aborted, not yet deregistered

A displaced or paused job is aborted at `routes/generation.ts:1394` (or
`:536-537`, `:2572`) and stays registered until `:2490` or `:2506`. Its needs
are excluded from every union by `controller.signal.aborted`, as `:1358-1360`
already filters. Same for an aborted splice controller.

### 3.3 The unload-flight race: narrowed, not closed

`reconcileResidentQwenTiers` awaits `GET /health`
(`tts/ensure-sidecar-loaded.ts:244`) before it posts `/unload` (`:256`).

- `keep` may be a function, called synchronously after `/health` resolves,
  immediately before the evictions are built (`:287`). Returning `null` means
  skip. Both generation callers pass one; it re-reads the keep set and
  #4497's busy check.
- This **narrows** the window to the unload's own flight. What can still be
  hit there, per §3.0: a render starting (a reload), or a design or mint
  starting (it fails and the user retries).

### 3.4 The startup window: narrowed, not closed

Today the run-start reconcile (`:1230`) runs before `registerJob` (`:1427`).
Between `registerJob` and the chapter loop (`:2475`) there are only
synchronous declarations (`:1430`, `:1441`, `:1503`, `:1508`, `:1515`), so
the reconcile moves to just before the loop with no hoisting.

**This removes one part of the window, the reconcile's own round trip.** A
starting run is still invisible for everything it awaits before
`registerJob`:

- `runBookJob` registration (`:872`);
- the cast read (`:878`) and `hydrateCastReusedVoices` (`:897`);
- `clearMismatchedDesignedVoices` (`:967`);
- the edits snapshot and `refreshCacheFromEdits` (`:1124-1133`);
- `loadAnalysisCache` (`:1135`), `mkdir` (`:1146`), the disk guard (`:1173`);
- Stage 1's new `.queue.json` read.

Another op that reads "nothing is rendering" in that span can still evict
the tier this run is about to keep.

- `keepForRunStart`'s "is anything else live" input is read **before**
  `registerJob`, as now, and reused.
- A bare-resume POST returns at `:1386`. It fires a run-start reconcile today
  (the reconcile sits above the subscribe branch at `:1353`); after the move
  it does not. Intended.
- The residual notes in `gpu/active-generation-gate.ts:30-49` and
  `gpu/evict-idle-tts.ts:43-68` say the run calls its own run-start
  reconcile "well before" `registerJob`. That sentence becomes false and is
  corrected. **The notes stay as residual-window notes**, reworded to the
  span above. They are not to be rewritten as closed.

### 3.5 Residuals and known under-predictions

- **The pre-pass's re-derives reload the 0.6B base (owner decision:
  accepted).** Before any synth, `synthesiseChapter` may re-derive a missing
  or stale designed or cloned Qwen voice (`:2133-2155`). Both resolvers use
  `deriveEngineArtifact` (`:1292-1307`), which posts `/qwen/clone-voice`
  (`tts/derive-engine-artifact.ts:127`): a 0.6B distil, not a VoiceDesign
  call. The sidecar's `clone_voice` re-ensures the base before and inside
  `_synth_lock` (`main.py:8218-8220`), so it reloads and proceeds; an
  eviction cannot fail it.
  *What actually happens:* on a chapter whose keep has `keep06` false, the
  run's own run-start reconcile evicts the 0.6B, then the pre-pass loads it
  again, next to the 1.7B, for the rest of that chapter. This needs no
  second worker and no scoring. It is not worse than `main`: there the same
  chapter either evicts and reloads identically (a full cast with no 0.6B
  member) or keeps the 0.6B resident throughout (a silent 0.6B member). The
  helper does not predict it, because the only static signal, "a speaker has
  a designed or cloned Qwen voice", is true of nearly every Qwen book and
  would pin `keep06` permanently. The re-derive fires once per missing
  artifact, then the artifact exists. On-box row (c) records it (§5.8).
- **The non-English engine forcing is applied once, at the request's engine
  (accepted, pre-existing).** `generation.ts` forces each character's
  `ttsEngine` with the POST's engine (`resolveClonedRetargetEngine`), and
  `computeRunQwenNeeds` reuses that forced cast for every pending entry. A
  character cloned on both Qwen and Coqui keeps the request's engine there, so
  under a Coqui request a Qwen-stamped pending chapter whose speakers are all
  such characters predicts no Qwen tier, while that chapter's own POST retargets
  them to Qwen. `main`'s full-cast keep reads the same forced cast and evicts
  the same tier, so this is not a regression; each hit costs one reload. Not
  fixed: re-forcing the cast per stamp engine means passing the book's eligible
  engines into the helper and choosing what a Kokoro or unstamped entry
  retargets to, which is a behaviour choice, not a one-line change.
- **The inter-chapter gap.** Another book's reconcile in the gap evicts this
  book's tier. One reload per hit. D2 (accepted).
- **An unstamped pending entry's tier is an estimate** (§2.6).
- **Other books' score passes** are skipped around, never unioned.
- **The third evictor, outside this design** (§8): the Coqui-phase Qwen
  eviction now waits, bounded (180 s), for another op's design or mint, then
  evicts anyway and logs it (#4568, owner decision 2026-11-28).

### 3.6 Multi-sidecar and per-device

One sidecar (`getResolvedSidecarUrl()`); `QwenEngine` has one shared device
for all its models (`main.py:5885-5889`). A keep set keyed by tier is enough.
If per-model devices ship, the key becomes `(deviceKey, tier)`.

### 3.7 What the union does not do

It does not create co-residency. Whether two tiers fit is the sidecar's
admission, unchanged.

## 4 · What each case gets

| Case | Fixed by | How |
|---|---|---|
| Blind-spot A (silent Qwen cast member pins a tier) | Stage 1 | Speakers of unfinished chapters only |
| Blind-spot B (fell back, still pins) | Stage 1 | Fallback set and `qwenUnavailable` excluded |
| Rendered chapters pinning a tier | Stage 1 | `P` holds unfinished chapters only |
| Cross-book race, render vs render / splice / repair | #4497; refined by Stage 2 | Skip; or union |
| A reconcile breaking a live design or mint | #4497, checked by §5.0 | Skip |
| Startup window | Stage 1, in part | Reconcile after `registerJob`; earlier awaits remain |
| Stale post-score keep (PR #1395 Finding 2) | Stage 1 | Re-read at reconcile time (§2.7) |
| Inter-chapter gap | Not fixed | Residual (D2) |
| 0.6B reloaded by a pre-pass re-derive | Not fixed | Accepted (§3.5) |
| A stray tier during a two-book overlap | Stage 2 only | Union still evicts it |

## 5 · Test plan

Each test names the mutation that must turn it red.

### 5.0 Transport guard: the precondition, as a test

Stage 1 narrows `keep06` and `keep17`, so a reconcile it issues is more
likely than today's to name a tier a design or mint is using. The test that
makes that safe:

- **G1, per transport.** For every code path on #4497's merged head that
  sends a voice design or a variant mint to the sidecar, start it with the
  sidecar call held open, then run Stage 1's run-start reconcile for a book
  whose keep would evict the tier in question (`keep06` false for a design,
  `keep17` false for a mint). Assert no `/unload` is issued. Release the
  call and assert the next reconcile does evict. The paths to enumerate are
  those found on the merged head; on `main` they are the three calls in
  `routes/qwen-voice.ts` (`:2383` design, `:2396` mint, `:2426` the fallback
  design) and `runVoiceDesign` (`tts/design-voice-core.ts:338`). Each is
  driven through its real entry point, not by setting the counter by hand.
  Mutation per path: bypass the counted function on that path; G1 for that
  path must go red.
- **G2, structural, and deliberately syntactic.** It catches one thing: a
  new **literal** `/qwen/design-voice` or `/qwen/mint-variant` request added
  outside the counted path. Its rule, over non-test files under
  `server/src`:
  1. a string literal or template containing either path may appear, as
     code, only in files on a named allowlist. On `main` that list is
     `tts/design-voice-core.ts` (the counted function and `runVoiceDesign`,
     `:339`) and `routes/qwen-voice.ts` (the three calls through the local
     `postDesignAndCache` wrapper, `:2356-2373`, `:2383`, `:2396`, `:2426`).
     The list is rebuilt from #4497's merged head when the test is written;
  2. in `routes/qwen-voice.ts`, each such literal must be an argument of a
     `postDesignAndCache(` call, and that wrapper's body must call
     `postDesignAndCacheAudition`;
  3. `postDesignAndCacheAudition` is the only function in the allowlisted
     files whose body issues a `fetch` / `undiciFetch` with its `target`.

  Mutation: add a bare `fetch` to a literal `/qwen/mint-variant` in a scratch
  route; G2 must go red.

  **Blind spots, listed in the test's header as the repo's other syntactic
  guards do:** a computed path (`` `${sidecarUrl}/${slot}/mint-variant` ``,
  as `derive-engine-artifact.ts:127` builds its own); a shared path constant
  imported from elsewhere; a new direct `undiciFetch` inside an allowlisted
  file that takes its URL from a variable; and anything call-graph-shaped (a
  new caller of an uncounted helper adds no literal). G1 is the behavioural
  check; G2 only stops the cheapest regression.

**If G1 is red for any path on #4497's merged head, Stage 1 stops at Task 4**
and the gap is reported against #4445. It is not fixed inside Stage 1.

### 5.1 `tts/qwen-tier-needs.test.ts` (new)

| # | Case | Expected | Mutation that must fail it |
|---|---|---|---|
| H1 | Silent unpinned Qwen character; every speaker is 1.7B | `{false, true}` | Walk the full cast |
| H2 | The only Qwen speaker has no designed voice and no variants | `{false, false}` | Remove the fallback exclusion |
| H3 | `qwenUnavailable` | `{false, false}` | Remove step 1 |
| H4 | Qwen narrator with no sentences; title beat on, then off | `keep06`, then none | Ignore `includesTitleBeat` |
| H5 | A group with an id not in the cast | Narrator's tier | Drop unresolved groups |
| H6 | A retired id mapped to a live 1.7B character | `keep17` | Raw `.get()` |
| H7 | Character pinned 0.6B, run at 1.7B | `{false, true}` | Use `c.ttsModelKey` directly |
| H8 | A 1.7B character whose only sentences are excluded | none | Use raw sentences |
| H9 | Kokoro-default run, one Qwen character, no pinned tier | `keep06` | Pass the raw run key |
| H10 | 0.6B speaker, empty base voice, one variant slot | `keep06` | Remove step 5's exception |
| H11 | 1.7B speaker, empty base voice, one variant slot | none | Apply the exception on every tier |

**Parity.** Feed each row to the real `synthesiseChapter` with recording fake
providers, collect every `modelKey` passed to `synthesize` and
`synthesizeBatch`, and assert the Qwen tiers recorded are a **subset** of the
helper's output on every row and **equal** on H1 to H9 and H11. H10 runs
twice, with and without a sentence tagged with the variant's emotion; the
helper keeps `keep06` in both and the test records what the render sent in
each. Controls: one row must record a 0.6B call and one a 1.7B call.
Mutations in `synthesise-chapter.ts`, helper untouched: change the fallback
predicate at `:1507-1508`; make `routeFor` ignore `ttsModelKey`.

**The fixtures must not reach the sidecar.** `synthesiseChapter` builds its
default resolver deps whenever a chapter has a library-backed cloned or
designed voice (`:2003-2026`), and those deps make real calls for a missing
artifact. Three selectors feed those lists, and every fixture character must
miss all three: `characterHasClonedSlot(c)` (`:1665`); the legacy shape, a
qwen slot with a string `libraryUuid` and no `provenance` (`:1722-1731`);
and `overrideTtsVoices.qwen.provenance === 'designed'` (`:1766-1770`). So a
fixture's Qwen voice is a slot with a `name` only: no `provenance`, no
`libraryUuid`, and no cloned slot on any engine. That leaves both request
lists empty and neither deps object built. The test asserts this
precondition directly on its fixtures, so a fixture that gains a
`provenance` fails with a clear message. The test also replaces
global `fetch` and undici's `fetch` with functions that throw, so a fixture
that drifts into a library-backed voice fails loudly, not slowly. No
`cloneResolverDepsOverride` / `designedResolverDepsOverride` is passed. The
pre-pass re-derives are outside this test by construction (§3.5); the test
file's header says so.

### 5.2 Run needs (`routes/generation-fallback-gate.test.ts`)

| # | Case | Expected | Mutation |
|---|---|---|---|
| R1 | H1's cast, one target chapter | `{keep06:false, keep17:true}` | Restore `computeUsedQwenTiers` |
| R2 | Target is 1.7B only; a `queued` entry, same book, speaks 0.6B | Both kept | Drop the queue term |
| R3 | Same, entry `done` / `failed` / another book's | `keep06` false | Count every status / book |
| R4 | A rendered, non-target, non-queued chapter speaks 1.7B; target 0.6B | `keep17` false | Add every chapter to `P` |
| R5 | Queue file unreadable | Full-cast value | Treat as "no pending" |
| R6 | Same-book job declares `{keep17}`; target 0.6B | Both kept | Remove the sibling union |
| R7 | That sibling is aborted | `keep17` false | Remove the abort filter |
| R8 | Same-book job with no `tierNeeds` | Full-cast value | Treat absent as none |
| R9 | This book's score pass in flight at run start | Full-cast value | Remove the check |
| R10 | Every speaker falls back | Reconcile not called | Remove the empty-keep guard |
| R11 | Pending entry stamped `qwen3-tts-1.7b`; request is 0.6B; its speaker is unpinned | `keep17` true | Use the request key for every chapter |
| R12 | Pending entry with **no** `modelKey`, status `awaiting_confirm`; request is 1.7B; its speaker is unpinned | `{keep06:false, keep17:true}` (evaluated at the request key, no full-cast fall-back) | Fall back to the full cast for an unstamped entry |
| R13 | The POST's own `in_progress` entry is stamped 0.6B but the request says 1.7B | `keep17` true, `keep06` false (the request wins for a target chapter) | Read the own entry's stamp for the target |

### 5.3 Ordering

- O1: when the mocked reconcile is entered, `isGenerationActive(bookId)` is
  true. Mutation: move the call back above `registerJob`.
- O2: a bare-resume POST with a live job makes no reconcile call.
- O3: the existing Kokoro-drop tests stay green. Mutation: read "another
  active" after `registerJob`; the first-POST test must go red.

### 5.4 Queue stamping

- Q1 (`src/store/queue-thunks.test.ts`): rehydrated and account hydrated, no
  override → posts `modelKey` equal to `ui.ttsModelKey`. Mutation: remove
  the stamp.
- Q2: an override is posted as given, in every state. Mutation: let the
  session model win.
- Q3 (`src/store/queue-dispatcher-middleware.test.ts:937`, existing): an
  entry with no `modelKey` dispatches at the session model. Stays green.
- Q4: before rehydrate, and after rehydrate with neither an explicit pick
  nor a hydrated account → no `modelKey` is posted. Rehydrated with an
  explicit pick and no account yet → stamped. Mutation: stamp
  unconditionally; the first two cases must go red.

### 5.5 Keep as a function (`tts/ensure-sidecar-loaded.test.ts`)

- F1: the function's answer changes while `/health` is in flight; no
  `/unload` for the tier it now keeps. Mutation: call it before the await.
- F2: it returns `null`; no `/unload`, returns `false`.
- F3: the existing tests stay green with a plain object.

### 5.6 Post-score re-read (`routes/generation-spk.test.ts`)

- S1: hold `scoreBook` open; add a `queued` entry for the same book whose
  chapter speaks the other tier; release. Reconcile receives a keep with
  both tiers. Mutation: use the value captured at the POST.
- S2: hold `scoreBook` open; register a same-book job with declared needs;
  release. Same assertion. Mutation: drop the live-job union.
- S3 (strict subset): the cast has a silent 0.6B member and only 1.7B
  speakers; the finished chapter is 1.7B; one `queued` 1.7B entry remains.
  Reconcile receives exactly `{keep06:false, keep17:true}`. Mutations: use
  the full cast at post-score; apply §2.2's own-score-pass fall-back here.
  Each must go red. S1 and S2 alone would pass a full-cast implementation.
- S4: the finished chapter spoke 0.6B and one `queued` entry speaks 1.7B
  only. Reconcile receives `{keep06:false, keep17:true}`: the finished
  chapter's tier is not kept. Mutation: leave the finished chapter in `P`.
- S5: #4497's skip tests, including (d) design and (e) mint, stay green and
  unmodified.

### 5.7 Stage 2 only (NOT PLANNED, D1)

- U1: another book's job declares `{keep17}`; this book is 0.6B only;
  reconcile is called with the union. Mutation: drop the other-book term.
- U2: another book's job with no `tierNeeds` → skipped.
- U3: a splice that declared `{keep06}` → unioned; before it declares →
  skipped; aborted → not counted.
- U4: another book's score pass, a live design, a live mint → skipped.

### 5.8 On-box

A Group A register row, **added by the implementing PR (Task 8), not by this
docs PR** (CLAUDE.md Before-shipping step 3; the id is the next free Group A
id when the implementing PR is written, read from the register's `next-id`
marker on the then-current `main` — not A132, which PR #4497 already uses). It carries the register row, the live view
and `register:build`:

- (a) Session model **Standard (0.6B)**, every speaker of the chapters to
  render pinned to Quality (1.7B), **the narrator included** (the title beat
  always speaks), and one silent character left unpinned, with the 0.6B
  resident. On this PR: `evicting unused Qwen tier(s) [0.6B]` at run start,
  then `qwen_loaded: false`. On main the silent unpinned character pins the
  0.6B (no eviction line). Under a Quality session model it proves nothing:
  tiers only elevate, so main's full-cast keep is already 1.7B only.
- (b) A chapter order where one tier has a last user before the final
  chapter (chapters 1 and 2: a Quality-pinned speaker plus a Standard
  narrator; chapter 3: Standard speakers only), under a Standard (0.6B)
  session model (a Standard narrator exists only there), with one generation
  worker and render-integrity QA off (the shipped defaults; a saved override
  or an exported env var counts as set. The worker count resolves
  `GEN_WORKERS`, then the `tts.gen.workers` override, then the legacy
  `generationWorkers` user setting; the knob is **Generation workers**, and it
  applies on a server restart. QA is **Render-integrity QA (voice match)**,
  `qa.speaker.enabled` / `SEG_SPK_ENABLED`. With 2+ workers chapter 3's POST
  overlaps chapter 2, whose job keeps the 1.7B; with QA on, a long chapter-1
  score pass can make single-flight drop later triggers, so no eviction line
  appears either way; with QA off nothing reconciles after chapter 2 ends),
  rendered through the queue so
  each chapter is its own POST. No `/unload` at chapters 1 and 2; at chapter
  3's POST `evicting unused Qwen tier(s) [1.7B]` and `qwen_base17_loaded:
  false`. On main neither tier is ever unloaded on this book.
- (c) **Record, do not pass/fail:** on a book whose keep has `keep06` false,
  remove one speaker's voice artifact and render a chapter. Record
  `qwen_loaded` and `qwen_base17_loaded` from `GET /health` after the
  run-start reconcile, during the chapter, and after the next chapter's
  POST, and whether anything ran out of memory. The expected reading is
  both true during the chapter (§3.5); the row records what was seen.

### 5.9 Issue acceptance, mapped

- "Two concurrent generations on different tiers: neither evicts the
  other's tier": #4497's tests.
- "Single-book behaviour unchanged": this design changes it (D6, approved). R1 to R4 are the proposed new single-book contract.

## 6 · Task breakdown (one commit each)

**Precondition: PR #4497 is merged.** Task 4 then proves, on that merged
head, that designs and mints are covered. If #4497 is rejected, Stage 2
stops being optional and still needs a design/mint skip.

### Stage 1 chain

1. **Helper.** `tts/qwen-tier-needs.ts`, H1 to H11. Export the narrator-id
   expression from `synthesise-chapter.ts:1566-1568` and use it in both
   places.
2. **Parity test.** Test-only, against the real `synthesiseChapter`, with the
   no-network fixtures and both mutations run and recorded.
3. **Stamp `modelKey` at enqueue.** `src/store/queue-thunks.ts`, with the
   trust condition of §2.6. Update the comments that say "absent → session
   default" (`queue-thunks.ts:53-54`, `workspace/queue-io.ts:45-47`, `:103`).
   Q1 to Q4. Frontend scope; independent of tasks 1 and 2.
4. **Transport guard.** G1 and G2 (§5.0), written against the current
   reconcile. Test-only. **A red G1 stops the chain here.**
5. **Run needs.** `routes/generation.ts`: `P`, `runNeeds`, the recompute
   closure, `RunningJob.tierNeeds`, the same-book union with the abort
   filter, and the fall-backs. Rewrite the "Known tradeoff" comment at
   `:1026-1032`. R1 to R13. Keep the variable name `usedQwenTiers`
   (`gpu/render-lease.test.ts:102` asserts the source text). Re-run G1.
6. **Reconcile after register.** Move the run-start reconcile to just before
   the loop. Correct the one false sentence in the residual notes and reword
   them as narrowed (§3.4). O1 to O3.
7. **Keep as a function, and the post-score re-read.** The reconciler
   accepts a function read after `/health`; the run-start caller passes one;
   `triggerScoring` recomputes the book's needs and passes one (§2.7).
   F1 to F3, S1 to S5.
8. **Docs and ship.** Both release-notes files (stamping is user-visible,
   D7), the on-box row and live view, the plan doc and `INDEX.md`,
   `verify:fast:branch`, PR with `Closes #1393` (D1: Stage 1 closes the issue).

### Stage 2 chain (NOT PLANNED: D1 decided no; history only)

9. `routes/chapter-job-coordination.ts`: declared needs, a declare function,
   a reader that reports an undeclared live splice.
10. `routes/chapter-splice.ts`: declare after `:440`; remix declares none.
11. `routes/chapter-qa-repair.ts`: declare after `:430`.
12. `routes/generation.ts`: replace the other-book-render and splice terms of
    `otherTierWorkActive` with the union and the not-declared rule; keep the
    score-pass, design and mint terms. U1 to U4. Re-run G1.
13. Docs, register row, ship.

## 7 · Claims most likely to be wrong, and what was checked

| # | Claim | Checked how | Standing |
|---|---|---|---|
| 1 | Nothing awaits between `registerJob` and the chapter loop | Listed every top-level statement in `generation.ts:1428-2476` | Verified |
| 2 | Nothing awaits between the current reconcile and `registerJob` | Read `:1237-1427` | Verified |
| 3 | #4497 is open at `ba658ab7` and counts designs and mints in `postDesignAndCacheAudition` | `gh pr view`, `gh pr diff` (the `inFlightByPurpose` hunk) | Verified for that function. Whether every transport reaches it is **not assumed**: §5.0 |
| 4 | On `main`, `qwen-voice.ts`'s local wrapper calls the shared function | `:2356-2373` | Verified on `main` only. Two call sites pass no `purpose` (`:2383`, `:2426`); how #4497's counter indexes an absent `purpose` was not established |
| 5 | The helper never predicts below what the render sends | Step 5; parity asserts subset on every row | By construction for synth calls. Not for pre-pass re-derives (§3.5) |
| 6 | A 0.6B eviction drops VoiceDesign; a bare 1.7B eviction does not wait for a mint | `main.py:7658-7660`; `:7192-7202`, `:8375-8380` | Verified in source; not reproduced |
| 7 | Both pre-pass re-derives are 0.6B `clone-voice` distils that reload and proceed | `synthesise-chapter.ts:1292-1307`; `derive-engine-artifact.ts:127`; `main.py:8201-8220` | Verified for the designed resolver's default deps and the sidecar. The cloned resolver's deps (`buildDefaultCloneResolverDeps`, `:1180`) were not re-read line by line |
| 8 | A 1.7B batch fails whole in the ensure→lock gap and is retried | `main.py:9011-9023` comment; `tts/sidecar.ts:461-473` marks 5xx transient | Read. The status code the sidecar returns for that raise was not traced |
| 9 | Variants apply on 0.6B only | `synthesise-chapter.ts:2382-2389`; `voice-mapping.ts:85-92` | Verified |
| 10 | `ui.ttsModelKey` can be wrong at boot | `ui-slice.ts:221`, `:610-614`; `store/index.ts:95-100`, `:257-265`; `generation-stream-middleware.ts:229-249` | Verified. That the persisted `ui` slice exposes a rehydrated flag the thunk can read is assumed from `persistReducer` (`store/index.ts:169`); the builder confirms the exact field |
| 11 | Parked entries are never claimed; `paused` is a dead status | `queue-io.ts:30-36` comment; `markAwaitingConfirm` / `confirmFallback` (`:311-351`). A search of non-test server code finds `'paused'` as a queue status only in the type (`queue-io.ts:27`); nothing produces it (the queue's pause is the file-level `paused` flag, `:93`) | Verified. `paused` in `P` is a dead term, harmless, kept so the status union is covered if it gains a producer |
| 17 | The design counter reads zero between a bulk design's characters | #4497's hunk holds it per `postDesignAndCacheAudition` call; that a render drops VoiceDesign at first synth is from CLAUDE.md's model-lifecycle notes | Read. The bulk design loop itself was not traced |
| 12 | The server drops an unrecognised `modelKey` | `routes/queue.ts:123-126` | Verified |
| 13 | The awaited span before `registerJob` | `:872`, `:878`, `:897`, `:967`, `:1124-1135`, `:1146`, `:1173` | Verified |
| 14 | Scoring is off and workers are 1 by default | `config/registry.ts:402-410`; `user-settings.ts:525` | Verified |
| 15 | Narrowing `usedQwenTiers` is safe for the lease and the Kokoro drop | `:1424`, `:1230`; the helper errs toward keeping | Reasoned (D4) |
| 16 | Qwen tiers share one device | `main.py:5885-5889` docstring | Read, not traced |

## 8 · Found in passing (not designed here)

Both in `tts/synthesise-chapter.ts`'s mixed-engine path. Read from code; not
reproduced.

1. **`evictQwenForCoquiPhase` is a third Qwen evictor**, with two
   call sites: the pre-pass (`:1902-1904`) and the render phase (`:2931`).
   Neither #4497 nor this design covers them. As found, both posted
   `/unload { engine: 'qwen' }` with no check of other work, so by §3.0 each
   could break a live design on any book. Since #4568 (owner decision
   2026-11-28) the Coqui-phase Qwen eviction now waits, bounded (180 s), for
   another op's design or mint, then evicts anyway and logs it.
2. **That call does not unload the 1.7B base.** With no `model` it runs
   `QwenEngine.unload()` (`main.py:12214-12217`), which nulls `_base` and
   `_design` only (`:7658-7660`). A mixed Coqui + Qwen-1.7B chapter loads
   XTTS next to a still-resident 1.7B base. Still open: #4568 did not change
   this.

## 9 · Decisions (all made by the owner, 2026-11-20)

Recorded; not reopened.

- **Already decided:** #4497 counts live designs and mints before it merges,
  and Stage 1 enforces it with section 5.0 (G1/G2). `modelKey` is stamped on
  every queue entry at enqueue. The 0.6B re-derive co-residency (section 3.5)
  is accepted, and the on-box row records the resident tiers. The post-score
  reconcile re-reads needs at reconcile time (section 2.7).
- **D0. Decided 2026-11-20: approved.** The keep set is a verified, parity-tested
  plan, not disk facts (section 1.1). This reinterprets the 2026-07-06 "real
  render facts" decision on #1393.
- **D1. Decided 2026-11-20: NO Stage 2.** #1393 closes on Stage 1. Stage 2
  (section 2.4, 2.5, 5.7, tasks 9-13) is **not planned**; it is kept below as
  design history only. Revisit only if the on-box acceptance check PR #4497 adds shows an out-of-memory
  during a two-book overlap. If #4497 is later rejected, Stage 2 stops being
  optional (section 6).
- **D2. Decided 2026-11-20: accepted as recommended.** The inter-chapter gap
  costs one reload per hit; no per-book linger.
- **D3. Decided 2026-11-20: accepted as recommended.** A run that needs no Qwen
  tier skips the reconcile.
  **Amended 2026-11-22 (owner decision on the #4580 review, #1393): the
  post-score reconcile does not skip when the recomputed keep is empty (the
  book's last chapter just finished).** It falls back to the keep computed at
  THIS run's start, so a tier only the scoring audition pulled in (a 0.6B on a
  legacy-segments fall-back) is evicted as on main, and the tiers the run used
  stay. A run-start keep that is itself empty still skips.
- **D4. Decided 2026-11-20: accepted as recommended.** The lease and the Kokoro
  drop follow the narrower `keep17` (one variable).
- **D5. Decided 2026-11-20: accepted as recommended.** Paused and parked
  entries count as pending; a parked chapter pins its tier until answered.
- **D6. Decided 2026-11-20: approved.** The issue's "single-book behaviour
  unchanged" acceptance line is replaced by R1 to R4 (section 5.9).
- **D7. Decided 2026-11-20: accepted.** Consequences of stamping: (i) a chapter
  queued under one session model keeps it if the session model is switched
  before the chapter runs; (ii) the session model is per browser
  (`src/store/index.ts:95-100`), so the tier is decided by the browser that
  **enqueued** the chapter, not the one that later claims and dispatches it;
  (iii) an entry enqueued before the session model is trustworthy is left
  unstamped and behaves as today (section 2.6). **Release notes must state (i)
  and (ii)**: a queued chapter keeps the model it was queued under, and the
  enqueuing browser decides the tier.
- **D8. Decided 2026-11-20: accepted as recommended.** An unstamped pending entry
  is evaluated at the request's model key (section 2.6); an occasional wrong
  estimate costs one reload.

## Ship notes

Shipped 2026-11-21 (Stage 1 only; Stage 2 is not planned, see D1). Branch `fix/server-1393-qwen-keep-set`; the PR is #4580 (opened by the verify child #4579 after #4562 failed on the #2128 guard).

Commits, in order:

- `a05242a0` pure Qwen tier-needs helper (`chapterQwenTierNeeds`)
- `b75d6543` parity test pinning it to the real `synthesiseChapter` synth calls
- `7224d839` frontend stamps the session TTS model on queue entries at enqueue
- `5529d7e8`, `4b58d736`, `788c6fd7` transport guards G1/G2 on designs and mints
- `9d30452f` the reconcile keeps only the tiers the book's unfinished chapters will use
- `c312d7d9` unions live same-book jobs' tier needs into the keep
- `5bf6a958` run-start reconcile runs after the job registers
- `119b488d` run-start keep is read after the sidecar health probe
- `ef0bbe7a` post-score reconcile recomputes the keep when it runs
- `33f77c02` the handler reads the cast id history once (the #2128 guard)
- `2365c46b` a pending entry is evaluated at its own stamp's engine and every pending entry of a chapter counts
- `cfa1df7a` the post-score keep falls back to the run-start keep when empty; one shared same-book union
- Review pass 3 fixes: the skip is by entry id (the POST's own at run start, the finished job's at post-score; chapter plus status only when the id is null), so a claimed re-queue of the same chapter counts; four stale descriptions corrected; A134 (b) names where the worker count and QA settings live and requires QA off.
- Review pass 2 fixes: only the `in_progress` entry of a target or just-finished chapter is skipped, so a re-queue of that chapter counts at its stamp (`bcc95469`); the spread order and empty-to-null of `keepAfterHealth` are pinned at both call sites (`b22ed74c`); two stale comment copies corrected (`da184b96`); on-box row A134 (b) gains the Standard session model and one-worker, QA-off preconditions (`0021ac42`); the non-English engine forcing is recorded in section 3.5 as an accepted residual

On-box row: **A134** in `docs/testing/onbox-acceptance-register.md` (plan section 5.8, owed, not run here; no separate run sheet). Release notes: D7 (i) and (ii) stated in `docs/release-notes-next.md` and `RELEASE_NOTES.md`; D7 (iii) is mentioned in the technical entry only. No behaviour delta against the plan was found while writing these notes.
