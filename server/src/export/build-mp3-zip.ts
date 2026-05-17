/* MP3.ZIP packer — Phase A of the audiobook export pipeline.

   Walks `state.chapters` (sorted by id, excluding any with `excluded === true`),
   resolves each chapter's `.mp3` on disk via the shared findChapterAudio
   probe, re-tags each one with chapter/book ID3v2.4 metadata via
   applyId3v24Tags (no re-encode — `-c:a copy` only), then streams the
   tagged files into a single zip via yazl.

   PocketBook Reader Android reads the resulting `*.zip` as a multi-chapter
   audiobook ordered by filename, displaying the TIT2 / TALB / TPE1 / TPE2 /
   TRCK frames as Title / Album / Author. Other apps (Voice, Plex, etc.)
   accept the same shape.

   Refuses with `ExportIncompleteError` listing missing chapter slugs when
   any non-excluded chapter has no `.mp3` on disk. Callers turn that into a
   409 with a clickable "Regenerate missing chapters" hint in the export
   modal. */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { applyId3v24Tags, type Id3Tags } from './id3-tags.js';
import type { BookStateJson } from '../workspace/scan.js';

export interface BuildMp3ZipOptions {
  bookDir: string;
  state: BookStateJson;
  outPath: string;
  /** Optional progress callback — fires once per chapter packed, with a
      0..1 ratio. The route uses this to update the job's `progress`. */
  onProgress?: (ratio: number) => void;
}

export interface BuildMp3ZipResult {
  sizeBytes: number;
  /** Filenames inside the zip, in the order they were written. Useful for
      the regression test + the change-log entry the route writes. */
  entries: string[];
}

export class ExportIncompleteError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Export incomplete: ${missing.length} chapter(s) lack an MP3 audio file.`);
    this.name = 'ExportIncompleteError';
    this.missing = missing;
  }
}

export async function buildMp3Zip(opts: BuildMp3ZipOptions): Promise<BuildMp3ZipResult> {
  const { bookDir, state, outPath, onProgress } = opts;

  const chapters = [...state.chapters]
    .filter(c => !c.excluded)
    .sort((a, b) => a.id - b.id);

  /* Pre-flight: every non-excluded chapter must have an MP3 on disk.
     Surface ALL missing slugs in one go so the user gets a full punch
     list, not one-at-a-time errors. */
  const root = audioDir(bookDir);
  const missing: string[] = [];
  const resolved: Array<{ idx: number; chapter: typeof chapters[number]; mp3Path: string }> = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ idx: i, chapter, mp3Path: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const total = resolved.length;
  const albumArtist = state.author;
  const artist = (state.narratorCredit && state.narratorCredit.trim()) || state.author;
  const album = state.title;

  /* Plan 36 A3: embed the cached OpenLibrary cover into each chapter's
     ID3v2 header as an APIC frame when one exists. Absent → no APIC
     frame, ID3 round-trip is otherwise unchanged. Probed once per export
     (the file doesn't change mid-export). */
  const coverDiskPath = coverImagePath(bookDir);
  const coverJpegPath: string | null = existsSync(coverDiskPath) ? coverDiskPath : null;

  /* Stage each tagged MP3 in a temp dir alongside the output, then zip
     them. We can't pipe ffmpeg-stdout straight into yazl because yazl
     wants Readable streams with a known content-length, and ffmpeg's
     ID3v2 + Xing-header rewrite means we don't know that until the
     file is done. A small per-chapter temp file is simpler and the I/O
     is dwarfed by the zip write itself. */
  const stagingDir = `${outPath}.staging-${process.pid}-${Date.now()}`;
  await mkdir(stagingDir, { recursive: true });

  const entries: string[] = [];
  try {
    const zip = new ZipFile();
    const writePromise = new Promise<number>((resolve, reject) => {
      const ws = createWriteStream(outPath);
      ws.on('error', reject);
      let bytes = 0;
      zip.outputStream.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      zip.outputStream.on('error', reject);
      zip.outputStream.pipe(ws).on('finish', () => resolve(bytes));
    });

    for (let i = 0; i < resolved.length; i++) {
      const { chapter, mp3Path } = resolved[i];
      const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.mp3`;
      const taggedPath = join(stagingDir, entryName);

      const tags: Id3Tags = {
        title:       chapter.title,
        album,
        artist,
        albumArtist,
        track:       i + 1,
        trackTotal:  total,
        genre:       state.genre ?? null,
        date:        state.publicationDate ?? null,
      };
      await applyId3v24Tags(mp3Path, taggedPath, tags, { coverJpegPath });
      const taggedStat = await stat(taggedPath);

      /* `compress: false` keeps entries "stored" — MP3 is already
         compressed, so deflate would burn CPU for ~0-1% gain. Stored
         entries also stay byte-readable from the zip without inflate,
         which keeps the test harness simple. */
      zip.addReadStream(createReadStream(taggedPath), entryName, {
        size: taggedStat.size,
        mtime: new Date(),
        compress: false,
      });
      entries.push(entryName);
      onProgress?.((i + 1) / total);
    }
    zip.end();
    const sizeBytes = await writePromise;
    return { sizeBytes, entries };
  } finally {
    /* Best-effort staging cleanup. If this throws, the caller's higher-up
       failure handler will already be reporting the build error — don't
       overwrite that with a cleanup-only complaint. */
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/* FAT32-safe filename. PocketBook Reader on Android reads from internal
   storage *or* removable SD; SD cards are typically FAT32, which forbids
   `\ / : * ? " < > |` and trims trailing dots/spaces. Em-dash is fine
   on FAT32 (UTF-16 LFN), but downgrade to ` - ` so titles also survive
   if the user copies the zip onto an old MTP-only e-reader path that
   can't handle the higher codepoint. */
export function sanitiseForZip(name: string): string {
  const cleaned = name
    .replace(/—/g, ' - ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  return cleaned || 'Untitled';
}
