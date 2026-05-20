/* Portable book bundle reader — inverse of server/src/export/build-portable-book.ts.

   Accepts a zip buffer produced by `buildPortableBundle`, validates its
   MANIFEST.json schema version, and lays the entries down under the
   workspace's books/<Author>/<Series>/<Book>/ tree. Returns the new bookId
   + the on-disk target path.

   Conflict handling (when the target dir already exists):

     - 'rename'   (default) — append `-imported-1`, `-imported-2`, … to
                              the book title until the slug-based target
                              dir is free. Also adjusts state.json's
                              `title` + `bookId` to match the rewritten
                              dir.
     - 'overwrite'           — write into the existing dir, replacing files
                              by the same path. Files that exist on disk
                              but not in the bundle are LEFT IN PLACE
                              (e.g. user's listen-progress.json which was
                              intentionally excluded from the bundle).
     - 'fail'                — throws BundleConflictError without touching
                              disk.

   Atomicity: every file in the bundle is written to a `.tmp-<pid>-<ts>`
   sibling first; once every write succeeds, we rename each tmp file over
   the live path. On ANY failure during the write phase, the tmp files
   are removed and no live file is touched. (This is per-file atomic, not
   bundle-atomic — a crash AFTER the first rename but before the last
   leaves a half-imported book. Operators recover by deleting the partial
   target dir and re-importing.) */

import { existsSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fromBuffer as yauzlFromBuffer, type ZipFile, type Entry } from 'yauzl';
import {
  STANDALONES_SERIES,
  audioDir,
  bookDirByDisplay,
  dotAudiobook,
  ensureWorkspace,
  makeBookId,
  stateJsonPath,
} from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';
import {
  PORTABLE_SCHEMA_VERSION,
  type PortableBundleManifest,
} from '../export/build-portable-book.js';

export type ConflictStrategy = 'rename' | 'overwrite' | 'fail';

export interface ImportPortableBundleOptions {
  onConflict?: ConflictStrategy;
}

export interface ImportPortableBundleResult {
  bookId: string;
  targetPath: string;
  importedFiles: number;
  conflict?: { strategy: ConflictStrategy; renamedTo?: string };
}

export class BundleConflictError extends Error {
  readonly existingPath: string;
  constructor(existingPath: string) {
    super(`bundle_conflict: a book already exists at ${existingPath}`);
    this.name = 'BundleConflictError';
    this.existingPath = existingPath;
  }
}

export class InvalidBundleError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'InvalidBundleError';
    this.reason = reason;
  }
}

/** Read every entry from a yauzl ZipFile into memory. The bundle is bounded
    by the multipart upload limit (50 MB by default), so loading the whole
    thing into RAM keeps the import path simple. For larger bundles this
    becomes streaming territory — out of scope for v1. */
async function readAllEntries(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzlFromBuffer(zipBuffer, { lazyEntries: true }, (err, zipFile) => {
      if (err || !zipFile) return reject(err ?? new Error('yauzl: empty zipFile'));
      const out = new Map<string, Buffer>();
      const z = zipFile as ZipFile;
      z.on('error', reject);
      z.on('end', () => resolve(out));
      z.on('entry', (entry: Entry) => {
        /* Directory entries end in '/'. We skip them — the writer
           creates parent dirs implicitly via mkdir({ recursive: true }). */
        if (entry.fileName.endsWith('/')) {
          z.readEntry();
          return;
        }
        z.openReadStream(entry, (rsErr, rs) => {
          if (rsErr || !rs) return reject(rsErr ?? new Error('yauzl: empty read stream'));
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            z.readEntry();
          });
          rs.on('error', reject);
        });
      });
      z.readEntry();
    });
  });
}

/** Append " (imported)" / " (imported 2)" / … to the title until the
    resulting bookDir doesn't exist. Returns the resolved bookDir path,
    the adjusted title, and the new bookId.

    The first-collision suffix is " (imported)" rather than " (imported 1)"
    because a single re-import (the common case) should produce a clean
    label; numeric suffixes only appear when the user is importing the same
    bundle multiple times.

    `attempts` is capped at 100 to keep a runaway-loop bug visible — a
    workspace with 100 colliding imports is almost certainly a script gone
    wrong. */
