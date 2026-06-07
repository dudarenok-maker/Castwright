# Variant-design filters — design spec

**Date:** 2026-06-08
**Status:** draft
**Issue:** fe-34 ([#595](https://github.com/dudarenok-maker/AudioBook-Generator/issues/595)) + a newly-found `bug` (the dead "Has variants" cast chip — issue to be filed)
**Scope:** `frontend` (`src/views/cast.tsx`, `src/views/voices.tsx`, `src/lib/voice-status.ts`)

## Problem

A cast member can have a designed Qwen voice yet still be missing **emotion
variants** — the per-quote expressive renders (e.g. `angry`, `whisper`) for the
emotions its quotes actually use. Today you can *see* this per row (the amber
**"N tags need a variant"** badge, `cast.tsx:1289`, driven by
`countMissingVariants` in `voice-status.ts`), but you **cannot filter the cast
down to just those members**. In the user's primary workflow (book → cast → fix
design → generate), finding "who still needs variants designed" means eyeballing
every row.

Two adjacent facts sharpen the scope:

1. **The other lifecycle states already filter fine** (`Needs voice`,
   `Designed`, `Generated`, …) via the cast view's status-filter chips. Variants
   are the one missing slice.
2. **The fs-25 "Has emotion variants" chip is dead code.** `CHIP_ORDER`
   (`cast.tsx:105`) lists `Variants` and `statusFilterKeys` (`voice-status.ts:161`)
   emits it, but the `statusBuckets` tally (`cast.tsx:279-302`) — which decides
   *which* chips render via `CHIP_ORDER.filter((key) => tally.has(key))` — never
   counts `Variants`. So the chip can never appear. This is why the user has
   never seen it.

fe-34's literal ask is a "Has emotion variants" filter on the cross-book
**Voices view** (`#/voices`). That view is the secondary pathway; the primary
win is the cast view. This spec does both (the user chose the "mirror into both"
option) and fixes the dead chip along the way.

## Goal / Definition of done

- Cast view exposes a working **"Has variants"** chip and a new **"Needs
  variants"** chip; both render only when ≥1 character matches, carry a live
  count, and filter the rows (desktop table + mobile cards).
- Voices view exposes an **All / Has variants / Needs variants** toggle over the
  Qwen "Designed voices" section.
- The dead fs-25 chip is resurrected (tally fix) rather than left unreachable.
- Paired automated tests at every touched seam; one Playwright spec for the cast
  "Needs variants" filter.
- fe-34 (#595) closed; the dead-chip `bug` issue filed and closed in the same PR.

Non-goals: changing how variants are *designed* or *rendered*; any backend
change; eager pre-fetching of every foreign book's sentences.

## Design

### 1. `src/lib/voice-status.ts` — single source of truth for chip keys

Extend the existing emitter so the chips and the rows can never diverge:

```ts
export function statusFilterKeys(
  c: Character,
  voice: Voice | undefined,
  effectiveEngine: TtsEngine,
  usedEmotions?: Set<string>, // NEW — the character's in-use emotions
): string[] {
  const { lifecycle, reused, hasEmotionVariants } =
    resolveVoiceStatus(c, voice, effectiveEngine);
  const keys = [lifecycle?.label ?? 'Unset'];
  if (reused) keys.push('Reused');
  if (hasEmotionVariants) keys.push('Variants');
  // NEW: Qwen-effective + at least one in-use emotion lacks a designed variant.
  const isQwen = effectiveEngine === 'qwen' || voice?.ttsVoice?.provider === 'qwen';
  if (isQwen && countMissingVariants(c, usedEmotions) > 0) keys.push('Needs variants');
  return keys;
}
```

`usedEmotions` is optional so the pre-existing two-arg/three-arg callers keep
compiling; without it `countMissingVariants` returns 0 (no `Needs variants`
key). `countMissingVariants` already exists and is engine-agnostic — the Qwen
gate lives here (a missing variant only changes audio under Qwen).

### 2. `src/views/cast.tsx` — wire the data + fix the tally + label the chips

- **Thread `usedEmotions`** (already computed once at `cast.tsx:133` via
  `usedEmotionsByCharacter(sentences)`) into:
  - `statusKeysFor(c)` (the `filtered` predicate, `cast.tsx:234`/`312`) →
    `statusFilterKeys(c, voice, engine, usedEmotions.get(c.id))`.
  - the `statusBuckets` tally memo (`cast.tsx:279-302`).
- **Tally fix.** In `statusBuckets`, after the lifecycle + `Reused` tallies, add
  per-character:
  - `Variants` when `resolveVoiceStatus(...).hasEmotionVariants` (color
    `library`).
  - `Needs variants` when Qwen-effective and
    `countMissingVariants(c, usedEmotions.get(c.id)) > 0` (color `warning`,
    matching the row badge). Add `usedEmotions` to the memo deps.
- **`CHIP_ORDER`** gains `Needs variants` after `Variants`.
- **Chip labels.** The chip currently renders the raw key (`cast.tsx:649`,
  `<span>{b.key}</span>`). Add a small label map so the display reads nicely
  while the key stays stable (the key flows through `statusFilters` / filtering):

  ```ts
  const CHIP_LABELS: Record<string, string> = {
    Variants: 'Has variants',
    'Needs variants': 'Needs variants',
  };
  // render: CHIP_LABELS[b.key] ?? b.key
  ```

No change to row rendering — the per-row "N tags need a variant" badge stays.

### 3. `src/views/voices.tsx` — mirror both filters (fe-34)

- **Cache sentences on hydrate.** `hydrateForeignCast` already calls
  `api.getBookState(bookId)`; its response carries `manuscriptEdits.sentences`
  (confirmed in `BookStateResponse`, `api-types.ts:3556`). Today only
  `res.cast.characters` is kept. Add a parallel cache (e.g.
  `sentencesByBookId: Map<string, Sentence[]>`) populated from
  `res.manuscriptEdits?.sentences ?? []` at the same write site. The open book
  reads sentences from the redux manuscript slice.
- **`missingVariantCountByVoiceId`** — a new memo beside the existing
  `variantCountByVoiceId` (`voices.tsx:232`). For each Qwen voice resolve its
  character (redux for the open book, `globalCastCache` otherwise), resolve its
  book's sentences (redux / `sentencesByBookId`), then
  `countMissingVariants(ch, usedEmotionsByCharacter(sentences).get(ch.id))`.
- **Filter control.** A minimal segmented toggle — **All / Has variants / Needs
  variants** — rendered above the Qwen sections (variants only matter for
  *designed* voices, so the toggle scopes the "Designed voices" section; the
  "Needs a voice" bucket and preset families are unaffected). Default `All`.
  Predicate uses the two maps.
- **Known limitation (accepted).** A foreign book whose state hasn't hydrated
  yet contributes 0 to both maps, so its voices read as "no variants / no needs"
  until loaded — identical to the existing lazy duplicate-detector behaviour. No
  eager fetch. Surface a one-line hint near the toggle ("counts fill in as books
  load") so the partial state isn't mistaken for completeness.

### Data flow

```
sentences ──usedEmotionsByCharacter──▶ Set<emotion> per characterId
                                          │
character.overrideTtsVoices.qwen.variants │ (designed)
                                          ▼
                              countMissingVariants ▶ N
        ┌───────────────────────────────┴───────────────────────────────┐
   cast.tsx                                                          voices.tsx
   statusFilterKeys → "Needs variants" key                          missingVariantCountByVoiceId
   statusBuckets    → chip + count                                  toggle predicate
```

## Testing

- **`src/lib/voice-status.test.ts`** — `statusFilterKeys` emits `Needs variants`
  for a Qwen character with an in-use emotion lacking a variant; omits it when
  all in-use emotions have variants, when `usedEmotions` is undefined, and for a
  non-Qwen character; still emits `Variants` for has-variants.
- **`src/views/cast.test.tsx`** — with a fixture cast + sentences: the
  resurrected **Has variants** chip renders with the right count; the **Needs
  variants** chip renders, counts correctly, and toggling it filters rows
  (assert via the chip/row count parity the suite already checks,
  `cast.test.tsx:1014`).
- **`src/views/voices.test.tsx`** — the toggle narrows the Designed-voices
  section to has / needs correctly off the cached sentences.
- **`e2e/`** — one Playwright spec: load a mock book whose cast has a
  needs-variants character, click **Needs variants**, assert only the matching
  row(s) remain. (UI-visible, crosses redux/layout — meets the CLAUDE.md e2e
  bar.) Add a mock fixture sentence with a non-neutral emotion if none exists.

## Issue hygiene

- PR body: `Closes #595` (fe-34).
- File a `bug`-labelled issue for the unreachable "Has variants" chip
  (fs-25 tally omission) and `Closes #<that>` in the same PR.
- fe-34 is a small/localized item — no new `docs/features/` regression plan; this
  spec + the paired tests are the record. Remove the fe-34 row from
  `docs/BACKLOG.md` on merge.
