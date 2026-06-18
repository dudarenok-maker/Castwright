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
import { safeSegment } from '../util/safe-path.js';
import { findBookByBookId } from './scan.js';
import { writeJsonAtomic } from './state-io.js';
import { getResolvedBackupConfig } from './user-settings.js';

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
    const s = await stat(join(dir, safeSegment(file)));
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
    await unlink(join(dir, safeSegment(s.file))).catch(() => {});
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
  const src = stateJsonPath(book.bookDir);
  if (!existsSync(src)) return null;

  if (opts.minIntervalMs && opts.minIntervalMs > 0) {
    const existing = await listBackups(book.bookId);
    if (existing.length > 0) {
      const newest = new Date(existing[0].createdAt).getTime();
      if (opts.now.getTime() - newest < opts.minIntervalMs) return null;
    }
  }

  const raw = await readFile(src, 'utf8');
  let value: unknown;
  /* Validate it parses before keeping it as a "good" snapshot — a corrupt
     state.json isn't worth preserving (the in-place .bak chain already
     guards the live file). */
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  const dir = bookBackupsDir(book.bookId);
  await mkdir(dir, { recursive: true });
  const file = `${backupStamp(opts.now)}.json`;
  await writeJsonAtomic(join(dir, file), value);
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
        const sp = stateJsonPath(bookDir);
        if (!existsSync(sp)) continue;
        try {
          const parsed = JSON.parse(await readFile(sp, 'utf8')) as { bookId?: unknown };
          if (typeof parsed.bookId === 'string' && parsed.bookId) {
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

/** Restore `file` (a snapshot filename) over the book's state.json. Rotates
    the current state.json into its `.bak` chain first (writeJsonAtomic
    `rotate`) so the restore is itself undoable. Throws BackupRestoreError for
    a bad filename / missing book / missing or corrupt snapshot. */
export async function restoreBackup(bookId: string, file: string): Promise<void> {
  if (!STAMP_RE.test(file)) throw new BackupRestoreError('invalid backup filename');
  const found = await findBookByBookId(bookId);
  if (!found) throw new BackupRestoreError('book not found');
  const bookDir = found.bookDir;
  const snapPath = join(bookBackupsDir(bookId), safeSegment(file));
  if (!existsSync(snapPath)) throw new BackupRestoreError('backup not found');
  const raw = await readFile(snapPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BackupRestoreError('backup is corrupt');
  }
  await writeJsonAtomic(stateJsonPath(bookDir), value, { rotate: { keep: 5 } });
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
