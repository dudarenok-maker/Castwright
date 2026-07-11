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
  article; the stripped person's quoted lines re-route to narrator), and
- **never stripping a legitimately framed in-fiction character** (#938 — an
  in-fiction letter, a genuine framed author's-note where the author speaks in
  character).

**Posture: conservative / high-precision.** All signals must agree before a
strip. When unsure, do not strip.

Out of scope: excluding the essay from synthesis; a per-book user affordance to
skip front matter; any change to `flag_nonstory`'s existing residue-only remit.

## Architecture correction (why Signal 2 is an in-pipeline classifier)

An earlier draft assumed the fs-58 script-review pass "already runs per chapter"
and could carry a chapter-level non-story flag to the analyze assembly block.
**That is false.** Script review is a **separate, later, user-initiated SSE
route** (`server/src/routes/script-review.ts`, mounted at `/api/books`) that
reads `cast.json` + post-fold sentences **from disk** and streams edit-ops to the
**frontend**. The analyze route never invokes it, and it runs *after*
`analysis.ts` has already folded and **written `cast.json`** (`analysis.ts:4273`).
So a script-review-produced flag can never be read at the guard's insertion
point.

Therefore Signal 2 is realized as a **new, cheap, gated chapter-level
classification call made inside the analyze pipeline** (a real, small LLM call —
not free). It is gated so hard that on a normal book it fires **zero** times (see
"Cost gating" below).

## Detection heuristic

A character is stripped **only if ALL THREE conditions hold**. They are evaluated
cheap-deterministic-first; the LLM (Signal 2) is only ever consulted for a
character that has already passed (b) and (c) and whose chapter title did not
already classify — so the expensive check rides behind two free filters.

### (c) Low presence — cheap deterministic pre-filter

The character is attributed in **exactly one chapter** and its attributed line
count is below a small threshold (reuse the minor-cast `minLines` notion,
default 3). Fail → keep. Cheapest check, evaluated first.

### (b) Name absent from every other chapter body — cheap deterministic pre-filter

The character's name and every alias appears in **no chapter body except the one
chapter** it is attributed in. Fail (name found elsewhere) → keep.

**Match algorithm (specified to remove ambiguity):**
- Search corpus = the raw body text of every OTHER chapter, sourced from
  `record.chapterHints[].body` (NOT the `chapters`/`chapterStub` array, which
  carries only `{id, title}`).
- Needles = the character's `name` plus each entry of `aliases`, each trimmed and
  case-folded (`toLocaleLowerCase`). Skip needles shorter than a floor (e.g. < 3
  chars) — too collision-prone to trust.
- Match = **case-folded substring** containment of a needle in the case-folded
  body. Do **not** use `\b` word boundaries: they are unreliable for Cyrillic in
  this codebase. Substring is deliberately the *permissive* direction — an
  incidental match keeps the character (the safe outcome under the posture).
