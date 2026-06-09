---
status: active
shipped: null
owner: null
---

# Per-book bulk emotion-variant design + cast-table variant glyphs (fe-32)

> Status: active
> Key files: `src/components/variant-glyph-strip.tsx`, `src/components/design-scope-picker.tsx`, `src/lib/variant-tasks.ts`, `src/views/cast.tsx`, `src/store/cast-design-slice.ts`, `src/store/cast-design-stream-middleware.ts`, `src/lib/api.ts`, `server/src/routes/cast-design.ts`, `server/src/routes/qwen-voice.ts` (`persistEmotionVariant`)
> URL surface: `#/books/<id>/cast` (Design full cast button → scope picker; glyph strip on every Qwen row)
> OpenAPI ops: `POST /api/books/{id}/cast/design` (extended with `scope` + `variantTasks`); `variant_designed` SSE event (new)

## Benefit / Rationale

- **User:** one action on the Cast screen now designs every *needed-but-missing*
  emotion variant for the book's cast — a Qwen character whose tagged lines use
  `whisper`, `angry`, `excited`, or `sad` will render the right emotion instead of
  silently falling back to the base voice. The glyph strip (second line of the
  Status column) shows per-emotion designed/needed state at a glance, replacing the
  opaque "N tags need a variant" text hint.
- **Technical:** the bulk design job (`cast-design.ts`) is generalized from a
  list of character IDs to a typed *task list* (`{ characterId, emotion? }[]`)
  computed demand-driven on the frontend; `persistEmotionVariant` is extracted from
  the single-design route as a shared helper so both paths write the
  `qwen.variants[emotion]` slot identically.
- **Architectural:** demand-driven model — only emotions *actually tagged* on a
  character's sentences and not yet designed surface as work. A designed variant
  is just another voiceId derived from the series-unified base voiceId
  (`qwen-<voiceId>__<emotion>`), so — exactly like the base voice carried by
  `applyOverrideToCastFiles` — the variant slot **travels across every linked
  character in the series** (`srv-37`): `persistEmotionVariant` propagates through
  the shared `forEachMatchingCastCharacter` walk when a series scope is in play,
  standalones excluded. A per-book variant slot would break the linked-cast
  premise (the same character would render the emotion in one book and fall back
  to base in another).

## How it works

### Part A — Cast-table variant glyphs

`VariantGlyphStrip` (`src/components/variant-glyph-strip.tsx`) renders on the
second line of the cast row's Status column for every Qwen character. It receives
`usedEmotions` (the emotions the character's sentences actually tag, from
`usedEmotionsByCharacter`) and `designedEmotions` (the keys in
`overrideTtsVoices.qwen.variants`). One glyph per in-use emotion in fixed order
(`whisper`, `angry`, `excited`, `sad`):

- **designed** → green halo + SVG `IconCheck` badge
- **needed** → amber halo + SVG `IconAlertTri` badge
- Hover: native `title` tooltip names the emotion + state (e.g. "Angry — needs a variant")

Quiet states (no glyph strip):
- Non-Qwen or Qwen-with-no-base — nothing
- Qwen with no in-use emotion tags → "no emotion tags" hint
- All demanded variants designed → "✓ variants complete" (with SVG check)

This supersedes and **removes** the old `VariantsBadge` count badge and the "N tags
need a variant" text hint from the cast row — the glyphs convey the same information
with more precision and less clutter.

### Part B — Scope picker + bulk variant design

The existing "Design full cast" button **no longer fires immediately** — it opens
`DesignScopePicker` (`src/components/design-scope-picker.tsx`), a popover with
three rows:

