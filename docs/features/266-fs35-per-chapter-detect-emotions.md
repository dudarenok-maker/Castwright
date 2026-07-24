---
status: stable
shipped: 2026-07-24
owner: null
---

# 266 — fs-35: Per-chapter "Detect emotions" trigger

> Status: stable
> Key files: `server/src/routes/annotate-emotion.ts`, `server/src/routes/instruct-annotation.ts`, `src/lib/api.ts`, `src/store/prosody-thunk.ts`, `src/components/detect-emotions-button.tsx`, `openapi.yaml`
> URL surface: indirect — the button lives in `#/books/<id>/manuscript`, no hash change
> OpenAPI ops: `POST /api/books/{id}/annotate-emotion` (requestBody gains optional `chapterId`); `instruct-annotation` has no openapi path (pre-existing gap, unchanged by this plan)

Source spec: [`docs/superpowers/specs/2026-07-24-fs35-per-chapter-detect-emotions-design.md`](../superpowers/specs/2026-07-24-fs35-per-chapter-detect-emotions-design.md)

## Benefit / Rationale

- **User:** Re-detecting emotions after editing a single chapter no longer
  forces a whole-book re-run. "Detect emotions" now defaults to the chapter
  you're viewing — cheap, immediate, no confirm — with the full whole-book
  pass still one click away behind the `⌄` menu when that's genuinely what's
  needed.
- **Technical:** The existing `chapterIds` computation in both prosody routes
  (`annotate-emotion.ts`, `instruct-annotation.ts`) gains a single optional
  narrowing filter, reusing every downstream mechanism (chunking, pacing/ETA,
  SSE events, per-chapter failure handling) unmodified. No new error code —
  an unreachable-by-the-UI edge case (excluded/absent scoped chapter) falls
  through the pre-existing `no_attribution` path.
- **Architectural:** Establishes the same `⌄`-menu split-button pattern as
  "Review Script" (fs-58) for a second manuscript-analysis action, and keeps
  the button's scope-selection self-contained (reads `ui.stage.currentChapterId`
  + `manuscript.sentences` from the store directly) rather than threading a
  new prop through `manuscript.tsx` — so that view is untouched by this
  feature.

## Architectural impact

- **New seams / extension points:** `chapterId?: number` added identically to
  `DetectEmotionsOpts`, `DetectInstructOpts` (`src/lib/api.ts`),
  `RunProsodyPassesOpts` (`src/store/prosody-thunk.ts`), and both routes'
  request-body shape. `openapi.yaml`'s `annotate-emotion` requestBody schema
  gains the matching optional `chapterId: integer` property.
