/* fs-1 — boot-time upgrade coordinator.

   Runs once at server start, before app.listen (alongside the other boot
   sweeps in index.ts). It compares the version recorded at last boot
   (user-settings.lastSeenAppVersion) against the running server version and,
   on a version INCREASE:

     1. Backs up every schema-seam JSON (state/cast/manuscript-edits/revisions/
        listen-progress per book, workspace voices.json, and user-settings.json)
        into <WORKSPACE_ROOT>/.upgrade-backups/from-<old>-to-<new>-<iso>/ — the
        data-integrity contract: nothing is migrated until a copy exists.
     2. Runs the registered schema migrations (none today — every seam is at v1,
        so this is the documented extension point; see schema-migrate.ts).
     3. Records lastSeenAppVersion = running (so the migration runs once) and
        sets showWhatsNew = true (the post-upgrade banner, cleared on dismiss).
     4. In a versioned-dir install, prunes old releases/ dirs to the newest 2.

   First boot ever (no lastSeenAppVersion) just records the version — no banner,
   no migration. A downgrade logs a warning and migrates nothing (the per-file
   refuse-future-schema guard protects reads). Idempotent: a crash between backup
   and the version stamp just re-backs-up next boot (cheap, timestamped).

   All filesystem roots + clock + settings IO are injected so the unit test
   drives it against a temp workspace with no module-const wrestling. */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { compareVersions } from '../app-version.js';
import { SCHEMA_SEAMS } from './schema-migrate.js';

export type CoordinatorAction = 'first-boot' | 'noop' | 'upgrade' | 'downgrade';

export interface CoordinatorResult {
  action: CoordinatorAction;
  fromVersion?: string;
  toVersion: string;
  backupDir?: string;
  backedUp?: string[];
  migrated?: string[];
  prunedReleases?: string[];
}

