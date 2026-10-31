/* srv-2 — per-book state.json auto-backup.

   On a configurable cadence (daily / weekly) snapshots each book's
   `.audiobook/state.json` to `<WORKSPACE_ROOT>/.backups/<bookId>/<stamp>.json`,
   keeping the newest N (default 14) and pruning the rest. A manual
   "restore from backup" path swaps a chosen snapshot back over state.json,
   rotating the current one aside via the existing writeJsonAtomic backup
   chain so the restore itself is undoable.

   Disaster recovery for the highest-value per-book file — particularly on
   Windows where a OneDrive sync race can corrupt state.json mid-write.

   Backups live OUTSIDE the book folder (at the workspace root) so a book
   move/delete doesn't take its history with it, and so every snapshot sits
   in one browsable place. */

import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_ROOT, bookBackupsDir, stateJsonPath } from './paths.js';
import { readEditsForHintsCheck } from './hints-proof-io.js';
import { swapLeavesStaleEvidence } from './stale-evidence.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';
import { withLocatedBook } from './book-state-update.js';
import { writeJsonAtomic } from './state-io.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from './state-migrate.js';
import { withStateJsonLock } from './file-lock.js';
import { mintEditEpoch } from './slice-revision.js';
import type { BookStateJson } from './scan.js';
import { getResolvedBackupConfig } from './user-settings.js';
import { removeManuscript } from '../store/manuscripts.js';

/* YYYYMMDD-HHMMSS in local time — zero-padded so a plain filename sort is
   chronological, and human-readable in File Explorer. */
export function backupStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const STAMP_RE = /^\d{8}-\d{6}\.json$/;

/* Mirrors the `BackupSnapshot` OpenAPI schema. */
export interface BackupSnapshot {
  /** Filename, e.g. "20260531-141530.json" — also the restore id. */
  file: string;
  /** Bytes on disk. */
  sizeBytes: number;
  /** ISO mtime, for display. */
  createdAt: string;
}

/** List a book's snapshots, newest first. Empty when none / dir absent. */
export async function listBackups(bookId: string): Promise<BackupSnapshot[]> {
  const dir = bookBackupsDir(bookId);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((n) => STAMP_RE.test(n));
  const out: BackupSnapshot[] = [];
  for (const file of names) {
    const snap = join(dir, sanitizeIdSegment(safeSegment(file)));
    assertContained(dir, snap);
    const s = await stat(snap);
    out.push({ file, sizeBytes: s.size, createdAt: s.mtime.toISOString() });
  }
  /* Zero-padded stamp ⇒ filename sort is chronological; newest first. */
  out.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
  return out;
}

/** Delete all but the newest `keep` snapshots for a book. Returns the count
    pruned. */
export async function pruneBackups(bookId: string, keep: number): Promise<number> {
  if (keep < 1) return 0;
  const stale = (await listBackups(bookId)).slice(keep); // newest-first
  const dir = bookBackupsDir(bookId);
  for (const s of stale) {
    const snap = join(dir, sanitizeIdSegment(safeSegment(s.file)));
    assertContained(dir, snap);
    await unlink(snap).catch(() => {});
  }
  return stale.length;
}

export interface BackupBookOpts {
  /** Retention cap — prune to the newest `keep` after writing. */
  keep: number;
  /** Wall clock (injected for deterministic tests). */
  now: Date;
  /** Skip when the newest snapshot is younger than this, so frequent server
      restarts don't spam snapshots. Omit / 0 to force a snapshot (manual
      "back up now"). */
  minIntervalMs?: number;
}

/** Snapshot one book's state.json. Returns the snapshot filename written, or
    null when there's no state.json, it's corrupt, or a recent snapshot makes
    this one not yet due (`minIntervalMs`). */
