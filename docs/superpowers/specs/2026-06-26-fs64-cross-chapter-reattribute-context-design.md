---
title: 'fs-64 — Cross-chapter context for `reattribute` (script-review)'
status: draft
date: 2026-06-26
issue: '#1120'
related:
  - 2026-06-25-fs58-unit-b-reattribute-flag-nonstory-design.md (Unit B — defines `reattribute`; §3.6 names this straddle limitation, §8 files it as a follow-up; PR #1118 MERGED, so the `reattribute` op this needs already ships)
  - 2026-06-23-fs58-llm-script-review-design.md (Unit A — the per-chapter review pass + chunker this builds on)
  - Russian stage-2 attribution under-production (plan 221) — the mis-attribution pain `reattribute` targets
---

# fs-64 — Cross-chapter context for `reattribute`

> **Follow-up from fs-58 Unit B** (`2026-06-25-fs58-unit-b-reattribute-flag-nonstory-design.md`,
> PR #1118, merged). Unit B's §3.6 accepted a v1 limitation: `script-review` reviews **one chapter at
> a time**, so a chapter-opening tagless line whose speaker is set by the *previous* chapter's last
> turn cannot be resolved by turn-taking — the review pass never sees across the boundary. This spec
> **feeds the model the signal it needs** to resolve that straddle: the prior chapter's last speaking
> turn, fed into the chapter's existing prompt as read-only context — **but only when the prior
> chapter actually ends in a live dialogue exchange** (the common case is a scene break, where the
> signal would be misleading). Strictly additive; **zero new LLM calls**.
>
> **Revised 2026-06-26 after a three-reviewer adversarial round** (code-grounding, design,
> scope/test-adequacy). The round corrected: a false read-only-guard premise (per-chapter ids, §4.6);
> an unbounded, non-budget-accounted context block (§4.1/§4.5); array-order vs reading-order and
> `excludeFromSynthesis` filtering in the tail walk (§4.1); a conflated null/selection fallback
> (§4.2); a YAGNI run-join (cut); over-claimed "closes the straddle" language (hedged, §6/§9); and the
> scene-break premise itself — which is now gated, not assumed (§4.1).

## 1. Summary

When the script-review pass reviews a chapter, prepend the **prior chapter's last speaking turn**
(speaker name + their single last line, char-capped) to the **first chunk** of that chapter's review
prompt, labelled as **reference-only** context — **gated** on the prior chapter ending in a genuine
alternating exchange (≥2 distinct non-narrator speakers alternating at the boundary). This gives the
model the turn-taking signal to resolve a tagless chapter-opening line (e.g. `"I know," she said.`)
*when, and only when,* cross-chapter turn-taking is plausible. On a scene-break / narration /
monologue ending — the common case — nothing is emitted.

**Additive throughout.** When the gate yields no boundary turn (first story chapter, scene-break
ending, all-narration, residue-only tail), the prompt is **byte-identical to today**. No schema
change, no `api-types` regen, no frontend change.

## 2. The straddle (what Unit B §3.6 left open)

`script-review` builds a per-chapter prompt in `buildScriptReviewChapterInbox`
(`server/src/routes/script-review.ts:78`) containing only **that chapter's** sentences plus the
post-fold roster. A chapter that opens on a tagless dialogue line has nothing in-prompt that tells
the model who spoke last — the alternation that resolves it lives at the **end of the previous
chapter**. The within-chapter chunker carries `overlap: 3` context between chunks of the *same*
chapter (`chapter-chunker.ts:58`); for the **first** chunk `start === 0`, so the before-context is
empty (`chunkWithContext`, `chapter-chunker.ts:71`) — and the chunker only ever sees one chapter's
array (`script-review.ts:227`), so overlap never crosses the boundary. That empty first-chunk
before-context is exactly the gap.

## 3. Why the cheap path, not "book-wide runs"

The issue note (#1120) frames this as *"cross-chapter context pushes toward larger / book-wide
runs"* — weighing the fix against RPD cost. That tradeoff only exists for one implementation
(stitching whole chapters together into bigger calls). The path here avoids it:

- The route already loads the **whole book** into `byChapter` via `loadPostFoldSentencesByChapter`
  (`script-review.ts:128`); the single-chapter narrowing happens *after*, on the `chapterIds`
  iteration list only (`script-review.ts:131-133`), never on `byChapter`. So the prior chapter's
  sentences are **already in memory** on any request — free to fetch via `byChapter.get(priorId)`.
- We add a **bounded** context block (one sentence, hard char cap — §4.1) to a prompt we are
  **already sending**. No extra call → **zero RPD impact**. The block's size is **deducted from the
  first chunk's budget** (§4.5) so it cannot overflow a local model's context window.

## 4. Components

### 4.1 New pure helper — `priorChapterBoundaryTurn(sentences, roster)`

Lives in `script-review.ts` (exported, unit-tested like `buildReviewSentencesInput`). Constants:
`PRIOR_TURN_LOOKBACK = 6` (sentences scanned back from the chapter end — "live exchange must be near
the boundary; a turn further back is a scene break, not a continuation") and
`MAX_PRIOR_TURN_CHARS = 240` (hard cap on the rendered line; longer text is truncated with `…`).

- **Input:** the prior chapter's post-fold sentence sequence + the roster (for name resolution).
- **Reading order:** walk back from the **end of the chapter's post-fold sequence** — the same
  sequence the chunker reviews (`byChapter.get(id)` order). *(Caveat: end-of-chapter split offspring
  are appended out of strict reading order — a wrinkle this route already shares with the chunker;
  out of scope to fix here, noted so the test author doesn't over-specify.)*
- **Eligible sentences:** skip narration (`characterId === NARRATOR_ID`, imported from
  `byline-author-guard.ts`) **and** `excludeFromSynthesis === true` residue (mirrors the synth-path
  filter; a `flag_nonstory` line must never become a turn-taking signal, nor consume the cap).
- **Turns:** over the last `PRIOR_TURN_LOOKBACK` sentences, collapse eligible sentences into *turns*
  (contiguous same-speaker runs).
- **The live-exchange gate:** return a turn **only if** there are ≥2 turns in the window **and the
  last two turns have different speakers** (genuine alternation at the boundary). A narration ending,
  a single-speaker monologue ending, or a residue-only tail fails the gate → **`null`**.
- **Output (gate passed):** `{ speakerId, speakerName, text }` where `text` is the **single last
  sentence** of the most-recent turn (capped to `MAX_PRIOR_TURN_CHARS`), `speakerName` resolved from
  the roster (fall back to `speakerId` if absent). **No `sentenceId` is returned** — see §4.6.

### 4.2 Neighbor selection — "the prior chapter" (no cascade)

The prior chapter = the **immediately-preceding non-excluded story chapter**: the nearest lower
chapter id present in `byChapter` that is not `excluded` (`located.state.chapters[].excluded`,
computed independently here — the route applies that flag only on the whole-book branch,
`script-review.ts:138-141`, so single-chapter requests must derive it the same way). Computed off the
full sorted `byChapter` key list (not the filtered `chapterIds`), so it resolves identically on a
single-chapter request and a whole-book run.

**No cascade.** If that immediately-preceding chapter exists but `priorChapterBoundaryTurn` returns
`null` (scene-break ending etc.), we emit **no block** — we do **not** fall back to chapter N‑2.
Resolving chapter *N*'s opening from chapter *N‑2*'s ending is semantically wrong (an intervening
chapter broke the exchange). "Has a non-excluded predecessor" gates selection; "that predecessor ends
in a live exchange" gates emission; the two are distinct and there is deliberately no retry between
them. First story chapter → no predecessor → no block.

### 4.3 Prompt change — `buildScriptReviewChapterInbox`

Add an optional `priorTurn?: { speakerName: string; speakerId: string; text: string }` param. When
present, render a labelled section immediately **above** the literal `## Sentences (already
attributed)` block (`script-review.ts:102`):

```
## Prior chapter — last speaking turn (reference only — not a reviewable line; do NOT emit an op on it)

Aldous (id: aldous): "Then we're agreed. Dawn, at the colliery gate."
```

The block exposes the **character** id/name and the line text **only — never a `sentenceId`** (§4.6).
When `priorTurn` is absent the function emits **exactly today's prompt**: the conditional must
contribute **zero characters** (no stray blank line). §6 pins this with a *frozen full-string
equality* test, not a `contains` check.

### 4.4 Skill-prompt note

`skills/audiobook-script-review.md` gains one short paragraph: the "Prior chapter — last speaking
turn" block, when present, is **read-only** turn-taking context for resolving a tagless chapter-
opening line. It carries **no `sentenceId`** and is **not reviewable** — never emit an op targeting
it; use it only to inform the attribution of the chapter's own opening sentences.

### 4.5 Route wiring — first chunk only, budget-reserved

- Compute `priorTurn` **once per chapter** (§4.2 + §4.1) **before** the chunk loop.
- When `priorTurn` is non-null, **reduce the chunk `charBudget`** passed to `chunkSentencesByBudget`
  (`script-review.ts:227`) by a fixed reserve (`MAX_PRIOR_TURN_CHARS` + the section's fixed header
  overhead) so the first chunk + the injected block stays within the local model's context window.
  Cloud engines use a `MAX_SAFE_INTEGER` budget, so the reserve is a harmless no-op there.
- Convert the inner `for (const chunk of chunks)` loop (`script-review.ts:233`) to an **indexed**
  form and pass `priorTurn` **only to the first chunk** (`index === 0`); later chunks get their
  in-chapter overlap context from the chunker, so prior-chapter context there is wasted budget.

### 4.6 Read-only enforcement (corrected — the original premise was false)

**The original §4.6 was wrong.** It claimed an op targeting the context line is "already dropped
because its id isn't in `coreIds`." But sentence ids are **per-chapter `1..N`** (`stage2-chunk.ts:259`
renumbers each chapter from 1; `cast-merges.ts:31` documents that ids are unique only within a
chapter) — so the prior chapter's ids **collide** with the current chapter's `coreIds`. The numeric
`ownsOp(chunk.coreIds, primarySentenceId(op))` filter (`script-review.ts:268`) would therefore *not*
reliably drop such an op; on a collision it would silently apply it to the **wrong current-chapter
sentence**.

**The actual guard:** the context block **surfaces no `sentenceId`** (§4.3 — only the character id and
the line text), so the model has nothing to copy as an op target, reinforced by the §4.4 skill
instruction. The `ownsOp` filter remains as defence-in-depth (it still drops any op whose primary id
falls outside the current core), but it is **not** the guarantee. **§6 pins the real invariant
behaviourally:** the rendered context block contains no `sentenceId`, and a review whose model output
references the context character/text yields no op outside the chapter's own sentences.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| First story chapter (no predecessor) | No block; prompt byte-identical to today. |
| Predecessor ends on narration / a monologue (single speaker) | Gate fails (no alternation) → `null` → no block. |
| Predecessor ends on a genuine A/B exchange | Block emitted: last speaker + their last line (capped). |
| Predecessor's last exchange is >`PRIOR_TURN_LOOKBACK` back | Outside the window → gate fails → no block. |
| Predecessor tail is `flag_nonstory` residue | Filtered out before turns/gate; never a signal, never eats the cap. |
| Predecessor empty / no attributed sentences | Skipped by neighbor selection; **no cascade** to N‑2 → no block. |
| Single-chapter request | Prior fetched from the whole-book `byChapter` map → identical behaviour. |
| Speaker off the current roster | Labelled by name (or raw id); used purely as turn-taking signal, never an op target. |
| Excluded (front/back-matter) predecessor | Skipped; nearest lower **non-excluded** story chapter used (no cascade past it if *it* fails the gate). |

## 6. Testing

- **Unit — `priorChapterBoundaryTurn`** (the gate is the heart of the feature):
  - ends on A/B exchange → returns last speaker + last line;
  - ends on narration → `null`; ends on single-speaker monologue → `null`;
  - exchange present but >`PRIOR_TURN_LOOKBACK` back → `null`;
  - tail is `excludeFromSynthesis` residue (non-narrator) → filtered, `null` (and does not consume the cap);
  - long last line → truncated to `MAX_PRIOR_TURN_CHARS`;
  - speaker-name resolved from roster; off-roster speaker falls back to id;
  - empty chapter → `null`.
- **Unit — `buildScriptReviewChapterInbox`:** renders the labelled block (with **no `sentenceId`**)
  when given `priorTurn`; **frozen full-string equality** to today's prompt when absent.
- **Unit/route — read-only invariant (§4.6):** the rendered block contains no `sentenceId`; a model
  op referencing the context character/text produces no op outside the chapter's own sentences.
- **Route — neighbor selection + budget:** picks the immediately-preceding non-excluded chapter;
  skips excluded; no cascade when the predecessor fails the gate; first chunk's `charBudget` is
  reduced by the reserve when a block is attached; only the first chunk receives the block.
- **No e2e.** Server-side prompt assembly with no UI/router/redux/layout seam — Playwright would test
  nothing (the CLAUDE.md "SHOULD land an e2e" bar is keyed on UI-visible behaviour crossing those
  seams). Called out explicitly per the testing-discipline bar.
- **Honest scope of the automated suite.** These unit tests pin **prompt assembly + the gate + the
  read-only invariant** — the *mechanism*. They do **not** prove the model re-resolves the opening
  line correctly (that is LLM behaviour, not cheaply unit-testable). **Resolution is confirmed only
  by the on-box acceptance below, and `status: stable` MUST NOT be set until it passes.**
- **On-box acceptance:** a real run on `server/src/__fixtures__/the-coalfall-commission.md` (the
  canonical fixture) — confirm a chapter that opens tagless after a dialogue-ending predecessor now
  resolves to the prior speaker, **and** that a scene-break opening produces *no* confident-wrong
  `reattribute` op (the regression that matters). Folded into the fs-58 Unit B on-box debt, which
  must exercise the `reattribute` op class specifically (already shipped, #1118). *(If the fixture has
  no tagless-opening boundary, confirm/add one before claiming acceptance.)*

## 7. New-infra summary

**New — server:** the `priorChapterBoundaryTurn` helper (+ `PRIOR_TURN_LOOKBACK`,
`MAX_PRIOR_TURN_CHARS` consts) + the `priorTurn` param/section on `buildScriptReviewChapterInbox` +
neighbor-selection + the indexed-loop / budget-reserve / first-chunk wiring in the route
(`script-review.ts`); one paragraph in `skills/audiobook-script-review.md`.

**New — client:** none. **Schema / api-types:** none.

## 8. Non-goals

- No whole-chapter or whole-book context stitching (the expensive interpretation §3 rejects).
- No context beyond the **first** chunk of a chapter; no block when the gate fails.
- No multi-turn / two-speaker block, and **no cascade** past the immediately-preceding chapter.
- No reach past `PRIOR_TURN_LOOKBACK` for the gate, and the emitted line is a **single** sentence
  capped at `MAX_PRIOR_TURN_CHARS` — the returned text never extends past the cap.
- No new endpoint, op class, schema field, or frontend surface; no auto-voicing / cast changes.

## 9. Ship checklist

1. Branch `feat/server-fs64-cross-chapter-reattribute`; `feat(server): …` commits.
2. Land the helper + gate + prompt change + route wiring + skill note with paired unit tests (§6).
3. `npm run verify` green (typecheck + tests + e2e + build).
4. Close **#1120** (`Closes #1120` in the PR body); remove its `docs/BACKLOG.md` row.
5. **Gate `status: stable` on the on-box acceptance** (§6) — not on green unit tests. Until then the
   spec stays `active`. On acceptance: set `status: stable`, fill Ship notes (date + merge SHA +
   acceptance result), and `git mv` to `docs/features/archive/` only if the fs-58 sibling specs move
   too (they currently live under `docs/superpowers/specs/`; match their home — these specs are **not**
   tracked in `docs/features/INDEX.md`).

## Ship notes

_(filled on ship — date, merge SHA, on-box acceptance result.)_
