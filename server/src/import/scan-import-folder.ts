/* Portable book bundle reader — inverse of server/src/export/build-portable-book.ts.

   Accepts a zip buffer produced by `buildPortableBundle`, validates its
   MANIFEST.json schema version, and lays the entries down under the
   workspace's books/<Author>/<Series>/<Book>/ tree. Returns the new bookId
   + the on-disk target path.

   Conflict handling (when the target dir already exists):

     - 'rename'   (default) — append ` (imported)`, ` (imported 2)`, … to
                              the book title until the slug-based target
                              dir is free. Also adjusts state.json's
                              `title` + `bookId` to match the rewritten
                              dir.
     - 'overwrite'           — write into the existing dir, replacing files
                              by the same path. Files that exist on disk
                              but not in the bundle are LEFT IN PLACE
                              (e.g. user's listen-progress.json which was
                              intentionally excluded from the bundle). The
                              existing book KEEPS its bookId, and the
                              overwrite is refused (BookBusyError) while a
                              long job is registered for it.
     - 'fail'                — throws BundleConflictError without touching
                              disk.

   #3711 — bookIds are unique: a bundle's own id is kept only when nothing in
   the workspace carries it; otherwise a fresh one is minted (`mintBookId`).

   Staging + atomicity: every entry is first written under
   `<workspace>/.staging/<nonce>/` (outside `books/`, same volume), with no lock
   held. A fresh/`rename` import then takes the path claim only for the
   collision check, the bookId, and ONE directory rename into place — atomic. An
   'overwrite' takes book-op(existing id) -> the claim, re-checks the target
   still carries that id (else BundleConflictError), then renames the staged
   files over the live ones (per-file atomic, not bundle-atomic — a crash after
   the first rename but before the last leaves a half-imported book; operators
   recover by deleting the partial target dir and re-importing). A crash leaves
   an orphan `.staging/<nonce>` which the startup sweep removes after an hour. */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import { dirname, join, relative } from 'node:path';
