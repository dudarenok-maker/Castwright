# Castwright Wave 1 — Narrator credit + persistent stamps (plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Listen-tab narrator credit defaults to "Castwright" (over the cast-narrator name; explicit wins) and persists; the exported-file artist tag keeps the author when the credit is the brand default; add a "Made with Castwright" footer stamp + a "Rendered with Castwright · castwright.ai" comment in exported MP3/M4B.

**Source of truth:** `docs/superpowers/specs/2026-06-08-castwright-brand-full-pass-design.md` (Wave 1).

---

## Task 1 — Frontend narrator credit default (display + hydrate + remove orphaned helper)

**Files:** `src/store/book-meta-slice.ts`, `src/views/listen.tsx`, `src/components/layout.tsx`, tests `book-meta-slice.test.ts` / `listen.test.tsx` / `src/test/a11y.test.tsx`.

- [ ] **Add the constant.** In `src/store/book-meta-slice.ts`, export `export const DEFAULT_NARRATOR_CREDIT = 'Castwright';`.
- [ ] **Hydrate default (TDD).** Change line ~79 `narratorCredit: state.narratorCredit ?? narratorFallback ?? null` → `narratorCredit: state.narratorCredit ?? DEFAULT_NARRATOR_CREDIT`. Remove the `narratorFallback` field from `HydratePayload` (line ~64) and its destructure (line ~74). Update `book-meta-slice.test.ts`: the "falls back to narratorFallback" case → "defaults to DEFAULT_NARRATOR_CREDIT when state.narratorCredit missing" (expect `'Castwright'`); the "uses null when both missing" case → expect `'Castwright'`.
- [ ] **Remove orphaned helper.** Delete `narratorNameFromCast` (line ~150) and its `describe` block in `book-meta-slice.test.ts`.
- [ ] **Update call sites.** In `src/components/layout.tsx`: drop the `narratorNameFromCast` import (line 23) and remove the `narratorFallback:` arg from BOTH `hydrateFromBookState` dispatches (lines ~742, ~828).
- [ ] **Display precedence (TDD).** In `src/views/listen.tsx` lines ~147-150, change to:
  ```ts
  const narratorName =
    (bookMeta?.narratorCredit && bookMeta.narratorCredit.trim()) || DEFAULT_NARRATOR_CREDIT;
  ```
  (import `DEFAULT_NARRATOR_CREDIT` from the slice; drop the `characters.find(c => c.id === 'narrator')` fallback; update the precedence comment). Update `listen.test.tsx`: rename "falls back to the cast narrator when narratorCredit is blank" → "defaults to Castwright when no explicit credit" (expect `'Castwright'`, not 'Anders Vale'); keep the explicit-credit-wins case green. Update `src/test/a11y.test.tsx` fixture if it asserts a specific narrator name.
- [ ] Run `npm test -- book-meta-slice listen` and `npm run typecheck`; commit `feat(frontend): narrator credit defaults to Castwright (over cast narrator), persisted via hydrate`.

## Task 2 — Server narrator default (book-state GET) + persistence

**Files:** server book-state GET handler (`server/src/routes/book-state.ts`; find the GET that returns `state` to the client — near the PATCH at line ~637), `server/src/workspace/scan.ts` if it assembles the returned state. Test: `server/src/routes/book-state.test.ts`.

- [ ] **Add a server constant** `export const DEFAULT_NARRATOR_CREDIT = 'Castwright';` in a shared server module (e.g. top of `book-state.ts` or a small `server/src/export/narrator-credit.ts` reused by the export builders in Task 3). Document the FE/server duplication.
- [ ] **TDD:** add a `book-state.test.ts` case: GET for a book whose stored `narratorCredit` is null/empty returns `narratorCredit: 'Castwright'`; a book with an explicit credit returns it unchanged.
- [ ] In the GET handler, when the resolved `narratorCredit` is null/empty, return `DEFAULT_NARRATOR_CREDIT`. (The existing meta-PUT path then writes it through on the next save — no change needed there.)
- [ ] Run `cd server && npx vitest run src/routes/book-state.test.ts`; commit `feat(server): book-state GET defaults empty narratorCredit to Castwright`.

## Task 3 — Export artist sentinel + "Rendered with Castwright" comment

**Files:** new `server/src/export/narrator-credit.ts` (shared `DEFAULT_NARRATOR_CREDIT` + `artistForExport`), `build-mp3-folder.ts:71`, `build-mp3-zip.ts:89`, `build-m4b.ts:154`, `server/src/export/id3-tags.ts`. Tests: the three builders' tests + `id3-tags.test.ts`.

