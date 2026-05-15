/* One-shot wipe-and-fresh for .audiobook/change-log.json files written
   before the generation_run_complete rollup landed.

   The pre-collapse middleware persisted one `chapter_complete` event per
   chapter tick — a single 14-chapter run became 14 nearly-identical audit
   lines and a noisy book accumulated 200+ entries that were the same row
   on repeat. This module runs once at server bootstrap, walks every
   book's change-log, and:

     - If the log contains chapter_complete entries AND no sibling
       `change-log.legacy.json` already exists, the original is renamed
       to `change-log.legacy.json` and replaced with a fresh `[]`.
     - The presence of the `.legacy.json` sentinel is what guarantees
       at-most-once execution — re-running the server is a no-op.
     - Books with a clean log (no chapter_complete entries) or no log at
       all are left untouched.

   The legacy file is preserved (not deleted) so the user can recover the
   pre-migration history if they need it. */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BOOKS_ROOT, changeLogJsonPath, dotAudiobook } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import { renameWithRetry } from './atomic-rename.js';

export interface MigrateResult {
  /** Books whose change-log was rewritten in this run. */
  migrated: string[];
  /** Books with a change-log but no chapter_complete spam — left untouched. */
  clean: string[];
  /** Books that already have a sibling .legacy.json (previous run handled them). */
  alreadyMigrated: string[];
}

interface LegacyChangeLogEntry {
  type?: unknown;
}

/** The marker that classifies an on-disk log as pre-collapse. We treat any
    persisted `chapter_complete` entry as a marker because the new write
    path never produces one — the rollup uses `generation_run_complete`
    instead. */
function looksLegacy(events: unknown[]): boolean {
  for (const e of events) {
    const t = (e as LegacyChangeLogEntry).type;
    if (t === 'chapter_complete') return true;
  }
  return false;
}

/** Walk Author/Series/Book directories and yield each book's
    .audiobook/ folder. Mirrors scanLibrary's three-level descent — kept
    self-contained here so the migration doesn't pull in the heavier
    library-scan module on the boot path. */
async function listBookDirs(): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(BOOKS_ROOT)) return out;
  for (const author of await listDirs(BOOKS_ROOT)) {
    for (const series of await listDirs(join(BOOKS_ROOT, author))) {
      for (const title of await listDirs(join(BOOKS_ROOT, author, series))) {
        out.push(join(BOOKS_ROOT, author, series, title));
      }
    }
  }
  return out;
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const ents = await readdir(path, { withFileTypes: true });
    return ents.filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
}

export async function migrateLegacyChangeLogs(): Promise<MigrateResult> {
  const result: MigrateResult = { migrated: [], clean: [], alreadyMigrated: [] };
  for (const bookDir of await listBookDirs()) {
    const logPath    = changeLogJsonPath(bookDir);
    const legacyPath = join(dotAudiobook(bookDir), 'change-log.legacy.json');

    if (!existsSync(logPath)) continue;
    if (existsSync(legacyPath)) { result.alreadyMigrated.push(bookDir); continue; }

    /* readJson returns the FULL parsed document. .audiobook/change-log.json
       on disk is a bare events array (see persistence middleware), so we
       parse as unknown and narrow defensively — older partial writes or
       hand-edits shouldn't crash the migration. */
    const doc = await readJson<unknown>(logPath).catch(() => null);
    const events: unknown[] = Array.isArray(doc)
      ? doc
      : Array.isArray((doc as { events?: unknown[] })?.events)
        ? (doc as { events: unknown[] }).events
        : [];

    if (!looksLegacy(events)) { result.clean.push(bookDir); continue; }

    /* Atomic rename + empty rewrite. Live shape mirrors what the persistence
       middleware writes — `{ events: [] }` — so the next PUT round-trip
       doesn't see a wrong-shape file. If the rename succeeds but the
       empty rewrite fails, the next boot will see no log file and the
       .legacy.json sentinel, so we keep the at-most-once guarantee. */
    await renameWithRetry(logPath, legacyPath);
    await writeJsonAtomic(logPath, { events: [] });
    result.migrated.push(bookDir);
  }
  return result;
}
