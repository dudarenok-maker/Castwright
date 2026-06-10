# Multi-source cover search — design

**Date:** 2026-06-10
**Status:** approved (brainstorming)
**Scope:** `server` (cover sources + aggregation), `frontend` (picker badges + copy)

## Problem

The Cover Image picker and the auto-fetch-on-import both depend on a single
source, OpenLibrary, queried with **strict structured params**
(`title=<…>&author=<…>`). When that exact match misses, there is no fallback —
the user is dropped into Upload/Frame and known books import cover-less.

The reported case is *Scepter of the Ancients* by Derek Landy (Skulduggery
Pleasant, Book 1). Probes during brainstorming proved the diagnosis:

| Query | Result |
|---|---|
| OpenLibrary `title=Scepter of the Ancients&author=Derek Landy` (current code) | **0 results** |
| OpenLibrary free-text `q=Scepter of the Ancients Derek Landy` | **1 result — the correct cover** (`cover_i=48006`) |
| Apple Books (iTunes) `term=Skulduggery Pleasant&media=ebook` | covers present, upscalable |
| Google Books keyless | flaky (`totalItems: null` in repeated probes) |

Two independent levers fall out of this:

1. **Query strictness** — OpenLibrary catalogs Book 1 under its UK title
   *"Skulduggery Pleasant"*, so the US subtitle as an exact `title=` match finds
   nothing. Free-text `q=` finds it. This is the higher-leverage fix and alone
   resolves the reported case plus every subtitle/edition-naming mismatch.
2. **Single source** — even with a relaxed query, some books are genuinely
   absent from OpenLibrary. A fallback source adds breadth.

## Goals

- Search **three** sources — OpenLibrary, Apple Books (iTunes Search API), and
  Google Books — with **free-text** queries.
- **Manual picker:** merge results into one interleaved grid, each cover tagged
  with a source badge, best-of-each-source first.
- **Auto-fetch on import:** try sources in priority order
  (OpenLibrary → Apple → Google) and take the first source that returns a match.
- One slow/failed source must never block or fail the others (picker) or the
  import (auto-fetch).

## Non-goals (YAGNI)

- No cross-source visual or ISBN dedup — per-source dedup plus a total cap only
  (covers legitimately differ by edition).
- No Google Books API key wiring — keyless, best-effort, silently skipped when
  it returns nothing or errors.
- No new sources beyond these three (no Amazon, no Goodreads — both lack a
  usable keyless cover API).
- No change to the Upload or Frame tabs.

## Architecture

### Module structure

`server/src/cover/openlibrary.ts` currently mixes three concerns — searching
OpenLibrary, downloading bytes, and patching `state.json`. With three sources
that boundary no longer holds. Split it:

```
server/src/cover/
  sources/
    openlibrary.ts   search(title, author) → CoverCandidate[]   (throws CoverSourceError)
    apple.ts         search(title, author) → CoverCandidate[]
    google.ts        search(title, author) → CoverCandidate[]
  search.ts          aggregateCovers() + firstAvailableCover() + findCandidateById()
  store.ts           downloadCover, patchStateCover, clearStateCover, backgroundFetchCover
  upload.ts          (unchanged)
```

- **Source adapter** — a pure `search(title, author): Promise<CoverCandidate[]>`
  that knows only its own API and image-URL shaping. Throws a typed
  `CoverSourceError { source, kind }` on timeout/HTTP/invalid; never swallows.
  Each gets its own `AbortController` timeout (reuse the existing ~6 s budget).
