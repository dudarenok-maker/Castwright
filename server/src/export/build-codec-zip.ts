/* Shared codec-zip packer for the AAC/M4A and Opus/Ogg chapter formats
   (plan 72). Mirrors `build-mp3-zip.ts` in spirit: walks `state.chapters`,
   resolves each chapter's encoded file via `findChapterAudio`, packs them
   into a zip with deterministic per-track filenames, surfaces a
   `ExportIncompleteError` listing any missing chapter slugs.

   Unlike the MP3.ZIP path, the AAC and Opus builders do NOT re-tag the
   chapter files — ID3v2.4 frames don't travel inside an M4A container
   (mp4 uses iTunes atoms) or Ogg (uses Vorbis-style comments), so a
   single-format tag-rewrite layer would have to grow per-format support.
   Voice metadata for those formats falls out of the standard M4B path,
   which already runs a re-encode pass through ffmpeg and stamps the
   QuickTime atoms. The codec-zip exports are the "raw chapters, no
   rewrite" equivalents of mp3-zip; downstream apps that read M4A / Opus
   files surface filename ordering for chapter sequencing.

   Refuses with `ExportIncompleteError` listing missing chapter slugs when
   any non-excluded chapter has no encoded file in the matching format
   on disk. Re-uses the same modal 409 banner copy as the MP3.ZIP path. */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { ZipFile } from 'yazl';
import { audioDir } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { ExportIncompleteError, pad2, sanitiseForZip } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

export type CodecZipFormat = 'aac-m4a' | 'opus';

interface FormatMetadata {
  /** On-disk extension `findChapterAudio` reports for this format. */
  diskExt: 'm4a' | 'ogg';
  /** Filename extension used inside the zip. */
  entryExt: 'm4a' | 'ogg';
}

const FORMAT_TABLE: Record<CodecZipFormat, FormatMetadata> = {
  'aac-m4a': { diskExt: 'm4a', entryExt: 'm4a' },
  opus: { diskExt: 'ogg', entryExt: 'ogg' },
};

export interface BuildCodecZipOptions {
  bookDir: string;
  state: BookStateJson;
  outPath: string;
  format: CodecZipFormat;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface BuildCodecZipResult {
  sizeBytes: number;
  entries: string[];
}

export async function buildCodecZip(opts: BuildCodecZipOptions): Promise<BuildCodecZipResult> {
  const { bookDir, state, outPath, format, onProgress, signal } = opts;
  const meta = FORMAT_TABLE[format];

  const chapters = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);

  const root = audioDir(bookDir);
  const missing: string[] = [];
  const resolved: Array<{ chapter: (typeof chapters)[number]; path: string }> = [];
  for (const chapter of chapters) {
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio || audio.ext !== meta.diskExt) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ chapter, path: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const total = resolved.length;
  const entries: string[] = [];

  /* Stage in a sibling dir for the chance of cleanup-on-failure. The
     codec-zip path doesn't re-encode (no tag rewrite step today), so it
     could in principle stream straight from the original audio files —
     keeping the staging dir keeps the cleanup behaviour identical to
     the mp3-zip path and lets a future per-format tag rewrite slot in
     without restructuring. */
  const stagingDir = `${outPath}.staging-${process.pid}-${Date.now()}`;
  await mkdir(stagingDir, { recursive: true });

  try {
    const zip = new ZipFile();
    const writePromise = new Promise<number>((resolve, reject) => {
      const ws = createWriteStream(outPath);
      ws.on('error', reject);
      let bytes = 0;
      zip.outputStream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      zip.outputStream.on('error', reject);
      zip.outputStream.pipe(ws).on('finish', () => resolve(bytes));
    });

    for (let i = 0; i < resolved.length; i++) {
      signal?.throwIfAborted();
      const { chapter, path } = resolved[i];
      const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.${meta.entryExt}`;
      const st = await stat(path);
      zip.addReadStream(createReadStream(path), entryName, {
        size: st.size,
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
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
