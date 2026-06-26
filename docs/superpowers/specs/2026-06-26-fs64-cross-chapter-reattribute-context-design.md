---
title: 'fs-64 — Cross-chapter context for `reattribute` (script-review)'
status: deferred
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
> exchange cannot be resolved by turn-taking — the review pass never sees across the boundary. This
> spec **feeds the model the signal it needs** to resolve that straddle: the prior chapter's final
> two-speaker exchange, fed into the chapter's existing prompt as read-only context — **but only when
> the prior chapter actually ends in a live dialogue exchange** (the common case is a scene break,
> where the signal would be misleading). Strictly additive; **zero new LLM calls**.
>
> **Disposition (2026-06-26): design FINAL, build DEFERRED.** The design below is complete and
> reviewer-cleared. Implementation is parked behind the fs-58 Unit B **on-box render acceptance**
> (fs-64's own `status: stable` acceptance can't complete before it). That debt is nearly cleared —
> Unit B is done and in `verify` on a separate worktree, not yet merged — so the deferral is short.
> Pick this spec up for the implementation plan once Unit B merges. See §9.
>
> **Revised 2026-06-26 after TWO three-reviewer adversarial rounds** (code-grounding, design,
> scope/test-adequacy each round). Round 1 corrected: a false read-only-guard premise (per-chapter
> ids, §4.6); an unbounded, non-budget-accounted block; array-order vs reading-order; missing
> `excludeFromSynthesis` filtering; a conflated null/selection fallback; a YAGNI run-join (cut);
> over-claimed "closes the straddle" language; and added the **live-exchange gate**. Round 2 then:
> upgraded the payload from one turn to the **final two-speaker exchange** (a single turn names the
> wrong thing — it excludes one candidate but never names the predicted opener, failing the
> same-gender two-hander, the one case turn-taking alone can resolve); de-ambiguated the gate clause;
> moved the budget reserve to **chunk 0 only** (a whole-chapter budget cut re-chunks the chapter and
> perturbs its *own* op emission — not "additive"); fixed a `NARRATOR_ID`-not-exported claim and an
> `unknown-male` collapse edge; and tightened the §9 acceptance prerequisites.

## 1. Summary

When the script-review pass reviews a chapter, prepend the **prior chapter's final two-speaker
exchange** (the last two alternating speakers — `A …` / `B …`, each a single line, char-capped) to the
**first chunk** of that chapter's review prompt, labelled as **reference-only** context — **gated** on
the prior chapter actually ending in such an exchange. This names *both* parties of the boundary
turn-taking, so the model can resolve a tagless chapter-opening line (e.g. `"I know," he said.`)
*when, and only when,* cross-chapter turn-taking is plausible — including the same-gender two-hander,
where the alternation is the sole disambiguator. On a scene-break / narration / monologue ending — the
common case — nothing is emitted.

**Additive throughout.** When the gate yields no exchange (first story chapter, narration/monologue
ending, residue-only tail, empty predecessor), the prompt is **byte-identical to today**. No schema
change, no `api-types` regen, no frontend change.

## 2. The straddle (what Unit B §3.6 left open)

`script-review` builds a per-chapter prompt in `buildScriptReviewChapterInbox`
(`server/src/routes/script-review.ts:78`) containing only **that chapter's** sentences plus the
post-fold roster. A chapter that opens on a tagless dialogue line has nothing in-prompt that tells
the model who was speaking — the alternation that resolves it lives at the **end of the previous
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
- We add a **bounded** block (two single sentences, each hard-capped — §4.1) to a prompt we are
  **already sending**. No extra call → **zero RPD impact**. The block's size is reserved from the
  **first chunk's** budget (§4.5) so it cannot overflow a local model's context window, and the rest
  of the chapter chunks at full budget so its own op emission is unperturbed.

## 4. Components

### 4.1 New pure helper — `priorChapterBoundaryExchange(sentences, roster)`

Lives in `script-review.ts` (exported, unit-tested like `buildReviewSentencesInput`). Constants:
`PRIOR_TURN_LOOKBACK = 6` (sentences — *positions*, not turns — scanned back from the chapter end:
"a live exchange must be near the boundary; one further back is a scene break, not a continuation")
and `MAX_PRIOR_TURN_CHARS = 240` (hard cap per rendered line; longer text truncated with `…`).
`NARRATOR_ID = 'narrator'` is **re-declared locally** in `script-review.ts` (matching the repo
convention — the constant is module-private and re-declared in five other modules, never exported).

