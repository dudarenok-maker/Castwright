---
status: draft
issue: 1447
refs: [1446, 938, 537]
area: srv
---

# Third-party front-matter roster guard (#1447)

## Problem

`server/src/analyzer/byline-author-guard.ts` drops **the book's own byline
author** from a chapter's detected roster before stage-2 attribution (#938),
unless the chapter title matches `AUTHOR_NOTE_TITLE_RX`. It has **no concept of
other real, unrelated people** named or quoted in front matter.

Real incident: book *Юный дрессировщик* (author: Лидия Ивановна Острецова) has
chapter 3 "Вступительная статья" — a critical essay **about a different real
author, Radiy Pogodin**. Stage-2 attribution cast Pogodin as a one-line speaker,
and `fold-minor-cast.ts`'s `proseTagged` carve-out (#537, which protects
legitimately quote-tagged speakers from being folded away) let the bogus entry
survive as an orphaned cast reference.

The #1446 safety net already ships: an orphaned `characterId` now degrades to
narrator at synthesis instead of hard-failing. So the **remaining harm** is a
bogus cast member cluttering the roster / cast-review screen and potentially
consuming a voice slot — not a crash. That reframes the posture: a wrongly
**stripped real character is the worst outcome**; a stray entry the user can
delete at cast review is cheap.

None of the three existing front-matter / non-story classifiers catches this
case, and none has any concept of a third-party person:

| Mechanism | Location | Catches "Вступительная статья"? | Purpose |
|---|---|---|---|
| `AUTHOR_NOTE_TITLE_RX` | `byline-author-guard.ts:16` | No (has предислови/послеслови/об авторе, not вступительн) | exempt byline author from drop |
| `isLikelyFrontMatterTitle` | `parsers/front-matter.ts` | No (Russian `frontMatterKeywords` lacks it) | discard PDF outline entries |
| `flag_nonstory` / `excludeFromSynthesis` | `schemas.ts:135` (fs-58) | LLM-decided, per-sentence, residue-only | filter sentences out of synthesis |

## Goal & scope

Stop a **real third-party person named/quoted only in a non-story front-matter
chapter** from surviving as an attributable cast member, while:

- **keeping the essay narrated** (it is real book content — foreword / critical
  article), and
- **never stripping a legitimately framed in-fiction character** (#938 — an
  in-fiction letter, a genuine framed author's-note where the author speaks in
  character).

**Posture: conservative / high-precision.** Multiple signals must agree before a
strip. When unsure, do not strip.

Out of scope: excluding the essay from synthesis; a per-book user affordance to
skip front matter; any change to `flag_nonstory`'s existing residue-only remit.

## Detection heuristic

A character is stripped **only if ALL THREE conditions hold**:

### (a) The chapter is a non-story front-matter chapter — the load-bearing anchor

Satisfied by **either** signal (OR-combined for recall; precision comes from the
(b)/(c) AND-guards below):

- **Signal 1 — extended deterministic title classifier.** Add an
  essay/critical-article class to the shared front-matter title machinery
  (`isLikelyFrontMatterTitle` / language-registry `frontMatterKeywords`):
  `вступительная статья`, `критическая статья`, `critical introduction`, and
  the like. Deterministic, testable, zero LLM cost; brittle and needs
  per-language upkeep — accepted, because Signal 2 backs it up and the whole
  strip is guarded by (b)/(c).
- **Signal 2 — new chapter-level non-story judgment from the existing
  script-review LLM pass.** A new **chapter-level** output
  (`nonStoryFrontMatter: true`) — *classification only, decoupled from
  `excludeFromSynthesis`* so the essay stays narrated. This rides the
  script-review pass that already runs per chapter — **no new LLM call**.
  `flag_nonstory` is left exactly as-is (residue only, per-sentence).

### (b) The person's name (+ aliases) appears in no *other* chapter's body

A corpus-wide scan of every chapter body except the front-matter chapter itself.
If the normalised name or any alias appears anywhere in the story proper, the
character is kept. This is what distinguishes a front-matter-only figure from a
real character.

### (c) Low presence

The character is attributed in **only this one chapter** and below a small line
threshold (reuse the minor-cast `minLines` notion). Backstop against stripping
anyone substantial.

### Why the #938 framed case is safe

(a) AND (b) AND (c) must all hold. A genuine in-fiction chapter is **not**
title-classified as an essay, and the script-review model will **not** call an
in-fiction narrative "non-story", so **(a) fails** and the character is never
stripped — even when (b) and (c) happen to be true for a character who only
appears in one framed chapter.

## Architecture

### New module — `server/src/analyzer/third-party-front-matter-guard.ts`

Pure, sibling to `byline-author-guard.ts`. Approximate shape:

```ts
export function stripThirdPartyFrontMatter(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  chapters: { id: number; title?: string; body: string; nonStoryFrontMatter?: boolean }[],
  opts: { minLines?: number; language?: string },
): { characters: CharacterOutput[]; sentences: SentenceOutput[]; stripped: string[] };
```

Behaviour:

