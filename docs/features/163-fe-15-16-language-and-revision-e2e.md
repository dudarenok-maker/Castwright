---
status: active
shipped: null
owner: null
---

# fe-15 + fe-16 — revision A/B player e2e + library/cast language UX

> Status: stable (shipped together; manual acceptance owed only for the live Qwen auto-load)
> Key files: `src/lib/api.ts` (cc mock), `src/views/revision-diff.tsx`, `e2e/revision-diff.spec.ts`, `e2e/profile-regen-preview.spec.ts`, `src/store/library-slice.ts`, `src/components/library/library-chrome.tsx`, `src/views/book-library.tsx`, `src/views/cast.tsx`, `src/routes/index.tsx`, `src/mocks/library.ts`
> URL surface: `#/books/<id>/cast`, `#/` (library), the revision A/B overlay
> OpenAPI ops: none (frontend + mock-fixture only)

Two deferred backlog items shipped together (one PR) because they share the
`cc`/`ts` mock fixtures and the same fs-2 language groundwork.

## Benefit / Rationale

- **User (fe-16a):** faster discovery of same-language books via an En/Русский
  filter pill set that ANDs with search + tags.
- **User (fe-16b):** a clear on-ramp on a non-English book's cast view — a banner
  explaining every speaking character needs a designed Qwen voice, plus Qwen
  auto-loading on entry so the user isn't blocked on a manual model load.
- **Technical (fe-15):** the profile-regen preview gate (plan 114) and the
  review-mode A/B player are now pinned at the browser level, covering the
  redux/middleware/timing seam (auto-open on `chapter_complete`) that jsdom
  can't honestly exercise.
- **Architectural:** `filterBooks` gains a composable `activeLanguages` axis;
  the cast view gains a `bookLanguage` input threaded from the library entry.

## Architectural impact

- **fe-15 stale-premise correction:** the BACKLOG claimed mock mode "doesn't
  hydrate chapters / hydration throws." It does — `sb` already seeds 18 chapters
  (`SB_CHAPTERS`) and the mock revision targets chapterId 3, so the review-mode
  player already resolved. The real gap was that **no mock book had both a
  populated cast AND chapters its cast speaks in**, which the preview flow
  (change voice → Regenerate character → Preview) needs. Closed by giving
  `cc` (Carrick's Compass) `CC_CHAPTERS` (4) + a `chapterCharacters` map
  (`eliza_cc` speaks in CH1/2/3 → CH1 is the preview sample, CH2/3 fan out).
- **New seam:** `filterBooks(books, search, activeTags, activeLanguages = [])`;
  `selectPresentLanguages(books)` + `LANGUAGE_LABELS`/`languageLabel` in
  `library-slice.ts`. `CastView` gains optional `bookLanguage` (default `'en'`).
- **Invariants preserved:** language is structured data, kept OUT of the
  user-tag set (00/73). `cc` stays English so the fe-15 preview e2e never trips
  the cast-view Qwen probe; the lone Russian fixture rides on `ts`.
- **Reversibility:** all changes are additive (a default-empty filter arg, an
  optional prop, an idempotent banner/effect, two mock fixtures). Removing the
  pills/banner reverts cleanly.

## Invariants to preserve

- `filterBooks` ANDs search ∩ tags ∩ languages; a missing `book.language`
  counts as `'en'` (`src/store/library-slice.ts`).
- The language pill row renders ONLY when `selectPresentLanguages(books).length
  > 1` (`library-chrome.tsx` + `book-library.tsx`).
- `CastView` banner + Qwen auto-load fire ONLY when `bookLanguage !== 'en'`;
  the auto-load is one-shot (ref-guarded) and gated on the `/api/qwen/detect`
  install probe (`src/views/cast.tsx`).
- `mockPollRevisions` returns `PENDING_REVISIONS` for every book because the
  revisions slice's `applyPoll` replaces `pending` wholesale regardless of
  bookId; scoping it per-book would let a background poll of an empty book wipe
  the active book's pending. The preview e2e clears `pending` itself before
  opening its stub (`src/lib/api.ts`, `e2e/profile-regen-preview.spec.ts`).

## Test plan

### Automated coverage

- Vitest (`src/store/library-slice.test.ts`) — `filterBooks` language filter
  (single, AND-with-tags, AND-with-search, languageless→'en', pass-through),
  `selectPresentLanguages`, `languageLabel`.
- Vitest (`src/components/library/library-chrome.test.tsx`) — pill row hidden at
  1 language, rendered with labels at >1, active `aria-pressed`, `toggleLanguage`
  fires, clear-filters surfaces on an active language.
- Vitest (`src/views/cast.test.tsx`) — banner shown on `ru` / hidden on `en`;
  Qwen auto-loads when installed, not when uninstalled, never on English.
- Playwright (`e2e/revision-diff.spec.ts`) — opens the **review-mode** A/B
  player from the Status popover (`data-mode="review"`).
- Playwright (`e2e/profile-regen-preview.spec.ts`) — drives **preview→Approve**
  (fans CH2/3 out + appends a `regenerate` change-log event) and
  **preview→Reject** (clears `previewRegen`, no fan-out), both via the real
  cast → drawer → modal → Preview path, with the preview chapter fast-forwarded
  through `window.__store__`.

### Manual acceptance walkthrough

1. `npm run dev` → `#/` shows **English / Русский** filter pills (because `ts`
   is Russian); clicking **Русский** narrows to `ts`, and it ANDs with a tag
   chip. A single-language library shows no pills.
2. Open `cc` → Status popover → "1 revision pending · Open" → review A/B player.
3. Open `cc` cast → a character → "Regenerate …'s lines" → "Preview CH 01 first"
   → A/B opens in preview mode → Approve fans the rest / Reject reverts.
4. **(owed, real backend + GPU)** Open a real Russian book's cast → the Qwen
   banner shows and Qwen loads in the background (analyzer evicted).

## Out of scope

- Russian UI localization (`fs-14`, react-i18next) — separate backlog item.
- Multi-step `pending`-by-book correctness in the revisions slice — `applyPoll`
  still replaces `pending` wholesale (pre-existing; documented above).

## Ship notes

Shipped 2026-06-01 on branch `feat/frontend-fe-15-16` (PR pending). fe-15 BACKLOG
premise was stale (chapters already hydrate); the substantive work was the `cc`
cast+chapters fixture for the preview flow. fe-16 Qwen auto-load is wired and
unit-covered; live GPU acceptance is the only owed item.
