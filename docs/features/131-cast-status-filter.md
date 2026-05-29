---
status: active
shipped: null
owner: null
---

# 131 — Cast status filter

> Status: active
> Key files: `src/views/cast.tsx`, `src/lib/voice-status.ts`
> URL surface: `#/books/<id>/cast` (filter is view-local UI state, not in the hash)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** as a cast grows, characters still on a default voice (e.g. an
  auto-assigned Kokoro preset, or a Qwen character with no designed voice) are
  easy to lose in a long table. A row of toggle chips under the search box
  isolates cast members by voice-matching status — tap **Needs voice** to see
  exactly who still has to be fixed, **Generated** to see what's done, etc. —
  so nothing slips through.
- **Technical:** reuses the existing `resolveVoiceStatus` resolver, so the
  chips and the per-row Status pills can never disagree (one source of truth
  for status labels). No new state shape, no Redux — local `useState`.
- **Architectural:** wires up the previously dead placeholder Filter button
  affordance with the project's existing chip/tab pattern (mirrors the
  voices-view tabs), keeping the cast view's controls consistent.

## Architectural impact

- **New seam:** `statusFilterKeys(c, voice, effectiveEngine)` exported from
  `src/lib/voice-status.ts` — returns the set of filter keys a character
  matches (its lifecycle label or `'Unset'`, plus `'Reused'` when reused). It
  wraps `resolveVoiceStatus` so the filter logic shares the row pills' exact
  resolution (engine-aware: a Qwen project's undesigned character keys as
  `Needs voice`, not `Matched`).
- **Invariants preserved:**
  - The filter operates on the post-search copy inside `CastView`, never the
    store/prop order — same discipline as the `compareCastRows` sort (plan 121,
    `cast.tsx`). Both the desktop grid and the mobile card list iterate the same
    `filtered` array, so the filter applies to both surfaces with no duplicate
    wiring.
  - No `ui.stage` / router change — the active filter is ephemeral view state
    and intentionally does not persist in the hash.
- **Migration story:** none — no persisted data shape changes.
- **Reversibility:** delete the chip row + `statusFilters` state in `cast.tsx`
  and the `statusFilterKeys` export; nothing else depends on them. (The old
  non-functional Filter button was removed and is not needed to revert.)

## Invariants to preserve

- `statusFilterKeys` (`src/lib/voice-status.ts`) must keep delegating to
  `resolveVoiceStatus` — if it ever derives status independently, the chip
  counts will drift from the row pills.
- `CHIP_ORDER` (`src/views/cast.tsx`) lists every lifecycle label
  (`Needs voice`, `Designed`, `Sampled`, `Generated`, `Matched`, `Tuned`,
  `Locked`), then `Unset`, then `Reused`. A new lifecycle label added to
  `resolveLifecyclePill` must be appended here or its chip won't render.
- Filter semantics are **OR** across selected keys; empty selection = show all.
- Chips touch targets: `min-h-[44px] sm:min-h-0` (WCAG 2.5.5 on phone).

## Test plan

### Automated coverage

- Vitest unit (`src/lib/voice-status.test.ts`) — `statusFilterKeys` keys an
  undesigned Qwen character `Needs voice`, a generated Qwen voice `Generated`,
  a preset matched character `Matched`, a stateless row `Unset`, and appends
  `Reused` when `matchedFrom` is set.
- Vitest component (`src/views/cast.test.tsx`, `describe('CastView status
  filter')`) — chips render one-per-present-status with live counts;
  single-chip filters to that status; multi-chip unions (OR); the Reused chip
  isolates carried-over voices; Clear resets to all rows and disappears.

No e2e added: the filter is local `useState` with no router/redux/layout seam,
so the component test is the primary gate. A short Playwright spec asserting a
chip click narrows the visible row count is a cheap future add if the surface
grows.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`), open a book's Cast view.

1. **Cast view loads** → chip row appears under the search box showing only the
   statuses present in this cast, each with a count matching the visible rows.
2. **Tap "Needs voice"** → only undesigned/default rows remain; the chip's
   count equals the visible row count. Chip shows active (filled) styling.
3. **Also tap "Generated"** (or another chip) → the visible set unions (OR).
4. **Tap "Clear"** → all rows return; Clear disappears.
5. **Tap "Reused"** → only characters carried over from a prior book remain.
6. **Phone viewport (<640px)** → chips stay ≥44px tall and tappable; the mobile
   card list filters identically to the desktop table.

## Out of scope

- Persisting the active filter in the URL hash or across reloads.
- Filtering by anything other than voice-matching status (engine, role, line
  count) — the search box already covers names.

## Ship notes

(Filled in when status flips to `stable`.)