- **Same-script only, no transliteration.** A Cyrillic-detected name ("Радий
  Погодин") is searched against body text as-is; we do NOT transliterate to
  "Radiy Pogodin". A transliteration mismatch fails-safe toward *keep*.
- `normaliseNameKey` is NOT used here — it is a whole-string equality key
  normaliser, not an in-body search primitive.

### (a) The one chapter is a non-story front-matter chapter — the anchor

Only evaluated for a character that passed (b) and (c). Satisfied by **either**:

- **Signal 1 — extended deterministic title classifier.** Add an
  essay/critical-article class to the shared front-matter title machinery
  (`isLikelyFrontMatterTitle` / language-registry `frontMatterKeywords`):
  `вступительная статья`, `критическая статья`, `critical introduction`, and the
  like. Deterministic, zero cost. If it fires → strip; Signal 2 is not consulted.
- **Signal 2 — new, cheap, in-pipeline chapter-level LLM classification.** Only
  invoked when Signal 1 did **not** fire for this chapter (and a character
  passed (b)+(c) in it). One lightweight yes/no prompt: "Is this whole chapter a
  non-story foreword / critical article / essay *about* the book or its author,
  as opposed to narrative fiction? Answer conservatively; when in doubt, no."
  Classification only — it never sets `excludeFromSynthesis`; the essay stays
  narrated. Result cached per chapter within the run so at most one call per
  candidate chapter.

### Why the #938 framed case is safe

(a) AND (b) AND (c) must all hold. A genuine in-fiction chapter is **not**
title-classified as an essay, and the conservative Signal-2 prompt will answer
"no" for narrative fiction, so **(a) fails** and the character is never stripped —
even when (b) and (c) happen to be true for a character who only appears in one
framed chapter.

## Cost gating (Signal 2 fires ~never on normal books)

The LLM classification is reached only when, for some character:
`(c) single-chapter + low-lines` AND `(b) name absent from all other bodies` AND
`Signal 1 title did not classify`. A normal novel has no character satisfying
(b)+(c) in a title-unclassified chapter, so **zero** calls. The pathological
book (a third-party essay under a title our regex doesn't know) pays exactly one
call for that one chapter. This is the honest cost: bounded by the number of
suspicious front-matter chapters, not by chapter count.

## Architecture — components

### New module — `server/src/analyzer/third-party-front-matter-guard.ts`

Pure-core with one injected async escalation. Approximate shape:

```ts
export interface ThirdPartyGuardChapter {
  id: number;
  title?: string;
  body: string; // from record.chapterHints[].body
}

export async function stripThirdPartyFrontMatter(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  chapters: ThirdPartyGuardChapter[],
  opts: {
    minLines?: number;
    language?: string;
    /** Signal 2. Injected so the core stays testable. Called at most once per
        candidate chapter, only when Signal 1 did not classify it. Omitted in
        unit tests → Signal-1-only (fully deterministic). */
    classifyNonStory?: (chapter: ThirdPartyGuardChapter) => Promise<boolean>;
  },
): Promise<{ characters: CharacterOutput[]; sentences: SentenceOutput[]; stripped: string[] }>;
```

Behaviour:
- Evaluate (c) then (b) then (a) as above.
- A qualifying character is **removed from the roster** AND its sentences are
  **re-routed to `narrator`** by this pass itself — upstream of
  `reconcileSentenceCharacterIds`, so re-routed narrator ids are valid and never
  enter the `attribution_drift` counter (verified: `taggedSpeakerIds` is computed
  inside `foldMinorCast` from the passed characters/sentences, so removing the
  entry upstream neutralises the `proseTagged` carve-out with no special-casing).
- No-op identity: when nothing qualifies, return the input array references
  unchanged (matches the `byline-author-guard` / `foldMinorCast` no-op
  convention).
- No schema/persistence change: the non-story boolean lives only in memory for
  the duration of the run.

### Insertion point in `analysis.ts`

Immediately after `dedupAndPrepare` and **before `foldMinorCast`** — in both the
full-analysis assembly block (~L4192) and the subset re-analysis block (~L5231).
`stage1.characters` and the recovered `sentences` are in scope there; chapter
**bodies** come from `record.chapterHints[].body` (confirmed present in both
paths), title from the chapter-title lookup. The real `classifyNonStory` is
wired to the analyzer handle already used by the surrounding pipeline (the exact
handle is a plan-step detail).

### Why a dedicated pass (not an exception inside `foldMinorCast`)

`foldMinorCast` already carries several interacting carve-outs (descriptor
names, protected roles, `proseTagged`, drifted buckets). A separate,
single-purpose module is easier to test and reason about, and mirrors how
`byline-author-guard` was split out of the same pipeline.

## Testing

### Unit — `third-party-front-matter-guard.test.ts` (the real coverage)

Fully deterministic — synthetic `characters` / `sentences` / `chapters`, no LLM:
- **Strips (Signal 1)** — title classifies + name absent from all other bodies +
  single-chapter/low-lines → character removed, its sentences re-routed to
  narrator; `stripped` names returned.
- **Strips (Signal 2)** — title does NOT classify; injected `classifyNonStory`
  stub returns `true` → strips. Assert the stub was called exactly once for that
  chapter.
- **Signal 2 not consulted when title classifies** — stub is a spy asserted
  **not** called (proves the cheap-first ordering / cost gating).
- **Signal 2 not consulted when (b)/(c) fail** — a character present in another
  body, or multi-chapter/high-lines, never reaches the stub (spy not called).
- **Preserves #938** — framed in-fiction chapter (title not classifying),
  `classifyNonStory` stub returns `false`, real quoted character only in that
  chapter → **not** stripped.
- **Preserves** — name also appears in a story chapter's body → kept (fails (b)),
  including a Cyrillic body-text case (`Радий` occurring in a later chapter).
- **No-op identity** — same array reference back when nothing qualifies.
- **Async contract** — returns a Promise; omitting `classifyNonStory` yields
  Signal-1-only behaviour with no throw.

### Title classifier

Extend `parsers/front-matter.ts` (+ its client mirror `src/lib/chapter-heuristics.ts`,
kept in sync per that file's header) and its tests to cover "Вступительная
статья" and the new essay-class terms across supported languages.

### Integration (analyzer-stubbed, not model-dependent)

Assert the strip fires inside the `analysis.ts` assembly block using the existing
analyzer-stub harness (`analysis.test.ts` style): feed a canned roster where a
third-party appears only in a front-matter chapter, stub `classifyNonStory`
true, and assert the person is absent from the final roster while the essay's
sentences are present and narrator-attributed. **No end-to-end LLM fixture** —
stage-1/stage-2 attribution and Signal 2 are both stubbed. (The *Юный
дрессировщик* shape informs the canned inputs but is not run through a live
model.)

## Risks / edge cases

1. **Common-name false "present" in (b)** — a short/common surname substring-
   matching incidental body text will *keep* the person. Safe direction under
   the conservative posture; the < 3-char needle floor trims the worst of it.
   Note it; do not over-engineer.
2. **Signal 2 quality** — the classifier is a small conservative yes/no; a wrong
   "yes" on a genuinely framed chapter is the dangerous case, mitigated by the
   prompt's "when in doubt, no" and by (b)/(c) already having narrowed to a
   single-chapter, body-absent, low-line character. A wrong "no" simply keeps a
   stray entry (cosmetic, per #1446).
3. **Two call sites** — the full-analysis and subset re-analysis blocks both need
   the guard, or the subset path leaks the bug (the same duplication the
   byline-guard already lives with).
4. **Async in the assembly block** — the guard is now `await`ed; confirm the
   surrounding assembly code is already async (it is — the route is async and
   awaits analyzer work) so this adds no new control-flow hazard.

## Acceptance criteria (from #1447)

- A front-matter / foreword-ish chapter that names or quotes a real third-party
  person does not roster them as an attributable speaker.
- A genuinely framed narrative chapter with a real quoted character (the #938
  author's-note case) is unaffected.
- Paired regression test using inputs shaped like the *Юный дрессировщик* ch3
  case (deterministic unit + analyzer-stubbed integration; no live model).

## Implementation notes

- Work lands on an **isolated worktree + branch** (per the user's instruction):
  `feat/server-third-party-front-matter-guard`.
- The new module mirrors `byline-author-guard.ts` but is async (one injected
  escalation); the analysis-route wiring touches the two assembly blocks only and
  adds no schema/persistence change.
