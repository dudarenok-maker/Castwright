---
status: draft
shipped: null
owner: null
---

# Voice library compare

> Status: draft
> Key files: `src/views/voices.tsx`, `src/components/voice-library-panel.tsx`, `src/modals/compare-cast-modal.tsx`, `src/lib/voice-character-link.ts`, `src/views/cast.tsx` (selection-pill pattern)
> URL surface: `#/voices`, `#/books/<bookId>/library`
> OpenAPI ops: none (UI-only — modal reuses existing surface)

## What this covers

Adds a two-cast-member compare affordance to the Voices tab, reusing the existing `CompareCastModal`. Users multi-select any two `VoiceCard`s; a floating "Selected · N [Compare]" pill — patterned after the Cast tab's selection pill at `src/views/cast.tsx:284-310` — surfaces and opens the modal pre-populated with the two underlying characters. The pill carries a "same base voice ✓" / "different base voices" badge so the family-grouped Voices tab privileges the core tuning use case ("why do these two characters routed to the same Coqui speaker sound subtly different?") without restricting cross-family selection.

The compare-cast logic itself is unchanged — only the entry point is new. Selection state and the pill mirror the Cast tab so users meet one UX vocabulary across both surfaces.

## Benefit / Rationale

- **User:** the highest-signal compare today (same base voice, two characters with different attributes) requires bouncing Voices → Cast → checkbox-select → Compare. Putting the entry point next to the family grouping collapses that into a single tab.
- **Technical:** zero modal changes. `CompareCastModal` accepts `[Character, Character]` already (`src/modals/compare-cast-modal.tsx:32-39`); we only need to resolve `Voice → Character` and mount it from a new spot.
- **Architectural:** `VoiceCard` gains optional `selected` / `onToggleSelect` props; consumers that omit them keep the drag-only legacy behavior. No new redux state — selection is ephemeral, matching the Cast tab's local-`useState` pattern at `cast.tsx:41`.

## Architectural impact

- **New seams:**
  - `VoiceCard` (`src/components/voice-library-panel.tsx`) gains `selected?: boolean` + `onToggleSelect?: (voice: Voice) => void`. When both are passed, the card renders a 5×5 rounded-md checkbox top-left (same DOM as `cast.tsx:196-199`). When unset, the card stays drag-only.
  - `LibraryView` in `src/views/voices.tsx` adds `selectedVoiceIds: string[]` local state and a `compareIds: [string, string] | null` modal trigger, mirroring `cast.tsx:41-42`.
  - Floating bottom-center pill renders when `selectedVoiceIds.length > 0`, positioned identically to `cast.tsx:284-310`.
- **Invariants preserved:**
  - Plan 22's family grouping, sort order, and tab filtering are untouched — the selection layer sits on top of `buildFamilies` (`voices.tsx:247`).
  - `CompareCastModal`'s signature is unchanged; entry point translates `Voice[]` → `Character[]` before mounting.
  - Drag-to-reassign (`draggingVoiceId` at `voices.tsx:69`) keeps working; the new checkbox hit zone is `e.stopPropagation()`-isolated from the card body click (open profile) and drag handle.
- **Reversibility:** removing the checkbox props + pill restores plan 22 exactly. Modal untouched, slice untouched.

## Resolving Voice → Character

`CompareCastModal` requires two `Character` records. The Voices view holds `Voice[]`. Resolution rules:

- **Per-book tab (`#/books/<bookId>/library`):** both voices belong to the open book → read from `state.cast.characters`. Reuse the existing link helper at `src/lib/voice-character-link.ts` inverted (`findCharacterForVoice(voice, characters)` matches by `voice.id === character.voiceId`).
- **Global tab (`#/voices`):** when both selected voices share a `bookId`, fetch that book's cast on demand via `api.getCast(bookId)` (already used by Layout hydration); cache for the modal session. When they belong to different `bookId`s, the Compare button stays disabled with tooltip "Cross-book compare not yet supported — see backlog". This is the v1 cut; full cross-book compare is in **Out of scope** with a follow-up backlog item.
- When the linked character is missing (deleted / manuscript-edited away), Compare stays disabled with tooltip "Selected voice is no longer linked to a character".

