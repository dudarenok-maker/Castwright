---
title: fs-58 — LLM Script Review (premium annotation-QA pass)
status: draft
date: 2026-06-23
issue: '#998'
related:
  - 2026-06-22-expressive-tts-instruct-tiers-design.md (§4.6 — fs-58's original sketch; this spec supersedes it)
  - fs-56 (#996) — per-line `instruct` field; owns the deferred instruct-validation class
  - fs-25 (#479) — per-quote emotion enum (the field `fix_emotion` repairs)
  - fs-33 (#596) — emotion-only backfill pass (precedent for a second analyzer pass)
  - Russian stage-2 attribution under-production (plan 221) — the attribution-quality pain `reattribute` targets
inspiration: github.com/Finrandojin/alexandria-audiobook (Alexandria — LLM Script Review)
---

# fs-58 — LLM Script Review

## 1. Summary

An **optional, operator-triggered, premium QA pass** that runs a second LLM over already-attributed
sentences and repairs common annotation errors, presented as an **accept/reject diff**. It is modeled
as **"just another editor"**: every accepted change produces the same kind of edit a human makes in the
confirm stage and is applied through the *existing* manual-edit + audio-invalidation machinery. The LLM
only *proposes*; the server applies deterministically and owns all sentence-ID allocation.

It is **additive** — off → today's behaviour, exactly. It reuses the **analyzer** compute path (no TTS
engine), so it is independent of Kokoro/Coqui/Qwen and shippable on its own.

## 2. Background

**Source feature (Alexandria):** an optional second pass fixing annotation-error classes after the
initial attribution. Castwright's Phase-1 attribution (`server/src/routes/analysis.ts`, the
`runStage2Chapter` analyzer call) produces, per chapter, a list of `Sentence`s:

```
{ id, chapterId, characterId, text, confidence?, emotion? }   // emotion = fixed 5-value enum
```

written (post-fold/dedup) to `manuscript-edits.json` at `analysis.ts:~4043`. Phase-1 is good but not
perfect: it leaks attribution tags into dialogue, over-/under-splits sentences at narrator↔dialogue
boundaries, mis-assigns speakers in tagless back-and-forth, occasionally sets a wrong `emotion`, and
treats front/back-matter residue (page numbers, headers) as narration. fs-58 is the targeted repair
pass for exactly those errors.

There is a strong in-repo precedent: **fs-33's emotion-only backfill** (`emotionAnnotationSchema`,
`server/src/handoff/schemas.ts`) already runs a second analyzer pass over attributed sentences and
returns only `{ sentenceId, emotion }`. fs-58 generalises that shape to multiple error classes.

## 3. Error classes (v1 = 7 live + 1 deferred)

Two tiers. **Mechanics** classes fix sentence *shape*; **content** classes fix *who/how*. The premium
value is in the content tier — that is where "wrong speaker / wrong delivery / junk read aloud" lives.

**Mechanics (structural):**
1. `strip_tag` — remove an attribution tag ("she said") that leaked into dialogue text. *Field delta, text-only.*
2. `split` — split narration out of a dialogue entry. *Structural.*
3. `extract_dialogue` — pull dialogue out of a narrator run into its own sentence with a `characterId`. *Structural.*
4. `merge` — merge over-split narrator entries back into one. *Structural.*

**Content (QA):**
5. `reattribute` — re-assign a dialogue line to the correct character (incl. tagless turn-taking runs).
   *Field delta on `characterId`; constrained to the existing cast roster — never invents a character.*
6. `fix_emotion` — correct an obviously-wrong `emotion` enum value (shouted line left `neutral`; calm
   line marked `angry`). *Field delta on `emotion`.*
7. `flag_nonstory` — flag front/back-matter residue and artifact lines (page numbers, headers, empty/
   punctuation-only) that Phase-1 mislabeled as narration, so the TTS never reads "Page 47" aloud.
   *Soft `excludeFromSynthesis` flag — no deletion, no ID churn.*

**Deferred — `validate_instruct`** (the 8th class). The per-sentence free-text `instruct` field does
not exist yet (fs-56 owns it; only voice-design-level `instruct` exists today). The class is therefore
**parked in fs-56's scope** with a bidirectional cross-link: **if fs-56 ships the per-sentence
`instruct` field before fs-58, the instruct-validation class moves back here into Script Review to
implement.** No dead code ships in fs-58.

**M5 carve-out (from the parent spec's adversarial review):** the prompt explicitly instructs the model
**never to strip intentional non-verbal vocalizations** ("Ah!", "Haah…") as if they were attribution
tags — they are legitimate content, not annotation noise. This is a hard, tested constraint on
`strip_tag` (and on `flag_nonstory`, which must not flag a vocalization line as junk).

## 4. Architecture & flow

### 4.1 Where it slots

A **standalone job**, *not* inside the analyse SSE — because it must be runnable **anytime**, including
after audio has been generated:

- New endpoint **`POST /api/books/:bookId/script-review`** with its own SSE stream, mirroring the
  analysis SSE event grammar (`phase` / per-chapter progress / `result`).
- Triggerable from the confirm/cast stage **and** post-generation — wherever the manuscript is editable.

### 4.2 The review pass

Per chapter, reusing the analyzer call path wholesale:

- `selectAnalyzer({ model })` → local Ollama-with-Gemini-fallback (`FallbackAnalyzer`), same
  `RateLimiter`, same schema-constrained JSON output, same `onThrottle` / `signal` plumbing
  (`server/src/analyzer/`).
- **Dedicated review-model knob** — a separate user setting so review can point at a stronger model than
  bulk attribution; **defaults to the analyzer's configured model** when unset.
- **Input:** the chapter's current `sentences[]` (post-fold, from `manuscript-edits.json`) + the cast roster.

### 4.3 Output format — hybrid

The LLM returns, per chapter, a list of proposed edits in two shapes. **The LLM never invents sentence
IDs**; it only references existing `id`s. The server allocates any new IDs.

- **Field deltas** keyed by existing `id` — `strip_tag` (newText), `reattribute` (characterId),
  `fix_emotion` (emotion), `flag_nonstory` (exclude).
- **Explicit structural ops** referencing existing `id`s — `split(id, offset, pieceCharacterIds[])`,
  `extract_dialogue(id, span, characterId)`, `merge(ids[])`.

This avoids array-diffing entirely (the fragile "which old ID maps to which new entry" heuristic the
parent spec's R2-M3 warned about). Each op/delta maps to exactly one diff row.

Every proposed edit also carries a one-line **rationale** (shown in the diff) and the **class**.

### 4.4 Compute note (corrects the parent spec's "no GPU" framing)

Script Review reuses the **analyzer** path — local Ollama (**runs on the GPU, identical footprint to
Phase-1 attribution**) or Gemini (cloud, GPU-free). It loads **no TTS-synthesis model** (Kokoro/Coqui/
Qwen) and adds **no new resident GPU model** beyond whatever the analyzer already uses. It is a text
pass, never co-resident with a TTS engine — so it stays clear of the §4.7 VRAM invariant of the parent
spec. "Engine-agnostic" means *TTS-engine-agnostic*, not *GPU-free*.

## 5. The ID-stability & audio-invalidation contract

The load-bearing part (parent spec M1 / R2-M3). Every accepted change is applied **server-side,
deterministically**, writing through to `manuscript-edits.json`.

### 5.1 Field deltas (no ID change)

`strip_tag`, `reattribute`, `fix_emotion`, `flag_nonstory` mutate the existing sentence in place by
`id`. Trivially ID-stable.

### 5.2 `split` / `extract_dialogue`

- The original sentence **keeps its `id`**.
- Each new piece is allocated `maxId+1, +2, …` — above the analyzer's max. This is exactly the rule that
  makes user-split offspring survive re-analysis: `book-state.ts:278–295` keeps any edit whose
  `id > maxCacheId`, and the frontend `splitSentence` reducer (`src/store/manuscript-slice.ts`) uses the
  same `maxId+1` allocation. fs-58 reuses this rule rather than inventing one.
- `extract_dialogue` assigns the extracted piece the dialogue `characterId`; the remainder stays narrator.

### 5.3 `merge` — reconciliation rule (answers R2-M3)

- **Surviving `id`** = the **lowest** id in the set (the original analyzer id — maximally stable across reparse).
- `text` = concatenated in document order, single-space joiner.
- `characterId` = **must be identical** across the set (merge only applies to over-split *narrator* runs).
  The apply step **validates** this and **rejects** a merge whose members disagree, rather than silently
  picking one.
- `emotion` = first non-neutral, else neutral; `confidence` = min (conservative).
- Non-surviving ids are dropped.

### 5.4 Audio invalidation = the manual-edit path, made eager

Any structural op, any `reattribute`/`fix_emotion` (changes the voice/variant rendered), or
`flag_nonstory` marks the affected chapter's audio **needs-regeneration** through the *same*
`segments.json` ↔ live-manuscript drift mechanism that a manual sentence reallocation already trips
(`segments.json.segments[].sentenceIds` vs the rendered speaker map). fs-58 triggers it **eagerly on
apply** rather than waiting for the next poll. This is the operator's stated model: *"treat audio as
needing regeneration — same as you manually change the chapter sentence allocations."*

### 5.5 Guards

1. **Server-side op validation before apply** — offset in range, referenced ids exist, merge set
   contiguous + same characterId, `reattribute` target ∈ cast roster. Invalid ops are **dropped with a
   logged reason**; they never corrupt state.
2. **In-flight generation guard** — if a generation job is running on a chapter, applying review changes
   to that chapter is **blocked/queued** (the explore map's render-stall hazard).
3. **Apply is transactional per chapter** — a write failure applies nothing for that chapter.

### 5.6 Suggestion lifetime

Suggestions are **ephemeral per run** — computed, streamed, held client-side for review; only *accepted*
changes write through to `manuscript-edits.json`. Persisting pending suggestions across a page reload
(`script-review-suggestions.json`) is a **named follow-up** (§9), not v1.

## 6. Operator UX

- A **"Review Script"** button surfaces wherever the manuscript is editable (confirm/cast stage **and**
  post-generation). It fires `POST /api/books/:bookId/script-review`; a per-chapter progress bar reuses
  the analysis SSE `phase` grammar.
- Results land in a **`ScriptReviewDiff` modal**, extending the existing revisions / `DriftReport`
  accept-reject pattern (`src/store/revisions-slice.ts`).
- **Grouped by the 7 classes**, with a **per-class accept/reject** toggle and **drill-down to per-change
  toggles** within a class. Each change shows **before → after** (text / characterId / emotion / exclude),
  the **class**, and the LLM **rationale**.
- **Default selection:** all suggestions pre-selected; the operator deselects what it doesn't want
  (efficient for a bulk QA pass). **Apply** writes the selected set, triggers audio-invalidation
  (§5.4), and records a change-log entry.

## 7. Error handling

- LLM unreachable → Gemini fallback (`FallbackAnalyzer`); both down → SSE `error` event, modal shows
  failure, **no state change**.
- Throttle / rate-limit → `onThrottle` SSE event, identical to analysis.
- Malformed LLM op → **dropped + logged**, the chapter continues (one bad op never fails the run).
- Cancel / abort → `signal` propagates; ephemeral suggestions discarded.

## 8. Testing & acceptance

- **Server unit:** one before/after fixture **per class** (7); the apply step's ID allocation
  (`split` maxId+1, `merge` surviving-id reconciliation §5.3), op-validation rejections (§5.5), the
  audio-invalidation trigger (§5.4).
- **Server regression (M1 / R2-M3):** split/merge preserve ID stability, do not orphan emotion/audio,
  and respect prior manual edits; reparse-survival (a split offspring `id > maxCacheId` survives a
  re-analysis).
- **M5 regression:** a fixture containing intentional vocalizations ("Ah!") that `strip_tag` must **not**
  strip and `flag_nonstory` must **not** flag.
- **Frontend unit:** `ScriptReviewDiff` selection logic (per-class / per-change toggles → apply payload).
- **E2E (Playwright):** trigger → diff → accept a subset → manuscript updates → affected audio marked
  stale. Append a case to `e2e/responsive/coverage.spec.ts` for the new modal.
- **No sidecar/golden-audio tier** — fs-58 loads no TTS model.

## 9. Non-goals & follow-ups

**Non-goals (v1):**
- **No TTS-synthesis engine involvement** — no Kokoro/Coqui/Qwen load (this is what "engine-agnostic"
  means; it is *not* "no GPU" — see §4.4).
- No cast-roster changes — `reattribute` targets only existing cast; never invents a character.
- No `validate_instruct` — deferred to fs-56 (§3).
- No suggestion persistence across reload — follow-up below.
- No auto-apply without operator review.
- No free-form text rewriting beyond `strip_tag` (no paraphrasing / content rewriting).

**Follow-ups to file (BACKLOG + issues):**
1. **Persist suggestions** across page reload (`script-review-suggestions.json`) so a long review survives
   a refresh.
2. **`validate_instruct` class** — implement once fs-56's per-sentence `instruct` field lands (tracked in
   fs-56's scope with the bidirectional move-here note).

## 10. Dependencies & linkage

- **fs-56 (#996)** owns the per-sentence `instruct` field; the `validate_instruct` class is added to
  fs-56's scope with a bidirectional cross-link (§3).
- **New optional `excludeFromSynthesis` sentence field** for `flag_nonstory` — fs-58 owns it; added to
  `openapi.yaml` + regenerated `src/lib/api-types.ts` (OpenAPI is the type source of truth) + the Zod
  `sentenceSchema`. **Relationship:** the existing `isLikelyFrontMatter` flag is *chapter-level*
  (`openapi.yaml:3342`, confirm-view auto-suggests excluding whole front/back-matter chapters);
  `excludeFromSynthesis` is the *sentence-level* counterpart for artifact lines inside a story chapter.
- **Reuses:** analyzer call path + `RateLimiter` (`server/src/analyzer/`), revisions-style diff modal
  (`src/store/revisions-slice.ts`), drift / `segments.json` audio invalidation, `splitSentence` maxId
  rule (`src/store/manuscript-slice.ts`), `manuscript-edits.json` I/O (`book-state.ts`).

## 11. Implementation ordering (for the plan)

A sketch for writing-plans, not a delivery commitment:

1. **Schema + contract** — `excludeFromSynthesis` field (OpenAPI → types → Zod); the review op/delta
   schema; the server-side **apply** module (field deltas + structural ops + §5 contract) with its unit
   + M1/R2-M3 regression tests. *Highest-risk, test-first.*
2. **Review pass + endpoint** — `runScriptReviewChapter` over the analyzer path; `POST
   /api/books/:bookId/script-review` SSE; the dedicated review-model knob; the M5 prompt carve-out.
3. **Operator UX** — `ScriptReviewDiff` modal (per-class + per-change toggles), the "Review Script"
   button, the apply → invalidate → change-log wire-up; the E2E spec.
