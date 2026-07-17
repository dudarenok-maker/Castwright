/* MP3-folder packer — the folder-based variant of the audiobook export
   pipeline (plan 34).

   Mirrors `buildMp3Zip`'s precheck + per-chapter `applyId3v24Tags`
   shape but writes each tagged MP3 directly into a destination folder
   instead of streaming into a zip. The intended consumers are folder-
   scanning Android audiobook apps (Smart AudioBook Player,
   Audiobookshelf, BookPlayer-via-Files-import) that ingest a folder
   per book rather than a single archive.

   Audio bytes are preserved verbatim — `applyId3v24Tags` runs with
   `-c:a copy`, only the ID3v2 header (including the optional APIC
   cover frame the cover-art pipeline embeds via plan 36 A3) is rewritten.

   Reuses the same `ExportIncompleteError` from `build-mp3-zip.ts` so
   the route's 409 handling stays uniform across formats. */

import { stat, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { sanitizeIdSegment } from '../util/safe-path.js';
import { applyId3v24Tags, type Id3Tags } from './id3-tags.js';
import { ExportIncompleteError, pad2, sanitiseForZip } from './build-mp3-zip.js';
import { DEFAULT_NARRATOR_CREDIT, artistForExport } from './narrator-credit.js';
import { bookStateLanguage, type BookStateJson } from '../workspace/scan.js';

export interface BuildMp3FolderOptions {
  bookDir: string;
  state: BookStateJson;
  /** Destination directory the per-chapter MP3s land in. The caller
      decides the path shape — typically `<stagingRoot>/<book-title>/`
      so the consumer app sees one folder per book. The builder mkdirs
      it if needed. */
  outDir: string;
  /** Progress callback — fires once per chapter packed, with a 0..1
      ratio. Mirrors `buildMp3Zip`. */
  onProgress?: (ratio: number) => void;
  /** Optional cancellation signal — checked between chapters. */
  signal?: AbortSignal;
}

export interface BuildMp3FolderResult {
  /** Sum of all chapter MP3 sizes on disk after the tag rewrite. */
  totalBytes: number;
  /** Absolute paths of every file written into `outDir`, in pack order.
      The route uses this to report progress + drive the sync-folder copy. */
  entries: string[];
}

export async function buildMp3Folder(opts: BuildMp3FolderOptions): Promise<BuildMp3FolderResult> {
  const { bookDir, state, outDir, onProgress, signal } = opts;

  const chapters = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);

  /* Same precheck as buildMp3Zip — surface ALL missing slugs at once. */
  const root = audioDir(bookDir);
  const missing: string[] = [];
  const resolved: Array<{ chapter: (typeof chapters)[number]; mp3Path: string }> = [];
  for (const chapter of chapters) {
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ chapter, mp3Path: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const total = resolved.length;
  const albumArtist = state.author;
  const artist = artistForExport(state);
  const album = state.title;

  /* fs-54 — same series gate as buildFfmetadata (build-m4b.ts). */
  const hasSeries = state.isStandalone !== true && !!state.series?.trim();

  /* Plan 36 A3: thread the cached cover into every chapter's APIC
     frame when one is on disk. Probe once per export. */
  const coverDiskPath = coverImagePath(bookDir);
  const coverJpegPath: string | null = existsSync(coverDiskPath) ? coverDiskPath : null;

  /* Folder destination is the responsibility of the builder — we mkdir
     fresh and rm-then-recreate so a previous export of the same book
     doesn't leave orphan chapter files behind when a later run produces
     fewer chapters (e.g. the user added an exclude). */
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(outDir, { recursive: true });

  const entries: string[] = [];
  let totalBytes = 0;

  for (let i = 0; i < resolved.length; i++) {
    signal?.throwIfAborted();
    const { chapter, mp3Path } = resolved[i];
    const fileName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.mp3`;
    /* Route the per-chapter filename through sanitizeIdSegment so a
       `..`/separator surviving sanitiseForZip can't escape outDir
       (js/path-injection). No-op for real chapter titles. */
    const taggedPath = join(outDir, sanitizeIdSegment(fileName));

    const tags: Id3Tags = {
      title: chapter.title,
      album,
      artist,
      albumArtist,
      track: i + 1,
      trackTotal: total,
      genre: state.genre ?? null,
      date: state.publicationDate ?? null,
      series: hasSeries ? state.series : null,
      seriesPart: hasSeries ? state.seriesPosition : null,
      comment: 'Rendered with Castwright · castwright.ai',
    };
    await applyId3v24Tags(mp3Path, taggedPath, tags, { coverJpegPath });
    const taggedStat = await stat(taggedPath);
    totalBytes += taggedStat.size;
    entries.push(taggedPath);
    onProgress?.((i + 1) / total);
  }

  /* fs-54 — written into every mp3-folder export (all three folder-scanning
     tiles get it, not just Audiobookshelf — Smart AudioBook Player /
     BookPlayer simply ignore the two extra files). Must run after the
     rm(outDir)-then-recreate above, which it does — this call is the last
     thing in the function. */
  await writeAudiobookshelfSidecars({ state, outDir, coverJpegPath });

  return { totalBytes, entries };
}

/* fs-54 — Audiobookshelf's own preferred metadata source: a `metadata.json`
   at the book-folder root, which ABS treats as authoritative over embedded
   ID3 tags when both are present. Folder-level `cover.jpg` sits alongside
   it, copied from the same source the per-chapter APIC frames already use.
   Series gate mirrors buildFfmetadata's (build-m4b.ts): `!isStandalone &&
   !!series`, never presence of `series` alone. */
async function writeAudiobookshelfSidecars(opts: {
  state: BookStateJson;
  outDir: string;
  coverJpegPath: string | null;
}): Promise<void> {
  const { state, outDir, coverJpegPath } = opts;
  const hasSeries = state.isStandalone !== true && !!state.series?.trim();
  const humanNarrator = state.narratorCredit?.trim();
  const narrators =
    humanNarrator && humanNarrator !== DEFAULT_NARRATOR_CREDIT ? [humanNarrator] : [];
  const description = state.description?.trim();
  const publishedYear = state.publicationDate ? parsePublishedYear(state.publicationDate) : null;

  const metadata: Record<string, unknown> = {
    title: state.title,
    authors: [state.author],
    narrators,
    genres: state.genre ? [state.genre] : [],
    language: bookStateLanguage(state),
  };
  if (hasSeries) {
    const seriesEntry: { name: string; sequence?: number } = { name: state.series };
    if (state.seriesPosition != null) seriesEntry.sequence = state.seriesPosition;
    metadata.series = [seriesEntry];
  }
  if (description) metadata.description = description;
  if (publishedYear != null) metadata.publishedYear = publishedYear;

  await writeFile(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  if (coverJpegPath) {
    await copyFile(coverJpegPath, join(outDir, 'cover.jpg'));
  }
}

/** Parses the leading 4-digit year out of a publicationDate string (e.g.
    "2026" or "2026-06-01") — metadata.json's `publishedYear` is a bare
    number, unlike the free-form ID3/FFMETADATA `date` string. Returns null
    when no 4-digit year can be found rather than emitting a wrong value. */
function parsePublishedYear(publicationDate: string): number | null {
  const match = publicationDate.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}
