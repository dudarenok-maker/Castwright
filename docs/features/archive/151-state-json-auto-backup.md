---
status: stable
---

# 151 — Per-book `state.json` auto-backup (srv-2)

## Context

`state.json` is the highest-value per-book file — it holds the chapter list,
metadata, cover, tags, audio-format and parser-version stamps. A corrupt or
lost `state.json` effectively orphans a book. On Windows a OneDrive sync race
can corrupt a file mid-write, and there was no scheduled off-book snapshot to
recover from (the in-place `.bak.N` rotation chain in `state-io.ts` guards a
single bad write, but not "I want yesterday's state back").

srv-2 adds a background sweep that snapshots every book's `state.json` on a
configurable cadence, keeps the newest N, and exposes a manual list/restore so
the user can roll a book back to a known-good point — disaster recovery without
manual intervention. Surfaced in the Account view ("Account view full" per the
plan decision; the `fe-2` power-user panel it was pencilled under isn't shipped).

## What shipped

**Storage.** Snapshots live OUTSIDE the book folder at
`<WORKSPACE_ROOT>/.backups/<bookId>/<YYYYMMDD-HHMMSS>.json` (paths:
`backupsRootDir()` / `bookBackupsDir(bookId)` in `server/src/workspace/paths.ts`)
— so a book move/delete doesn't take its history with it, and every snapshot
sits in one browsable place. The zero-padded stamp makes a plain filename sort
chronological.

**Engine** (`server/src/workspace/auto-backup.ts`):
- `backupBook({bookId, bookDir}, {keep, now, minIntervalMs?})` — validates the
  source `state.json` parses, writes a snapshot via `writeJsonAtomic`, prunes to
  `keep`. `minIntervalMs` skips when the newest snapshot is younger than the
  window, so frequent server restarts don't spam snapshots.
- `runBackupSweep({keep, now?, minIntervalMs?})` — walks the three-level
  `books/` tree (self-contained `enumerateBooks()`, keyed by each `state.json`'s
  `bookId`) and snapshots every due book.
- `listBackups(bookId)` / `pruneBackups(bookId, keep)` — newest-first listing +
  retention prune.
- `restoreBackup(bookId, file)` — resolves the book via `findBookByBookId`,
  validates the snapshot parses, then writes it over `state.json` with
  `writeJsonAtomic({ rotate: { keep: 5 } })` so the restore is itself undoable.
  Throws `BackupRestoreError` for bad filename / missing book / missing or
  corrupt snapshot.
- `startBackupScheduler()` / `stopBackupScheduler()` — `unref()`'d `setTimeout`
  (one boot sweep ~30 s after start) + `setInterval` on the cadence. No-op when
  disabled. Wired into `server/src/index.ts` (`startBackupScheduler()` in the
  listen callback, `stopBackupScheduler()` in `shutdown`).

**API** (`server/src/routes/backup.ts`, mounted at `/api/books`):
- `GET /:bookId/backups` → `{ backups: BackupSnapshot[] }` (newest first).
- `POST /:bookId/backups/now` → force a snapshot (409 when no `state.json`).
- `POST /:bookId/backups/restore` `{ backupFile }` → 200 / 400 (bad filename) /
  404 (book or snapshot missing) / 409 (corrupt snapshot).

**Settings** (`server/src/workspace/user-settings.ts`): additive optional
`backupEnabled` / `backupCadence` (`daily`|`weekly`) / `backupRetention`
(1–365), defaulting **ON / daily / 14**; resolver `getResolvedBackupConfig()`.
Mirrored in the frontend defaults + Account view "Backups" card (settings +
per-book restore picker).

## Invariants

- Backups are keyed by `state.json`'s `bookId`, so the sweep's folder key always
  matches the id the restore route looks up — no drift between write and read.
- A corrupt source `state.json` is never kept as a snapshot (parse-gated).
- Restore rotates the current `state.json` aside before overwriting — undoable.
- A successful restore re-hydrates the library slice from `api.getLibrary()` (#424
  acceptance "library view refreshes after restore") — the restored `state.json`
  may carry different title/cover/chapter-count metadata, so the cached library
  list must not stay stale (`src/views/account.tsx` `BackupRestoreSection.onRestore`).
- Scheduler timers are `unref()`'d — they never keep the process alive.
- Legacy `user-settings.json` without the backup fields loads unchanged
  (resolver falls back to the ON/daily/14 defaults).

## Tests

- `server/src/workspace/auto-backup.test.ts` — stamp format; snapshot + prune to
  N (16 daily → 14 kept); `minIntervalMs` skip; `runBackupSweep` over a 2-book
  workspace; restore reverts; restore error paths (invalid filename, book not
  found, corrupt snapshot).
- `server/src/routes/backup.test.ts` — route-contract test (added in the
  close-out round): drives the real router against a real temp workspace
  (`WORKSPACE_DIR` + `vi.resetModules` + dynamic import, no fs mocks) and asserts
  the live status codes — `GET /:bookId/backups` → 200 list / 200 empty array /
  404 unknown book; `POST /:bookId/backups/now` → 200 `{ ok, file }` / 404
  unknown book (a folder with no `state.json` is undiscoverable via
  `findBookByBookId`); `POST /:bookId/backups/restore` → 200 / 400 (missing
  field, invalid filename) / 404 (unknown book, missing snapshot) / 409 (corrupt
  snapshot). The 409 "no state.json to back up" branch on `/now` is a TOCTOU edge
  (`state.json` must exist at lookup yet vanish before `backupBook` reads it), so
  it isn't deterministically reachable over HTTP — the `backupBook`-returns-null
  contract behind it is pinned in `auto-backup.test.ts`.
- Frontend: Account "Backups" card render + settings round-trip; restore flow;
  restore-success re-hydrates the library from the server scan (#424 — see
  Invariants).

## Acceptance walkthrough

1. With daily backups ON, run the server; within ~30 s `<WORKSPACE_DIR>/.backups/<bookId>/`
   gains a snapshot. Leave it running (or restart) and snapshots accumulate, capped at 14.
2. Account → Backups: toggle cadence/retention, Save, reload → values persist.
3. Corrupt a book's `state.json`, pick a snapshot in the restore picker → the
   book opens at the restored state; the pre-restore file is preserved as
   `state.json.bak.1`.

## Ship notes

- Shipped: 2026-05-31 (integration round with ops-3 / ops-6 / fe-17 / side-5),
  commit `1feccba`.
- Close-out round (2026-06-03, branch `chore/srv-2-closeout`): added the missing
  route-contract test (`server/src/routes/backup.test.ts`) and the
  restore-success library refresh (#424 acceptance), then flipped this plan to
  `stable` and archived it.
