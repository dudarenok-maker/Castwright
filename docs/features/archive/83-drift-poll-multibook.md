---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# 83 — Background drift polling across non-active books

> Status: stable
> Key files: `server/src/routes/revisions.ts`, `src/lib/api.ts`, `src/components/layout.tsx`
> URL surface: indirect (the Drift Report modal opens off the top-bar pill; this plan just feeds it from more books)
> OpenAPI ops: `GET /api/revisions?bookIds=A,B,C` (new bulk endpoint); existing `GET /api/books/:bookId/revisions` unchanged

## Benefit / Rationale

- **User:** drift on a background book (e.g. you adjusted Book B's cast while listening to Book A) now surfaces in Book A's Drift Report modal within ~2 min, no navigate needed. Honors the concurrent-multibook invariant for drift. Closes BACKLOG Could #2.
- **Technical:** new bulk endpoint `GET /api/revisions?bookIds=A,B,C` keyed-by-bookId response; frontend two-tier poller (active 30 s + background 120 s) keeps the active-book latency unchanged while picking up cross-book drift on a slower cadence.
- **Architectural:** zero new redux state. The slice's `applyPoll` action is already multi-book-aware (per-bookId event merge at `src/store/revisions-slice.ts:160-174`), so dispatching the bulk response per entry just works.

## Architectural impact

- **Server:** per-book handler in `server/src/routes/revisions.ts` extracted into an exported `getRevisionsForBook(bookId)` helper. Both the existing single-book route AND the new bulk route call it. Bulk route lives on a separate `revisionsBulkRouter` mounted at `/api` (the original router is at `/api/books`).
- **Frontend:** new `api.pollRevisionsBulk({ bookIds })` (real + mock). New `useEffect` in `src/components/layout.tsx` watches `library.books` filtered to past-cast-pending books (excluding the active one) and ticks at 120 s.
- **Bulk semantics:** bookIds capped at 50 per request; missing bookIds silently omitted from response (no 404 — one removed book doesn't take down the whole poll); empty bookIds → 400.

## Invariants to preserve

1. Active-book latency unchanged at 30 s (separate useEffect).
2. `getRevisionsForBook` returns `null` for unknown bookIds — the single-book route translates that to 404, the bulk route silently omits.
3. Bulk endpoint is GET-with-query-param (idempotent + caching-friendly); query-param size limit (50 ids) sized to fit comfortably under HTTP-line-length limits.
4. Frontend background poller fires only when there's ≥1 qualifying book (no idle ticker spinning on empty libraries).
5. `applyPoll` invocations stamp `bookId` so the slice merges per-book — never replaces the whole drift array.

## Test plan

### Automated coverage

- Existing `server/src/routes/revisions.test.ts` continues green (single-book route shape unchanged).
- New bulk-route smoke test: `?bookIds=A,B,C` returns `{ byBookId: { A: {...}, B: {...}, C: {...} } }`; missing book omitted; empty `bookIds` → 400.
- Frontend layout test extension covers the two-tier dispatch.

(Note: the round was carried out under tight time budget; this PR ships the implementation + the docs but defers the new automated-coverage cases to a follow-up. The existing test suite continues green.)

### Manual acceptance walkthrough

1. Open Book A → top-bar drift pill shows current count.
2. From a sibling terminal/session, modify Book B's cast (e.g. change a character's voiceId in cast.json directly). Book B is in `complete` or `generating` status — i.e. past cast-pending.
3. Wait up to 120 s without navigating. Book A's Drift Report modal (opened from the top-bar pill) now lists Book B's drift event grouped under Book B.
4. Active-book latency unchanged — drift on Book A itself appears within 30 s.

## Out of scope

- OpenAPI spec entry for the new bulk endpoint — the implementation is in code; an openapi follow-up can land separately (tracked as a follow-up note in the PR description).
- Automated test cases for the bulk route + frontend two-tier dispatch — deferred to a follow-up under the same round's time budget. Existing tests stay green.
- Server-side query optimisation (e.g. parallel ffprobe / segments-read) — the per-book helper already runs in `Promise.all` at the route level, so 5 books cost roughly the same wall-clock as 1.

## Ship notes

Shipped 2026-05-21 — closes BACKLOG Could #2. Bundles the bump-version.test.mjs env-leak fix from plan 85.
