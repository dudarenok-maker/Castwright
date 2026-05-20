/* Portable book bundle packer — plan 75.

   Walks a single book directory and bundles every artifact needed to
   re-create it on another machine into a single .zip:

     portable-book/
       state.json         (BookStateJson — workspace/state-migrate.ts shape)
       manuscript.<ext>   (original ext preserved — txt/md/epub/pdf/mobi)
       cover.<ext>        (optional — .jpg today, format-detected for forward-compat)
       change-log.json    (optional — empty array if no events have been logged)
       audio/
         <chapter-slug>.mp3              (per-chapter audio; ext mirrors what's on disk)
         <chapter-slug>.segments.json    (timing metadata + speaker manifest)
         <chapter-slug>.peaks.json       (waveform peaks, when present)
       MANIFEST.json      (envelope — see PortableBundleManifest below)

   Excluded from the bundle:

     - .audiobook/listen-progress.json — private user listening bookmark,
       not portable across machines. Intentionally never crosses the
       bundle boundary even when the file exists.
     - .audiobook/analysis-state.json   — in-flight analyzer scratch.
     - .audiobook/state.json.bak.*      — rotating backups handled
       implicitly by writeJsonAtomic, no point re-shipping them.
     - .audiobook/exports/              — staged export artifacts.
     - .audiobook/dropped-quotes.json   — operator-audit only, large,
       not needed to re-create the book.

   Uses yazl streaming write — chapter audio files are added via
   addReadStream so a multi-hundred-MB book doesn't load every MP3 into
   RAM before flushing.

   Entries are emitted in deterministic order: MANIFEST first (for early
   schema-version sniffs), then state.json, manuscript, cover (if any),
   change-log (if any), then audio/ in chapter-id order. Deterministic
   ordering keeps round-trip checksum tests stable across runs. */

