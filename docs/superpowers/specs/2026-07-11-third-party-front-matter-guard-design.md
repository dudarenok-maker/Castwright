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
| `isLikelyFrontMatterTitle` | `parsers/front-matter.ts` | No (Russian `frontMatterKeywords` lacks it) | discard PDF outline entries; **also drives chapter `excluded`** |
| `flag_nonstory` / `excludeFromSynthesis` | `schemas.ts:135` (fs-58) | LLM-decided, per-sentence, residue-only | filter sentences out of synthesis |

## Goal & scope

Stop a **real third-party person named/quoted only in a non-story front-matter
chapter** from surviving as an attributable cast member, while:

- **keeping the essay narrated** (it is real book content — foreword / critical
  article; the stripped person's quoted lines re-route to narrator), and
- **never stripping a legitimately framed in-fiction character** (#938 — an
  in-fiction letter, a genuine framed author's-note where the author speaks in
  character), and **never stripping an ordinary walk-on speaker** in a real
  story chapter.

**Posture: conservative / high-precision.** Every gate must agree before a strip.
When unsure, do not strip.

Out of scope: excluding the essay from synthesis; a per-book user affordance to
skip front matter; any change to `flag_nonstory`'s residue-only remit or to the
existing `isLikelyFrontMatterTitle` → `excluded` behaviour.

## Two architecture corrections from adversarial review

**1. Signal 2 is an in-pipeline classifier, not a script-review flag.** An early
draft assumed the fs-58 script-review pass runs per chapter in-pipeline. It does
not: script review is a **separate, later, user-initiated SSE route**
(`routes/script-review.ts`, `/api/books`) that reads `cast.json` from disk and
streams ops to the frontend, *after* `analysis.ts` has folded and written
`cast.json` (`analysis.ts:4273`). So Signal 2 must be a **new analyzer call made
inside the analyze pipeline**.

**2. Signal 1 must NOT reuse `isLikelyFrontMatterTitle` / `frontMatterKeywords`.**
That predicate directly sets chapter `excluded` (`store/manuscripts.ts:102`,
`routes/import.ts:269/275`), and an excluded chapter is skipped from analysis and
contributes **no sentences** (`analysis.ts` `if (h.excluded) continue`).
Extending it with essay terms would drop the essay from the audiobook AND moot
the guard (no sentences → nothing to strip). Signal 1 is therefore a **new,
dedicated essay-class title predicate** in its own module, wired ONLY into this
guard — never into the exclusion machinery.

## Detection heuristic — chapter-first gating

The strip is gated **chapter-first** so ordinary walk-on speakers in real story
chapters are never even considered. Order:

### Gate 0 (chapter, cheap, structural) — is this a front-matter-suspicious chapter?

A chapter is a **candidate** if EITHER:
- **Signal 1 — new essay-class title predicate** matches its title
  (`isNonStoryEssayTitle`, new module): `вступительная статья`, `критическая
  статья`, `critical introduction`, `об авторе`-adjacent essay forms, etc.
  Deterministic, zero cost, decoupled from `excluded`. OR
- **Positional front-region** — the chapter's index is within the first `F`
  chapters of the book (default `F = 5`). A bounded cost gate, not a precision
  claim: it only decides *whether Signal 2 may be consulted*, never strips on its
  own.

Non-candidate chapters (the vast majority — all deep story chapters) are skipped
entirely. A walk-on speaker in chapter 14 is never evaluated.

### Per-character gates, evaluated only for characters attributed in a candidate chapter

**(c) Low presence.** Attributed in exactly one chapter, line count below the
minor-cast `minLines` threshold (default 3). Fail → keep.

**(b) Name absent from every other chapter body.** The character's name + every
alias appears in no chapter body except its one chapter. Fail → keep. Match
algorithm:
- Corpus = raw body text of every OTHER chapter, from `record.chapterHints[].body`
  (confirmed present for ALL chapters in BOTH the full and subset paths — the
  record is the full parsed manuscript). NOT the `chapterStub` `{id,title}` array.
- Needles = `name` + each `aliases` entry, trimmed, case-folded
  (`toLocaleLowerCase`); skip needles < 3 chars (collision-prone).
- Match = case-folded **substring** containment (NOT `\b` — unreliable for
  Cyrillic here). Same-script, **no transliteration**.
- `normaliseNameKey` is NOT used (it is whole-string equality, not in-body search).

### (a) Confirm non-story, only for a character that passed Gate 0 + (b) + (c)

- If **Signal 1** already classified the chapter title → strip. Signal 2 not consulted.
- Else **Signal 2 — new, in-pipeline chapter-level LLM classification** on that
  candidate chapter: one conservative yes/no — "Is this whole chapter a non-story
  foreword / critical article / essay *about* the book or its author, as opposed
  to narrative fiction? When in doubt, answer no." Result cached per chapter for
  the run (≤ 1 call per candidate chapter). Classification only — never sets
  `excludeFromSynthesis`; the essay stays narrated.

### Why the protected cases are safe

- **#938 framed in-fiction chapter:** even inside the front region, Signal 1
  won't match a fiction title and the conservative Signal 2 answers "no" for
  narrative fiction → (a) fails → not stripped.
- **Ordinary walk-on speaker:** in a deep story chapter, Gate 0 fails → never
  considered. In a *front-region* story chapter (e.g. a bartender in chapter 1),
  Signal 2 answers "no" (it is a story chapter, not an essay) → not stripped;
  the only cost is one benign classification call.

## Cost (honest, bounded — not "zero")

Signal 2 fires at most once per candidate chapter (Signal-1-unclassified,
front-region) that contains a (b)+(c) character. Bounded by `F` (default 5), and
in practice near-zero: front-region chapters are usually title-page / dedication
/ TOC with no (b)+(c) *named speaker*. A front-region story chapter with a
walk-on costs one call that returns "no". The pathological target book (a
third-party essay under an unenumerated title) pays exactly one call. This is the
real cost — a small constant, not free.

## Architecture — components

### New module — `server/src/analyzer/non-story-essay-title.ts`

`export function isNonStoryEssayTitle(title: string | undefined, language?: string): boolean`.
The Signal-1 essay-class predicate, decoupled from `isLikelyFrontMatterTitle`.
Its own per-language term list (may share the language-registry lookup shape but
NOT the `frontMatterKeywords` array that drives `excluded`).

### New analyzer method — Signal 2

Add to the `Analyzer` interface (`analyzer/index.ts:65`) a first-class
schema-constrained method, e.g.:
`runNonStoryClassification(manuscriptId, chapterId, promptMd, call): Promise<{ nonStory: boolean }>`.
Implement in the Gemini and local analyzers; `FallbackAnalyzer` delegates like
the other methods. This is what makes the analyzer-stubbed integration test
work — the guard reaches Signal 2 through the mocked `select-analyzer` seam, not
a raw Ollama/Gemini call.

### New module — `server/src/analyzer/third-party-front-matter-guard.ts`

Pure-core with one injected async escalation:

```ts
export interface ThirdPartyGuardChapter { id: number; title?: string; body: string; }

export async function stripThirdPartyFrontMatter(
  characters: CharacterOutput[],
  sentences: SentenceOutput[],
  chapters: ThirdPartyGuardChapter[], // ordered; index drives the front-region gate
  opts: {
    minLines?: number;
    language?: string;
    frontRegion?: number; // F, default 5
    /** Signal 2, injected so the core stays testable. Called at most once per
        candidate chapter, only when Signal 1 did not classify it. Omitted in
        unit tests → Signal-1-only, fully deterministic. */
    classifyNonStory?: (chapter: ThirdPartyGuardChapter) => Promise<boolean>;
  },
): Promise<{ characters: CharacterOutput[]; sentences: SentenceOutput[]; stripped: string[] }>;
```

Behaviour:
- Gate 0 → (c) → (b) → (a), in that order.
- A qualifying character is removed from the roster and its sentences re-routed
  to `narrator` by this pass — upstream of `reconcileSentenceCharacterIds`, so
  re-routed ids are valid and never enter the `attribution_drift` counter
  (verified: `taggedSpeakerIds` is computed inside `foldMinorCast` from the
  passed roster, so removing the entry upstream neutralises the `proseTagged`
  carve-out with no special-casing).
- No-op identity: input array references returned unchanged when nothing
  qualifies.
- No schema/persistence change: the non-story boolean lives only in memory.

### Insertion point in `analysis.ts`

After `dedupAndPrepare`, **before `foldMinorCast`** — in both the full-analysis
block (~L4192) and the subset re-analysis block (~L5231). Both are already
`async`, so the awaited guard adds no control-flow hazard. Chapter bodies come
from `record.chapterHints[].body`; the real `classifyNonStory` wraps the new
analyzer method against the analyzer handle already in scope.

### Why a dedicated pass (not an exception inside `foldMinorCast`)

`foldMinorCast` already carries several interacting carve-outs. A separate
single-purpose module is easier to test and mirrors how `byline-author-guard`
was split out.

## Testing

### Unit — `third-party-front-matter-guard.test.ts` (the real coverage)

Deterministic, synthetic inputs, no live model:
- **Strips (Signal 1)** — candidate via essay title + (b) + (c) → removed,
  sentences re-routed to narrator, `stripped` returned.
- **Strips (Signal 2)** — front-region chapter, title NOT essay, stub
  `classifyNonStory` → true → strips; assert stub called exactly once.
- **Gate 0 blocks walk-ons** — a (b)+(c) character in a **deep** story chapter
  (index ≥ F, non-essay title): stub is a spy asserted **not** called, character
  kept. (Directly locks the B2 fix.)
- **Signal 2 not consulted when Signal 1 classifies** — spy not called.
- **Front-region story chapter kept** — candidate by position, stub returns
  false → kept (proves Signal 2's "no" protects walk-ons/framed fiction).
- **Preserves #938** — framed in-fiction chapter, stub false, real quoted
  character only there → kept.
- **Preserves (b)** — name also in another chapter body (incl. a Cyrillic
  `Радий` occurrence) → kept.
- **No-op identity**, **async contract** (omitting `classifyNonStory` →
  Signal-1-only, no throw).

### Title predicate — `non-story-essay-title.test.ts`

"Вступительная статья" + essay-class terms across supported languages; assert it
does NOT alter `isLikelyFrontMatterTitle` / `excluded` behaviour (regression that
the two predicates stay decoupled).

### Analyzer method

Unit-test `runNonStoryClassification` schema handling on at least the local
analyzer path (mirrors existing per-method analyzer tests); add the stub to the
`analysis.test.ts` analyzer mock.

### Integration (analyzer-stubbed, not model-dependent)

In the `analysis.test.ts` harness, feed a canned roster where a third-party
appears only in a front-region chapter; stub `runNonStoryClassification` → true;
assert the person is absent from the final roster and the essay's sentences are
present and narrator-attributed. No live-LLM fixture. (The *Юный дрессировщик*
shape informs the canned inputs.)

## Risks / edge cases

1. **(b) fragility to incomplete aliases / cross-script mentions.** If a REAL
   recurring character is mentioned elsewhere only under a variant/short form or
   a different script not in its alias set, the substring needle misses, (b)
   reads "absent", and the character moves *toward* strip — the dangerous
   direction. Mitigated by: Gate 0 (must be a front-matter-suspicious chapter),
   (c) (must be a single-chapter, <3-line character), and Signal 2's conservative
   "no" for story chapters. The corrected reasoning: substring is permissive for
   *matches*; a *miss* is the risky side, so alias completeness matters — tests
   name the cross-script case.
2. **Signal 2 quality.** A wrong "yes" on a genuinely framed chapter is the
   dangerous case, mitigated by the "when in doubt, no" prompt and the upstream
   gates. A wrong "no" merely keeps a stray entry (cosmetic, per #1446).
3. **Two call sites** — full and subset assembly blocks both need the guard.
4. **`F` tuning** — `frontRegion` default 5 is a cost bound; too small could miss
   a late foreword (rare), too large only adds benign "no" calls. Configurable
   via `opts.frontRegion`.

## Acceptance criteria (from #1447)

- A front-matter / foreword-ish chapter that names or quotes a real third-party
  person does not roster them as an attributable speaker.
- A genuinely framed narrative chapter with a real quoted character (the #938
  case) — and an ordinary walk-on speaker in a real story chapter — are
  unaffected.
- Paired regression tests shaped like the *Юный дрессировщик* ch3 case
  (deterministic unit + analyzer-stubbed integration; no live model).

## Implementation notes

- Work lands on an isolated worktree + branch:
  `feat/server-third-party-front-matter-guard`.
- New surface: `non-story-essay-title.ts`, a new `Analyzer` method (interface +
  Gemini/local impls + Fallback delegation + test stub), and the async guard
  module; analysis-route wiring touches the two assembly blocks only; **no
  schema/persistence change** and **no change to `isLikelyFrontMatterTitle` /
  `excluded`.**
