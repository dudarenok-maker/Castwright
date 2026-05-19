---
status: stable
shipped: 2026-05-19
owner: null
---

# Voices global-tab same-book compare

> Status: stable
> Key files: `src/views/voices.tsx` (gating logic + on-demand fetch), `src/lib/api.ts` (`getBookState` consumer + `ns` mock seed), `e2e/voices-compare.spec.ts`
> URL surface: `#/voices`
> OpenAPI ops: `GET /api/books/{id}/state` (consumer only — no new endpoints)

## Benefit / Rationale

Closes the v1 scope cut from plan 22a (`docs/features/archive/22a-voice-library-compare.md`): on the global `#/voices` tab, the Compare button was disabled outright with the tooltip "Open a book to compare its voices" — even for pairs that would resolve cleanly with one fetch.

- **User:** the global `#/voices` tab can now compare any two voices that share the same `bookId`, regardless of whether that book is currently open. Today's friction (open book → navigate to Voices → compare) collapses to "select two voices anywhere in the global library, click Compare". Closes BACKLOG #16.
- **Technical:** the on-demand fetch lives in component-local state (`useState<Map<bookId, Character[]>>`) — no new redux slice, no persistent cache, no eviction policy to maintain. Plan 22a's `CompareCastModal` consumer is unchanged; only the cast resolution path was rerouted to consult the cache when the pair lives outside the open book.
- **Architectural:** unblocks BACKLOG #17 (cross-book compare) by introducing the foreign-cast hydrate machinery the cross-book case will reuse. The save-routing decision (does saving a foreign-book character write through to its source book's slice?) is deliberately scoped out of this plan and surfaced as part of #17.

## Architectural impact