- **Input:** the prior chapter's post-fold sentence sequence + the roster (for name resolution).
- **Reading order:** walk back from the **end of the chapter's post-fold sequence** — the same
  sequence the chunker reviews (`byChapter.get(id)` order). *(Caveat: end-of-chapter split offspring
  are appended out of strict reading order — a wrinkle this route already shares with the chunker;
  out of scope here. The §9 on-box step sanity-checks the boundary lines.)*
- **Eligible subsequence:** from the last `PRIOR_TURN_LOOKBACK` sentences, drop narration
  (`characterId === NARRATOR_ID`) **and** `excludeFromSynthesis === true` residue (mirrors the
  synth-path filter; a `flag_nonstory` line must never be a turn-taking signal nor consume the
  window). *(Note: narration sentences still occupy window positions, so stage-business beats shrink
  the effective dialogue reach — intended.)*
- **Turns:** collapse the eligible subsequence (gaps closed) into *turns* — contiguous same-speaker
  runs. By construction adjacent turns have different speakers, and two distinct speakers folded to
  the same id (e.g. both `unknown-male`) collapse into **one** turn.
- **The live-exchange gate:** emit **only if there are ≥2 turns** in the eligible subsequence
  (which, by the collapse property, guarantees the last two turns are different speakers). Otherwise
  → **`null`** (narration/monologue ending, residue-only tail, or single-speaker window).
- **Output (gate passed):** `{ turns: [A, B] }` — the **last two** turns in reading order, each
  `{ speakerId, speakerName, text }` where `text` is that turn's **single boundary-adjacent
  sentence** (turn A's last line, turn B's last line), capped to `MAX_PRIOR_TURN_CHARS`,
  `speakerName` resolved from the roster (fall back to `speakerId`). **No `sentenceId` is returned**
  — see §4.6.

### 4.2 Neighbor selection — "the prior chapter" (no cascade)

The prior chapter = the **immediately-preceding non-excluded story chapter**: the nearest lower
chapter id present in `byChapter` that is not `excluded` (`located.state.chapters[].excluded`,
computed independently here — the route applies that flag only on the whole-book branch,
`script-review.ts:138-141`, so single-chapter requests must derive it the same way). Computed off the
full sorted `byChapter` key list (not the filtered `chapterIds`), so it resolves identically on a
single-chapter request and a whole-book run.

**No cascade.** Selection skips only `excluded` chapters. A *selected* predecessor that is empty or
yields no exchange makes `priorChapterBoundaryExchange` return `null` → we emit **no block** and do
**not** fall back to chapter N‑2 (resolving chapter *N*'s opening from chapter *N‑2*'s ending is
semantically wrong — an intervening chapter broke the exchange). "Has a non-excluded predecessor"
gates selection; "that predecessor ends in a live exchange" gates emission; the two are distinct and
there is deliberately no retry between them. First story chapter → no predecessor → no block.

### 4.3 Prompt change — `buildScriptReviewChapterInbox`

Add an optional `priorExchange?: { turns: Array<{ speakerName: string; speakerId: string; text: string }> }`
param. When present, render a labelled section immediately **above** the literal `## Sentences
(already attributed)` block (`script-review.ts:102`):

```
## Prior chapter — final exchange (reference only — not reviewable lines; do NOT emit an op on them)

Aldous (id: aldous): "Then we're agreed. Dawn, at the colliery gate."
Berrin (id: berrin): "If the others come."
```

The block exposes the **character** id/name and the line text **only — never a `sentenceId`** (§4.6).
When `priorExchange` is absent the function emits **exactly today's prompt**: the conditional must
contribute **zero characters** (no stray blank line). §6 pins this with a *frozen full-string
equality* test, not a `contains` check.

### 4.4 Skill-prompt note

`skills/audiobook-script-review.md` gains one short paragraph: the "Prior chapter — final exchange"
block, when present, is **read-only** turn-taking context for resolving a tagless chapter-opening
line. It carries **no `sentenceId`** and is **not reviewable** — never emit an op targeting it; use
the named alternation only to inform the attribution of the chapter's own opening sentences.

### 4.5 Route wiring — first chunk only, chunk-0 budget reserve