- For each non-narrator character, evaluate (a)/(b)/(c).
- A qualifying character is **removed from the roster** AND its sentences are
  **re-routed to `narrator`** by this pass itself — rather than left as orphans
  for `reconcileSentenceCharacterIds`. Re-routing here keeps those sentences out
  of the `attribution_drift` abort counter (a mass strip must not look like a
  corrupted run).
- No-op identity: when nothing qualifies, return the input `characters` /
  `sentences` array references unchanged (matches the `byline-author-guard` /
  `foldMinorCast` no-op convention that preserves referential identity).

### Insertion point in `analysis.ts`

Immediately after `dedupAndPrepare` and **before `foldMinorCast`** — in both the
full-analysis assembly block (~L4192) and the subset re-analysis block (~L5231).
At that point `stage1.characters`, the recovered `sentences`, and all `chapters`
(with bodies) are in scope.

Stripping **before** the fold means `foldMinorCast`'s `proseTagged` carve-out
never sees the bogus entry — no special-casing inside that already-complex
385-line file.

### Why a dedicated pass (not an exception inside `foldMinorCast`)

`foldMinorCast` already carries several interacting carve-outs (descriptor
names, protected roles, `proseTagged`, drifted buckets). A separate,
single-purpose, pure module is easier to test and reason about, and mirrors how
`byline-author-guard` was split out of the same pipeline.

## Schema + script-review changes (Signal 2)

- **`server/src/handoff/schemas.ts`** — add an **optional** chapter-level field
  `nonStoryFrontMatter?: boolean` where the analysis chapter output lives.
  Additive/optional so pre-existing cached analyses validate unchanged (same
  discipline as the fs-25 / fs-57 / fs-58 optional fields). Must not invalidate
  in-flight cached analyses.
- **Script-review prompt** (`skills/audiobook-script-review.md` + the analyzer
  prompt that emits it) — add a chapter-level judgment: "if this whole chapter
  is a non-story foreword / critical article / essay *about* the book or its
  author (not narrative fiction), report `nonStoryFrontMatter: true`."
  Explicitly **distinct** from `flag_nonstory` (which stays residue-only) and
  explicitly **not** an exclude-from-synthesis action. Keep it conservative:
  "when in doubt, omit" — matching the posture.
- **Plumbing** — thread the flag from the script-review result onto the
  `chapters` objects that reach the assembly block so
  `stripThirdPartyFrontMatter` can read `chapter.nonStoryFrontMatter`.

## Testing

### Unit — `third-party-front-matter-guard.test.ts` (core)

- **Strips** — non-story chapter (via title) + name absent from all other
  bodies + low lines → character removed, its sentences re-routed to narrator.
- **Preserves #938** — framed in-fiction chapter (not non-story) with a real
  quoted character appearing only in that chapter → **not** stripped.
- **Preserves** — name that also appears in a story chapter's body → not
  stripped (fails (b)).
- **Signal-2-only path** — title does not classify but `nonStoryFrontMatter:
  true` is set → strips.
- **No-op identity** — returns the same array reference when nothing qualifies.

### Title classifier

Extend `strip-front-matter` / `parsers/front-matter.ts` tests to cover
"Вступительная статья" and the new essay-class terms across the supported
languages.

### Fixture

A small manuscript shaped like the *Юный дрессировщик* ch3 case: author
Острецова; a "Вступительная статья" chapter quoting Radiy Pogodin; Pogodin
absent from every other chapter body. Per the issue's acceptance criteria.

### Integration

Assert the strip fires inside the `analysis.ts` assembly block: the third-party
person is absent from the final roster, and the essay's sentences are present and
narrator-attributed. Wired like the existing byline-guard integration check.

## Risks / edge cases

1. **Common-name false "present" in (b)** — a short/common surname matching
   incidental body text will *keep* the person. This is the safe direction under
   the conservative posture; note it, do not over-engineer.
2. **Signal 2 availability** — the chapter-level flag only exists when script
   review runs for the book. If it is gated/skipped, only Signal 1 (title)
   fires. This is the intended graceful degradation: we strip less, never more.
3. **Two call sites** — the full-analysis and subset re-analysis blocks both
   need the guard, or the subset path leaks the bug (the same duplication the
   byline-guard already lives with).
4. **Cache interaction** — the new optional chapter field must not invalidate
   in-flight cached analyses; keeping it additive/optional handles this.

## Acceptance criteria (from #1447)

- A front-matter / foreword-ish chapter that names or quotes a real third-party
  person does not roster them as an attributable speaker.
- A genuinely framed narrative chapter with a real quoted character (the #938
  author's-note case) is unaffected.
- Paired regression test using a fixture shaped like the *Юный дрессировщик* ch3
  case.

## Implementation notes

- Work lands on an **isolated worktree + branch** (per the user's instruction)
  to avoid collisions with `main` / concurrent sessions. Branch:
  `feat/server-third-party-front-matter-guard`.
- The new module is pure and mirrors `byline-author-guard.ts`; the analysis-route
  wiring touches the two assembly blocks only.