export interface CoordinatorDeps {
  /** Running server version (getAppVersion()). */
  appVersion: string;
  /** Workspace root that holds books/, voices.json, .upgrade-backups/. */
  workspaceRoot: string;
  /** <workspaceRoot>/books — the Author/Series/Book tree. */
  booksRoot: string;
  /** Shared user-settings.json path (homedir) — backed up too. */
  userSettingsPath: string;
  /** Reads the persisted lastSeenAppVersion (and nothing else needed here). */
  readLastSeenAppVersion: () => Promise<string | undefined>;
  /** Persists the upgrade bookkeeping (writeUpgradeMeta in prod). Return value
      is ignored — typed `Promise<unknown>` so writeUpgradeMeta's
      `Promise<UserSettings>` slots in without a wrapper. */
  writeMeta: (patch: { lastSeenAppVersion?: string; showWhatsNew?: boolean }) => Promise<unknown>;
  /** releases/ dir to prune in a versioned-dir install; null/undefined in dev. */
  releasesDir?: string | null;
  /** Newest N release dirs to keep when pruning. Default 2. */
  keepReleases?: number;
  /** Injectable clock for the backup-dir timestamp. */
  now?: () => Date;
  log?: (msg: string) => void;
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const ents = await readdir(path, { withFileTypes: true });
    return ents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Author/Series/Book three-level descent → each book directory. Mirrors the
    self-contained walk in changelog-migrate.ts (kept local so the boot path
    doesn't pull in the heavier library-scan module). */
async function listBookDirs(booksRoot: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(booksRoot)) return out;
  for (const author of await listDirs(booksRoot)) {
    for (const series of await listDirs(join(booksRoot, author))) {
      for (const title of await listDirs(join(booksRoot, author, series))) {
        out.push(join(booksRoot, author, series, title));
      }
    }
  }
  return out;
}

/* The per-book .audiobook files worth snapshotting before a migration. We back
   up state.json too (even though it owns its own rotating backups) so a single
   .upgrade-backups/ folder is a complete pre-upgrade restore point. */
const PER_BOOK_BACKUP_FILES = [
  'state.json',
  'cast.json',
  'manuscript-edits.json',
  'revisions.json',
  'listen-progress.json',
];

/** ISO-ish timestamp safe for a directory name (no colons). */
function stampDir(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

async function copyInto(src: string, destRoot: string, relPath: string): Promise<boolean> {
  if (!existsSync(src)) return false;
  const dest = join(destRoot, relPath);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return true;
}

/**
 * Snapshot every schema-seam JSON into `backupDir`. Returns the relative paths
 * actually copied. Pure I/O — no migration, no mutation of the originals.
 */
export async function backupSeamFiles(opts: {
  booksRoot: string;
  workspaceRoot: string;
  userSettingsPath: string;
  backupDir: string;
}): Promise<string[]> {
  const { booksRoot, workspaceRoot, userSettingsPath, backupDir } = opts;
  const copied: string[] = [];

  for (const bookDir of await listBookDirs(booksRoot)) {
    const relBook = relative(workspaceRoot, bookDir);
    for (const file of PER_BOOK_BACKUP_FILES) {
      const rel = join(relBook, '.audiobook', file);
      if (await copyInto(join(bookDir, '.audiobook', file), backupDir, rel)) copied.push(rel);
    }
  }
  // Workspace-level voices.json.
  if (await copyInto(join(workspaceRoot, 'voices.json'), backupDir, 'voices.json')) copied.push('voices.json');
  // Shared user-settings.json (lives in homedir → flat name in the backup).
  if (await copyInto(userSettingsPath, backupDir, 'user-settings.json')) copied.push('user-settings.json');

  return copied;
}

/**
 * Run the registered schema migrations across the workspace. Today every seam
 * in SCHEMA_SEAMS is at CURRENT = 1, so there is no transform to run and this
 * returns []. When the first real bump lands, the walk activates here (read →
 * migrateSeamDoc → write back when changed). Kept as the single wiring point so
 * that future change is local.
 */
export async function migrateAllSeams(_opts: { booksRoot: string; workspaceRoot: string }): Promise<string[]> {
  const pending = SCHEMA_SEAMS.filter((s) => s.current > 1);
  if (pending.length === 0) return []; // v1 everywhere — nothing to migrate.
  // First real migration plugs the file walk in here.
  return [];
}

/** Decide which release dirs to delete, keeping the newest `keep` by semver and
    always keeping `keepVersion`. Pure — exported for the unit test. */
export function planReleasePrune(dirNames: string[], keep: number, keepVersion: string): string[] {
  const semverDirs = dirNames.filter((n) => /^v\d+\.\d+\.\d+$/.test(n));
  const sorted = [...semverDirs].sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  const keepSet = new Set(sorted.slice(0, Math.max(keep, 0)));
  keepSet.add(`v${keepVersion}`);
  return sorted.filter((n) => !keepSet.has(n));
}

async function pruneOldReleases(releasesDir: string, keep: number, keepVersion: string, log: (m: string) => void): Promise<string[]> {
  const names = await listDirs(releasesDir);
  const toDelete = planReleasePrune(names, keep, keepVersion);
  for (const name of toDelete) {
    try {
      await rm(join(releasesDir, name), { recursive: true, force: true });
      log(`[upgrade] pruned old release ${name}`);
    } catch (err) {
      log(`[upgrade] could not prune ${name}: ${(err as Error).message}`);
    }
  }
  return toDelete;
}

export async function runUpgradeCoordinator(deps: CoordinatorDeps): Promise<CoordinatorResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const to = deps.appVersion;
  const last = await deps.readLastSeenAppVersion();

  if (!last) {
    // First boot ever — record the version, no banner, no migration.
    await deps.writeMeta({ lastSeenAppVersion: to });
    log(`[upgrade] first boot at v${to} — recorded, nothing to migrate.`);
    return { action: 'first-boot', toVersion: to };
  }

  const cmp = compareVersions(last, to);
  if (cmp === 0) return { action: 'noop', toVersion: to };
  if (cmp > 0) {
    log(`[upgrade] running v${to} but last saw v${last} (downgrade) — not migrating; reads refuse any future-schema file.`);
    return { action: 'downgrade', fromVersion: last, toVersion: to };
  }

  // Upgrade: backup → migrate → record → prune.
  const backupDir = join(deps.workspaceRoot, '.upgrade-backups', `from-${last}-to-${to}-${stampDir(now())}`);
  log(`[upgrade] v${last} → v${to}: backing up workspace JSON to ${backupDir}`);
  const backedUp = await backupSeamFiles({
    booksRoot: deps.booksRoot,
    workspaceRoot: deps.workspaceRoot,
    userSettingsPath: deps.userSettingsPath,
    backupDir,
  });
  const migrated = await migrateAllSeams({ booksRoot: deps.booksRoot, workspaceRoot: deps.workspaceRoot });

  await deps.writeMeta({ lastSeenAppVersion: to, showWhatsNew: true });
  log(`[upgrade] v${last} → v${to}: backed up ${backedUp.length} file(s), migrated ${migrated.length}.`);

  let prunedReleases: string[] | undefined;
  if (deps.releasesDir) {
    prunedReleases = await pruneOldReleases(deps.releasesDir, deps.keepReleases ?? 2, to, log);
  }

  return { action: 'upgrade', fromVersion: last, toVersion: to, backupDir, backedUp, migrated, prunedReleases };
}