| Scope | Work count | Action |
|---|---|---|
| **Base voices** | characters with lifecycle `Needs voice` | bases only (today's behaviour) |
| **Emotion variants** | Σ demanded-but-missing variants across Qwen cast | variants only |
| **Both** | bases + their needed variants | bases first, then variants |

A scope with zero work is disabled with a green "all done" chip. Selecting a scope
dispatches `castDesignActions.designAllRequested({ scope, characterIds, variantTasks })`.

**Work-list computation.** `buildVariantTasks` (`src/lib/variant-tasks.ts`) iterates
the cast: for each Qwen character that HAS a base voice, emits the in-use emotions
that lack a designed variant. `variantWorkCounts` gives the picker its count. The
list is computed at dispatch time and passed to the server as `variantTasks` in the
POST body — the server re-validates freshness (already-designed = skip, missing-base
= skip) to avoid clobbering concurrent work.

**Dependency rule.** Under `variants` scope, a character still missing its base
voice is silently skipped (the base must exist before a variant can be designed).
Under `both`, the character's base is designed first and its variant tasks follow.
`buildTaskList` in `cast-design.ts` enforces the base-before-variant ordering.

**Server execution.** `cast-design.ts` receives the unified task list. Each task
routes through `withDesignLock` + `gpuSemaphore` (unchanged). For a variant task
(`emotion` is set), it calls `designQwenVoiceForCharacter({ …, emotion })` — the
helper already designs under `<baseVoiceId>__<emotion>` — then calls
`persistEmotionVariant(bookDir, characterId, emotion, voiceId, seriesFilter)`.

**New SSE event.** `variant_designed { characterId, emotion, voiceId }` is broadcast
after each successful variant design. The frontend's `onVariantDesigned` callback
dispatches `castActions.setCharacterEmotionVariant({ characterId, emotion, voiceId })`
so the glyph strip flips live. Base designs continue to use the existing
`character_designed` event and `setQwenOverrideName`.

**Variant persistence helper.** `persistEmotionVariant(bookDir, characterId, emotion, variantVoiceId, seriesFilter?)`
is extracted from the single-design route and exported from `qwen-voice.ts`. It
merges the new variant slot while preserving the base `name` and any sibling
variants. When `seriesFilter` is supplied it propagates the slot to **every linked
character across the series** via the shared `forEachMatchingCastCharacter` walk in
`voices.ts` (the same walk `applyOverrideToCastFiles` uses), matching on the linked
identity `voiceId ?? id` and excluding standalones; without it the write stays
book-scoped (a standalone, or a caller with no series context). Both the single-design
route and the bulk job compute the series scope and pass it. No-op for an unknown
character. `applyOverrideToCastFiles` was also fixed to **preserve** an existing
slot's `variants` when (re)assigning the base `name`, so a base re-design or its
propagation can no longer wipe designed variants.

**Pill copy.** `job.total` counts bases + variant tasks; the Design pill reads
"Designing voices & variants… (k of N)".

## Concurrency hardening

All concurrency invariants from plan 195 are preserved and extended:

- The bulk job holds the per-book design lock (`withDesignLock`) throughout,
  making it mutually exclusive with single-design and re-analysis (unchanged).
- The scope picker only shows (and variant tasks are only dispatched for) characters
  whose demand is current at picker-open time; the server re-checks freshness per
  task, so concurrent work cannot produce duplicate designs.
- `persistEmotionVariant` uses the same `writeJsonAtomic` path as all other
  `cast.json` writers — no new races introduced.

## Demand-driven model

Variants are surfaced and designed only for emotions that characters' sentences
*actually use* — not all four for everyone. The primary signal is
`usedEmotionsByCharacter` (mapping `characterId → Set<emotion>` derived from the
loaded sentences). This means:

- A character with no emotion-tagged lines sees no glyph strip.
- A character with `angry`-only tagged lines sees one `angry` glyph, not four.
- A re-analysis that removes an emotion tag will eventually make the corresponding
  glyph disappear (the variant `.pt` is not deleted — it may still render on any
  remaining tagged lines elsewhere; a clean-up sweep is a deferred follow-up).

## Invariants to preserve

- `VariantGlyphStrip` renders **nothing** (or the quiet "no emotion tags" hint)
  for non-Qwen characters — variants are Qwen-only. Guard at `ttsEngine === 'qwen'`
  in `cast.tsx` before passing props.
- `buildVariantTasks` (and therefore the `variantTasks` sent to the server) includes
  ONLY Qwen characters that **have a base voice** (`overrideTtsVoices?.qwen?.name`
  truthy). A character without a base is excluded from the `variants` task list; it
  only appears under `both` as a base task (and only gets variant tasks once the base
  is in place).
- The server's `runDesignJob` checks freshness per task at execution time — a variant
  whose base was concurrently removed between picker-open and task execution is
  skipped (not failed). Skipped tasks increment `job.skipped`.
- `persistEmotionVariant` is a **no-op** for an unknown `characterId` — it does not
  create a character from scratch.
- Variant persistence **travels with the linked cast**: a variant designed for a
  `voiceId` propagates the `cast.json` slot to every linked character across the
  series (standalones excluded), mirroring base-voice propagation. A standalone (or
  a call with no series context) writes only its own `cast.json`. This is the core
  linked-cast invariant — the same character must never render an emotion in one
  book and fall back to base in a sibling.
- The existing `character_designed` SSE event and `setQwenOverrideName` reducer path
  are unchanged (base voice designs still use them).
- `showDesignFullCast` now also fires when `variantCount > 0` (not only on
  `needsVoiceIds.length > 0`), so the button appears for a fully-voiced cast that
  still has outstanding variant work.

## Test plan

### Automated coverage

**Server (Vitest + node, real-ffmpeg where noted):**
- `server/src/routes/qwen-voice.test.ts` — `persistEmotionVariant` unit: records the
  variant slot without clobbering the base name; preserves sibling variants when adding
  another; is a no-op for an unknown character (book-scoped, no series filter).
- `server/src/routes/variant-propagation.test.ts` — linked-cast propagation: a variant
  designed with a series scope travels to every linked character (same `voiceId`) across
  the series; does NOT touch a different series or a standalone; bootstraps the base name
  on a linked sibling lacking the slot; preserves sibling variants across the series; stays
  book-scoped with no filter. Also pins that `applyOverrideToCastFiles` preserves designed
  `variants` when (re)assigning the base name.
- `server/src/routes/cast-design.test.ts` — scope `variants` designs each task emotion
  and persists the slot; skips a variant whose base is missing; scope `both` designs base
  then its variants in order; `job.total` and progress counts include variant tasks;
  per-task failure isolates (loop continues); sidecar-wide failure fast-fails the job.

**API client (Vitest + jsdom):**
- `src/lib/api.test.ts` (or the cast-design API test file) — `startCastDesign` forwards
  `scope` + `variantTasks` in the POST body; `readCastDesignStream` maps a
  `variant_designed` event to `onVariantDesigned`; mock implementation emits
  `variant_designed` for each variant task.

**Redux (Vitest + jsdom):**
- `src/store/cast-design-slice.test.ts` — `DesignAllRequestedPayload` type accepts
  `scope` + `variantTasks`; existing reducer surface unchanged.
- `src/store/cast-design-stream-middleware.test.ts` — passes `scope` + `variantTasks`
  through to `api.startCastDesign`; `onVariantDesigned` mirrors the variant into the
  cast slice and bumps done; variants-only start (empty `characterIds`) proceeds.

**Frontend — work-list + scope picker (Vitest + RTL):**
- `src/lib/variant-tasks.test.ts` — `buildVariantTasks` emits only in-use emotions
  lacking a designed variant for chars with a base voice; excludes chars with no base;
  excludes chars with no in-use emotions. `variantWorkCounts` returns the total.
- `src/components/design-scope-picker.test.tsx` — shows live counts and a combined
  "both" total; disables an empty scope with "all done"; calls `onPick` with the chosen
  scope; all three rows disabled when total is zero.
- `src/views/cast.test.tsx` — clicking the button opens the picker; clicking a scope row
  dispatches `designAllRequested` with the correct payload (`scope`, `variantTasks`);
  existing base-only dispatch updated to go through the picker.

**Frontend — glyph strip (Vitest + RTL):**
- `src/components/variant-glyph-strip.test.tsx` — renders one glyph per in-use emotion
  with correct `data-state` (designed vs needed); shows "variants-complete" when every
  in-use emotion is designed; shows "no-tags" hint when no emotions used; tooltip names
  the emotion + state.

**E2E (Playwright, mock mode):**
- `e2e/cast-variant-design.spec.ts` — open cast view → click "Design full cast" → picker
  appears with Base / Emotion variants / Both rows → select "Emotion variants" → pill
  runs "Designing voices & variants…" → a row's glyph flips from needed (amber) to
  designed (green) → pill clears on completion.
- `e2e/design-full-cast.spec.ts` — updated for the picker: existing "bases" golden path
  now clicks through the scope picker (`scope-bases` row) before asserting the pill.

### Manual / live-GPU acceptance walkthrough

Requires a Qwen project with weights installed + a book with emotion-tagged sentences
(run `Detect emotions` first if needed).

1. **Open `#/books/<id>/cast`** — for a fully-voiced Qwen cast with no variants,
   each row with emotion-tagged lines shows amber `!` glyphs in the Status column
   second line.
2. **Click "Design full cast"** — the scope picker opens. Verify "Emotion variants" shows
   the correct count (matches the total amber glyphs across all rows); "Base voices" shows
   0 / "all done" (cast is fully voiced).
3. **Click "Emotion variants"** — picker closes; the Design pill appears in the top bar
   reading "Designing voices & variants… (0 of N)".
4. **Close the tab and re-open** — the pill resumes (reload-resilient job). Verify the pill
   count continues ticking from where it was.
5. **Watch a row** — as each variant completes, the corresponding amber `!` glyph flips to a
   green `✓` live. If all of a character's demanded variants are designed, the strip shows
   "✓ variants complete".
6. **After all variants complete** — pill clears; "Design full cast" button no longer
   appears (variantCount + needsVoiceIds both = 0).
7. **Audition a variant** — open a character's profile drawer → click the ▶ preview button
   on an emotion tag chip (plan 180, fe-31) to audition the newly designed variant.
8. **Re-open the scope picker** after design completes → all three rows disabled / "all done".
9. **VRAM headroom check** — verify the Design pill shows no "Stalled" indicator during a
   long run (VoiceDesign 1.7B is evicted by the idle watchdog after `QWEN_DESIGN_IDLE_TTL`
   seconds after completion; confirm no co-residency with a heavy base model).

## Out of scope

- **The series rebaseline modal** (plan 108 wave 5) — `fe-32`'s original "series-wide
  rebaseline modal for emotion variants" framing is parked. This plan delivers the
  per-book scope; the rebaseline modal remains base-only.
- **Capability-driven design** — designing all four variants for every character regardless
  of usage. Only demanded (in-use, missing) variants are surfaced and designed.
- **Non-Qwen variant design** — Kokoro and Coqui XTTS have no per-emotion variant model;
  glyph strips are Qwen-only.
- **Clean-up of unreferenced variant `.pt` files** — when a sentence's emotion tag is
  removed, the corresponding variant `.pt` is not deleted. A sweep utility is a deferred
  follow-up.

## References

- Spec: `docs/superpowers/specs/2026-06-09-cast-bulk-emotion-variants-design.md`
- Plan: `docs/superpowers/plans/2026-06-09-cast-bulk-emotion-variants.md`
- Plan 195 — Design full cast (bulk job, pill, slice): `docs/features/195-design-full-cast.md`
- Plan 177 (archived) — fs-25 per-quote emotion: `docs/features/archive/177-fs25-per-quote-emotion.md`
- Plan 180 — fe-31 emotion chip preview (variant audition in the drawer): `docs/features/180-fe31-emotion-chip-preview.md`
- Backlog: `fe-32` ([#512](https://github.com/dudarenok-maker/AudioBook-Generator/issues/512))

## Follow-ups

- **Live cross-tab glyph flip for sibling books** — variant slots now propagate to
  sibling books' `cast.json` immediately, but a sibling book's cast view open in
  another tab won't repaint until it re-reads state (reopen/refresh). The on-disk data
  is correct; only the live in-tab repaint of a *non-active* book lags. Low priority.
- **Responsive coverage case for the scope picker** — add a phone/tablet viewport case to
  `e2e/responsive/coverage.spec.ts` (the picker bottom-sheet placement on mobile).

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec. Once filled, the plan becomes eligible
for archive — move to `docs/features/archive/` in the same PR as the ship.)