- **New seams:**
  - `LibraryView` (`src/views/voices.tsx`) gains three local-state shards: `globalCastCache: Map<bookId, Character[]>` (resolved foreign casts), `globalCastFailed: Set<bookId>` (so a failed fetch disables the button retroactively without retrying on every render), and `globalCastFetching: bookId | null` (so a double-click on Compare can't fire two parallel requests).
  - `compareDerivations` now exposes `sharedBookId` so the modal-mount path can pick the right cast source (redux for the open book; cache otherwise).
  - `fetchAndOpenForeignCast(bookId, voicePair)` — async handler invoked by the Compare button click on the foreign-book path. Hits `api.getBookState(bookId)`, populates the cache on success, dispatches a `notificationsActions.pushToast` + records `bookId` in `globalCastFailed` on failure or empty-cast response.
- **Cast-save routing:** when the open pair belongs to the currently-open book, `onSaveSide` continues to dispatch `castActions.updateCharacter` (unchanged plan 22a path). For foreign-book pairs, `onSaveSide` becomes a no-op — the modal still tracks the in-flight draft so the user can audition tone changes, but no redux mutation persists. Persisting foreign-book edits is part of BACKLOG #17.
- **Mock-state surface:** `src/lib/api.ts` now seeds the Northern Star (`ns`) book in `MOCK_BOOK_STATES` with `cast: { characters: initialCharacters }` — needed so the e2e and any manual walkthrough under `VITE_USE_MOCKS=true` can resolve the global-tab fetch. The existing Solway Bay (`sb`) seed deliberately keeps `cast: null` so plan 22a's per-book disabled-button assertion still holds.
- **Invariants preserved:**
  - `CompareCastModal`'s props (`src/modals/compare-cast-modal.tsx:32-39`) are byte-identical — the modal is consumer-side only.
  - Plan 22a's selection pill, same-/different-base-voice badge, "Cross-book compare not supported yet" tooltip on cross-`bookId` pairs, and "Select exactly 2 voices" gate at 0/1/3+ all stay green.
  - Drag-to-reassign on `VoiceCard` is untouched.
- **Reversibility:** removing the `globalCast*` state + the `fetchAndOpenForeignCast` helper + the `castSource` branch in the modal mount path restores plan 22a exactly. The `ns` mock seed is independently useful (currently unconsumed elsewhere) but trivially removable.

## Cast resolution decision tree

After selection (exactly 2 voices), the `sharedBookId` derivation drives gating:

| Selection state                                | `sharedBookId`    | Cast source                        | Compare button             |
| ---------------------------------------------- | ----------------- | ---------------------------------- | -------------------------- |
| 0/1/3+ selected                                | n/a               | n/a                                | disabled — "Select exactly 2 voices" |
| 2 voices, different `bookId`s                  | null              | n/a                                | disabled — "Cross-book compare not supported yet" (BACKLOG #17) |
| 2 voices, shared `bookId === currentBookId`    | currentBookId     | `state.cast.characters` (redux)    | enabled iff both voices resolve to characters; disabled with "Selected voice is no longer linked to a character" otherwise |
| 2 voices, shared foreign `bookId`              | foreign bookId    | `globalCastCache.get(bookId)`      | enabled (cache miss → click triggers fetch); after fetch fails: disabled with "Could not load that book — try again later" |

## Invariants to preserve

- `Voice.bookId` is non-nullable per `openapi.yaml` `Voice` schema — `selectedVoices[0].bookId !== selectedVoices[1].bookId` is a safe cross-book check.
- `api.getBookState(bookId)` returns `BookStateResponse | null` and may resolve with `cast: null` for books the workspace hasn't analysed yet — both paths flow through the catch branch in `fetchAndOpenForeignCast` and surface the same "Could not load that book" toast.
- `globalCastCache` lives in the component's `useState`; navigating away from `#/voices` unmounts `LibraryView` and clears it. This is by design — the cache is per modal session, not per workspace. A workspace-level cache would require redux + invalidation policy + cross-tab sync (BACKLOG-grade work).
- `notificationsActions.pushToast` is the single error surface — no inline banner, no modal. `dedupeKey: 'voices-compare-fetch:${bookId}'` collapses repeated attempts on the same failing book.

## Test plan

### Automated coverage

- Vitest unit (`src/views/voices.test.tsx`, `LibraryView compare-two-voices affordance (plan 22a) > global-tab same-book fetch path (plan 60)` describe block):
  - **fetches foreign cast via api.getBookState and mounts the modal on Compare click** — asserts the happy path: `getBookState` called once with the correct bookId, dialog mounts after the fetch resolves.
  - **pushes a toast and retroactively disables Compare when the fetch fails** — asserts the error path: no dialog mounts, Compare re-asserts disabled with the documented tooltip.
  - **also disables Compare when the fetched book has no cast at all** — asserts the empty-cast guard (`res.cast === null` or `cast.characters === []` both route through the failure branch).
  - **caches the foreign cast so re-opens skip the second fetch** — asserts the cache-hit path: second Compare click does NOT increment `getBookState` call count.
  - **enables Compare on the global tab for a same-bookId pair (plan 60)** — replaces the plan-22a "disables Compare on the global tab" assertion that the global-tab gate-closed contract used to enforce.
- Playwright e2e (`e2e/voices-compare.spec.ts`):
  - **global #/voices tab fetches foreign cast and opens Compare modal (plan 60)** — Halloran + Eliza Gray (both `ns`) under mocks; click Compare → `getRole('dialog')` becomes visible.
  - **global #/voices tab still disables Compare on cross-book pairs (plan 60)** — Halloran (`ns`) + Narrator (`sb`); Compare stays disabled with the documented cross-book tooltip.

### Manual acceptance walkthrough

Run `VITE_USE_MOCKS=true`.

1. **Open `#/voices`** → global tab loads with the full library of mock voices spanning `ns`, `sb`, `cc`.
2. **Click the select checkbox on Captain Halloran (`ns`) and Eliza Gray (`ns`)** → pill renders with "different base voices" badge (Halloran → Charon, Eliza → Kore). Compare button enabled.
3. **Click Compare** → after ~60 ms (the mock's `wait`), `CompareCastModal` mounts with both characters as A/B sides.
4. **Close the modal, leaving both voices selected, click Compare again** → modal re-mounts instantly. No network round-trip in the dev-tools network tab.
5. **Select Captain Halloran (`ns`) and Narrator (`sb`)** → Compare disabled with tooltip "Cross-book compare not supported yet".
6. **Navigate to `#/` then back to `#/voices`** → the foreign-cast cache is gone (component remounted); the next Compare click re-fetches.

## Out of scope

- **Cross-book compare** — BACKLOG #17. Lifts the `selectedVoices[0].bookId !== selectedVoices[1].bookId` guard. Depends on this plan's fetch machinery; defers the save-routing decision (does a foreign-book Save write through to its source book's slice?).
- **Workspace-level cast cache** — the current cache lives in `useState`. Promoting it to a redux slice + cross-tab sync + invalidation policy is much bigger than this entry's scope and isn't blocking any in-flight work.
- **Pre-warming the cache on hover** — would mask the latency of the first click but adds complexity for a 60-ms saving under mocks (real backend latency is similar). Reconsiderable if users report click-then-wait friction.
- **Foreign-book Save persistence** — `onSaveSide` becomes a no-op on foreign-book pairs; the modal still tracks drafts so audition still works, but no redux mutation. Persisting is part of BACKLOG #17.

## Ship notes

- **Shipped:** 2026-05-19.
- **Commit SHA:** filled in at merge.
- **Drift corrections vs. the brief:** none — the brief's `api.getBookState(bookId)` is the exact name; the `response.cast.characters` shape matches what `BookStateResponse` exposes (`src/lib/types.ts:180`); the notifications slice is `src/store/notifications-slice.ts` with `notificationsActions.pushToast({kind:'error', message, dedupeKey})`.
- **Tests landed:**
  - `src/views/voices.test.tsx` — five new cases under the plan-60 describe block (happy path, fetch-fails path, empty-cast path, cache-on-second-open, global-tab-enabled-pair); one plan-22a test rewritten from "disables Compare on global tab" to "enables Compare on global tab for same-bookId pair".
  - `e2e/voices-compare.spec.ts` — two new specs replace the old "global tab disables Compare" spec: happy-path (fetch + modal mounts) and cross-book negative case.
  - `src/lib/api.ts` — `buildNorthernStarMockState()` + `seedDefaultMockBookStates()` add `ns` to `MOCK_BOOK_STATES` with `cast: { characters: initialCharacters }`. The existing `sb` seed deliberately keeps `cast: null` so plan 22a's per-book disabled assertion holds.
