---
status: draft
shipped: null
owner: null
---

# 190 — srv-35 — Stable per-chapter identifier (reorder/rename-proof)

> Status: draft
> Key files: `server/src/workspace/chapter-uuid.ts` (new), `server/src/workspace/scan.ts`, `server/src/workspace/restructure.ts`, `server/src/routes/book-state.ts`, `server/src/routes/chapters-restructure.ts`, `openapi.yaml`
> URL surface: none (server-internal; consumed by the web Listen view via `GET/PUT /api/books/{id}/listen-progress`)
> OpenAPI ops: extends `ListenProgress` (optional `chapterUuid`)

The first MVP server prerequisite for the Android companion app
([plan 188](188-android-companion-app.md), issue `srv-35` / #540): give every
chapter an immutable `uuid` that survives restructure (merge / split / reorder)
and rename, and key resume bookmarks by it. The sync manifest (`srv-32`) and the
companion's bookmarks key off this `uuid`; it also repairs a latent bug in the
existing web player. **Lands before `srv-32`.**

## Benefit / Rationale

- **User:** A server-side reorder/merge/split/rename no longer strands the
  Listen view's resume position on the wrong chapter — resume follows the chapter
  by identity, not by its shifting position number. On the companion, bookmarks
  and per-chapter sync survive a restructure of an already-downloaded book.
- **Technical:** Chapter `id` is *positional* — re-issued `1..N` on every
  restructure (`restructure.ts:1185-1189`) — and `slug` embeds `id`+title
  (`chapterSlug`), so neither is a stable key. Today's web listen-progress already
  assumes a stable `id` with no fallback (`book-state.ts:1064-1075`); this is the
  latent bug. A `uuid` gives every keyed-by-chapter artifact a durable anchor.
- **Architectural:** Establishes the stable chapter identity that `srv-32`'s
  sync manifest and `app-3`/`app-6` key by (plan 188 invariant 6). Additive +
  backward-compatible — no `state.json` schema bump.

## Architectural impact

- **New seams / extension points:**
  - `server/src/workspace/chapter-uuid.ts` — `ensureChapterUuids(state)` (mint a
    `uuid` for any chapter lacking one; idempotent; covers excluded chapters) and
    `reconcileChapterUuids(incoming, existing)` (carry a chapter's `uuid` across a
    wholesale `chapters` replacement, matched by `id`; mint for genuinely-new
    chapters). These are the lazy-migration + anti-strip primitives.
  - Optional `uuid?: string` on the `state.json` chapter shape
    (`BookStateJson.chapters[]`, `scan.ts`) and an optional `chapterUuid` on
    `ListenProgressFile` + the `ListenProgress` OpenAPI schema.
- **Invariants preserved:**
  - state.json **rename-vs-add policy** (plan 27): `uuid` is an *optional* added
    field → no `CURRENT_STATE_SCHEMA` bump; legacy files load unchanged.
  - The restructure module stays a **pure transform** (plan 51) — `uuid`
    inheritance happens inside `buildNewStateChapters` off the existing fate map;
    no I/O moves into it.
  - The positional `id` and the `slug` grammar are **unchanged** — `uuid` is
    additive, not a replacement, so every existing `id`/`slug` consumer is
    untouched.
- **Migration story (lazy backfill + persist — the chosen approach):** No
  one-shot script. Each book gains `uuid`s the first time it is **written** after
  the upgrade, via `ensureChapterUuids` at the read seams that already persist:
  the library scan (`scan.ts:scanBook`), the book-state GET
  (`book-state.ts` `GET /:bookId/state`), and any restructure
  (`chapters-restructure.ts:applyRestructure`, before the transform so old
  chapters carry a `uuid` to inherit). Minting is idempotent — a `uuid` is only
  assigned when absent, never regenerated. **Anti-strip guard:** the generic
  `PUT /:bookId/state` replaces `chapters` wholesale
  (`book-state.ts:568 — chapters: patch.chapters ?? state.chapters`); a frontend
  that doesn't track `uuid` would otherwise erase it on every chapter edit, so the
  patch is routed through `reconcileChapterUuids` to preserve `uuid` by `id`.
- **Reversibility:** Fully additive. Deleting the `uuid` field + the helper
  reverts cleanly; existing books keep loading (the field is optional everywhere
  it appears, and every keyed-by-`uuid` path falls back to `id`).

## Invariants to preserve

1. **`uuid` is immutable once minted.** `ensureChapterUuids` only ever *adds* a
   missing `uuid`; no path regenerates an existing one. A regenerated `uuid` would
   look like a brand-new chapter to the companion and force a full re-download.
2. **Restructure carries `uuid` by identity, not position**
   (`restructure.ts:buildNewStateChapters`): reorder keeps each chapter's `uuid`;
   merge keeps the survivor's (first old chapter in narrative order); split keeps
   the original on the **first** half and mints a fresh one for the **second**;
   rename/exclude/refresh-titles preserve `uuid` (they spread `...chapter`).
3. **A wholesale `chapters` PUT never strips `uuid`**
   (`book-state.ts` PUT `/:bookId/state`) — `reconcileChapterUuids` carries it by
   `id`.
4. **Resume resolves by `uuid` when present** (`book-state.ts` listen-progress
   GET): a stored `chapterUuid` resolves to the *current* `chapterId`; falls back
   to the stored `chapterId` when the `uuid` is absent (legacy record) or no
   longer maps to a live chapter (chapter deleted).
5. **No `state.json` schema bump** — `uuid` is optional (plan 27 add policy).

## Test plan

Paired automated tests land with the change:

- **`chapter-uuid.test.ts`** — `ensureChapterUuids` mints for chapters missing a
  `uuid` (including excluded), is idempotent, and never overwrites an existing
  `uuid`; `reconcileChapterUuids` carries `uuid` by `id`, mints for unmatched
  incoming chapters, and respects a `uuid` the caller already supplied.
- **`restructure.test.ts`** — reorder preserves each chapter's `uuid`; merge keeps
  the survivor's; split keeps the first half's + mints a distinct second-half
  `uuid`; rename and exclude preserve `uuid`.
- **`book-state.test.ts`** (or the listen-progress test file) — PUT stores
  `chapterUuid` derived from the current `chapterId`; GET resolves a stored
  `chapterUuid` to the current `chapterId` after a simulated restructure (id
  shifted, uuid unchanged); a legacy record without `chapterUuid` returns the
  stored `chapterId` unchanged; a `PUT /:bookId/state` patch whose `chapters`
  omit `uuid` does not strip the existing `uuid`s.

### Manual acceptance walkthrough

1. Open a book in the Listen view, play partway into chapter 5, leave.
2. Reorder chapters on the Generate view so the old chapter 5 becomes chapter 2.
3. Re-open the Listen view — resume lands on the **same chapter** (now #2) at the
   same position, not on whatever chapter is now #5.

## Out of scope

- The sync-manifest endpoint (`srv-32`) — its own branch/plan; keys off this
  `uuid`.
- Restructure-proofing individual **markers** (`ListenMarker.chapterId`) — the
  resume position is keyed by `uuid` here; marker re-anchoring is a follow-up.
- Any frontend type/UI change — the web-player repair is server-side (GET
  resolves `chapterUuid` → current `chapterId`).

## Ship notes

(Filled on ship: date + commit SHA; flip `status:` to `stable` and `git mv` to
`archive/` once the manual walkthrough passes.)
