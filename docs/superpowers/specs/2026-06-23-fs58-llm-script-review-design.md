---
title: fs-58 — LLM Script Review (annotation-QA second pass)
status: draft
date: 2026-06-23
issue: '#998'
related:
  - 2026-06-22-expressive-tts-instruct-tiers-design.md (§4.6 — fs-58's original sketch; this spec supersedes it, incl. placement)
  - fs-56 (#996) — per-line `instruct` field; owns the deferred `validate_instruct` class
  - fs-33 (#596) — emotion-only backfill pass; emotion correction is routed here, NOT duplicated in fs-58
  - fs-35 — per-chapter scoping follow-up for the whole-book emotion pass (precedent: whole-book is too coarse)
  - fs-25 (#479) — per-quote emotion enum
  - Russian stage-2 attribution under-production (plan 221) — the attribution pain `reattribute` targets
  - com-1 — Cast Pass entitlement seam (no gate in fs-58; see §9)
inspiration: github.com/Finrandojin/alexandria-audiobook (Alexandria — LLM Script Review)
---

# fs-58 — LLM Script Review

> **Supersedes** the §4.6 sketch in `2026-06-22-expressive-tts-instruct-tiers-design.md`, **including its
> placement** ("before `manuscript-edits.json` is written"). This spec runs the pass as a standalone job
> *over* `manuscript-edits.json`, runnable anytime (incl. post-generation) — see §4.1.
>
> **Re-scoping note (2026-06-23):** issue #998 / BACKLOG describe *five* classes + "engine-agnostic
> (no GPU)." This spec ships **six live classes** (drops `fix_emotion` → fs-33; defers `validate_instruct`
> → fs-56; adds `reattribute` + `flag_nonstory`) and corrects "no GPU" to "no TTS-synthesis engine"
> (§4.4). **#998 + the BACKLOG row must be updated to match before this leaves `draft`.**

## 1. Summary

An **optional, operator-triggered, per-chapter QA pass** that runs a second LLM over already-attributed
sentences and repairs common annotation errors, presented as an **accept/reject diff**. The LLM only
*proposes*; the **server applies deterministically** and owns all sentence-ID allocation. It is
**additive** — off → today's behaviour, exactly.

"Engine-agnostic" means **TTS-engine-agnostic** (no Kokoro/Coqui/Qwen load) — *not* GPU-free: it reuses
the analyzer compute path (local Ollama on GPU, or Gemini cloud). See §4.4.

## 2. Background

Phase-1 attribution (`server/src/routes/analysis.ts`, the `runStage2Chapter` analyzer call) produces,
per chapter, `Sentence`s `{ id, chapterId, characterId, text, confidence?, emotion?, startMs?, endMs? }`,
written (post-fold/dedup) to `manuscript-edits.json` at `analysis.ts:~4043`. Phase-1 is good but not
perfect: it leaks attribution tags into dialogue, over-/under-splits at narrator↔dialogue boundaries,
mis-assigns speakers in tagless back-and-forth, and treats front/back-matter residue (page numbers,
headers) as narration. fs-58 is the targeted repair pass for those errors.

**Precedent:** fs-33's emotion-only backfill (`emotionAnnotationSchema`, `server/src/handoff/schemas.ts`)
already runs a second analyzer pass over attributed sentences and returns `{ sentenceId, emotion }`.
fs-58 generalises that *shape* (a second per-chapter analyzer pass) to additional error classes.
**Emotion correction stays with fs-33** — fs-58 does not duplicate it (§3, §10).

## 3. Error classes (v1 = 6 live + 1 deferred + 1 routed)

Two tiers. **Mechanics** classes fix sentence *shape*; **content** classes fix *who*.

**Mechanics (structural):**
1. `strip_tag` — remove an attribution tag ("she said") that leaked into dialogue text. *Field delta (newText).*
2. `split` — split narration out of a dialogue entry. *Structural (content-addressed pieces, §4.3).*
3. `extract_dialogue` — pull dialogue out of a narrator run into its own sentence with a `characterId`. *Structural.*
4. `merge` — merge over-split narrator entries into one. *Structural.*

**Content (QA):**
5. `reattribute` — re-assign a dialogue line to the correct **existing** cast member (incl. tagless
   turn-taking). *Field delta on `characterId`.* Constrained to the **post-fold** roster (§4.2); never
   invents a character. When the correct speaker is **off-roster** (e.g. folded into `unknown-male`), the
   model instead emits a **read-only `reattribute_blocked` advisory** (rationale only, no apply, no roster
   mutation) so the operator can decide to add a cast member — converting a silent mis-attribution into a
   signal.
6. `flag_nonstory` — flag front/back-matter residue and artifact lines (page numbers, headers, empty/
   punctuation-only) that Phase-1 mislabeled as narration, via a soft `excludeFromSynthesis` flag (no
   deletion, no ID churn). **Constrained** to lines whose `characterId` is `narrator` AND that match
   artifact signatures (digit-only, header-case, page-number patterns) — never a line the model would
   otherwise `reattribute`, and never a short legitimate narration/dialogue line ("Silence.", "Run!").

**Routed — `fix_emotion`:** emotion correction is **out of fs-58**; it belongs to fs-33's emotion pass. If
fs-33 needs a "correct an existing wrong emotion" mode (vs. backfill-only), that is filed against fs-33
(§9). Rationale: avoid a second, divergent emotion path (Simplicity-first); and emotion staleness has its
own 3-way-gated rule (`sentence-emotion-control.tsx:77-87`) that fs-33 already lives next to.

**Deferred — `validate_instruct`:** the per-sentence free-text `instruct` field does not exist yet
(fs-56 owns it). **Parked in fs-56's scope** with a bidirectional cross-link filed as a tracked issue
(§9) — if fs-56 ships the field before fs-58, the class moves back here. No dead code ships in fs-58.

**M5 carve-out:** the prompt **never strips intentional non-verbal vocalizations** ("Ah!", "Haah…") as
attribution tags, and `flag_nonstory` never flags a vocalization line as junk. Hard, tested constraint.

## 4. Architecture & flow

### 4.1 Where it slots

A **standalone, per-chapter job** (not inside the analyse SSE), runnable **anytime** incl. post-generation:

- New endpoint **`POST /api/books/:bookId/script-review`** taking an **optional `chapterId`** (default:
  the chapter being edited; whole-book is opt-in). Own SSE stream mirroring the analysis grammar
  (`phase` / per-chapter progress / `result`). Per-chapter default keeps the diff usable at novel scale
  (fs-35 precedent: a whole-book-only pass is too coarse).
- Mounts under `/api`, so it **inherits `requireLanToken` + `requireSameOrigin` CSRF** (`app.ts:111-114`)
  — no per-route auth needed.
- **Non-sticky / no resume** (like fs-33's annotate-emotion): a disconnect mid-run aborts; re-run from
  scratch. Set this UX expectation.

### 4.2 The review pass — interface touch-list (NOT "wholesale reuse")

The `Analyzer` interface is **closed and per-stage** (`index.ts:62-94`); adding a pass means a ~7-site
extension in lockstep (exactly what fs-33 did):
1. `runScriptReviewChapter` on the `Analyzer` interface (`index.ts`).
2. `OllamaAnalyzer` impl (`ollama.ts`) — grammar via `format`/`z.toJSONSchema`.
3. `GeminiAnalyzer` impl (`gemini.ts`).
4. `FallbackAnalyzer` delegation (`index.ts`).
5. The review op/delta schema pair (`schemas.ts`).
6. A skill/prompt file + prompt-registry id.
7. A `HandoffKey`.
8. The route (§4.1).

- Model selection: reuse `selectAnalyzer` / per-phase selection (`select-analyzer.ts`,
  `isPerPhaseModelSelectionActive`) with a **dedicated review-model knob** (separate user setting;
  defaults to the analyzer's configured model).
- **Input:** the target chapter's current `sentences[]` + the **post-fold** cast roster (the cache retains
  pre-fold descriptor ids, `book-state.ts:296-304`; passing the post-fold roster prevents every
  `reattribute` to a folded id being dropped as off-roster).

### 4.3 Output format — flat schema, content-addressed structural ops

**Flat schema, no discriminated union.** Reason: the **Gemini path does not send `responseSchema`** today
(`gemini.ts:561-566` sets only `responseMimeType`) — output is free-form JSON repaired by `parseAndValidate`.
A tagged union with integer offsets is unsafe in that regime. Two options, decided at plan time:
(a) keep a **flat** array of edits in the working free-form-JSON regime (preferred), or (b) **wire
`config.responseSchema` into `gemini.ts`** as an explicit prerequisite (verify no regression to existing
passes). **Stop asserting Gemini is schema-constrained until (b) lands.**

Each edit is one row: `{ id, op, ...payload, rationale, confidence }`. **The LLM never invents sentence
IDs.** Payloads:
- **Field deltas** keyed by existing `id`: `strip_tag` (newText), `reattribute` (characterId),
  `flag_nonstory` (exclude=true).
- **Structural ops, content-addressed (no offsets):** `split`/`extract_dialogue` return the resulting
  text **pieces verbatim** + per-piece `characterIds`; `merge` returns the member `ids`. The server
  validates `normalizeWhitespace(concat(pieces)) === normalizeWhitespace(original.text)` before applying
  — deterministic, self-validating, no character-counting. Off-roster `reattribute` → `reattribute_blocked`
  advisory row (no payload, rationale only).

**Apply order (resolves same-id collisions).** Per chapter: apply **structural ops first** (merge →
split/extract) to fix the id set, **then** field deltas against surviving ids. **Reject** (drop + log,
surface as un-appliable) any field delta whose target id was consumed by a structural op, and any 2nd
structural op on the same id.

### 4.4 Compute note

Reuses the **analyzer** path — local Ollama (**GPU, same footprint as Phase-1**; holds the analyzer GPU
semaphore slot, `ollama.ts:523`) or Gemini (cloud, GPU-free). Loads **no TTS model**, adds **no new
resident GPU model**, never co-resident with a TTS engine — clear of the parent spec's §4.7 VRAM
invariant. On a single small (8 GB) GPU it **contends with the analyzer and is evicted-by/evicts TTS** —
you cannot run a review pass concurrently with a generation on one small card.

### 4.5 Cost & latency

Per-chapter trigger = **one LLM call per run** (book-wide = one per chapter). The free-tier RPD caps bite
on book-wide runs: `gemini-2.5/3.5-flash` RPD **20** (`rate-limit.ts:38-40`) — a 20+-chapter book cannot
finish in a day on those; `gemini-3.1-flash-lite` is RPD 500 / RPM 15. The **stronger** models have the
**lowest** RPD, so the review-model knob's "point at a stronger model" actively worsens book-wide cost.
*Spec requirement:* the UI knob **warns when (book-wide chapters > model RPD)**, and the recommended
default is **local Ollama or a high-RPD Gemma**. The limiter serializes + emits `throttle` SSE events.

## 5. The ID-stability & audio-staleness contract

The load-bearing part. Every accepted change is applied **server-side**, writing through to
`manuscript-edits.json` as the **sole ID allocator**.

### 5.1 ID allocation — global, server-only

- Sentence ids are **per-chapter** (restart at 1, `stage2-chunk.ts:259`), but the reparse-survival filter
  keeps any edit with `id > maxCacheId` where `maxCacheId` is computed over the **flattened cache across
  all chapters** (`book-state.ts:281-284`). So new ids must be allocated from the **global** max across the
  whole manuscript's current sentence set — **not** the per-chapter max (a per-chapter allocation would
  mint an id ≤ global max and be orphan-filtered on the next GET, `book-state.ts:289`).
- **Sole allocator:** the server apply read-modify-writes `manuscript-edits.json` under the existing
  mutation serialization (`serializeQueueMutation`, `generation.ts:305-315`). The client does **not**
  optimistically merge — it **refetches** the manuscript after apply. This kills the client+server
  dual-allocator collision/race (two independent allocators minting the same id).

### 5.2 Field deltas (no ID change)

`strip_tag`, `reattribute`, `flag_nonstory` mutate the existing sentence in place by `id`. ID-stable.

### 5.3 `split` / `extract_dialogue`

- Original keeps its `id`; each new piece gets a **global** `maxId+1, +2, …` (§5.1).
- `extract_dialogue` assigns the extracted piece the dialogue `characterId`; remainder stays narrator.
- **Drop `startMs`/`endMs`** on the original and all pieces — render-time timing is invalid the moment the
  shape changes; the next render restamps. (Silently copying corrupts listen-view seek / clip-share.)

### 5.4 `merge` — restructure, not pure drop (re-analysis must not resurrect)

- Surviving `id` = **lowest** in the set; `text` = members concatenated in document order (single space).
- **Validation:** members must share an identical `characterId` AND be **all `neutral`** (so no emotion is
  orphaned — the parent spec's M1 forbids orphaning emotion) AND lie within **one `chapterId`**. Reject
  otherwise (drop + log). Drop `startMs`/`endMs`.
- **Contract requirement (the C3 hazard):** a merge must **survive a subsequent re-analysis** without
  resurrecting the dropped ids as duplicate content. A pure drop from `manuscript-edits.json` is
  insufficient — re-analysis re-mints the per-chapter ids and the frontend `hydrateFromAnalysis` append
  branch (`manuscript-slice.ts:149-151`) re-adds them. **Candidate mechanism (verify at plan time):** model
  merge/split as a server-side chapter **restructure with a remap table** (mirroring
  `applyChapterRestructure`, `manuscript-slice.ts:378-401`, which drops un-remapped ids deterministically)
  and/or a persisted **tombstone set** the hydrate-append branch consults. *The hydrate-append branch is
  the corruptor and must be addressed.*

### 5.5 Audio staleness — the real lever is `boundary_move`, not a server stale flag

There is **no server-side stale flag**; staleness is **client-derived** (`stale-chapters.ts:58-70` diffs
the render-time speaker map against the live Redux manuscript; `generation.tsx:629-646`). The only
server-reachable lever is the **change-log `boundary_move` event** (the time-based heuristic,
`stale-chapters.ts:18-44`, whose precondition is *"EVERY reassignment path must emit a `boundary_move`"*).

- The server apply **appends a `boundary_move` change-log event** for **every affected chapter** on:
  any structural op, any `reattribute`, and any `flag_nonstory` exclude. The client then re-derives
  staleness on its next manuscript refetch (which §5.1 already forces).
- **Remove** the prior "eager server-side invalidation via the segments-map drift mechanism" claim — that
  mechanism is client-only and carries `characterId` only.
- **Cross-tab caveat:** manuscript mutations are **not** broadcast (`broadcast-middleware.ts:60-62`), so a
  second open tab keeps a stale manuscript + stale-audio badges until it refetches. State this; don't
  promise cross-tab freshness.

### 5.6 Guards

1. **Op validation before apply:** concat-equality for structural ops (§4.3); referenced ids exist;
   merge same-`characterId` + all-`neutral` + same-`chapterId`; `reattribute` target ∈ **post-fold**
   roster; ≤1 structural op per id; no field delta on a consumed id. Invalid → dropped + logged + surfaced
   as un-appliable; never corrupt state.
2. **In-flight generation guard (v1 = book-level):** only `isGenerationActive(bookId)` is exported
   (`generation.ts:396`); the per-chapter registry is private. **v1 blocks apply for the whole book while
   any generation job runs.** A chapter-level guard is a filed follow-up (§9).
3. **Transactional per chapter** — a write failure applies nothing for that chapter.

### 5.7 Suggestion lifetime & storage

Ephemeral per run. Stored in a **dedicated, non-polled, bookId-keyed** slice — **NOT** `revisions.pending`,
which `applyPoll` replaces wholesale per poll (`revisions-slice.ts:160-163`) and would wipe an in-progress
review (and violate the concurrent-multi-book invariant). "Extends the revisions/DriftReport pattern" means
the **UI pattern only**. Persisting suggestions across reload is a follow-up (§9).

## 6. Operator UX

- A **"Review Script"** button on the manuscript editing surface (per-chapter; whole-book is an explicit
  opt-in). Fires `POST …/script-review`; per-chapter progress reuses the analysis SSE `phase` grammar.
- Results land in a **`ScriptReviewDiff` modal** (the DriftReport accept-reject *pattern*, dedicated slice
  per §5.7), **grouped by chapter then class**, with per-class accept/reject and drill-down to per-change
  toggles. Each row: before → after (text / characterId / exclude), class, LLM rationale, confidence.
  `reattribute_blocked` rows render **read-only** (advisory).
- **Tiered defaults:** mechanics classes (`strip_tag`/`split`/`extract_dialogue`/`merge`) pre-selected
  **ON**; content classes (`reattribute`, `flag_nonstory`) default **OFF** (explicit opt-in). **Apply**
  writes the selected set, emits `boundary_move` per affected chapter (§5.5), records a change-log entry,
  and triggers a client manuscript refetch.

## 7. Error handling

- LLM unreachable → Gemini fallback (`FallbackAnalyzer`); both down → SSE `error`, **no state change**.
- Throttle / RPD → `onThrottle` SSE event; book-wide may hit `DailyQuotaExhaustedError` mid-run (§4.5) —
  surface partial progress, no partial corruption (per-chapter transactional apply).
- Malformed / invalid op → dropped + logged + surfaced as un-appliable; the run continues.
- Cancel / abort → `signal` propagates; ephemeral suggestions discarded.

## 8. Testing & acceptance

- **Server unit, per class (6):** before/after fixtures; the apply step's **global** ID allocation (§5.1),
  the **restructure remap** for `split` + `merge` (§5.3/§5.4), apply-order on mixed same-id ops (§4.3),
  op-validation rejections (§5.6), the `boundary_move` emission (§5.5).
- **Re-analysis regression (the C3 hazard):** after a `merge`/`split`, run a re-analysis and assert the
  dropped ids do **not** resurrect and content is **not** duplicated.
- **M1/R2-M3 regression:** structural ops preserve ID stability, don't orphan emotion/audio, respect prior
  manual edits; split offspring (`id > global maxCacheId`) survive re-analysis.
- **Abstention fixtures (precision):** `reattribute` must NOT fire on correctly-attributed dialogue;
  `flag_nonstory` must NOT exclude short legitimate narration/dialogue; `strip_tag`/`flag_nonstory` must
  NOT touch M5 vocalizations ("Ah!").
- **Synth consumer:** a `excludeFromSynthesis` sentence produces **no audio segment** (filter in
  `buildSentenceGroups`, §10).
- **Frontend unit:** `ScriptReviewDiff` selection logic (tiered defaults, per-class/per-change → apply
  payload); the dedicated slice is **not wiped** by a revisions poll.
- **E2E (Playwright):** per-chapter trigger → diff → accept a subset → manuscript refetches → affected
  chapter reads stale. Append a case to `e2e/responsive/coverage.spec.ts`.
- **No sidecar/golden-audio tier** — fs-58 loads no TTS model.

## 9. Non-goals & follow-ups

**Non-goals (v1):**
- No TTS-synthesis engine involvement (this is what "engine-agnostic" means; it is *not* GPU-free, §4.4).
- No cast-roster mutation — `reattribute` targets only existing post-fold cast; off-roster → read-only
  `reattribute_blocked` advisory.
- No `fix_emotion` — routed to fs-33 (below).
- No `validate_instruct` — deferred to fs-56 (below).
- No suggestion persistence across reload (below).
- No chapter-level in-flight guard — v1 blocks at book level (below).
- No auto-apply without review; no free-form text rewriting beyond `strip_tag`.
- No entitlement/paywall gate (the word "premium" is dropped; relationship to com-1 Cast Pass is TBD at
  that seam, not here).

**Follow-ups — FILE NOW (issue + thin BACKLOG row, per the project rule):**
1. **Persist suggestions** across reload (`script-review-suggestions.json`).
2. **`validate_instruct` class** — blocked on fs-56's per-sentence `instruct`; **also edit the fs-56
   issue/spec** to carry the move-here note (make the cross-link bidirectional in tracked artifacts).
3. **fs-33 "correct an existing wrong emotion" mode** — the home for emotion correction fs-58 declined.
4. **Chapter-level in-flight generation guard** — replace the v1 book-level block.

## 10. Dependencies & linkage

- **fs-56 (#996)** — owns the per-sentence `instruct` field; `validate_instruct` parked there (§9.2).
- **fs-33 (#596)** — owns emotion correction (§9.3).
- **New optional `excludeFromSynthesis` sentence field** — fs-58 owns it: `openapi.yaml` →
  regenerated `src/lib/api-types.ts` → Zod `sentenceSchema`. **Synth consumer in scope:** a
  `.filter(s => !s.excludeFromSynthesis)` in `buildSentenceGroups` (`synthesise-chapter.ts:~659`) + test
  (§8) — without it the flag is cosmetic. **`.strict()` is safe on disk:** persisted `manuscript-edits.json`
  / cache are read leniently (`book-state.ts:225`, no `sentenceSchema.parse()`), so the new optional field
  needs **no migration** and isn't stripped on read — **but** keep the review output **delta-only** (never
  a full strict `Sentence`, which would require the field in the grammar schema). **Precedence vs the
  chapter-level `isLikelyFrontMatter`** (`openapi.yaml:3342`): chapter-level exclusion wins; a sentence
  flag inside an already-excluded chapter is a no-op.
- **Reuses:** analyzer call path + `RateLimiter` (`server/src/analyzer/`); `serializeQueueMutation`
  (`generation.ts`); the `boundary_move` change-log + `stale-chapters.ts` staleness derivation; the
  `applyChapterRestructure` remap pattern (`manuscript-slice.ts:378-401`); `manuscript-edits.json` I/O
  (`server/src/routes/book-state.ts`); the DriftReport accept-reject UI pattern.

## 11. Implementation ordering (for the plan)

1. **Schema + server apply contract (highest-risk, test-first):** the `excludeFromSynthesis` field
   (OpenAPI → types → Zod) + the synth-side filter + test; the review op/delta schema; the server **apply
   module** — global allocator under `serializeQueueMutation` (§5.1), restructure-based split/merge with
   the re-analysis-no-resurrect guarantee (§5.4), apply-order (§4.3), `boundary_move` emission (§5.5),
   op-validation (§5.6) — with the C3 re-analysis regression + M1/R2-M3 + abstention fixtures.
2. **Review pass + endpoint:** the 7-site `runScriptReviewChapter` extension (§4.2); the flat output
   schema (decide flat-vs-wire-Gemini-responseSchema, §4.3); the per-chapter endpoint + optional
   book-wide; the review-model knob + RPD warning (§4.5); the prompt with M5 + abstention constraints.
3. **Operator UX:** the dedicated non-polled slice (§5.7); `ScriptReviewDiff` (per-chapter, tiered
   defaults, `reattribute_blocked` advisories); apply → `boundary_move` → change-log → client refetch; the
   book-level in-flight guard; the E2E spec.

## 12. Adversarial review — resolutions (2026-06-23)

Three independent code-grounded reviewers (data-integrity, scope/product, architecture). Findings resolved
into the sections above:

- **§5.4 server-side invalidation was fictional → §5.5 rewritten** around `boundary_move` + client
  re-derive (staleness is client-derived; `stale-chapters.ts`).
- **`fix_emotion` was doubly wrong + overlapped fs-33 → routed to fs-33** (§3, §9.3); emotion is not in the
  speaker-map diff and the real rule is 3-way gated incl. the neutral-direction miss.
- **merge-as-drop resurrected on re-analysis → §5.4 restructure/tombstone contract** (`hydrateFromAnalysis`
  append branch is the corruptor).
- **Gemini `responseSchema` never wired → §4.3 flat schema** (drop the union; or wire it as a prerequisite).
- **Offsets fragile → §4.3 content-addressed pieces** with concat-equality validation.
- **Undefined mixed-op order → §4.3 apply-order rule.**
- **maxId is global not per-chapter → §5.1.** **Dual allocator race → §5.1 sole-allocator + refetch.**
- **"Wholesale reuse" overstated → §4.2 7-site touch-list.**
- **In-flight guard chapter-level didn't exist → §5.6 book-level v1 + §9.4 follow-up.**
- **`excludeFromSynthesis` cosmetic → §10 synth consumer in scope.**
- **Pre-selected-all unsafe → §6 tiered defaults.** **`reattribute` off-roster → §3 advisory.**
  **`flag_nonstory` false-positives → §3 constraints + §8 abstention tests.**
- **`validate_instruct` orphan deferral → §9.2 file now + edit fs-56.**
- **Whole-book unusable → §4.1/§6 per-chapter (fs-35 precedent).**
- **`ScriptReviewDiff` on `revisions.pending` → §5.7 dedicated non-polled slice.**
- **Scope 5→7 + no-GPU reversal → re-scoping note (header) + #998/BACKLOG update gate.**
- **Moderates/minors folded in:** `startMs/endMs` dropped on structural ops (§5.3/5.4); token/RPD cost
  (§4.5); cross-chapter merge rejected (§5.4/5.6); placement supersedes (header); `.strict()` safe on disk
  + delta-only output (§10); post-fold roster (§4.2); auth inherited (§4.1); non-sticky (§4.1); cross-tab
  caveat (§5.5); corrected `book-state.ts` path (§10); "premium" dropped (§9).