import { fromBuffer as yauzlFromBuffer, type ZipFile, type Entry } from 'yauzl';
import {
  STANDALONES_SERIES,
  audioDir,
  bookDirByDisplay,
  dotAudiobook,
  ensureWorkspace,
  manuscriptHintsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import { reencodeToJpeg } from '../cover/reencode.js';
import { withStateJsonLock } from '../workspace/file-lock.js';
import { removeManuscript } from '../store/manuscripts.js';
import {
  BOOK_GONE,
  BookBusyError,
  bookJobKinds,
  bookIdTakenIn,
  manuscriptIdTakenIn,
  mintBookIdFrom,
  takenBookIds,
  type TakenIds,
  readBookStateOrThrow,
  withBookOp,
  withBookPathClaim,
} from '../workspace/book-op-lock.js';
import { assertContained } from '../util/safe-path.js';
import { makeStagingDir } from '../workspace/portable-staging.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
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
    and the adjusted title.

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
): { bookDir: string; title: string } {
  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? ' (imported)' : ` (imported ${i + 1})`;
    const title = `${baseTitle}${suffix}`;
    const bookDir = bookDirByDisplay(author, series, title);
    if (!existsSync(bookDir)) {
      return { bookDir, title };
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

  /* #3711 -- stage EVERY entry into `<workspace>/.staging/<nonce>/` first. That
     is outside `books/` and on the same volume, with no lock and no write under
     `books/`: a slow bundle never holds the path claim, and a half-written book
     is never visible to a scan or a resolve. The tree mirrors the final book
     folder, so a fresh/`rename` import is placed by ONE directory rename. */
  const stage = await makeStagingDir();
  try {
    /* Staged files, relative to the book folder (state.json first, as before: the
       overwrite path renames them over live files in this order). */
    const stagedRel: string[] = [];
    /* A bundle-supplied name (state.manuscriptFile, an audio/ entry) must land
       inside `root`. yauzl already refuses `..` entry names, but that is a
       dependency default this write must not lean on. */
    const stageFile = async (rel: string, buf: Buffer, root: string = stage): Promise<void> => {
      const dest = join(stage, rel);
      try {
        assertContained(root, dest);
      } catch {
        throw new InvalidBundleError(
          'unsafe_path',
          `Bundle entry "${rel}" escapes the book folder.`,
        );
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      stagedRel.push(rel);
    };
    const stateRel = relative(stage, stateJsonPath(stage));
    /* The final state.json is written once the bookId and title are decided under
       the claim; reserve its slot (and the directory skeleton) now. */
    stagedRel.push(stateRel);
    await mkdir(dotAudiobook(stage), { recursive: true });
    await mkdir(audioDir(stage), { recursive: true });

    const manuscriptBuf = entries.get(state.manuscriptFile);
    if (!manuscriptBuf) {
      throw new InvalidBundleError(
        'missing_manuscript',
        `Bundle references manuscript ${state.manuscriptFile} but the file is absent.`,
      );
    }
    await stageFile(state.manuscriptFile, manuscriptBuf);

    /* Optional top-level entries: cover.{jpg,png,…}, change-log.json and
       manuscript-hints.json. */
    const coverEntries: [string, Buffer][] = [];
    for (const [name, buf] of entries.entries()) {
      if (name === 'MANIFEST.json' || name === 'state.json') continue;
      if (name === state.manuscriptFile) continue;
      if (name.startsWith('audio/')) continue;
      /* Cover, change-log and manuscript-hints land in .audiobook/, everything
         else top-level is unexpected — log + skip rather than fail, so a
         forward-compat writer adding fields doesn't break older importers. */
      if (name === 'change-log.json') {
        await stageFile(relative(stage, join(dotAudiobook(stage), 'change-log.json')), buf);
        continue;
      }
      if (name === 'manuscript-hints.json') {
        await stageFile(
          relative(stage, join(dotAudiobook(stage), 'manuscript-hints.json')),
          buf,
        );
        continue;
      }
      if (name.startsWith('cover.')) {
        coverEntries.push([name, buf]);
        continue;
      }
      /* Forward-compat: skip silently. */
    }

    /* #3535: re-encode the cover to a clean JPEG like every other cover path,
       and store it as cover.jpg whatever the entry's extension. Every cover.*
       entry shares that one destination, so stage at most one: an exact
       cover.jpg first, else the first that decodes. An undecodable entry is
       skipped (the book still imports), like an unknown entry. */
    coverEntries.sort(([a], [b]) => Number(b === 'cover.jpg') - Number(a === 'cover.jpg'));
    let coverStaged = false;
    for (const [name, buf] of coverEntries) {
      if (coverStaged) {
        console.warn(`[import] skipping extra cover entry ${name}: one cover per bundle`);
        continue;
      }
      try {
        const jpeg = await reencodeToJpeg(buf, { tolerant: true });
        await stageFile(relative(stage, join(dotAudiobook(stage), 'cover.jpg')), jpeg);
        coverStaged = true;
      } catch (e) {
        console.warn(`[import] skipping undecodable cover entry ${name}: ${(e as Error).message}`);
      }
    }

    /* Audio entries — audio/<slug>.<ext>. Restored into <bookDir>/audio/. */
    const audioRoot = audioDir(stage);
    for (const [name, buf] of entries.entries()) {
      if (!name.startsWith('audio/')) continue;
      const relPath = name.slice('audio/'.length);
      if (!relPath) continue;
      await stageFile(relative(stage, join(audioRoot, relPath)), buf, audioRoot);
    }

    /* Re-serialise state.json from the in-memory shape instead of writing
       stateRaw verbatim, so the decided bookId / title actually land on disk. A
       bundle state.json with no `language` lands as an explicit `language: null`
       (key present); a bundle that carries a language round-trips unchanged. */
    const writeStagedState = (
      bookId: string,
      title: string,
      manuscriptId: string | undefined = state.manuscriptId,
    ): Promise<void> =>
      writeFile(
        stateJsonPath(stage),
        JSON.stringify(
          { ...state, title, bookId, manuscriptId, language: state.language ?? null },
          null,
          2,
        ),
        'utf8',
      );

    /* #3823 -- a book whose manuscriptId ANOTHER book already carries (a renamed
       copy, an id-taken re-import into a free folder, an overwrite of a different
       book) gets its own: one in-memory ManuscriptRecord per id, so a shared id
       lets restructuring one twin rewrite the hints the other reads. An unused id
       is kept. The staged hints entries are keyed by the id they were written
       under, so re-key them to the fresh one or the copy's own hints stop
       validating (`manuscriptId` mismatch -> re-parse). A hints file the reader
       would reject anyway (unparseable, no `entries` array) is dropped instead:
       the copy re-parses, as it would have; a non-object entry is left alone.
       Analysis state / edits / the analyzer cache are not in a bundle. */
    const freshManuscriptId = async (
      ids: TakenIds,
    ): Promise<string | undefined> => {
      if (!state.manuscriptId || !manuscriptIdTakenIn(ids, state.manuscriptId)) {
        return state.manuscriptId;
      }
      const manuscriptId = 'mns_' + nanoid(10);
      const hintsPath = manuscriptHintsJsonPath(stage);
      if (existsSync(hintsPath)) {
        let file: { entries?: unknown } | null = null;
        try {
          file = JSON.parse(await readFile(hintsPath, 'utf8')) as { entries?: unknown } | null;
        } catch {
          /* unparseable: dropped below */
        }
        if (file && typeof file === 'object' && Array.isArray(file.entries)) {
          for (const entry of file.entries) {
            if (entry && typeof entry === 'object') {
              (entry as { manuscriptId?: string }).manuscriptId = manuscriptId;
            }
          }
          await writeFile(hintsPath, JSON.stringify(file, null, 2), 'utf8');
        } else {
          await rm(hintsPath, { force: true });
          const rel = relative(stage, hintsPath);
          const at = stagedRel.indexOf(rel);
          if (at >= 0) stagedRel.splice(at, 1);
        }
      }
      return manuscriptId;
    };

    /* The id a NEW book gets: the bundle's own when nothing in the workspace
       carries it, else a minted one (never two books with one id). Called under
       the claim. */
    const idForNewBook = (ids: TakenIds, title: string, keepBundleId: boolean): string =>
      keepBundleId && state.bookId && !bookIdTakenIn(ids, state.bookId)
        ? state.bookId
        : mintBookIdFrom(ids, author, series, title);

    /* Fresh / `rename` import. Under the claim ONLY: collision check -> bookId ->
       mkdir the parents -> one directory rename of the staged tree into place. */
    const placeFresh = (): Promise<ImportPortableBundleResult> =>
      withBookPathClaim(async () => {
        let bookDir = bookDirByDisplay(author, series, baseTitle);
        let title = baseTitle;
        let renamedTo: string | undefined;
        if (existsSync(bookDir)) {
          /* 'fail' -- or an 'overwrite' whose target is not a book we can lock. */
          if (strategy !== 'rename') throw new BundleConflictError(bookDir);
          const renamed = resolveRenamedTarget(author, series, baseTitle);
          bookDir = renamed.bookDir;
          title = renamed.title;
          renamedTo = bookDir;
        }
        /* ONE walk under the claim answers the bookId and manuscriptId decisions. */
        const ids = await takenBookIds();
        const bookId = idForNewBook(ids, title, renamedTo === undefined);
        const manuscriptId = await freshManuscriptId(ids);
        await writeStagedState(bookId, title, manuscriptId);
        await mkdir(dirname(bookDir), { recursive: true });
        /* Placed under the target's state-json lock too (#3625: every bundle
           promotion holds it), so no state.json writer of that path interleaves. */
        await withStateJsonLock(stateJsonPath(bookDir), () => renameWithRetry(stage, bookDir));
        return {
          bookId,
          targetPath: bookDir,
          importedFiles: stagedRel.length,
          ...(renamedTo ? { conflict: { strategy: 'rename' as const, renamedTo } } : {}),
        };
      });

    /* 'overwrite' into an existing folder, under the claim: re-check the target
       still carries `expectedId` (null = it carried none), else it is a conflict;
       then rename the staged files over the live ones, state.json first, holding
       state-json(target) as before. Files only on disk are LEFT IN PLACE, except
       a local manuscript-hints.json the bundle does not carry (dropped as soon
       as state.json lands). */
    const commitOverwrite = (
      targetDir: string,
      expectedId: string | null,
    ): Promise<ImportPortableBundleResult> =>
      withBookPathClaim(async () => {
        /* A read error is the curated refusal, never "carries no id" (review pass 4). */
        const live = await readBookStateOrThrow(targetDir);
        if (!existsSync(targetDir) || (live?.bookId ?? null) !== expectedId) {
          throw new BundleConflictError(targetDir);
        }
        /* The target folder is left out of the walk: its own ids are not "taken"
           against the bundle replacing it (keyed by folder -- its state may carry no
           bookId). A book OTHER than the target carrying the bundle's manuscriptId
           still forces a fresh one (#3823). */
        const ids = await takenBookIds(targetDir);
        const bookId = expectedId ?? idForNewBook(ids, baseTitle, true);
        const manuscriptId = await freshManuscriptId(ids);
        await writeStagedState(bookId, baseTitle, manuscriptId);
        /* #3703 -- the manuscript on disk is becoming the bundle's, so a local
           restructure's hints describe another book's bodies and can still
           validate (same uuid sequence, same manuscript bytes). The hints file
           is therefore settled the moment the bundle's state.json is live -- the
           bundle's own renamed in right behind it, or, when the bundle carries
           none, the local one removed -- NOT after the loop: a later rename
           failing (EBUSY on the manuscript or an audio file) would otherwise
           leave the restored state beside the stale local file. */
        const hintsRel = relative(stage, manuscriptHintsJsonPath(stage));
        const bundleHasHints = stagedRel.includes(hintsRel);
        const order = [
          stateRel,
          ...(bundleHasHints ? [hintsRel] : []),
          ...stagedRel.filter((rel) => rel !== stateRel && rel !== hintsRel),
        ];
        try {
          await withStateJsonLock(stateJsonPath(targetDir), async () => {
            for (const [i, rel] of order.entries()) {
              const dest = join(targetDir, rel);
              await mkdir(dirname(dest), { recursive: true });
              await rename(join(stage, rel), dest);
              if (i === 0 && !bundleHasHints) {
                await rm(manuscriptHintsJsonPath(targetDir), { force: true });
              }
            }
          });
        } finally {
          /* PR #3714 review pass 5 -- the manuscript on disk was replaced, so a
             warm ManuscriptRecord for either id is now another book's text: drop
             both, and the next reader (a restructure, an analysis start)
             re-hydrates from disk. In a `finally`: an overwrite that fails part-way
             has still replaced some files, so the warm record is stale either way. */
          if (live?.manuscriptId) removeManuscript(live.manuscriptId);
          if (state.manuscriptId) removeManuscript(state.manuscriptId);
        }
        return { bookId, targetPath: targetDir, importedFiles: stagedRel.length };
      });

    const targetDir = bookDirByDisplay(author, series, baseTitle);
    if (strategy === 'overwrite' && existsSync(targetDir)) {
      /* Read the existing id UNLOCKED, take that book's book-op, then the claim
         (lock order: book-op -> book-path-claim). The overwrite KEEPS the existing
         bookId and is refused while a long job is registered for it. */
      /* PR #3714 review pass 4 -- a state that does not parse carries no id
         (null), but a READ failure is not "no id": treating it so skipped book-op
         and the busy refusal and re-id'd a book a render was still writing. It
         is the curated `BookStateUnreadableError`, and nothing is replaced. */
      const existing = await readBookStateOrThrow(targetDir);
      const existingId = existing?.bookId;
      if (!existingId) return await commitOverwrite(targetDir, null);
      const overwritten = await withBookOp(existingId, async () => {
        const kinds = bookJobKinds(existingId);
        if (kinds.length > 0) throw new BookBusyError(kinds);
        return commitOverwrite(targetDir, existingId);
      });
      if (overwritten !== BOOK_GONE) return overwritten;
      /* The book left the library while we queued: import it as a fresh one. */
    }
    return await placeFresh();
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
