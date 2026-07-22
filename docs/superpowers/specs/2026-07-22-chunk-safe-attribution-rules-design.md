# Chunk-safe stage-2 attribution rules (#1758 / srv-63) — Design

**Status:** draft (awaiting user approval → writing-plans → SDD)
**Date:** 2026-07-22
**Author:** design thread (follow-up to PR #1761 Target C)
**Related:** [[project_attribution_eval_qwen_baseline]], issue #1758 (srv-63),
Target C spec `docs/superpowers/specs/2026-07-21-target-c-stage2-attribution-prompt-design.md`,
regression plan `docs/features/265-attribution-eval-tuning.md`

## Goal

Get the stage-2 `STAGE2_ATTRIBUTION_RULES` block — which Target C (#1761) ships
into the whole-chapter builder only — into the **chunk** builder as well,
**without** re-introducing the cross-boundary regression that forced Target C to
narrow to chapter-only. The win is confined to chapters large enough to chunk;
in the eval corpus that is **ch44 alone**, so this raises ch44's `raw`
attribution toward the chapter-only fixtures' gains while leaving every
single-call fixture untouched.

## Background — why the block is chapter-only today

Target C's on-box eval (`--runs 3`, targets `qwen36-cw-iq4-32k`,
`gemma-4-31b-it`, `gemini-3.1-flash-lite`) found that injecting the rules block
into **both** stage-2 builders lifted the single-call chapters (Qwen raw ch45
+3.5, ch46 +0.8) but **regressed ch44 −2.5** — the only chunked fixture — with a
**broad drop across every speaker-inference family** (narration held). Root
cause: **rule #3**, "untagged quotes continue, and two-handers alternate."

`buildStage2ChunkInbox` sends the model one *section* of a large chapter at a
time. Rule #3 tells the model to alternate a sustained two-hander, but a chunk
that opens mid-conversation has no in-band anchor for the alternation **parity**
(who spoke last). The model re-derives parity from scratch and, when it guesses
the offset wrong, flips the speaker for the *entire* run of alternating lines in
that chunk — hence the broad-family collapse. Target C shipped the block
chapter-only (ch44 recovered to baseline 82.6) and filed #1758 to design a
chunk-safe variant.

## The enabling fact — chunks are dispatched sequentially

`runStage2ChapterChunked` (`server/src/analyzer/stage2-chunk.ts:347–353`)
processes chunks **in order**, carrying the prior chunk's tail forward:

```ts
let preceding: string | null = null;
for (let i = 0; i < chunks.length; i += 1) {
  const sectionSentences = await attributeSpan(chunks[i], 0, preceding);
  // …accumulate…
  preceding = tailParagraphs(chunks[i], contextParagraphs);
}
```

Two consequences the design leans on:

1. By the time chunk *i+1*'s prompt is built, chunk *i*'s **attributions**
   (`sectionSentences`, `SentenceOutput[]` with `characterId`) already exist —
   the last-established speaker is deterministically in hand.
2. The prompt already carries a `precedingContext` **text** block
   (`buildStage2ChunkInbox`, `analysis.ts:1629`) — the prior chunk's tail
   paragraphs — "provided ONLY so you can carry a speaker across the boundary."
   But it hands the model the tail *prose*, not the *fact* of who last spoke; the
   model still has to re-infer it. The seed closes exactly that gap.

The eval observed the both-builders ch44 regression **through this same driver**,
so a change here is exercised by the eval automatically — no separate harness
wiring for the chunk path.

## Design (hybrid: boundary-safe rule #3 + last-speaker seed)

### 1. Chunk-variant rules block

A `STAGE2_ATTRIBUTION_RULES_CHUNK` constant, module-level in `analysis.ts`
beside `STAGE2_ATTRIBUTION_RULES`. Rules **1, 2, 4, 5 are byte-identical** to the
shipped chapter block — all four are boundary-safe (explicit tag, action beat,
narration, addressee) and are the high-value rules the chapter-only ship
currently denies chunks. Only **rule #3** is rewritten to scope
continuation/alternation *within the section*:

```
3. Untagged quotes continue, and two-handers alternate — within this section.
   An untagged quote keeps the last speaker established here (or the "Speaker at
   section start" named below, for the first quote). Do NOT assume a two-hander's
   alternation carries in from before this section's start; near the start, rely
   on dialogue tags and action beats rather than alternation parity.
```

The failure mode (cross-boundary parity flip) is designed out by wording, not
merely mitigated: the model is told the alternation does not carry across the
seam.

### 2. Last-speaker seed

When a preceding chunk exists **and** it produced a spoken line, inject a small
block (rendered only when a seed id is present):

```
## Speaker at section start

The last character to speak before this section was `X`. Treat the first
untagged quote in this section as continuing `X`, unless a dialogue tag or
action beat names a different speaker.
```

- **Computed as:** the `characterId` of the **last non-`narrator` sentence** in
  the immediately-preceding chunk's attributions. `null` (block omitted) when the
  prior chunk was pure narration or this is the first chunk. Rule #1 ("a tag is
  decisive") overrides the seed, so a stale/wrong seed only affects genuinely
  untagged lines right at the boundary — a deliberately small blast radius.
- **Deliberately no parity seed.** Seeding two-hander alternation parity is the
  fragile part of the rejected approach B; a wrong parity seed flips a whole run.
  The last-speaker seed only powers rule #3's *continuation* clause, not its
  alternation clause. Alternation, cross-boundary, is simply disclaimed.

### 3. Plumbing

Thread a `lastSpeakerId: string | null` alongside the existing `preceding` text,
mirroring how `preceding` is already carried and updated:

- **`stage2-chunk.ts`** — extend `RunStage2ChunkedOpts.callForBody` to
  `(subBody, precedingContext, lastSpeakerId) => …`. In the driver loop, after
  each chunk, compute `lastSpeakerId` = last non-`narrator` `characterId` in that
  chunk's `sectionSentences`, **falling back to the incoming value** when the
  chunk added no spoken line (so a speaker established two chunks back still
  carries across an all-narration chunk). Pass it into the next
  `attributeSpan(...)`. Thread it through the **adaptive re-split recursion**
  (`attributeSpan`, `stage2-chunk.ts:328–331`) the same way `prev` is updated per
  sub-section, so a split chunk seeds its sub-sections correctly.
- **`analysis.ts`** — `callForBody` passes `lastSpeakerId` into
  `buildStage2ChunkInbox`; the builder gains a `lastSpeakerId: string | null`
  parameter and renders the seed block (§2) and the chunk-variant rules block
  (§1). `buildStage2ChapterInbox` is **untouched** — it never chunks, so it keeps
  the shipped chapter rules block.

No change to the JSON output contract, the roster, or the chapter-builder path.

### 4. Rules-block structure (implementation detail)

Lean choice: a **separate `STAGE2_ATTRIBUTION_RULES_CHUNK` constant** plus a unit
test asserting rules 1/2/4/5 are textually identical across the two constants
(drift guard). The alternative — factoring rule #3 out as a parameter of a shared
builder — is also fine; the drift-guard test makes the small duplication safe
either way. Settled in the plan, not a design fork.

## Measurement plan

Deciding metric: **`raw`** recall (pre-crossExamine), `--runs 3`, same harness
and gate shape as Target C. This change is **structurally confined to ch44**: the
chunk builder only runs on bodies over the ~9000-char budget, and ch44 (~18.4k)
is the sole such fixture (ch43 8.85k, ch45 3.1k, ch46 4.6k, Coalfall 3.4k are all
single-call — see Target C spec "Chunking"). So the gate is unusually tight:

- **ch44 (the target):** treatment mean `raw` **≥ shipped chapter-only baseline
  min** is the floor (no regression); the goal is to recover the chunk share of
  the both-builders ch45/ch46-style gains — treatment mean `raw` **≥ baseline
  max** counts as the win. The per-family split (Target C's `raw.byFamily`, now
  populated) must show the speaker-inference families that collapsed under
  both-builders **holding at or above their baseline min** — that is the exact
  regression signature this design targets.
- **Every other fixture (ch43/45/46/Coalfall):** **flat by construction** — their
  prompt is the untouched chapter builder. Any movement beyond run-to-run noise
  is a bug (an accidental chapter-builder change) and blocks ship.
- **Secondary:** `det`/`final` on ch44 do not regress vs the post-#1761 baseline
  (same band rule).
- **Targets:** local `qwen36-cw-iq4-32k` is the primary decision gate (ch44's
  regression was Qwen-only; cloud was flat there). Cloud `gemma-4-31b-it` /
  `gemini-3.1-flash-lite` are confirmatory — run if the free-tier budget/time
  allows, but a Qwen-green result ships (cloud was already flat on ch44 under
  both-builders, so it has little to say here).

Baseline = current `main` (chapter-only, post-#1761). Treatment = this branch.
Re-baseline fresh in-session (seed/quant drift). Run from a checkout with the
corpus present (`server/src/analyzer/attribution-eval/corpus/`) and Ollama up.

## Testing

- **`buildStage2ChunkInbox` unit test (rewrite the existing one).** The current
  test asserts the rules block is *absent* from the chunk builder (Target C's
  chapter-only invariant). Flip it: assert (a) the chunk-variant block **is**
  present; (b) rule #3 uses the within-section wording (no unqualified
  "alternation carries"); (c) the "Speaker at section start" block renders with
  `X` when `lastSpeakerId` is given and is **omitted** when `null`; (d) the
  first-person block still renders alongside the seed when both apply; (e)
  ordering (roster → rules → preceding-context → seed → first-person → body).
- **Drift-guard unit test.** Rules 1/2/4/5 are textually identical between
  `STAGE2_ATTRIBUTION_RULES` and `STAGE2_ATTRIBUTION_RULES_CHUNK`.
- **`stage2-chunk.ts` driver unit test.** With a stubbed `callForBody` capturing
  its args: across a two-chunk body, chunk 2 receives `lastSpeakerId` = the last
  non-narrator id of chunk 1; an all-narration middle chunk carries the prior
  speaker through; the value threads into an adaptive re-split's sub-sections.
- **Chapter-builder regression guard.** A test (or reuse of Target C's) pinning
  that `buildStage2ChapterInbox` output is unchanged by this work.
- **On-box acceptance (not CI):** the ch44 `raw --runs 3` eval above — live model,
  manual/on-box gate, recorded in the plan and `docs/features/265`.

## Risks

- **Seed error propagation** — a wrong last-speaker id seeds the next chunk's
  first untagged quote. Bounded: rule #1 overrides it, and it touches only
  genuinely-untagged boundary lines. The eval's ch44 per-family gate is the guard.
- **Chunk-variant drift** — two rules constants can diverge silently. Mitigated by
  the drift-guard test on rules 1/2/4/5.
- **Thin chunk-path coverage** — ch44 is the *only* chunked fixture, so the gate
  rests on one chapter. Accepted (same limitation Target C shipped under); the
  RU/DE follow-up (#1759) and any future large fixtures widen it later. If ch44
  proves too thin to call, the plan may lower the eval chunk budget so ch43 also
  chunks (Target C's noted option) — a measurement tweak, not a design change.
- **Prompt length on the iq4 quant** — the chunk block + seed add ~18 lines ×
  chunk count. Negligible vs body; the no-regression gate catches a net loss.

## Rollout

Single `feat/server-chunk-safe-attribution-rules` branch off latest `main`
(already cut), SDD implementation (chunk-variant constant + seed block + the
`lastSpeakerId` threading through `stage2-chunk.ts`/`analysis.ts` + the tests
above), on-box ch44 eval as acceptance, PR with `Closes #1758`, mandatory
code-review gate, merge. Update `docs/features/265-attribution-eval-tuning.md`
with the #1758 cycle and captured ch44 numbers; release-notes entry gated on a
measurable user-visible delta (a ch44 raw-attribution lift qualifies — large
chunked chapters now get the same rules the single-call ones already do).

## Out of scope

- **Two-hander parity seed** (rejected approach B's fragile half) — revisit only
  as a measured follow-up if ch44 still leaves alternation gains after this.
- **Deterministic-first phase-2 / crossExamine strong-tag softening** — the
  separately-sequenced next item, not this work.
- **RU/DE fixtures (#1759)** — the language axis; tracked separately.