- **`aggregateCovers(title, author)`** (powers the picker) — fans out all three
  adapters with `Promise.allSettled`. Rejected sources are dropped; fulfilled
  ones are **interleaved round-robin** (each source's rank-0, then rank-1, …)
  and capped at ~12 total. A slow/failed source never blocks the rest.
- **`firstAvailableCover(title, author)`** (powers auto-fetch) — runs the
  adapters **sequentially** in priority order `[openlibrary, apple, google]`,
  returns the first source's top candidate, swallowing per-source errors and
  continuing to the next. Reuses the same adapters.
- **`findCandidateById(title, author, candidateId)`** — re-runs
  `aggregateCovers` and locates the candidate by `id`. The POST `/cover` route
  downloads only this re-derived `coverUrl`, never a client-supplied URL —
  preserving the existing no-SSRF property.

### Per-source query & image handling

All adapters use free-text queries:

- **OpenLibrary:** `search.json?q=<title> <author>&limit=20`; dedupe by
  `cover_i`; image `https://covers.openlibrary.org/b/id/<cover_i>-L.jpg`.
- **Apple Books:** `itunes.apple.com/search?term=<title> <author>&media=ebook`;
  upscale `artworkUrl100` by swapping its `100x100bb` token for `600x600bb`.
- **Google Books:** `googleapis.com/books/v1/volumes?q=<title> <author>&country=US`;
  take `volumeInfo.imageLinks.thumbnail`, force `https`, strip `&edge=curl`,
  bump zoom where available. Weakest resolution — acceptable as best-effort.

`edition` is a best-effort `"<publisher> · <year>"` per source (publisher +
publish year from each API's metadata; optional).

## Data model / contract

`CoverCandidate` becomes source-agnostic:

```ts
interface CoverCandidate {
  id: string;        // "openlibrary:48006" | "apple:<trackId>" | "google:<volumeId>"
  source: 'openlibrary' | 'apple' | 'google';
  coverUrl: string;
  edition?: string;  // "<publisher> · <year>", best-effort
}
```

- POST `/api/books/:bookId/cover` body `{ openLibraryId }` → `{ candidateId }`.
- `openapi.yaml` is the type source of truth — update it, regenerate
  `src/lib/api-types.ts`, mirror `src/lib/types.ts`.
- This is an internal contract (one frontend, one backend, shipped together) so
  the rename needs no back-compat shim; both sides + the OpenAPI spec change in
  the same diff.

## Frontend (`src/modals/cover-picker.tsx`)

- Each grid cell gains a small **source badge** — a top-left pill
  ("OpenLibrary" / "Apple" / "Google") built from design tokens (no hex
  literals), alongside the existing bottom edition caption.
- Empty state reworded from "… on OpenLibrary." to "… across OpenLibrary,
  Apple Books, and Google Books."
- Footer attribution: "Covers from OpenLibrary, Apple Books & Google Books."
- The mock `api.findCoverCandidates` (`src/lib/api.ts`) returns multi-source
  canned candidates so dev and e2e exercise the badges and interleaving.

## Testing

- **Server:**
  - Per-adapter parser tests — mock `fetch`, assert the API JSON maps to
    `CoverCandidate[]` (including image-URL shaping and `CoverSourceError` on
    timeout/HTTP/malformed).
  - `aggregateCovers` — one source throws → the others still render; total cap
    honoured; round-robin order (each source's #1 surfaces before any #2).
  - `firstAvailableCover` — priority-order first-hit; skips an empty/failing
    source and falls through to the next.
  - `findCandidateById` — locates a candidate from any source by composite id.
  - `backgroundFetchCover` — uses `firstAvailableCover`, downloads the top, and
    patches `state.json`.
  - Route test (`cover.test.ts`) updated for the `candidateId` body field.
- **Frontend:** `cover-picker.test.tsx` — badge renders per candidate; new
  empty-state and footer attribution copy.
- **E2E:** extend/add a cover-picker spec (mock mode) asserting interleaved
  source badges render and the reworded empty state appears when a search is
  empty.

## Acceptance

- Opening the Cover Image picker for *Scepter of the Ancients* (Derek Landy)
  returns at least one real cover, with a visible source badge, instead of
  "No covers found."
- Importing a known book that OpenLibrary misses but Apple/Google has results in
  an auto-downloaded cover.
- A simulated source outage (one adapter throwing) still renders the surviving
  sources' covers.
