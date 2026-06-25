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
- **Popover:** a `role="menu"`-style surface containing a `<textarea>` pre-filled
  with the current `instruct`, plus **Save** and **Clear**. Save dispatches
  `setSentenceInstruct(text)`; Clear dispatches it with `''` (delete). Escape /
  outside-click closes without saving.
- **Audibility hint:** the field is inaudible unless the book uses Qwen 1.7B with
  live-instruct on. Show a small caption in the popover when those conditions are
  not met — "Audible only on Qwen 1.7B with Live expressive delivery on" — so the
  author isn't surprised the direction had no effect. (Read the per-book
  `liveInstruct` flag + the resolved engine the same way the emotion control reads
  `character.ttsEngine`.) No hard gating: the tag is additive data and survives an
  engine switch, exactly like the emotion tag.

### 4. Placement (`src/views/manuscript.tsx`)

Render `SentenceInstructControl` immediately after `SentenceEmotionControl`
(`manuscript.tsx:1483`), but **ungated** — shown for every sentence, narrator
included (the approved scope). The emotion control keeps its existing
dialogue-or-tagged gate; only the instruct control is universal.

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

- **Clear vs re-detect:** clearing deletes the field; a later "Detect emotions"
  run may refill it (fill-only). This is intended — clearing means "let the model
  decide again," matching emotion semantics.
- **Split / merge:** the in-flight fs-57 follow-up **#1100** nulls
  `instruct`/`vocalization` on `splitSentence` / `mergeSentences` so an edited
  direction never bleeds onto a new fragment. fs-56 depends on nothing from #1100
  but composes correctly with it; this build stays off that file's uncommitted
  hunks (separate worktree).
- **Staleness banner:** an instruct edit changes audio only when it would actually
  reach the synth (Qwen 1.7B + live-instruct on). v1 does **not** raise a
  character-stale banner for instruct edits — unlike emotion variants, there is no
  per-emotion variant voice to invalidate, and a false "needs re-render" on a
  silent edit is worse than none. (Revisit if live-instruct becomes the default
  render path.)

## Testing

- **Reducer unit** (`src/store/manuscript-slice.test.ts`): set, overwrite,
  clear-deletes-field, whitespace-clears, wrong-id no-op, scoped by chapter.
- **Persistence**: assert `setSentenceInstruct` triggers a manuscript persist with
  the instruct on the serialised sentence (follow the `setSentenceEmotion`
  persistence test).
- **Component** (`src/components/sentence-instruct-control.test.tsx`): empty chip
  renders the faint icon; typing + Save dispatches with the trimmed value; Clear
  dispatches `''`; outside-click closes without dispatch; the audibility caption
  shows when live-instruct is off.
- **E2E** (`e2e/manuscript-instruct-edit.spec.ts`): the change crosses the
  redux↔manuscript-view seam, so one Playwright spec — open a line's instruct
  popover, type, save, reload, assert it persisted and the chip shows the preview.

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

1. An author can open any line (narrator included), type a free-text direction,
   Save, and see the chip reflect it.
2. The value persists across reload (`manuscript-edits.json`).
3. A re-run of "Detect emotions" does not overwrite a hand-set instruct.
4. Clearing removes the field; a re-detect may refill it.
5. On a Qwen 1.7B book with live-instruct on, the hand-set direction reaches synth
   (`resolveInstructForGroup` returns it); otherwise it is stored silently.
6. Paired tests above are green; `npm run verify` passes.