## Same-base-voice badge

When `selectedVoiceIds.length === 2`, resolve each voice's `(engine, ttsVoice.name)` pair:

- Identical → pill shows a green "same base voice ✓" chip beside Compare.
- Different → pill shows an amber "different base voices" chip with tooltip "Comparing across families is allowed; same-voice characters are the core tuning case".

This is the soft variant of exploration option (3) — visually privileges the family case without restricting selection.

## Invariants to preserve

- `VoiceCard` drag affordance (`draggingVoiceId` flow at `src/views/voices.tsx:69` + `src/components/voice-library-panel.tsx`) keeps working alongside selection.
- `CompareCastModal` props at `src/modals/compare-cast-modal.tsx:32-39` are byte-identical (unchanged signature).
- Selection state stays component-local; no slice additions.
- Per-card `e.stopPropagation()` on the checkbox prevents the card-body click (which opens the profile drawer per plan 22 acceptance step 7) from firing on a select toggle.
- Cast tab selection pill at `src/views/cast.tsx:284-310` remains the pattern source-of-truth — the Voices pill mirrors its DOM so future style edits transfer cleanly.

## Test plan

### Automated coverage

- Vitest unit (`src/components/voice-library-panel.test.tsx`):
  - Checkbox affordance renders only when both `selected` and `onToggleSelect` are passed; legacy drag-only path stays intact when unset.
  - Clicking the checkbox calls `onToggleSelect(voice)` and does NOT call `onSelect` (the profile-open handler).
- Vitest unit (`src/views/voices.test.tsx`):
  - Selecting two cards in the same family shows the pill with "same base voice ✓".
  - Selecting one card from family A and one from family B shows "different base voices".
  - Compare button is disabled at 0, 1, or 3+ selected; enabled at exactly 2 (within-book pair).
  - Cross-book pair (different `bookId`s) in the global view disables Compare with the documented tooltip.
- Vitest integration (`src/views/voices.test.tsx`):
  - Per-book tab passes the resolved characters into `CompareCastModal`; asserted via `screen.getByRole('dialog')`'s `aria-label`.
- Playwright e2e (`e2e/voices-compare.spec.ts`): open a mock book's Voices tab → click two card checkboxes (same family) → assert pill shows the green badge → click Compare → assert dialog with both names → click Done → dialog closes, pill remains with the 2 still selected.

### Manual acceptance walkthrough

Run `VITE_USE_MOCKS=true`.

1. **Open `#/books/<id>/library`** → no checkboxes visible by default; existing drag-to-reassign behavior preserved.
2. **Click the checkbox on one `VoiceCard`** → card gains a peach tint (mirroring `cast.tsx:195`); floating pill appears bottom-center "Selected · 1 [Compare]"; Compare disabled.
3. **Click the checkbox on a second card in the same family** → pill updates to "Selected · 2 [same base voice ✓] [Compare]"; Compare enabled.
4. **Click Compare** → `CompareCastModal` opens with both characters; tune one side; click Save → cast slice updates; close → pill remains with the 2 still selected; click Clear → selection clears.
5. **Select one card in family A + one in family B** → pill shows "different base voices" amber badge; Compare still enabled (no restriction).
6. **In `#/voices` (global view)** select two voices from different books → Compare disabled with cross-book tooltip.
7. **Open Cast tab on the same book** → existing Cast-side selection + Compare flow continues to work identically (no regression).

## Out of scope

- **Cross-book compare** — requires caching cast data from non-current books. Tracked as a follow-up backlog Could-item once this v1 ships.
- **Drag-to-compare gesture** (option 2 from the exploration) — overloads the existing drag-to-reassign semantics; deferred.
- **Per-family-scoped picker** (pure option 3) — superseded by the universal pill + badge; reconsiderable only if the badge proves insufficient signal.
- **N-way compare (>2 voices)** — `CompareCastModal` is built for two sides; an N-way layout is a separate UX problem.

## Ship notes

(Filled in when status flips to `stable`.)