- Compute `priorExchange` **once per chapter** (§4.2 + §4.1) **before** the chunk loop.
- Convert the inner `for (const chunk of chunks)` loop (`script-review.ts:233`) to an **indexed**
  form and pass `priorExchange` **only to the first chunk** (`index === 0`); later chunks get their
  in-chapter overlap context from the chunker, so prior-chapter context there is wasted budget.
- **Budget: reserve against chunk 0 only.** Chunk the chapter at **full** `charBudget` (so the rest
  of the chapter's seams — and thus its own op emission — are unchanged from today), then ensure
  **chunk 0** + the rendered block fits the local context window: trim chunk 0's core to leave room
  for `2 × MAX_PRIOR_TURN_CHARS` + the section's fixed header overhead, pushing the trimmed
  sentence(s) into the overlap/next chunk. Do **not** lower the global budget (a whole-chapter
  reduction greedily re-chunks the chapter and perturbs unrelated ops — rejected). Cloud engines
  carry a `MAX_SAFE_INTEGER` budget, so the whole reserve is a no-op there.

### 4.6 Read-only enforcement (the original premise was false)

**The first draft's §4.6 was wrong.** It claimed an op targeting the context lines is "already
dropped because its id isn't in `coreIds`." But sentence ids are **per-chapter `1..N`**
(`stage2-chunk.ts:259` renumbers each chapter from 1; `cast-merges.ts:31` documents that ids are
unique only within a chapter) — so the prior chapter's ids **collide** with the current chapter's
`coreIds`, and the numeric `ownsOp(chunk.coreIds, primarySentenceId(op))` filter (`script-review.ts:268`)
would not reliably drop such an op; on a collision it would silently apply it to the **wrong
current-chapter sentence**.

**The actual — and only — guard:** the block **surfaces no `sentenceId`** (§4.3 renders only the
character id and the line text), so a block-targeted op is **unconstructible** by the model,
reinforced by the §4.4 skill instruction. (`ownsOp` is unrelated to this vector — it dedupes overlap
ops between chunks; do not lean on it as a read-only guard.) **§6 pins the real invariant
behaviourally:** the rendered block contains no `sentenceId`, and a review whose model output
references the context character/text yields no op outside the chapter's own sentences.

## 5. Edge cases

| Case | Behaviour |
|---|---|
| First story chapter (no predecessor) | No block; prompt byte-identical to today. |
| Predecessor ends on narration / a monologue (single speaker in window) | <2 turns → `null` → no block. |
| Predecessor ends on a genuine A/B exchange | Block emitted: the last two turns (A line / B line), each capped. |
| Predecessor's last exchange is beyond the `PRIOR_TURN_LOOKBACK` window | Outside the window → <2 turns → no block. |
| Two distinct speakers both folded to one id (e.g. `unknown-male`) | Collapse to one turn → <2 turns → `null` (safe false-negative: can't name the alternation, so don't assert it). |
| Predecessor tail is `flag_nonstory` residue | Filtered before turns/gate; never a signal, never eats the window. |
| Predecessor empty / no attributed sentences | **Selected** (present + non-excluded), `priorChapterBoundaryExchange` returns `null` → no cascade → no block. |
| Single-chapter request | Prior fetched from the whole-book `byChapter` map → identical behaviour. |
| Speaker off the current roster | Labelled by name (or raw id); used purely as turn-taking signal, never an op target. |
| Excluded (front/back-matter) predecessor | Skipped by selection; nearest lower **non-excluded** story chapter used (no cascade past it if *it* fails the gate). |

## 6. Testing

- **Unit — `priorChapterBoundaryExchange`** (the gate is the heart of the feature):
  - ends on A/B exchange → returns both turns (A then B), each = boundary-adjacent line;
  - ends on narration → `null`; ends on single-speaker monologue → `null`;
  - both speakers folded to one id (`unknown-male`) → one turn → `null`;
  - exchange present but beyond `PRIOR_TURN_LOOKBACK` positions → `null`;
  - tail is `excludeFromSynthesis` residue (non-narrator) → filtered, `null` (and does not consume the window);
  - long line → truncated to `MAX_PRIOR_TURN_CHARS`; per-turn cap applied to both lines;
  - speaker names resolved from roster; off-roster speaker falls back to id;
  - empty chapter → `null`.
- **Unit — `buildScriptReviewChapterInbox`:** renders the two-line labelled block (with **no
  `sentenceId`**) when given `priorExchange`; **frozen full-string equality** to today's prompt when absent.
- **Unit/route — read-only invariant (§4.6):** the rendered block contains no `sentenceId`; a model
  op referencing the context character/text produces no op outside the chapter's own sentences.
- **Route — neighbor selection + budget:** picks the immediately-preceding non-excluded chapter;
  skips excluded; no cascade when the predecessor returns `null`; chunk 0's core is trimmed to fit
  the reserve while the rest of the chapter chunks at full budget (chapter's own ops unchanged);
  only the first chunk receives the block.
- **No e2e.** Server-side prompt assembly with no UI/router/redux/layout seam — Playwright would test
  nothing (the CLAUDE.md "SHOULD land an e2e" bar is keyed on UI-visible behaviour crossing those
  seams). Called out explicitly per the testing-discipline bar.
- **Regression-plan exemption (stated, not silent).** Per CLAUDE.md "Before-shipping checklist" step
  1, small/localized work skips a `docs/features/` regression plan — "the issue body + paired test is
  the spec." fs-64 is server-only, single-file (`script-review.ts`) + one skill paragraph, additive,
  no schema. This spec + the §6 tests are the spec of record (mirroring the fs-58 sibling specs'
  home under `docs/superpowers/specs/`); **no `docs/features/` plan is owed.**
- **Honest scope of the automated suite.** These unit tests pin **prompt assembly + the gate + the
  read-only invariant** — the *mechanism*. They do **not** prove the model re-resolves the opening
  line correctly (LLM behaviour, not cheaply unit-testable). **Resolution is confirmed only by the
  on-box acceptance (§9), and `status: stable` MUST NOT be set until it passes.**

## 7. New-infra summary

**New — server:** the `priorChapterBoundaryExchange` helper (+ `PRIOR_TURN_LOOKBACK`,
`MAX_PRIOR_TURN_CHARS`, and a local `NARRATOR_ID` const) + the `priorExchange` param/section on
`buildScriptReviewChapterInbox` + neighbor-selection + the indexed-loop / chunk-0 budget-reserve /
first-chunk wiring in the route (`script-review.ts`); one paragraph in
`skills/audiobook-script-review.md`. **No edit to `byline-author-guard.ts`** (the constant is
re-declared locally per repo convention).

**New — client:** none. **Schema / api-types:** none.

## 8. Non-goals

- No whole-chapter or whole-book context stitching (the expensive interpretation §3 rejects).
- No context beyond the **first** chunk of a chapter; no block when the gate fails.
- No more than the **two** boundary turns, and **no cascade** past the immediately-preceding chapter.
- No reach past the `PRIOR_TURN_LOOKBACK` window for the gate; each emitted line is a **single**
  sentence capped at `MAX_PRIOR_TURN_CHARS`.
- No new endpoint, op class, schema field, or frontend surface; no auto-voicing / cast changes.

## 9. Ship checklist (when un-deferred)

**Unblocks when fs-58 Unit B merges** (its on-box render acceptance is the prerequisite fs-64's own
acceptance rides on). Then:

1. Cut branch `feat/server-fs64-cross-chapter-reattribute`; `feat(server): …` commits.
2. Land the helper + gate + prompt change + route wiring + skill note with paired unit tests (§6).
   (Worth driving via writing-plans → subagent-driven-development, as the fs-58 units were.)
3. `npm run verify` green (typecheck + tests + e2e + build).
4. Close **#1120** (`Closes #1120` in the PR body); remove its `docs/BACKLOG.md` row.
5. **On-box acceptance** on `server/src/__fixtures__/the-coalfall-commission.md` (canonical fixture):
   - **Prerequisite:** verify (or add) a chapter that opens tagless *after* a dialogue-ending
     predecessor — without such a boundary the acceptance can't exercise the path. Sanity-check the
     boundary lines are the true last spoken lines (the §4.1 split-offspring caveat).
   - Confirm such an opener now resolves to the prior exchange, **and** that a scene-break opener
     produces *no* confident-wrong `reattribute` op (the regression that matters).
6. **Gate `status: stable` on that acceptance** — not on green unit tests. On acceptance: set
   `status: stable`, fill Ship notes (date + merge SHA + acceptance result), back-link this spec from
   the fs-58 Unit B spec's §3.6/§8 as the delivered follow-up, and `git mv` to
   `docs/features/archive/` only if the fs-58 sibling specs move too (they currently live under
   `docs/superpowers/specs/` and are **not** tracked in `docs/features/INDEX.md`).

## Ship notes

_(filled on ship — date, merge SHA, on-box acceptance result.)_