- **Invariants preserved:**
  - The eager auto-trigger (`layout.tsx`'s prosody-watermark path) calls
    `runProsodyPasses` **without** `chapterId` — unaffected, and per-chapter
    runs **never** write the `prosodyAnnotated` disk watermark. Per-chapter
    is a manual, targeted action only.
  - `manuscript.tsx` is byte-identical — it keeps rendering
    `<DetectEmotionsButton disabled={sentences.length === 0} />`; the
    `disabled` prop remains the book-level/whole-book availability signal.
    The component derives per-chapter availability itself from the store.
  - The shared bookId-keyed substage lock (busy/substage) is unchanged and
    already prevents a per-chapter and whole-book run overlapping.
  - `detect-emotions-confirm` / `-progress` / `-done` / `-error` test-ids are
    unchanged; only the confirm's trigger path moved (see below).
- **Migration story:** None — `chapterId` is optional on the wire and in
  Redux/thunk state; an old client omitting it is byte-identical to
  pre-fs-35 behaviour (whole-book, both routes' `scopeChapterId` resolves to
  `null`).
- **Reversibility:** Reverting the component change alone restores the
  single-button whole-book-only UI; the server/API/thunk changes are inert
  no-ops for any caller that never sends `chapterId`.

## Invariants to preserve

1. **Split button, per-chapter primary.** The "Detect emotions" primary
   button (`detect-emotions-button` test-id, unchanged) runs **both** prosody
   passes (emotion backfill via `annotate-emotion`, then instruct/vocalization
   via `instruct-annotation`) scoped to the **current chapter**, immediately,
   with **no confirm popover**. Disabled when the current chapter has no
   sentences or `currentChapterId == null` (plus the pre-existing
   `disabled`/`busy` gates).
2. **Whole-book lives behind the `⌄` menu.** `detect-emotions-menu-toggle`
   opens a small menu containing `detect-emotions-wholebook` ("Detect whole
   book"), which opens the pre-existing confirm popover (quota cost,
   "adds natural reactions", "hand-set emotions never overwritten") and, on
   confirm, runs `run({})` — no `chapterId`, i.e. every chapter. The menu
   dismisses on outside-click **and** Escape.
3. **Server `chapterId` scoping is symmetric across both routes.**
   `annotate-emotion.ts` and `instruct-annotation.ts` each read an optional
   `chapterId` (`typeof req.body?.chapterId === 'number'`) off the request
   body and narrow `chapterIds` to that single id (the `excludedChapterIds`
   filter still applies on top). Everything downstream — chunking, the
   pacing/ETA accumulator, SSE `phase`/`annotation`/`result` events,
   per-chapter failure handling — is unmodified; `totalChapters` naturally
   settles at `1` for a scoped run.
4. **No new error code.** A requested `chapterId` that is excluded, absent,
   or has no attributed sentences yields an empty `chapterIds`, which flows
   through the **existing** `no_attribution` path. This deliberately diverges
   from `script-review.ts`'s dedicated `no_such_chapter` code — the UI
   disables the per-chapter trigger whenever the current chapter is
   empty/excluded, so this edge is unreachable through the button; a
   stale/malformed client request still degrades safely (`no_attribution`,
   never a crash).
5. **Scope source is the store, not props.** `detect-emotions-button.tsx`
   reads `s.ui.stage.currentChapterId` (inside the `ready` stage variant) and
   `s.manuscript.sentences.some((x) => x.chapterId === currentChapterId)` to
   decide per-chapter availability — `manuscript.tsx` is not touched by this
   feature (verify via `git diff main --stat -- src/views/manuscript.tsx` ⇒
   empty).
6. **Success copy is scope-aware.** Per-chapter run → "Tagged N line(s) in
   this chapter."; whole-book run → "Tagged N line(s) across M chapter(s)."
   (unchanged wording for the whole-book case).

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/annotate-emotion.test.ts`,
  `server/src/routes/instruct-annotation.test.ts`) — a `chapterId`-scoped
  POST annotates only that chapter (`result.annotatedChapters === 1`, no
  `annotation` events for other chapters); a `chapterId` for an
  excluded/absent chapter takes the `no_attribution` path.
- Vitest unit (`src/lib/api-detect-emotions.test.ts` + the instruct
  equivalent) — `chapterId` is forwarded in the POST body when present, and
  omitted entirely when `undefined`; `mockDetectEmotions`/`mockDetectInstruct`
  honor `chapterId` by emitting annotations for only that chapter.
- Vitest unit (`src/store/prosody-thunk.test.ts`) — `chapterId` is forwarded
  verbatim to both `api.detectEmotions` and `api.detectInstruct`.
- Vitest unit (`src/components/detect-emotions-button.test.tsx`) — split
  button renders; primary click runs per-chapter immediately (no confirm,
  `chapterId` passed); `⌄` → "Detect whole book" opens the confirm, then runs
  with no `chapterId`; the primary is disabled on an empty/excluded chapter;
  the menu dismisses on outside-click and on Escape.
- Playwright e2e (`e2e/manuscript-detect-emotions.spec.ts`) — drives the
  per-chapter primary and asserts only the current chapter's lines are
  tagged (mock scoped by `chapterId`); the whole-book path is covered via the
  `⌄` menu → confirm.
- Playwright e2e (`e2e/manuscript-detect-emotions-instruct.spec.ts`,
  `e2e/detect-emotions-pill-progress.spec.ts`,
  `e2e/generate-disabled-while-analysing.spec.ts`,
  `e2e/prosody-auto-trigger-guard.spec.ts`) — updated for the new primary
  behaviour (a plain primary click now starts a run with no confirm step in
  between, since the primary's own click **is** the trigger).

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, the default for `npm run dev`).

1. Open a book's manuscript view (`#/books/<id>/manuscript`), select a
   chapter with sentences → click **Detect emotions** (the primary button).
   Expected: the run starts immediately, no confirm popover; on completion
   the inline summary reads **"Tagged N line(s) in this chapter."**
2. On the same book, click the **`⌄`** toggle next to Detect emotions →
   **"Detect whole book"**. Expected: the existing confirm popover opens
   (quota cost / "adds natural reactions" / "hand-set emotions never
   overwritten" copy); confirming starts a whole-book run, and on completion
   the inline summary reads **"Tagged N line(s) across M chapter(s)."**
3. Open the `⌄` menu again, then click elsewhere on the page (or press
   `Escape`). Expected: the menu closes without triggering either action.
4. Select a chapter with no sentences (or an excluded chapter). Expected:
   the primary "Detect emotions" button is disabled; the `⌄` menu's
   whole-book option remains available/disabled per the existing book-level
   `disabled` prop (unaffected by the current chapter's emptiness).

## Out of scope

- No change to pass internals, prompts, chunking, or pacing/ETA math — see
  plan [236](236-prosody-review-progress-detail.md) for that machinery.
- No change to the eager auto-trigger / `prosodyAnnotated` watermark logic,
  the Analysing-pill substage ladder, or the Generate-gate — see plan
  [234](234-manuscript-analysis-pill-gate.md).
- No new per-chapter concurrency model — the existing shared substage lock
  is reused as-is.
- No re-run "already has annotations" confirm gate (unlike Review Script's
  unresolved-findings gate) — emotion/instruct passes are fill-only-empty,
  so a re-run is idempotent-ish and cheap; a confirm would be friction
  without payoff.
- Adding a full `instruct-annotation` OpenAPI path — a pre-existing gap left
  as-is; only `annotate-emotion`'s existing schema gained the `chapterId`
  field.

## Ship notes

Shipped 2026-07-24 via PR #1789 (`Closes #592`, fs-35, follow-up to fs-33 #510),
merge commit `842212ec`. First PR of the v1.15.0 cycle — bootstrapped the
release-notes files to 1.15.0. All cloud `verify.yml` checks green.