function resolveRenamedTarget(
  author: string,
  series: string,
  baseTitle: string,
): { bookDir: string; title: string; bookId: string } {
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? ' (imported)' : ` (imported ${i + 1})`;
    const title = `${baseTitle}${suffix}`;
    const bookDir = bookDirByDisplay(author, series, title);
    if (!existsSync(bookDir)) {
      return { bookDir, title, bookId: makeBookId(author, series, title) };
    }
  }
  throw new Error('bundle_conflict: too many colliding imports; aborting after 100 attempts');
}

export async function importPortableBundle(
  zipBuffer: Buffer,
  opts: ImportPortableBundleOptions = {},
): Promise<ImportPortableBundleResult> {
  ensureWorkspace();
  const strategy: ConflictStrategy = opts.onConflict ?? 'rename';

  let entries: Map<string, Buffer>;
  try {
    entries = await readAllEntries(zipBuffer);
  } catch (e) {
    throw new InvalidBundleError(
      'malformed_zip',
      `Bundle could not be read as a zip archive: ${(e as Error).message}`,
    );
  }

  /* MANIFEST + state.json are mandatory. Missing either → InvalidBundleError
     with a precise reason so the route can return a 400 with copy that
     doesn't say "something went wrong". */
  const manifestRaw = entries.get('MANIFEST.json');
  if (!manifestRaw) {
    throw new InvalidBundleError('missing_manifest', 'Bundle is missing MANIFEST.json.');
  }
  let manifest: PortableBundleManifest;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8')) as PortableBundleManifest;
  } catch (e) {
    throw new InvalidBundleError(
      'malformed_manifest',
      `MANIFEST.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (typeof manifest.schemaVersion !== 'number') {
    throw new InvalidBundleError(
      'unknown_schema',
      `MANIFEST.json has no schemaVersion. Expected ${PORTABLE_SCHEMA_VERSION}.`,
    );
  }
  if (manifest.schemaVersion > PORTABLE_SCHEMA_VERSION) {
    throw new InvalidBundleError(
      'unsupported_schema',
      `Bundle MANIFEST.schemaVersion=${manifest.schemaVersion} but this server only understands up to ${PORTABLE_SCHEMA_VERSION}.`,
    );
  }

  const stateRaw = entries.get('state.json');
  if (!stateRaw) {
    throw new InvalidBundleError('missing_state', 'Bundle is missing state.json.');
  }
  let state: BookStateJson;
  try {
    state = JSON.parse(stateRaw.toString('utf8')) as BookStateJson;
  } catch (e) {
    throw new InvalidBundleError(
      'malformed_state',
      `state.json is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (!state.title || !state.author || !state.manuscriptFile) {
    throw new InvalidBundleError(
      'incomplete_state',
      'state.json is missing one of: title, author, manuscriptFile.',
    );
  }

  const author = state.author;
  const series = state.series || STANDALONES_SERIES;
  const baseTitle = state.title;
  let bookDir = bookDirByDisplay(author, series, baseTitle);
  let resolvedTitle = baseTitle;
  let resolvedBookId = state.bookId || makeBookId(author, series, baseTitle);
  let renamedTo: string | undefined;

  if (existsSync(bookDir)) {
    if (strategy === 'fail') {
      throw new BundleConflictError(bookDir);
    }
    if (strategy === 'rename') {
      const renamed = resolveRenamedTarget(author, series, baseTitle);
      bookDir = renamed.bookDir;
      resolvedTitle = renamed.title;
      resolvedBookId = renamed.bookId;
      renamedTo = bookDir;
      state = { ...state, title: resolvedTitle, bookId: resolvedBookId };
    }
    /* 'overwrite' falls through — bookDir stays as the existing path. */
  }

  /* Stage every entry into a tmp file alongside its eventual home, then
     promote all of them via rename. Per-file atomicity (see file-header
     comment for the caveat about bundle-atomicity). */
  await mkdir(bookDir, { recursive: true });
  await mkdir(dotAudiobook(bookDir), { recursive: true });
  await mkdir(audioDir(bookDir), { recursive: true });

  /* Re-serialise state.json from the (possibly renamed) in-memory shape
     instead of writing stateRaw verbatim — otherwise the bookId / title
     in the rename branch wouldn't actually land on disk. */
  const finalStateBuf = Buffer.from(JSON.stringify(state, null, 2), 'utf8');

  type Staged = { dest: string; tmp: string; buf: Buffer | null; sourceEntry?: string };
  const staged: Staged[] = [];
  const tmpSuffix = `.tmp-${process.pid}-${Date.now()}`;

  function planEntry(dest: string, buf: Buffer, sourceEntry: string): void {
    staged.push({ dest, tmp: `${dest}${tmpSuffix}`, buf, sourceEntry });
  }

  planEntry(stateJsonPath(bookDir), finalStateBuf, 'state.json');
  const manuscriptBuf = entries.get(state.manuscriptFile);
  if (!manuscriptBuf) {
    throw new InvalidBundleError(
      'missing_manuscript',
      `Bundle references manuscript ${state.manuscriptFile} but the file is absent.`,
    );
  }
  planEntry(join(bookDir, state.manuscriptFile), manuscriptBuf, state.manuscriptFile);

  /* Optional top-level entries: cover.{jpg,png,…} and change-log.json. */
  for (const [name, buf] of entries.entries()) {
    if (name === 'MANIFEST.json' || name === 'state.json') continue;
    if (name === state.manuscriptFile) continue;
    if (name.startsWith('audio/')) continue;
    /* Cover and change-log land in .audiobook/, everything else top-level
       is unexpected — log + skip rather than fail, so a forward-compat
       writer adding fields doesn't break older importers. */
    if (name === 'change-log.json') {
      planEntry(join(dotAudiobook(bookDir), 'change-log.json'), buf, name);
      continue;
    }
    if (name.startsWith('cover.')) {
      planEntry(join(dotAudiobook(bookDir), name), buf, name);
      continue;
    }
    /* Forward-compat: skip silently. */
  }

  /* Audio entries — audio/<slug>.<ext>. Restored into <bookDir>/audio/. */
  const audioRoot = audioDir(bookDir);
  for (const [name, buf] of entries.entries()) {
    if (!name.startsWith('audio/')) continue;
    const relPath = name.slice('audio/'.length);
    if (!relPath) continue;
    planEntry(join(audioRoot, relPath), buf, name);
  }

  /* Phase 1: write every tmp file. On ANY failure, unlink the ones already
     written and abort before touching live files. */
  const tmpsWritten: string[] = [];
  try {
    for (const s of staged) {
      if (s.buf === null) continue;
      await mkdir(dirname(s.tmp), { recursive: true });
      await writeFile(s.tmp, s.buf);
      tmpsWritten.push(s.tmp);
    }
  } catch (e) {
    for (const t of tmpsWritten) await unlink(t).catch(() => {});
    throw e;
  }

  /* Phase 2: rename each tmp file over its final destination. Failure
     mid-rename is the half-imported case called out in the header. */
  try {
    for (const s of staged) {
      await rename(s.tmp, s.dest);
    }
  } catch (e) {
    /* Best-effort cleanup of remaining tmp files (the ones we hadn't
       renamed yet); already-renamed live files are left in place because
       we don't have their pre-import bytes any more. */
    for (const t of tmpsWritten) await unlink(t).catch(() => {});
    throw e;
  }

  return {
    bookId: resolvedBookId,
    targetPath: bookDir,
    importedFiles: staged.length,
    ...(strategy === 'rename' && renamedTo
      ? { conflict: { strategy: 'rename' as const, renamedTo } }
      : {}),
  };
}
