# Hash router

> Status: stable
> Key files: `src/lib/router.ts`, `src/store/index.ts` (RouterStore adapter)
> URL surface: `#/`, `#/new`, `#/voices`, `#/log`, `#/books/:bookId/analysing`, `#/books/:bookId/confirm`, `#/books/:bookId/:view?chapter=&profile=`
> OpenAPI ops: none

## What this covers

Two-way binding between the URL hash and `ui.stage`. `parseHash` turns a URL into a `Stage`; `stageToHash` turns a `Stage` back into a URL; `installRouter` keeps them in sync via `hashchange` events and a store subscription. The router stays decoupled from the store by accepting a `RouterStore` adapter so the action shape stays internal to the slice.

## Invariants to preserve

- `VALID_VIEWS` in `src/lib/router.ts:14` is exactly `['manuscript', 'cast', 'library', 'generate', 'listen', 'log']`. Adding a view requires updating both this list and `View` in `src/lib/types.ts:251`.
- Default `currentChapterId` on `ready` parse is `3` (`router.ts:35`) — must match `READY_DEFAULTS` in `ui-slice.ts:13`.
- `stageToHash` omits the `chapter` query param when `currentChapterId === 3` (`router.ts:53`) and omits `profile` when `openProfileId` is null. URL stays clean for the default state.
- `installRouter` uses `history.replaceState` not `pushState` (`router.ts:88,96`). Pushing would break the back button; do not change.
- `stageEqual` (`router.ts:62-72`) is the gate that prevents infinite hashchange loops. Do not bypass.
- Unknown URL segments parse to safe defaults: `#/books/X/garbage` → `{ kind: 'ready', view: 'cast', ... }` (action falls back to `'cast'` at `router.ts:32`); fully unknown path → `{ kind: 'books' }` (`router.ts:39`).

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=true`. Open the app, then in DevTools console call `parseHash('#/...')` and `stageToHash({...})` to verify round-trips, OR drive via real URL changes.

1. **Cold boot at `/` (no hash)** — `installRouter` calls `replaceState` to `#/`. URL bar shows `#/`.
2. **Hand-edit URL to `#/new`** → `stage = { kind: 'upload' }`. Edit to `#/voices` → `{ kind: 'voices' }`. Edit to `#/log` → `{ kind: 'changelog' }`.
3. **Edit URL to `#/books/abc/analysing`** → `stage = { kind: 'analysing', bookId: 'abc' }` (manuscriptId is `null`/`undefined`). Edit to `#/books/abc/confirm` → `{ kind: 'confirm', bookId: 'abc' }`.
4. **Edit URL to `#/books/abc/manuscript?chapter=5&profile=p1`** → `stage = { kind: 'ready', bookId: 'abc', view: 'manuscript', currentChapterId: 5, openProfileId: 'p1' }`.
5. **Edit URL to `#/books/abc/garbage`** → `stage = { kind: 'ready', bookId: 'abc', view: 'cast', currentChapterId: 3, openProfileId: null }` (fallback view).
6. **Dispatch `setCurrentChapterId(7)` via DevTools while in ready stage** → URL becomes `#/books/abc/manuscript?chapter=7`.
7. **Dispatch `setCurrentChapterId(3)` (back to default)** → URL drops the `chapter` param: `#/books/abc/manuscript`.
8. **Dispatch `setOpenProfileId('p1')`** → URL adds `?profile=p1`. Dispatch `setOpenProfileId(null)` → URL drops it.
9. **Round-trip every `Stage` variant** — call `parseHash(stageToHash(s))` for each: `{kind:'books'}`, `{kind:'upload'}`, `{kind:'analysing',bookId:'abc'}` (note `manuscriptId` is dropped — that's a documented narrowing), `{kind:'confirm',bookId:'abc'}`, full `ready`, `{kind:'voices'}`, `{kind:'changelog'}`. Each result `stageEqual` to the input (or, for `analysing`, equal under the union narrowing).
10. **Browser back/forward after several `replaceState` calls** — back/forward still navigates between the user's earlier `pushState`-equivalent entries (i.e. nothing is pushed, the history reflects only what the user navigated to).

## Out of scope

- `pushState` vs `replaceState` policy beyond confirming `replaceState` is used.
- Deep linking with auth/session — there's no auth in v1.
- URL encoding of bookIds containing slashes (bookIds are slug-form `author__series__title`; no slashes inside).