import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { audioDir, changeLogJsonPath, coverImagePath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';
import { findBookByBookId } from '../workspace/scan.js';

/** Bundle MANIFEST schema version. Bump on incompatible shape changes; the
    import path refuses bundles with `schemaVersion` it doesn't know. */
export const PORTABLE_SCHEMA_VERSION = 1;

export interface PortableBundleManifestContents {
  /** sha256 hex digest of the serialised state.json bytes inside the bundle.
      Round-trip tests use this to confirm state.json arrived byte-identical
      to what was packed. */
  stateJsonHash: string;
  /** sha256 hex digest of the manuscript bytes inside the bundle. */
  manuscriptHash: string;
  /** sha256 hex digest of the cover image, when present. */
  coverHash?: string;
  /** Number of audio files (mp3/m4a/ogg) packed under audio/. */
  audioCount: number;
  /** Sum of bytes (uncompressed) of every entry written into the bundle. */
  totalSizeBytes: number;
}

export interface PortableBundleManifestExportedFrom {
  /** Server package version at export time (server/package.json `version`). */
  appVersion: string;
  /** Schema version of BookStateJson — taken verbatim from state.schema so an
      importer can reject bundles whose embedded state.json predates a known
      migration. Absent when state.schema is unset. */
  stateSchemaVersion?: number;
}

export interface PortableBundleManifest {
  schemaVersion: number;
  exportedAt: string;
  exportedFrom: PortableBundleManifestExportedFrom;
  /** Identifying info pulled from state.json so a quick `unzip -p MANIFEST.json`
      tells the operator what they're looking at without parsing state.json. */
  book: {
    bookId: string;
    title: string;
    author: string;
    series: string;
  };
  contents: PortableBundleManifestContents;
}

export interface BuildPortableBundleResult {
  /** Complete zip payload. Held in memory because the route streams it
      straight to the client; if a future caller needs a path-on-disk
      variant, add an `outPath` opt later. */
  buffer: Buffer;
  /** Total bytes of the zip (== buffer.length). */
  sizeBytes: number;
  /** Internal entry names in the order they were written. */
  entries: string[];
  /** Echo of the MANIFEST so callers can log/audit without re-reading the zip. */
  manifest: PortableBundleManifest;
}

/** Look up the server's own package version once at module load. Used by
    MANIFEST.exportedFrom.appVersion. Failure (missing file in some
    weird sandbox) falls back to '0.0.0' rather than crashing the export. */
const APP_VERSION = readAppVersion();

function readAppVersion(): string {
  try {
    /* server/package.json is two levels up from server/src/export/. */
    const url = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(url, 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Resolve the cover file extension from the path on disk. Today we only
    write `.jpg` (OpenLibrary serves JPEGs) and `.png` (user uploads),
    so the helper accepts both and falls back to `.jpg` for safety. */
function coverExtFromPath(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : 'jpg';
}

/** Slug-prefixed audio asset files we want to ship: `<slug>.mp3|m4a|ogg|opus`,
    `<slug>.segments.json`, `<slug>.peaks.json`. Excludes `.previous.*`
    pairs (rollback-only state, not portable) and orphan segments without
    a paired audio file. */
function listAudioAssets(root: string, slug: string): string[] {
  if (!existsSync(root)) return [];
  /* Use the synchronous fs API here — we're inside the build pipeline,
     not on the request hot path. Keeps the loop simple. */
  const all = readdirSync(root);
  const wanted: string[] = [];
  const audioExts = ['.mp3', '.m4a', '.ogg', '.opus'];
  for (const name of all) {
    if (name.includes('.previous.')) continue;
    if (!name.startsWith(`${slug}.`)) continue;
    const lower = name.toLowerCase();
    if (audioExts.some((e) => lower.endsWith(e))) wanted.push(name);
    else if (lower.endsWith('.segments.json')) wanted.push(name);
    else if (lower.endsWith('.peaks.json')) wanted.push(name);
  }
  /* Deterministic order keeps round-trip checksums stable. */
  return wanted.sort();
}

/** Convenience overload — accept a bookId and look the book up. */
export async function buildPortableBundleByBookId(
  bookId: string,
): Promise<BuildPortableBundleResult> {
  const located = await findBookByBookId(bookId);
  if (!located) throw new Error(`book_not_found: ${bookId}`);
  return buildPortableBundle(located.bookDir, located.state);
}

/** Build the bundle for the book rooted at `bookDir`. Caller already has
    the state.json in hand (e.g. from `findBookByBookId`), so we don't
    re-read it here — that also guarantees the bytes hashed into the
    MANIFEST match what we just packed. */
export async function buildPortableBundle(
  bookDir: string,
  state: BookStateJson,
): Promise<BuildPortableBundleResult> {
  /* Serialise state.json deterministically (sorted-output not needed — JSON
     object key order is preserved in modern Node and the round-trip test
     hashes the exact bytes we write). */
  const stateBuf = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
  const stateJsonHash = sha256Hex(stateBuf);

  /* Manuscript bytes — read straight from disk so we don't double-buffer
     for large EPUBs. */
  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) {
    throw new Error(`portable_export_failed: manuscript file missing at ${manuscriptPath}`);
  }
  const manuscriptBuf = readFileSync(manuscriptPath);
  const manuscriptHash = sha256Hex(manuscriptBuf);

  /* Cover — optional. We accept the workspace's canonical .jpg path AND
     a sibling .png (some upload paths produced PNG before plan 40 settled
     on JPEG). When the bytes are missing the bundle simply omits cover.*. */
  let coverEntry: { name: string; buf: Buffer; hash: string } | null = null;
  const coverJpg = coverImagePath(bookDir);
  if (existsSync(coverJpg)) {
    const buf = readFileSync(coverJpg);
    coverEntry = { name: `cover.${coverExtFromPath(coverJpg)}`, buf, hash: sha256Hex(buf) };
  }

  /* Change-log — optional but very small when present. */
  let changeLogEntry: { name: string; buf: Buffer } | null = null;
  const changeLogPath = changeLogJsonPath(bookDir);
  if (existsSync(changeLogPath)) {
    changeLogEntry = { name: 'change-log.json', buf: readFileSync(changeLogPath) };
  }

  /* Audio assets — enumerated in chapter-id order. Excluded chapters are
     skipped (no audio on disk) but we DO ship excluded-but-rendered audio
     in case the operator later un-excludes the chapter and wants the bytes
     back without re-rendering. Excluded chapters are filtered out by
     listing only chapter slugs that appear in state.chapters. */
  const audioRoot = audioDir(bookDir);
  const audioFilesByEntry: Array<{ entryName: string; diskPath: string; size: number }> = [];
  const sortedChapters = [...state.chapters].sort((a, b) => a.id - b.id);
  let audioCount = 0;
  for (const ch of sortedChapters) {
    for (const fileName of listAudioAssets(audioRoot, ch.slug)) {
      const diskPath = join(audioRoot, fileName);
      const st = await stat(diskPath);
      audioFilesByEntry.push({
        entryName: `audio/${fileName}`,
        diskPath,
        size: st.size,
      });
      if (/\.(mp3|m4a|ogg|opus)$/i.test(fileName)) audioCount += 1;
    }
  }

  /* Total-bytes ledger for the MANIFEST — sum of uncompressed sizes of
     every entry we're about to write. The audio-listing above already
     stat'd each file; we add the in-memory entries' lengths here. */
  let totalSizeBytes =
    stateBuf.length +
    manuscriptBuf.length +
    (coverEntry?.buf.length ?? 0) +
    (changeLogEntry?.buf.length ?? 0);
  for (const a of audioFilesByEntry) totalSizeBytes += a.size;

  const manifest: PortableBundleManifest = {
    schemaVersion: PORTABLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      appVersion: APP_VERSION,
      ...(state.schema ? { stateSchemaVersion: state.schema } : {}),
    },
    book: {
      bookId: state.bookId,
      title: state.title,
      author: state.author,
      series: state.series,
    },
    contents: {
      stateJsonHash,
      manuscriptHash,
      ...(coverEntry ? { coverHash: coverEntry.hash } : {}),
      audioCount,
      totalSizeBytes,
    },
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  /* Drive yazl into an in-memory Buffer rather than a write stream. The
     resulting Buffer is what the route streams to the client and what the
     round-trip test re-imports without disk I/O. yazl's outputStream emits
     'data' Buffers and 'end' once finalised; we concatenate them. */
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });

  const entries: string[] = [];

  /* Stable mtime for every entry so the zip is byte-deterministic across
     runs of the same fixture — used by the round-trip test. We don't need
     anything realistic since import doesn't honour entry mtime. */
  const stableMtime = new Date('2024-01-01T00:00:00Z');

  function addBuffer(name: string, buf: Buffer): void {
    zip.addBuffer(buf, name, { mtime: stableMtime, compress: false });
    entries.push(name);
  }

  /* MANIFEST first so a partial-download / range-read can sniff schemaVersion
     before the rest of the bundle materialises. */
  addBuffer('MANIFEST.json', manifestBuf);
  addBuffer('state.json', stateBuf);
  addBuffer(state.manuscriptFile, manuscriptBuf);
  if (coverEntry) addBuffer(coverEntry.name, coverEntry.buf);
  if (changeLogEntry) addBuffer(changeLogEntry.name, changeLogEntry.buf);

  for (const a of audioFilesByEntry) {
    zip.addReadStream(createReadStream(a.diskPath), a.entryName, {
      size: a.size,
      mtime: stableMtime,
      compress: false,
    });
    entries.push(a.entryName);
  }

  zip.end();
  const buffer = await done;
  return {
    buffer,
    sizeBytes: buffer.length,
    entries,
    manifest,
  };
}

