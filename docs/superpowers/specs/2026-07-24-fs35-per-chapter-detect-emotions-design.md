# fs-35 — Per-chapter Detect-emotions trigger

- **Issue:** [#592](https://github.com/dudarenok-maker/Castwright/issues/592) (`fs-35`, follow-up to fs-33 #510)
- **Date:** 2026-07-24
- **Status:** design (assumption-checker pass folded 2026-07-24)
- **Area:** full-stack (server route + api + thunk + manuscript UI + e2e)

## Problem

"Detect emotions" runs a two-pass LLM annotation over the **whole book**:
pass 1 emotion backfill (`api.detectEmotions` → `POST /:bookId/annotate-emotion`),
pass 2 instruct/vocalization (`api.detectInstruct` → `POST /:bookId/instruct-annotation`).
Re-detecting a single edited or late-added chapter forces the whole book's
analyzer quota to be re-spent, even though the other chapters are unchanged.

fs-35 adds a **per-chapter** scope so the common "I just edited this one
chapter, re-detect it" case is cheap and targeted.

## Decisions (confirmed with user)

1. **Per-chapter runs BOTH passes** (emotion + instruct) scoped to the current
   chapter — identical work to today's whole-book button, just narrowed. The
   issue's "emotion-only" framing and single-file "Key files" list predate
   fs-57 (which added the instruct pass to this same button); scoping only the
   emotion pass would make the per-chapter button behave differently from the
   whole-book one under the same label. This is a deliberate scope expansion
   into `instruct-annotation.ts` beyond the issue's literal Key-files list.
2. **Split-button UI, per-chapter primary** — mirror fs-58's "Review Script"
   exactly: the primary button detects the **current chapter**; a `⌄`
   disclosure opens "Detect whole book". This changes the existing button's
   default action from whole-book to per-chapter.
3. **Cost-asymmetric confirm** — the per-chapter primary runs **immediately**
   (no confirm popover); the whole-book option keeps today's explanatory
   confirm popover (quota cost, "adds natural reactions", "hand-set emotions
   never overwritten"). Matches Review Script's asymmetry.

## Design

### Server — `annotate-emotion.ts` and `instruct-annotation.ts`

Both routes today compute the chapter set identically:

```ts
const chapterIds = [...byChapter.keys()]
  .filter((id) => !excludedChapterIds.has(id))
  .sort((a, b) => a - b);
```

Add an optional `chapterId` filter read from the request body. When present,
the set is narrowed to that single chapter (the `excluded` filter still
applies):

```ts
const scopeChapterId =
  typeof req.body?.chapterId === 'number' ? req.body.chapterId : null;
const chapterIds = [...byChapter.keys()]
  .filter((id) => !excludedChapterIds.has(id))
  .filter((id) => scopeChapterId == null || id === scopeChapterId)
  .sort((a, b) => a - b);
```

- A requested chapter that is excluded, absent, or has no attributed
  sentences yields an empty `chapterIds`, which flows through the **existing**
  `no_attribution` error path — no new branch.
- Everything downstream (chunking, pacing/ETA, SSE `phase`/`annotation`/
  `result` events, per-chapter failure handling) is unchanged. `totalChapters`
  in the pacing math is naturally `1` for a scoped run.

This is a symmetric ~3-line change in each of the two route files. Verified:
the instruct route's `chapterIds` computation (`instruct-annotation.ts:91-92`)
and request body are byte-identical to the emotion route's.

**Precedent + a conscious divergence.** The `script-review` route already
implements exactly this `chapterId` scoping (`openapi.yaml` script-review
description: "When an optional `chapterId` is provided, only that chapter is
reviewed"), but it emits a dedicated `no_such_chapter` error code for a
requested-but-absent chapter. fs-35 deliberately does **not** add that code:
the UI disables the per-chapter trigger whenever the current chapter has no
sentences (excluded/empty), so an absent scoped chapter is unreachable through
the button. The generic `no_attribution` fall-through is therefore adequate and
strictly simpler. (If a stale/malformed client request ever sends a bad
`chapterId`, it gets `no_attribution` — a safe, non-crashing result.)

### API layer — `src/lib/api.ts`

- `DetectEmotionsOpts` and `DetectInstructOpts` each gain `chapterId?: number`.
- `realDetectEmotions` / `realDetectInstruct` include it in the POST body:
  `JSON.stringify({ ...(model !== undefined ? { model } : {}), ...(chapterId !== undefined ? { chapterId } : {}) })`.
- `mockDetectEmotions` / `mockDetectInstruct` honor `chapterId` by emitting
  annotations for only that chapter (and reporting `annotatedChapters: 1`), so
  e2e and unit tests can assert "only the current chapter was tagged". **Note:**
  both mocks currently hardcode a 2-chapter simulation and do not even
  destructure `chapterId` (`api.ts:2968`), so this needs new conditional logic
  in each mock — it is not free.

### Thunk — `src/store/prosody-thunk.ts`

`RunProsodyPassesOpts` gains `chapterId?: number`, forwarded verbatim to both
`api.detectEmotions` and `api.detectInstruct`. No other change — the
totalChapters-pinning and combined-ETA logic already work for a 1-chapter run
(pinnedTotalChapters just settles at 1).

The eager auto-trigger (`layout.tsx`, prosody watermark) calls
`runProsodyPasses` **without** `chapterId` and is therefore unaffected —
per-chapter is a manual, targeted action only and never writes the
`prosodyAnnotated` watermark.

### Component — `src/components/detect-emotions-button.tsx`

Restructured from a single button + confirm popover into a split button that
mirrors `review-script-chapter` / `review-script-menu-toggle`.

**Scope source — the store, not props.** The button already reaches into
`ui.stage` for `bookId` (`s.ui.stage.bookId`). It reads `currentChapterId` the
same way (it lives inside the `ready` stage variant — confirmed:
`{ kind: 'ready', bookId, view, currentChapterId }`) and derives per-chapter
availability from `s.manuscript.sentences.some((x) => x.chapterId === currentChapterId)`.
**`manuscript.tsx` therefore does NOT change** — it keeps rendering
`<DetectEmotionsButton disabled={sentences.length === 0} />` (the `disabled`
prop remains the book-level / whole-book availability signal). This is smaller
and more consistent with the component's existing self-contained pattern than
threading new props.

- **Primary** ("Detect emotions"): `onClick` → `run({ chapterId: currentChapterId })`
  immediately, no confirm. Disabled when the current chapter has no sentences
  (or `currentChapterId == null`), plus the existing `disabled`/`busy` gates.
- **`⌄` toggle** (`detect-emotions-menu-toggle`): opens a small menu with
  **"Detect whole book"** (`detect-emotions-wholebook`), which opens the
  existing confirm popover → `run({})` (no chapterId). Disabled when the book
  has no sentences (`disabled` prop).
- `run` takes an optional `{ chapterId }` and passes it into `runProsodyPasses`.
- Success copy is scope-aware: per-chapter → "Tagged N line(s) in this
  chapter."; whole-book → today's "Tagged N line(s) across M chapter(s)."
- The running-state `SubstageProgressPill`, `busy`/substage lock, cancel, and
  error handling are unchanged. The shared bookId-keyed substage lock already
  prevents a per-chapter and whole-book run overlapping.
- Test-ids: `detect-emotions-button` stays the **primary** (now per-chapter);
  new `detect-emotions-menu-toggle` + `detect-emotions-wholebook`;
  `detect-emotions-confirm` / `-progress` / `-done` / `-error` unchanged.

### Contract — `openapi.yaml`

Only `annotate-emotion` is documented in `openapi.yaml` (`:2564`, with a
`requestBody.model` property); **`instruct-annotation` has no openapi path at
all** — a pre-existing gap. So the contract change is limited to adding an
optional `chapterId: integer` to `annotate-emotion`'s `requestBody` schema
(and a mention in its SSE-description prose). Run `npm run openapi:types` to
regenerate `src/lib/api-types.ts`. Adding a brand-new `instruct-annotation`
path to openapi is **out of scope** for fs-35 — leaving it undocumented keeps
the diff minimal and matches the route's current state.

## Testing

- **Server** (`annotate-emotion.test.ts`, `instruct-annotation.test.ts`): a
  `chapterId`-scoped POST annotates only that chapter (other chapters emit no
  `annotation` events; `result.annotatedChapters === 1`); a `chapterId` for an
  excluded/absent chapter takes the `no_attribution` path.
- **API** (`api-detect-emotions.test.ts` + instruct equivalent): `chapterId`
  is forwarded in the request body; omitted when undefined.
- **Thunk** (`prosody-thunk.test.ts`): `chapterId` is forwarded to both
  `api.detectEmotions` and `api.detectInstruct`.
- **Component** (`detect-emotions-button.test.tsx`): split button renders;
  primary click runs per-chapter (chapterId passed, no confirm); `⌄` →
  "Detect whole book" opens the confirm then runs with no chapterId; per-chapter
  primary disabled on an empty/excluded chapter.
- **e2e** (`manuscript-detect-emotions.spec.ts`): drive the per-chapter primary
  and assert only the current chapter's lines are tagged (mock scoped by
  `chapterId`); keep the whole-book path covered via the menu.

**Existing tests that WILL break and must be updated (not additive):** the
primary action changes from "open confirm → whole-book" to "run immediately →
this chapter", so the primary click no longer shows a confirm popover. Every
spec that does `click(detect-emotions-button)` → `click(detect-emotions-confirm)`
breaks. Grep-verified full list:

- `src/components/detect-emotions-button.test.tsx` (6 tests reference the flow)
- `e2e/manuscript-detect-emotions.spec.ts`
- `e2e/manuscript-detect-emotions-instruct.spec.ts`
- `e2e/detect-emotions-pill-progress.spec.ts`
- `e2e/generate-disabled-while-analysing.spec.ts`
- `e2e/prosody-auto-trigger-guard.spec.ts`

For the four specs where the confirm click was merely a way to *start a run*
(pill-progress, generate-disabled, prosody-guard, and the instruct spec's run),
the fix is a **simplification** — delete the `detect-emotions-confirm` click;
the primary click alone now starts the (per-chapter) run. Only
`manuscript-detect-emotions.spec.ts` and the component test need the confirm
path re-homed under the new `⌄` menu (`detect-emotions-menu-toggle` →
`detect-emotions-wholebook` → `detect-emotions-confirm`). New/updated test-ids
mirror the `review-script-menu-toggle` / `review-script-wholebook` naming.

## Out of scope

- No change to pass internals, prompts, chunking, pacing, or the eager
  auto-trigger / watermark logic.
- No new per-chapter concurrency model — the existing shared substage lock is
  reused.
- No re-run "already has annotations" confirm gate (unlike Review Script's
  unresolved-findings gate) — emotion/instruct passes are fill-only-empty, so a
  re-run is idempotent-ish and cheap; a confirm would be friction without
  payoff.

## Ship notes

_(filled at ship time)_
