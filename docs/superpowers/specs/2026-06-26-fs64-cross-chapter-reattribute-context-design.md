---
title: 'fs-64 — Cross-chapter context for `reattribute` (script-review)'
status: draft
date: 2026-06-26
issue: '#1120'
related:
  - 2026-06-25-fs58-unit-b-reattribute-flag-nonstory-design.md (Unit B — defines `reattribute`; §3.6 names this straddle limitation, §8 files it as a follow-up)
  - 2026-06-23-fs58-llm-script-review-design.md (Unit A — the per-chapter review pass + chunker this builds on)
  - Russian stage-2 attribution under-production (plan 221) — the mis-attribution pain `reattribute` targets
---

# fs-64 — Cross-chapter context for `reattribute`

> **Follow-up from fs-58 Unit B** (`2026-06-25-fs58-unit-b-reattribute-flag-nonstory-design.md`,
> PR #1118). Unit B's §3.6 accepted a v1 limitation: `script-review` reviews **one chapter at a
> time**, so a chapter-opening tagless line whose speaker is set by the *previous* chapter's last
> turn cannot be resolved by turn-taking — the review pass never sees across the boundary. This
> spec closes that straddle by feeding the prior chapter's **last speaking turn** into each
> chapter's existing prompt as read-only context. Strictly additive; **zero new LLM calls**.

## 1. Summary

When the script-review pass reviews a chapter, prepend the **prior chapter's last speaking turn**
(speaker + their line) to the **first chunk** of that chapter's review prompt, clearly labelled as
**reference-only** context. This gives the model the turn-taking signal it needs to resolve a
tagless chapter-opening dialogue line (e.g. `"I know," she said.`) whose speaker is whoever spoke
last at the end of the previous chapter.

**Additive throughout.** When there is no prior speaking turn (first story chapter, prior chapter is
pure narration, prior chapter empty), the prompt is **byte-identical to today**. No schema change, no
`api-types` regen, no frontend change.

## 2. The straddle (what Unit B §3.6 left open)

`script-review` builds a per-chapter prompt in `buildScriptReviewChapterInbox`
(`server/src/routes/script-review.ts:78`) containing only **that chapter's** sentences plus the
post-fold roster. A chapter that opens on a tagless dialogue line has nothing in-prompt that tells
the model who spoke last — the alternation that resolves it lives at the **end of the previous
chapter**. The within-chapter chunker already carries `overlap: 3` context between chunks of the
same chapter (`chapter-chunker.ts`), but that overlap stops at the chapter boundary. Result:
chapter-opening straddle lines are mis-resolved (often defaulting to narrator or the wrong speaker).

## 3. Why the cheap path, not "book-wide runs"

The issue note (#1120) frames this as *"cross-chapter context pushes toward larger / book-wide
runs"* — weighing the fix against RPD cost. That tradeoff only exists for one implementation
(stitching whole chapters together into bigger calls). The path here avoids it entirely:

- The route already loads the **whole book** into `byChapter` via
  `loadPostFoldSentencesByChapter` (`script-review.ts:128`), even on a single-chapter request. The
  prior chapter's tail is therefore **already in memory** — free to fetch.
- We add the tail as **a few extra tokens** to a prompt we are **already sending**. No extra call is
  made → **zero RPD impact**, no change to the per-chapter vs whole-book opt-in.

## 4. Components

### 4.1 New pure helper — `priorChapterSpeakingTurn(sentences, roster)`

Lives in `script-review.ts` (exported, unit-tested like `buildReviewSentencesInput`).

- **Input:** the prior chapter's post-fold sentence array + the roster (for name resolution).
- **Behaviour:** walk **backward** from the end of the array, skipping narration
  (`characterId === 'narrator'`; the canonical `NARRATOR_ID` from `byline-author-guard.ts:12`),
  within a **6-sentence look-back cap**. The first non-narrator sentence found marks the speaker;
  gather that sentence's **contiguous same-speaker run** (within the array) — that run *is* "the
  turn". Concatenate its text (trimmed/space-joined). Resolve `speakerName` from the roster (fall
  back to the raw `characterId` if absent).
- **Output:** `{ speakerId: string; speakerName: string; text: string } | null`.
- **Returns `null`** when: the prior chapter is empty, is all narration, or the last speaking turn
  lies **beyond** the 6-sentence cap (a chapter ending on a long narration block has no live
  dialogue at the boundary → no useful turn-taking signal, so we send nothing rather than reach
  arbitrarily far back).

### 4.2 Neighbor selection — "the prior chapter"

The prior chapter = the **nearest lower chapter id present in `byChapter` that is not `excluded` and
has sentences**. Computed off the full sorted `byChapter` key list (the in-memory whole-book map),
**not** the filtered `chapterIds`, so it resolves identically on a single-chapter request and on a
whole-book run. Excluded chapters (front-/back-matter, per `located.state.chapters[].excluded`) are
skipped so turn-taking continuity holds between **story** chapters. The first story chapter has no
qualifying prior → no context block.

### 4.3 Prompt change — `buildScriptReviewChapterInbox`

Add an optional `priorTurn?: { speakerName: string; speakerId: string; text: string }` param. When
present, render a labelled section **above** the `## Sentences` block:

```
## Prior chapter — last speaking turn (reference only — do NOT emit ops on this)

Aldous (id: aldous): "Then we're agreed. Dawn, at the colliery gate."
```

When absent, the function emits **exactly today's prompt** (the param defaults to omitted).

### 4.4 Skill-prompt note

`skills/audiobook-script-review.md` gains one short paragraph: the "Prior chapter — last speaking
turn" block, when present, is **read-only** turn-taking context for resolving a tagless chapter-
opening line. The model must **never** emit an op targeting it; it carries no reviewable
`sentenceId`.

### 4.5 Route wiring — first chunk only

In the chunk loop (`script-review.ts:233`), pass `priorTurn` **only to the first chunk of each
chapter** (`chunkIndex === 0`). The straddle is the chapter *opening*; later chunks already receive
in-chapter overlap context from the chunker, so prior-chapter context there is wasted tokens. The
`priorTurn` for chapter *N* is computed once per chapter (§4.2) before the chunk loop.

### 4.6 Read-only enforcement

The context turn is **not a reviewable sentence**: its source `sentenceId` belongs to the prior
chapter and is therefore **not** in the current chunk's `coreIds`. The existing owned-op filter —
`result.ops.filter((op) => ownsOp(chunk.coreIds, primarySentenceId(op)))` (`script-review.ts:268`)
— already drops any op the model emits against it. We keep that as the primary guard **and** add a
unit test pinning the invariant, so a future chunker change cannot silently let a context-targeted
op leak into `send({ kind: 'ops' })`.

## 5. Edge cases (all handled — no open questions)

| Case | Behaviour |
|---|---|
| First story chapter (no qualifying prior) | No context block; prompt byte-identical to today. |
| Prior chapter is pure narration | Helper returns `null` → no block. |
| Prior chapter ends on a long narration block (last speaker beyond cap) | Helper returns `null` → no block (no live boundary turn-taking). |
| Prior chapter empty / no attributed sentences | Skipped by neighbor selection; next-lower story chapter considered. |
| Single-chapter request | Prior fetched from the whole-book `byChapter` map → identical behaviour. |
| Speaker off the current roster | Still labelled by name (or raw id); used purely as turn-taking signal, never as an op target. |
| Excluded (front/back-matter) chapter as neighbor | Skipped; nearest lower **non-excluded** story chapter used. |

## 6. Testing

- **Unit — `priorChapterSpeakingTurn`:** ends-on-dialogue (returns that turn); ends-on-narration-
  within-cap (walks back, returns the dialogue turn); ends-on-narration-beyond-cap (`null`);
  all-narration (`null`); empty (`null`); multi-sentence contiguous run (joined text);
  speaker-name resolved from roster; off-roster speaker falls back to id.
- **Unit — `buildScriptReviewChapterInbox`:** renders the labelled block when given `priorTurn`;
  omits it (byte-identical to today) when not.
- **Unit/route — read-only guard:** an op whose primary sentence is the prior-chapter context id is
  dropped (not present in `coreIds`), pinning §4.6.
- **Neighbor selection:** picks the nearest lower non-excluded chapter; skips excluded; returns no
  prior for the first story chapter.
- **No e2e.** This is a server-side prompt-assembly change with no new UI seam, router, or redux
  path — Playwright would add nothing. (Called out explicitly per the testing-discipline bar.)
- **Manual / on-box acceptance:** a real Coalfall run where a chapter opens on a tagless line —
  confirm it now resolves to the prior chapter's last speaker. Folded into the existing fs-58 Unit B
  on-box acceptance debt.

## 7. New-infra summary

**New — server:** the `priorChapterSpeakingTurn` helper + the `priorTurn` param + section on
`buildScriptReviewChapterInbox` + the neighbor-selection + first-chunk wiring in the route
(`script-review.ts`); one paragraph in `skills/audiobook-script-review.md`.

**New — client:** none.

**Schema / api-types:** none.

## 8. Non-goals

- No whole-chapter or whole-book context stitching (the expensive interpretation §3 rejects).
- No context beyond the **first** chunk of a chapter.
- No reach past the 6-sentence look-back cap (a chapter ending on long narration gets no boundary
  context by design).
- No new endpoint, op class, schema field, or frontend surface.
- No auto-voicing / cast changes (separate Unit B follow-up #1118).

## 9. Ship checklist

1. Land the helper + prompt change + route wiring + skill note with paired unit tests (§6).
2. `npm run verify` green (typecheck + tests + e2e + build).
3. Close **#1120**; remove its `docs/BACKLOG.md` row; update `docs/features/INDEX.md` if this spec
   moves to `archive/` on ship.
4. Set this spec `status: stable` + fill Ship notes (date + SHA) once on-box acceptance confirms the
   straddle resolves; `git mv` to `docs/features/archive/` (or keep under `specs/`, matching the
   fs-58 sibling specs' home).

## Ship notes

_(filled on ship — date, merge SHA, on-box acceptance result.)_