export async function backupBook(
  book: { bookId: string; bookDir: string },
  opts: BackupBookOpts,
): Promise<string | null> {
  /* #3625 pass 6 - the recovering read, not `existsSync` + a raw read: a
     rotating write renames main away before its rename-in, so a plain read
     inside that window found no state.json and skipped the book. In the window
     (or for a stranded book) this reads `.bak.1`, the state before the write.
     A corrupt main recovers from its newest parseable backup too; only when
     nothing parses (a SyntaxError) is there no snapshot worth keeping. */
  let value: unknown;
  try {
    value = await readStateJsonWithRecovery(stateJsonPath(book.bookDir));
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (!value) return null;

  if (opts.minIntervalMs && opts.minIntervalMs > 0) {
    const existing = await listBackups(book.bookId);
    if (existing.length > 0) {
      const newest = new Date(existing[0].createdAt).getTime();
      if (opts.now.getTime() - newest < opts.minIntervalMs) return null;
    }
  }

  const dir = bookBackupsDir(book.bookId);
  await mkdir(dir, { recursive: true });
  const file = `${backupStamp(opts.now)}.json`;
  const snap = join(dir, sanitizeIdSegment(safeSegment(file)));
  assertContained(dir, snap);
  await writeJsonAtomic(snap, value);
  await pruneBackups(book.bookId, opts.keep);
  return file;
}

/** Walk the three-level books/ tree (<Author>/<Series>/<Book>) and yield each
    book's `{ bookId, bookDir }` by reading its state.json's bookId — so the
    backup folder key matches the id the restore route looks up via
    findBookByBookId. Self-contained (no scan.ts enumeration helper exists);
    corrupt / id-less state.json files are skipped. */
async function enumerateBooks(): Promise<Array<{ bookId: string; bookDir: string }>> {
  const out: Array<{ bookId: string; bookDir: string }> = [];
  if (!existsSync(BOOKS_ROOT)) return out;
  const dirsIn = async (dir: string): Promise<string[]> => {
    const names = await readdir(dir);
    const kept: string[] = [];
    for (const n of names) {
      try {
        if ((await stat(join(dir, n))).isDirectory()) kept.push(n);
      } catch {
        /* vanished between readdir and stat — skip */
      }
    }
    return kept;
  };
  for (const author of await dirsIn(BOOKS_ROOT)) {
    const authorDir = join(BOOKS_ROOT, author);
    for (const series of await dirsIn(authorDir)) {
      const seriesDir = join(authorDir, series);
      for (const title of await dirsIn(seriesDir)) {
        const bookDir = join(seriesDir, title);
        try {
          /* The recovering read (#3625 pass 6): a book mid-write has no main
             state.json for a moment, and must not drop out of the sweep. */
          const parsed = (await readStateJsonWithRecovery(stateJsonPath(bookDir))) as { bookId?: unknown } | null;
          if (parsed && typeof parsed.bookId === 'string' && parsed.bookId) {
            out.push({ bookId: parsed.bookId, bookDir });
          }
        } catch {
          /* corrupt state.json — the in-place .bak chain guards it; skip here */
        }
      }
    }
  }
  return out;
}

/** Snapshot every book in the workspace whose backup is due. `now` injected
    for tests. */
export async function runBackupSweep(
  opts: { keep: number; now?: Date; minIntervalMs?: number },
): Promise<{ booksBackedUp: number }> {
  const now = opts.now ?? new Date();
  const books = await enumerateBooks();
  let booksBackedUp = 0;
  for (const b of books) {
    try {
      const file = await backupBook(
        { bookId: b.bookId, bookDir: b.bookDir },
        { keep: opts.keep, now, minIntervalMs: opts.minIntervalMs },
      );
      if (file) booksBackedUp += 1;
    } catch (err) {
      console.warn(`[backup] failed for ${b.bookId}:`, err);
    }
  }
  return { booksBackedUp };
}

export class BackupRestoreError extends Error {}

/** Restore `file` (a snapshot filename) over the book's state.json. Routes
    through writeStateJsonAtomic, which rotates the current state.json into
    its `.bak` chain (via STATE_BACKUP_KEEP = 3) so the restore is itself
    undoable, and also stamps the schema. Throws BackupRestoreError for a bad
    filename / missing book / missing or corrupt snapshot. */
export async function restoreBackup(bookId: string, file: string): Promise<void> {
  if (!STAMP_RE.test(file)) throw new BackupRestoreError('invalid backup filename');
  /* #3400 — locate + write under the book lock: a restore must not interleave
     with a chapter restructure's writes, and the folder it writes to must be the
     one the book is in when the lock is held. */
  const located = await withLocatedBook(bookId, async (found) => {
    const bookDir = found.bookDir;
    const backupsDir = bookBackupsDir(bookId);
    const snapPath = join(backupsDir, sanitizeIdSegment(safeSegment(file)));
    assertContained(backupsDir, snapPath);
    if (!existsSync(snapPath)) throw new BackupRestoreError('backup not found');
    const raw = await readFile(snapPath, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BackupRestoreError('backup is corrupt');
    }
    if (typeof value !== 'object' || value === null) {
      throw new BackupRestoreError('backup is corrupt');
    }
    /* #2246 Tasks 4+5 — a restore whose snapshot has no `language` must land on
       disk as an explicit `language: null` (key present), and routing through
       writeStateJsonAtomic also stamps the schema (restore previously wrote
       unstamped state.json — a second defect fixed in the same change). A
       snapshot that does carry a language round-trips unchanged.

       Routing through writeStateJsonAtomic is intentional and adopts the house
       STATE_BACKUP_KEEP depth of 3 for state.json backups (changed from the
       prior local override of 5). Three slots cover the realistic recovery
       window: the last completed write, the one before it, and one earlier. */
    const parsed = value as BookStateJson;
    /* Plan 290 (#3837, round 10) -- a restore swaps state.json only, so the local
       manuscript-edits.json stays. Read here, under the book lock every edits
       writer takes (or under book-op, which the route holds). */
    const edits = await readEditsForHintsCheck(bookDir);
    /* The manuscript id the book carried before the restore, read under the
       state-json lock below. */
    let currentManuscriptId: string | undefined;
    try {
      /* #3700 — a whole-file overwrite that renames over state.json; it takes the
         per-book state-json leaf lock (inside the book lock) so it can't
         interleave with a render's stamp. */
      await withStateJsonLock(stateJsonPath(bookDir), async () => {
        /* #3700 review pass 3 — the book may have been deleted or moved after
           `bookDir` was resolved above. The write below would recreate the old
           folder with the same bookId, so an absent state.json is "book not
           found": write nothing. A stranded main (absent, `.bak.1` beside it:
           a write died between its renames, #3625) is still the book, so the
           restore goes ahead. */
        const sp = stateJsonPath(bookDir);
        if (!existsSync(sp) && !existsSync(`${sp}.bak.1`)) throw new BackupRestoreError('book not found');
        /* Plan 290 (#3837, round 10) -- the book's current state, read under this
           leaf lock: the snapshot's chapters are compared with it to decide the
           stale-evidence marker. Unreadable counts as a different list. */
        const current = await readStateJsonWithRecovery(sp).catch(() => null);
        const currentId = (current as { manuscriptId?: unknown } | null)?.manuscriptId;
        if (typeof currentId === 'string' && currentId) currentManuscriptId = currentId;
        const stale = swapLeavesStaleEvidence(edits, parsed.chapters, current);
        await writeStateJsonAtomic(stateJsonPath(bookDir), {
          ...parsed,
          /* Never the snapshot's own marker: only the rule above decides
             (undefined is not serialised). */
          sentencesPredateChapters: stale ? true : undefined,
          language: parsed.language ?? null,
          /* Plan 289 Invariant 4 — a restore is a wipe-class event: the snapshot's
             own epoch must not come back, or a save based on a read taken under
             it would pass the revision check against rewound state. */
          editEpoch: mintEditEpoch(),
        });
      });
    } finally {
      /* PR #3966 review pass 1 -- the restored state.json describes another
         chapter list, so a warm ManuscriptRecord built from the state it
         replaced is stale: a main run would rebuild state.chapters from it and
         undo the restore. Drop the record for the id the book carried and for
         the snapshot's id, and the next reader re-hydrates from disk -- as the
         bundle overwrite does (scan-import-folder.ts). In a `finally`, like
         there: dropping a warm record is harmless if the write did not land. */
      if (currentManuscriptId) removeManuscript(currentManuscriptId);
      if (typeof parsed.manuscriptId === 'string' && parsed.manuscriptId) removeManuscript(parsed.manuscriptId);
    }
  });
  if (!located) throw new BackupRestoreError('book not found');
}

/* ── Scheduler ──────────────────────────────────────────────────────────── */

const CADENCE_MS: Record<'daily' | 'weekly', number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweep from user-settings (enabled / cadence / retention).
    Idempotent — clears any prior timer first; no-op when disabled. Kicks one
    sweep shortly after boot (so a fresh server doesn't wait a full cadence for
    its first snapshot) then runs on the cadence interval. The boot/interval
    sweeps pass `minIntervalMs` so a server restarted several times within a day
    doesn't pile up redundant snapshots. Both timers are `unref()`d so they
    never keep the process alive on their own. */
export function startBackupScheduler(): void {
  stopBackupScheduler();
  const cfg = getResolvedBackupConfig();
  if (!cfg.enabled) return;
  const period = CADENCE_MS[cfg.cadence];
  const tick = () => {
    void runBackupSweep({ keep: cfg.retention, minIntervalMs: period / 2 })
      .then((r) => {
        if (r.booksBackedUp > 0) console.log(`[backup] snapshotted ${r.booksBackedUp} book(s).`);
      })
      .catch((err) => console.warn('[backup] sweep failed:', err));
  };
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, period);
  timer.unref();
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
