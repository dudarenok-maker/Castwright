# Stage machine

> Status: stable
> Key files: `src/store/ui-slice.ts`, `src/lib/types.ts`
> URL surface: indirect — every URL maps to a `Stage` variant (see `01-hash-router.md`)
> OpenAPI ops: none

## What this covers

`ui.stage` is the discriminated union that drives the whole app. The shell renders one of five top-level views off `stage.kind`; transient overlays (mini-player, modals) live flat at the slice root because their lifecycle cuts across stages. Reducers are guarded — they refuse to fire from the wrong source state — so the union never enters an impossible variant.

## Invariants to preserve

- `Stage` union variants in `src/lib/types.ts:253-260` are exactly: `books`, `upload`, `analysing { bookId?, manuscriptId? }`, `confirm { bookId, openProfileId }`, `ready { bookId, view, currentChapterId, openProfileId }`, `voices`, `changelog`. Do not flatten `view`/`currentChapterId`/`openProfileId` out of their owning variants — `openProfileId` lives on both `confirm` and `ready` because the ProfileDrawer is reachable from "Meet the cast" cards too.
- Every stage-changing reducer in `src/store/ui-slice.ts:54-107` guards on `s.stage.kind` and returns early when the source state is wrong. Do not remove the guards — the router relies on them to ignore late hashchange events.
- `READY_DEFAULTS` in `ui-slice.ts:13` is `{ currentChapterId: 3, openProfileId: null }`. The hash router's default chapter mirrors this (see `01-hash-router.md`).
- Transient overlays (`currentTrack`, `matchDetailFor`, `handoffApp`, `regenChapter`, `regenCharacterCtx`, `batchRegenIds`, `showRevisionPlayer`, `showDriftReport`, `previewMode`) stay at the slice top — they do not move inside `stage` variants.
- `openBook` in `ui-slice.ts:78-88` is the only entry point that picks a `view` from a book's `status`: `analysing → analysing`, `cast_pending → confirm`, `complete → ready/listen`, `generating → ready/generate`, else `ready/cast`. Do not duplicate that mapping elsewhere.
- `AnalysingRoute` in `src/routes/index.tsx` derives the manuscriptId fed to `AnalysingView` as `stage.manuscriptId ?? manuscript.manuscriptId ?? activeBook.manuscriptId ?? null`. Stage takes precedence so a freshly-uploaded book skips a round-trip, but the fallbacks are load-bearing: `useHydrateStage` resets `stage.manuscriptId` to `null` on page refresh, deep link, or `confirm→reanalyse`, and the manuscript slice / library entry are what carry the id through those paths. Covered by `src/routes/index.test.tsx`.

## Acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`). Use the Redux DevTools panel to assert `ui.stage` after each step.

1. **Cold boot at `#/`** → `stage = { kind: 'books' }`.
2. **Click "New book"** → dispatches `startNewBook`; `stage = { kind: 'upload' }`; URL becomes `#/new`.
3. **Upload manuscript (paste a paragraph, Continue)** → dispatches `manuscriptUploaded { bookId, manuscriptId }`; `stage = { kind: 'analysing', bookId, manuscriptId }`.
4. **Wait for analysis to finish** → dispatches `analysisComplete { bookId }`; `stage = { kind: 'confirm', bookId, openProfileId: null }`.
5. **Click "Re-analyse"** from confirm view → dispatches `reanalyse`; `stage = { kind: 'analysing', bookId, manuscriptId }`. Note: from any non-`confirm` source the action is a no-op.
6. **Confirm cast** → dispatches `confirmCast`; `stage = { kind: 'ready', bookId, view: 'manuscript', currentChapterId: 3, openProfileId: null }`.
7. **Click "Voices" from a `ready` stage** → dispatches `openVoices`; `stage = { kind: 'voices' }`. **Click home** → `goHome` → `{ kind: 'books' }`.
8. **Open a `cast_pending` book from library** → dispatches `openBook { id, status: 'cast_pending' }`; `stage = { kind: 'confirm', bookId: id, openProfileId: null }`. Click a "Meet the cast" character card → drawer opens, URL becomes `#/books/<id>/confirm?profile=<charId>`. Repeat for each status and assert the mapping above.
9. **Guard check** — dispatch `confirmCast` while `stage.kind === 'books'`. Expected: no change. Assert `stage.kind` is still `'books'`.
10. **Refresh the page on `#/books/<id>/analysing`** → URL re-hydrate sets `stage.manuscriptId` to `null`, but the analysing screen still streams progress (no "No manuscript loaded" banner). The manuscript slice's `manuscriptId` (seeded by Layout's book-state hydration) is what feeds `api.analyseManuscript`. Regression for #16 May 2026.

## Out of scope

- Visual styling of each stage's shell.
- Modal stacking order (covered indirectly per-modal plan).
- Persistence of `selectedModel` / `ttsModelKey` across reloads (out — those are flat slice fields, covered by `13-tts-engine-picker.md`).
