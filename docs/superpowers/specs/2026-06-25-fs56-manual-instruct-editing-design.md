# fs-56 — Manual per-line instruct editing UI

**Issue:** [#996](https://github.com/dudarenok-maker/Castwright/issues/996) · **Date:** 2026-06-25 · **Status:** design (approved, pre-plan)

## Problem

fs-57 (PR #1095) shipped the entire `instruct` *engine* path on the Qwen 1.7B
tier — the `instruct?: string` field on `Sentence`, the live-instruct synth path,
the Stage-3 LLM pass that auto-generates instruct, the per-book "Live expressive
delivery" toggle, and a precedence ladder `manual › analyzer › emotion-derived ›
neutral` (`server/src/tts/resolve-instruct.ts`).

The top rung — **manual** — is unreachable. Nothing in the UI can write a
per-line `instruct`, so the field is effectively LLM-fill-only. An author cannot
direct a line ("a sharp, startled whisper") themselves; they can only accept what
Stage-3 guessed. fs-56 closes that gap with the author-facing control.

## Scope

In scope: a user-editable free-text `instruct` on **every** manuscript line
(narrator included — fs-56 is *expressive narration*, the value over fs-25's
dialogue-only emotion tags), surfaced as an inline chip → popover textarea that
mirrors the existing `SentenceEmotionControl`.

Out of scope: any change to the synth path, the resolver, the Stage-3 pass, or
the schema — all already shipped by fs-57. No new "manual vs analyzer" field (see
Design rationale).

## Design rationale — why a single field suffices

`resolveInstructForGroup` reads one field, `group.instruct`
(`server/src/tts/resolve-instruct.ts:33`). The "manual wins over analyzer"
precedence is **not** a second field — it is the *fill-only* semantics of
`applyDetectedInstruct` (`src/store/manuscript-slice.ts:358`: `if (!sent.instruct
&& ann.instruct !== undefined)`). So a manual write to `sent.instruct`:

- overrides any analyzer value (last writer wins), and
- survives a re-run of "Detect emotions" (fill-only skips a populated field).

This is the exact model fs-25 uses for emotion (`setSentenceEmotion` is the manual
write site; `applyDetectedEmotions` is fill-only). We reuse it verbatim. No new
field, no migration.

## Components

### 1. Reducer — `setSentenceInstruct` (`src/store/manuscript-slice.ts`)

Sibling to `setSentenceEmotion`. Scoped by `(chapterId, sentenceId)`; no-op if the
sentence is absent.

```ts
setSentenceInstruct: (s, a: PayloadAction<{ chapterId: number; sentenceId: number; instruct: string }>) => {
  const sent = s.sentences.find((x) => x.chapterId === a.payload.chapterId && x.id === a.payload.sentenceId);
  if (!sent) return;
  const trimmed = a.payload.instruct.trim();
  if (trimmed === '') delete sent.instruct;   // clear → fall back to analyzer/emotion/neutral
  else sent.instruct = trimmed;               // manual override (fill-only applyDetectedInstruct preserves it)
}
```

A blank/whitespace value clears the field rather than storing an empty string, so
the store never carries a redundant empty instruct (mirrors `'neutral' → delete`).

### 2. Persistence (`src/store/persistence-middleware.ts`)

One entry, identical shape to `manuscript/setSentenceEmotion`:

```ts
'manuscript/setSentenceInstruct': {
  slice: 'manuscript',
  build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
},
```

`instruct` already serialises as part of each sentence, so the hand-set value lands
in `manuscript-edits.json` — the same file synth reads — and reaches generation
exactly like a manual emotion tag.

### 3. Component — `SentenceInstructControl` (`src/components/sentence-instruct-control.tsx`, new)

Mirrors `SentenceEmotionControl`'s scaffolding (outside-click close,
`contentEditable={false}`, 44×44 touch targets, design tokens only — no hex):

- **Chip:** a 🎬 director's-note button. Empty → faint icon (`text-ink/30`,
  `coarse-pointer:text-ink/40` so it stays faintly visible on touch). Set → tinted
  chip showing a truncated preview of the instruct text (e.g. first ~24 chars + `…`),
  with the full text in the `title`/`aria-label`.
- **Popover:** a surface containing a `<textarea>` plus **Save** and **Clear**.
  Save dispatches `setSentenceInstruct(text)`; Clear dispatches it with `''`
  (delete). Escape / outside-click closes without saving.
- **Edit-the-suggestion is the primary flow.** The textarea is pre-filled with the
  line's *current* `instruct` — whether the author wrote it OR Stage-3 (the LLM)
  proposed it. There is one field, so the control is the single edit surface for
  both. Opening an LLM-instruct'd line shows the AI's suggestion ready to refine;
  editing it makes it the author's value, which `applyDetectedInstruct`'s fill-only
  guard then preserves against re-detect. (This is *why* the control is ungated on
  every line — an LLM may have proposed a direction on any line, narration
  included, and the author needs to be able to see and amend it.)
- **Audibility signalling.** The field only reaches synth on a Qwen 1.7B book with
  live-instruct on (`resolveInstructForGroup` gate). When that condition is NOT
  met, signal it in TWO places, not just a buried caption: (a) a muted/struck chip
  style so an inaudible direction reads as inactive at a glance in the margin, and
  (b) a one-line popover caption — "Audible only on Qwen 1.7B with Live expressive
  delivery on." The control stays **enabled** regardless: the tag is additive data
  that survives an engine switch (identical philosophy to the emotion tag), so an
  author can pre-author directions before flipping live-instruct on. We strengthen
  the *signal*, we don't disable the control.
- **Accessibility & mobile (REQUIRED — `min-h-[44px] sm:min-h-0`, design tokens):**
  - Chip `aria-label`: empty → "Set delivery direction for this line"; set →
    `Delivery direction: <text> — edit`.
  - Popover: focus the textarea on open; **Escape** closes and returns focus to the
    chip; outside-click closes. (The emotion *menu* doesn't trap focus; a textarea
    is a heavier interaction, so explicit focus-on-open + return-focus is in scope.)
  - On `<640px` the popover renders as a bottom sheet (full-width), not a
    `top-full` absolute menu, so the textarea + Save/Clear never overflow a narrow
    phone (per the mobile-testing protocol). `sm:` and up keep the inline popover.

### 4. Placement (`src/views/manuscript.tsx`)

Render `SentenceInstructControl` immediately after `SentenceEmotionControl`
(`manuscript.tsx:1483`), **ungated** — shown for every sentence, narrator included
(the approved scope). The emotion control keeps its existing dialogue-or-tagged
gate; only the instruct control is universal.

**Clutter mitigation (the cost of "ungated").** An always-visible chip on every
narrator line is noisy. The empty-state affordance is therefore *minimal*: a tiny
dot that reveals the 🎬 on row hover/focus on desktop, and stays faint on touch
(`coarse-pointer:` opacity, the pattern the manuscript boundary handle already
uses). A line that HAS an instruct always shows its tinted preview chip. The list
is virtualised (`estimateSize: 220`, overscan 5 — only ~visible rows mount, so
this is *not* thousands of live components), but the second per-line control may
push rows taller; the plan re-checks/raises `estimateSize` so the virtualiser
doesn't thrash on first scroll. Touch note: the empty affordance sits at line-end,
outside the `[data-text-offset]` text span, so a stray tap can't hijack a
narrator-text selection (selection/split keys on the text span, not the control).

**Data wiring (corrected).** Audibility + staleness need the per-book
`liveInstruct` flag AND whether the engine is Qwen. `character.ttsEngine` arrives
by prop (as the emotion control already receives `character`), but **`liveInstruct`
is NOT on the character** — it lives in `book-meta-slice` keyed by `bookId`
(`selectLiveInstruct(bookId)`, `book-meta-slice.ts:167`). `bookId` is already read
at the `Manuscript` top level (`manuscript.tsx:120`); thread it down to the control
(or read `selectLiveInstruct(bookId)` in the control). Client-side `liveInstruct
&& character.ttsEngine === 'qwen'` is the audibility proxy — the exact
`is17b` model-key check is a server detail the resolver owns; the client only needs
"would this be audible," and `liveInstruct` on implies the 1.7B path.

## Data flow

```
author types → Save → dispatch setSentenceInstruct
  → Immer writes sent.instruct
  → persistence-middleware serialises sentences → manuscript-edits.json
  → synth: resolveInstructForGroup({instruct}, {is17b, liveInstruct})
       → is17b && liveInstruct ? instruct : (emotion phrase | none)
```

On Kokoro/XTTS, or with live-instruct off, the resolver returns `{}` — the value
is stored but silent. Consistent with fs-25 emotion-tag behaviour.

## Edge cases

- **Staleness — mark-if-it-would-change-audio (corrected).** An instruct edit on an
  already-rendered chapter MUST flag that audio stale *when the edit would actually
  change synth output* — i.e. when `liveInstruct && character.ttsEngine === 'qwen'`
  (the same audibility proxy as above). This mirrors the emotion control, which
  marks stale only when the change selects a different voice
  (`sentence-emotion-control.tsx:81`) and stays silent when the tag is inaudible.
  The earlier "never mark stale" stance was wrong: it would let an author edit a
  direction, see no "re-render needed" banner, and have the change silently never
  reach audio. When the edit is inaudible (live-instruct off / non-Qwen), we
  correctly do NOT flag stale — there is no audio impact. Reuse
  `useMarkCharacterStaleIfRendered` exactly as the emotion control does.
  - *Out of scope / surfaced:* fs-58's `setSentenceText` does NOT mark stale on a
    text edit, which is arguably the same gap for text (text is audible on every
    engine). That is pre-existing fs-58 behaviour, not fs-56's to fix here — flagged
    to the user as a separate follow-up.
- **Split / merge — fs-56 SOFT-DEPENDS on #1100 (corrected).** `splitSentence`
  spreads `{...original}` (`manuscript-slice.ts:411`), so a manual instruct ALREADY
  bleeds onto both fragments today — a pre-existing fs-57 issue that the in-flight
  **#1100** fixes by nulling `instruct`/`vocalization` on split/merge. fs-56 makes
  this more likely to bite (more instructs in play), so: **sequence #1100 to land
  first** (it's near-done WIP), and fs-56 ships a split/merge-×-manual-instruct
  regression test **regardless** of order, asserting a fragment does not inherit a
  stale direction. This build still stays off #1100's uncommitted hunks (separate
  worktree); the test is the guard that makes the dependency explicit rather than
  assumed.
- **Clear vs re-detect (accepted tradeoff).** Clearing deletes the field; a later
  "Detect emotions" run may refill it (fill-only) — and because the "Detect
  emotions" button runs the Stage-3 instruct pass on every click, a cleared
  direction CAN be re-suggested. This matches the shipped emotion-backfill
  precedent (`applyDetectedEmotions` is fill-only too) and is intended: clearing
  means "let the model decide again." Named as an explicit tradeoff. If it proves
  annoying in practice, a deferred follow-up adds a per-sentence "suppressed"
  tombstone (the `mergedAwayKeys` pattern) so re-detect skips an explicitly-cleared
  line — NOT built in v1 (YAGNI).

## Tradeoffs (v1, explicit)

- **One `instruct` field, no provenance marker.** Analyzer-generated and
  hand-written instructs share `sent.instruct` with no "who wrote this" flag. This
  is YAGNI-correct for v1 (a provenance field means a schema migration + UI
  complexity for no shipping requirement), but it has named costs: the UI can't
  label AI-suggested vs author-written, and a future "bulk-clear only AI instructs"
  feature would need a schema migration. Recorded here so the tradeoff is a
  decision, not an accident.

## Testing

- **Reducer unit** (`src/store/manuscript-slice.test.ts`): set, overwrite,
  clear-deletes-field, whitespace-clears, wrong-id no-op, scoped by chapter.
- **Fill-only protection**: after a manual `setSentenceInstruct`, `applyDetectedInstruct`
  must NOT overwrite it (locks in the "manual wins" claim).
- **Split / merge guard** (`manuscript-slice.test.ts`): a sentence with a hand-set
  instruct, when split (and when merged), must not leave a stale direction on a new
  fragment. (Passes once #1100's null-ing is in; the test makes the dependency
  explicit and fails loudly if fs-56 somehow ships first.)
- **Persistence**: assert `setSentenceInstruct` triggers a manuscript persist with
  the instruct on the serialised sentence (follow the `setSentenceEmotion`
  persistence test).
- **Staleness**: an instruct edit marks the chapter stale-if-rendered when
  `liveInstruct && qwen`, and does NOT when inaudible (live-instruct off / non-Qwen).
- **Component** (`src/components/sentence-instruct-control.test.tsx`): empty chip
  renders the minimal affordance with the correct `aria-label`; opening pre-fills
  the textarea with an existing (LLM-proposed) instruct; typing + Save dispatches
  the trimmed value; Clear dispatches `''`; Escape closes and returns focus;
  outside-click closes without dispatch; the inaudible chip style + caption show
  when live-instruct is off.
- **E2E** (`e2e/manuscript-instruct-edit.spec.ts`): the change crosses the
  redux↔manuscript-view seam, so one Playwright spec — open a line's instruct
  popover, edit a pre-filled direction, save, reload, assert it persisted and the
  chip shows the preview.

## Files touched

| File | Change |
|---|---|
| `src/store/manuscript-slice.ts` | new `setSentenceInstruct` reducer |
| `src/store/persistence-middleware.ts` | new persist entry |
| `src/components/sentence-instruct-control.tsx` | new component |
| `src/views/manuscript.tsx` | render the control (ungated) |
| `src/store/manuscript-slice.test.ts` | reducer + persistence tests |
| `src/components/sentence-instruct-control.test.tsx` | component test (new) |
| `e2e/manuscript-instruct-edit.spec.ts` | e2e spec (new) |
| `docs/features/NN-fs56-manual-instruct-editing.md` | regression plan (new, `needs-plan`) |

## Acceptance

1. An author can open any line (narrator included) and see the current `instruct` —
   including an LLM-proposed one — pre-filled, edit it, Save, and see the chip
   reflect it.
2. The value persists across reload (`manuscript-edits.json`).
3. A re-run of "Detect emotions" does not overwrite a hand-set instruct.
4. Clearing removes the field; a re-detect may refill it (named tradeoff).
5. On a Qwen 1.7B book with live-instruct on, the hand-set direction reaches synth
   (`resolveInstructForGroup` returns it); otherwise it is stored silently AND the
   chip/popover signal that it is currently inaudible.
6. Editing an instruct on an already-rendered chapter flags it stale-if-rendered
   when (and only when) the change would change audio (`liveInstruct && qwen`).
7. A split/merge does not leave a stale hand-set direction on a new fragment.
8. Paired tests above are green; `npm run verify` passes.