- [ ] **TDD `artistForExport`.** Create `server/src/export/narrator-credit.ts`:
  ```ts
  export const DEFAULT_NARRATOR_CREDIT = 'Castwright';
  /** TPE1 artist: a real human narrator credit, else the author. The brand
      default "Castwright" is treated as "no human narrator" so the artist tag
      stays the author. */
  export function artistForExport(state: { narratorCredit?: string | null; author: string }): string {
    const c = state.narratorCredit?.trim();
    return c && c !== DEFAULT_NARRATOR_CREDIT ? c : state.author;
  }
  ```
  Add `narrator-credit.test.ts`: empty → author; `'Castwright'` → author; `'Jane Narrator'` → 'Jane Narrator'. (If Task 2 created the server const elsewhere, consolidate it here and re-import to avoid duplication.)
- [ ] Replace the duplicated `const artist = (state.narratorCredit && state.narratorCredit.trim()) || state.author;` in all three builders with `const artist = artistForExport(state);` (import the helper). Keep the three builders' existing tests green (they pass `narratorCredit: 'Jane Narrator'` → still 'Jane Narrator').
- [ ] **ID3 comment (TDD).** In `server/src/export/id3-tags.ts`: add optional `comment?: string | null` to `Id3Tags`; when present, push `'-metadata', \`comment=${tags.comment}\`` into the ffmpeg args (after the `date` arg). Add an `id3-tags.test.ts` case asserting the `comment=` metadata arg is emitted when `comment` is set and omitted when not. Wire the three MP3 builders to pass `comment: 'Rendered with Castwright · castwright.ai'`.
- [ ] **M4B comment.** In `build-m4b.ts`, add the same `Rendered with Castwright · castwright.ai` to the M4B metadata atoms (follow the existing `-metadata` pattern there; M4B uses `comment`/`©cmt`). Keep `build-m4b.test.ts` green; add an assertion for the comment if the test inspects metadata args.
- [ ] Run `cd server && npx vitest run src/export/`; commit `feat(server): export artist keeps author for default credit + "Rendered with Castwright" comment stamp`.

## Task 4 — Footer stamp + back-catalogue backfill

**Files:** `src/components/build-stamp.tsx` (+ the `formatBuildStamp` helper it calls — find it), new `scripts/repair-narrator-credit.mjs` + test.

- [ ] **Footer stamp.** Prepend `"Made with Castwright · "` to the rendered build stamp. Locate `formatBuildStamp` (the pure formatter) and prepend there so it's covered by its existing unit test; update that test. If the stamp is assembled inline in `build-stamp.tsx`, prepend in the JSX and add/adjust a render test. Keep a11y (the footer's aria-label) sensible.
- [ ] **Backfill script (TDD).** Create `scripts/repair-narrator-credit.mjs` mirroring the repo's `repair-*.mjs` pattern: an exported pure `planBackfill(books)` that returns the bookIds whose `book-state.json` `narratorCredit` is empty/null (to be set to `'Castwright'`), and a `main()` with `--apply` (dry-run default) that walks `BOOKS_ROOT`/each book's `.audiobook/state.json` (or book-state.json — match how other repair scripts read book state) and writes `"Castwright"` only where empty. Add `scripts/tests/repair-narrator-credit.test.mjs` (use `node:test`+`assert`, the repo's scripts-test convention) covering `planBackfill`: empty→included, explicit→skipped.
- [ ] Run the frontend stamp test + `node --test scripts/tests/repair-narrator-credit.test.mjs`; commit `feat(repo): Made-with-Castwright footer + repair-narrator-credit backfill`.

## Task 5 — Verify + PR

- [ ] `npm run verify` green.
- [ ] Add one Playwright assertion (in an existing listen e2e spec or a small new one) that the Listen header shows "Castwright" for a book with no explicit narrator credit. Keep e2e green.
- [ ] Push `feat/castwright-narrator-stamps`; `gh pr create --draft` with `Refs #631` (Wave 1 of the brand pass); body links the spec + this plan.

## Notes
- Per-book `.audiobook/` folder name is unrelated — do not touch.
- DEFAULT_NARRATOR_CREDIT is duplicated FE (book-meta-slice) + server (narrator-credit.ts) by necessity (no shared module) — document it in both.
- Explicit user credits are never overwritten anywhere.
