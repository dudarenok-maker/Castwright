# Mock toggle (`VITE_USE_MOCKS`)

> Status: stable
> Key files: `src/lib/api.ts` (`USE_MOCKS`, exported `api`), `.env.development`
> URL surface: none
> OpenAPI ops: indirect — toggles all of them

## What this covers

The whole frontend talks to one object: `api`. That object is built once at module init by selecting either the `mock` or `real` implementations based on `VITE_USE_MOCKS`. Components never import `mockXxx` or `realXxx` directly. This is what lets us iterate UI without a backend and swap implementations without touching component code.

## Invariants to preserve

- `USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true'` (`src/lib/api.ts:22`). Anything other than the string `'true'` (case-sensitive) falls through to real.
- `mock` and `real` objects MUST share identical keys (`src/lib/api.ts:597-639`). Adding a method requires adding both implementations.
- `api = USE_MOCKS ? mock : real` (`src/lib/api.ts:641`). Single export; no conditional imports elsewhere.
- Components, views, modals, and slice thunks import `{ api }` only. Importing `realXxx` or `mockXxx` directly is forbidden.
- `.env.development` sets `VITE_USE_MOCKS=true` so `npm run dev` defaults to mock mode. `.env.production` or missing env defaults to real.
- Documented mock divergences (assert these explicitly, do not "fix" them):
  - `mockGetBookState` throws "Book state hydration is not available in mock mode (no disk workspace)." (`api.ts:148-152`).
  - `mockGetChapterAudio` returns `url: null`; no real audio in mock mode (`api.ts:268-273`).
  - `mockGetVoiceSample` returns `url: ''`; mock cannot synthesise (`api.ts:276-281`).
  - `mockReparseBook` returns empty arrays (`api.ts:513-516`).
- Documented real-stub divergences:
  - `real.getChapterAudio` throws "Chapter audio not wired yet. Set VITE_USE_MOCKS=true." (`api.ts:612-614`).
  - `real.pollRevisions` returns `{ pending: [], drift: [] }` to keep the 30 s poll silent (`api.ts:615-619`).

## Acceptance walkthrough

1. **Cold boot with `.env.development` defaults** → `npm run dev` boots; `VITE_USE_MOCKS === true`; the app uses canned data; analysis flows, library, voices all populate from fixtures.
2. **Flip to real** → set `VITE_USE_MOCKS=false`, restart `npm run dev`. App boots; library scan hits `:8080`; analysing hits SSE; chapter playback errors out per the documented stub.
3. **Add a new api method** (e.g. `getStatistics`) — add to both `mock` and `real` objects; TypeScript should error if only one is added (because the inferred `Api` type forces parity).
4. **Grep test** — `grep -r 'mockUploadManuscript\|realUploadManuscript' src/` should return only `src/lib/api.ts` (the definitions). Same check for every other `mock*` / `real*` identifier.
5. **Permission to throw in mocks** — `mockGetBookState` throws by design. Components calling it must handle the exception and fall back to in-memory defaults; do not "silence" the throw to make mock mode boot cleanly.

## Out of scope

- A live toggle in the running UI — flag is read once at module init; restart is required to flip.
- Partial mock mode (some endpoints real, others mock) — all or nothing.
- Recording real responses into mock fixtures.
