---
status: draft
shipped: null
owner: null
---

# 191 — srv-32 — Per-chapter sync-manifest endpoint (two-level, gzip, delta-friendly)

> Status: draft
> Key files: `server/src/workspace/sync-manifest.ts` (new, pure builders), `server/src/routes/library-sync-manifest.ts` (new route), `server/src/workspace/scan.ts` (`collectBooks`), `server/src/routes/info.ts` (schema bump), `server/src/index.ts` (mount), `openapi.yaml`
> URL surface: native companion — no new web URL
> OpenAPI ops: **new** `GET /api/library/sync-manifest` (index) + `?bookId=` (per-book detail); bumps `GET /api/info` `schemas.syncManifest`

The second MVP server prerequisite for the Android companion app
([plan 188](188-android-companion-app.md), issue `srv-32` / #538). The one change
that makes **delta sync** possible: a two-level, gzip-compressed manifest the
companion diffs to pull **only changed chapters**. Keys chapters by the stable
`uuid` from [srv-35](190-srv-35-stable-chapter-uuid.md) (its hard dependency).

## Benefit / Rationale

- **User:** Fix/upgrade one chapter on the server and the phone re-pulls only that
  one file on the next home-LAN sync — never a whole-book re-export.
- **Technical:** A cheap `?since` index (per-book audio-aware `updatedAt`) over the
  existing workspace scan, with a per-book detail carrying each chapter's
  **fingerprint** (`audioRenderedAt` + file size) and **actual** audio `urlSuffix`
  (`audio.mp3` | `.m4a` | `.ogg`). Stateless deletion via a full active-ID set.
- **Architectural:** Establishes the **sync-manifest contract** any client (Android
  now, iOS later) consumes; gates compatibility off the `GET /api/info` `schemas`
  map (a `syncManifest` version it bumps). Also feeds `fs-15`.

## Architectural impact

- **New seams / extension points:**
  - `workspace/sync-manifest.ts` — pure builders (`chapterFingerprint`,
    `bookManifestUpdatedAt`, `buildSyncManifestIndex`, `buildSyncManifestBookDetail`)
    + `SYNC_MANIFEST_SCHEMA`. No I/O — unit-testable.
  - `routes/library-sync-manifest.ts` — `GET /api/library/sync-manifest`
    (index; `?since=<iso>` trims `books`, NEVER the `activeBookIds` set) and
    `?bookId=<id>` (detail). Thin I/O + gzip wrapper.
  - `scan.ts:collectBooks()` — a lightweight all-books walk returning
    `{ bookDir, state }` (reuses the existing `listDirs`/`readStateJsonWithRecovery`
    walk + audio-model backfill) so the index has ISO timestamps for `?since`
    (the `LibraryBook` shape only carries a relative `lastWorkedOn`).
- **Invariants preserved:**
  - **Fingerprint moves on every audio mutation** — the fingerprint is derived
    from `audioRenderedAt` + file size, and every audio-writing path
    (full regen, splice `fs-26`, QA re-record plan 179, loudnorm) converges on
    `finalize-chapter-write.ts`, which stamps a fresh `audioRenderedAt`. A test
    pins that the fingerprint changes when either input changes.
  - **Per-chapter `urlSuffix` is the actual rendered format** (`findChapterAudio`
    probe), so the client never hardcodes `.mp3`.
  - **Chapters keyed by the srv-35 `uuid`**, not the positional `id`.
  - **Stateless deletion** — every response carries the full active set
    (`activeBookIds` on the index; the detail's `chapters` ARE the book's full
    active chapter set, surfaced as `activeChapterUuids`), so a filesystem scan
    with no tombstones still drives client-side eviction.
  - HTTP server stays unchanged except the new route + a manual `Content-Encoding:
    gzip` on this response (no global compression middleware added).
- **Migration story:** none — reshapes existing `scan.ts`/`state.json` data. Bumps
  `GET /api/info` `schemas.syncManifest` so the app can compat-gate. Additive.
- **Reversibility:** Deleting the route + `sync-manifest.ts` + `collectBooks` fully
  reverts; nothing else depends on it server-side.

## Invariants to preserve

1. **`activeBookIds` (index) and `activeChapterUuids` (detail) are ALWAYS the full
   current set**, even under `?since` — they drive stateless client eviction.
   `?since` only trims the `books` array.
2. **`chapterFingerprint` is a pure function of `audioRenderedAt` + file size** — no
   audio change can leave it unchanged; absent when the chapter has no audio.
3. **`urlSuffix`/`audioUrl` reflect the on-disk format** via `findChapterAudio`.
4. **Chapters are keyed by `uuid`** (srv-35); the detail still includes the current
   positional `id` so the app can build the `audioUrl`.
5. **`SYNC_MANIFEST_SCHEMA` is surfaced in `GET /api/info` `schemas`** for compat
   gating; bump it on any breaking manifest shape change.

## Test plan

- **`sync-manifest.test.ts`** (pure) — `chapterFingerprint` changes when
  `audioRenderedAt` OR file size changes, and is absent without audio;
  `buildSyncManifestIndex` filters `books` by `?since` but keeps the full
  `activeBookIds`; `buildSyncManifestBookDetail` emits uuid-keyed chapters with
  fingerprint/urlSuffix/durationSec/lufs and the full `activeChapterUuids`.
- **`library-sync-manifest.test.ts`** (route, supertest + tempdir) — index shape +
  `?since` delta + gzip negotiation; detail per-chapter fields + `audioUrl`; the
  fingerprint changes after a simulated `audioRenderedAt` bump (the audio-mutation
  invariant); unknown `bookId` → 404.
- **`info.test.ts`** — `GET /api/info` `schemas.syncManifest` present.

### Manual acceptance walkthrough

Run after the companion's `app-3` exists: pair a phone, sync a book, regenerate one
chapter on the server, re-sync — only that chapter's fingerprint changed in the
detail, so only it re-downloads.

## Out of scope

- The companion-side sync engine (`app-3`) — consumes this contract.
- Content hashing — fingerprint is `audioRenderedAt` + size (cheap); a hash is a
  later option behind the same field.
- Cover-thumbnail `?width=` (D11) — separate, recommended item.

## Ship notes

(Filled on ship: date + commit SHA; flip `status:` to `stable` and archive once the
`app-3` acceptance passes.)
