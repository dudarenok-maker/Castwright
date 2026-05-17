/* Per-chapter audio access for the playback slice.

   GET /api/books/:bookId/chapters/:chapterId/audio
     → JSON { url, durationSec, peaks, sampleRate, segments }
   GET /api/books/:bookId/chapters/:chapterId/audio.mp3
     → the MP3 file, with range-request support.

   GET /api/books/:bookId/chapters/:chapterId/audio/previous
     → JSON pointing at the PRESERVED prior render. Available only after
       a regen has happened and before the user accepts/rejects. 404
       when no preserved pair exists (first renders, or chapters that
       predate the rollback-preservation feature).
   GET /api/books/:bookId/chapters/:chapterId/audio/previous.mp3
     → binary preview of the preserved file with range-support.
   DELETE /api/books/:bookId/chapters/:chapterId/audio/previous
     → ACCEPT — the new render wins. Removes the .previous.* pair.
   POST   /api/books/:bookId/chapters/:chapterId/audio/previous/restore
     → REJECT — the prior render wins. Renames .previous.* over the
       live names, clobbering the just-rendered audio. 409 when a
       generation is in flight for the book (would race the write).

   Express's `sendFile` sets Accept-Ranges + handles 206 partials natively,
   which is what <audio> seeking relies on.

   Why this route exists rather than reusing the /workspace static mount: the
   workspace directory tree uses display strings (`<Author>/<Series>/<Title>/
   audio/<slug>.mp3`) with spaces and possibly diacritics. A bookId-keyed
   route is opaque, survives renames, and doesn't depend on URL-encoding
   every path segment correctly. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio, type ChapterAudioFile } from '../workspace/chapter-audio-file.js';
import { isGenerationActive } from './generation.js';

const MP3_MIME = 'audio/mpeg';

interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: string;
  synthesizedAt: string;
  segments: Array<{
    groupIndex: number;
    characterId: string;
    sentenceIds: number[];
    startSec: number;
    endSec: number;
  }>;
  /** Per-character voice snapshot captured at synthesis time. Read by the
      revisions route to surface drift. Older segments files (pre-snapshot
      field) omit this; the chapter-audio route ignores it either way. */
  characterSnapshots?: Record<string, {
    tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
    voiceId?: string;
    voiceEngine?: string;
    attributes?: string[];
  }>;
}

export const chapterAudioRouter = Router();

type AudioVariant = 'current' | 'previous';

/** Look up the live (`<slug>.mp3`) or preserved (`<slug>.previous.mp3`)
    audio pair. */
async function locateChapterAudio(
  bookId: string,
  chapterIdRaw: string,
  variant: AudioVariant = 'current',
): Promise<{
  audio: ChapterAudioFile;
  segPath: string;
  chapterId: number;
  chapterTitle: string;
} | null> {
  const chapterId = Number.parseInt(chapterIdRaw, 10);
  if (!Number.isInteger(chapterId)) return null;
  const located = await findBookByBookId(bookId);
  if (!located) return null;
  const chapter = located.state.chapters.find(c => c.id === chapterId);
  if (!chapter) return null;
  const root = audioDir(located.bookDir);
  const audio = variant === 'current'
    ? findChapterAudio(root, chapter.slug)
    : findPreviousChapterAudio(root, chapter.slug);
  if (!audio) return null;
  const segPath = variant === 'current'
    ? `${root}/${chapter.slug}.segments.json`
    : `${root}/${chapter.slug}.previous.segments.json`;
  return { audio, segPath, chapterId, chapterTitle: chapter.title };
}

/** Mirror of findChapterAudio but for the `.previous.mp3` sibling. */
function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  const path = join(audioRoot, `${slug}.previous.mp3`);
  if (!existsSync(path)) return null;
  return { path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' };
}

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio', async (req: Request, res: Response) => {
  const found = await locateChapterAudio(req.params.bookId, req.params.chapterId, 'current');
  if (!found) return res.status(404).json({ message: 'Chapter audio not found.' });
  const meta = await readJson<ChapterSegmentsFile>(found.segPath);
  /* On-disk segments use `startSec/endSec/sentenceIds[]` (per-group). The
     ChapterAudio contract publishes `start/end/sentenceId` (singular) — map
     each group to one outward segment, using the group's first sentence id
     as the representative. Peaks: [] for now (MiniPlayer doesn't draw them;
     Listen's waveform is out of scope here). */
  const segments = (meta?.segments ?? []).map(s => ({
    start: s.startSec,
    end: s.endSec,
    characterId: s.characterId,
    sentenceId: s.sentenceIds[0],
  }));
  res.json({
    url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/${found.audio.urlSuffix}`,
    durationSec: meta?.durationSec ?? 0,
    peaks: [],
    sampleRate: meta?.sampleRate ?? 24000,
    segments,
  });
});

/* The preserved variant: same JSON shape as current, URL points at the
   `previous.mp3` binary endpoint below. The revision-diff a/b player
   fetches BOTH this and the live `/audio` endpoint and renders one A
   audio element + one B audio element. */
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio/previous', async (req: Request, res: Response) => {
  const found = await locateChapterAudio(req.params.bookId, req.params.chapterId, 'previous');
  if (!found) return res.status(404).json({ message: 'No preserved previous audio.' });
  const meta = await readJson<ChapterSegmentsFile>(found.segPath);
  const segments = (meta?.segments ?? []).map(s => ({
    start: s.startSec,
    end: s.endSec,
    characterId: s.characterId,
    sentenceId: s.sentenceIds[0],
  }));
  res.json({
    url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/audio/previous.mp3`,
    durationSec: meta?.durationSec ?? 0,
    peaks: [],
    sampleRate: meta?.sampleRate ?? 24000,
    segments,
  });
});

function makeFileHandler(variant: AudioVariant = 'current') {
  return async (req: Request, res: Response) => {
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId)) return res.status(404).json({ message: 'Chapter audio not found.' });
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
    const chapter = located.state.chapters.find(c => c.id === chapterId);
    if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
    const fileName = variant === 'current'
      ? `${chapter.slug}.mp3`
      : `${chapter.slug}.previous.mp3`;
    const path = join(audioDir(located.bookDir), fileName);
    if (!existsSync(path)) return res.status(404).json({ message: 'Chapter audio not found.' });
    res.sendFile(path, {
      headers: { 'Content-Type': MP3_MIME, 'Cache-Control': 'no-cache' },
    }, err => {
      if (err && !res.headersSent) res.status(500).end();
    });
  };
}

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.mp3', makeFileHandler('current'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio/previous.mp3', makeFileHandler('previous'));

/* ACCEPT — the user has chosen the new render. Delete the .previous.* pair.
   404 when nothing to delete (caller didn't audition first, or already
   accepted/rejected). 204 on success. */
chapterAudioRouter.delete('/:bookId/chapters/:chapterId/audio/previous', async (req: Request, res: Response) => {
  const chapterId = Number.parseInt(req.params.chapterId, 10);
  if (!Number.isInteger(chapterId)) return res.status(404).json({ message: 'Chapter audio not found.' });
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
  const chapter = located.state.chapters.find(c => c.id === chapterId);
  if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
  const root = audioDir(located.bookDir);
  const previous = findPreviousChapterAudio(root, chapter.slug);
  if (!previous) return res.status(404).json({ message: 'No preserved previous audio.' });
  /* Delete both files — segments.json absence on its own isn't a fault. */
  await unlink(previous.path).catch(() => {});
  await unlink(join(root, `${chapter.slug}.previous.segments.json`)).catch(() => {});
  res.status(204).end();
});

/* REJECT — the user has chosen the prior render. Promote .previous.* over
   the live names. 409 when a generation is in flight (the rename would
   race the write path). 404 when no preserved pair. */
chapterAudioRouter.post('/:bookId/chapters/:chapterId/audio/previous/restore', async (req: Request, res: Response) => {
  if (isGenerationActive(req.params.bookId)) {
    return res.status(409).json({
      message: 'A generation is in flight for this book. Wait for the render to finish before rejecting.',
    });
  }
  const chapterId = Number.parseInt(req.params.chapterId, 10);
  if (!Number.isInteger(chapterId)) return res.status(404).json({ message: 'Chapter audio not found.' });
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
  const chapter = located.state.chapters.find(c => c.id === chapterId);
  if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
  const root = audioDir(located.bookDir);
  const previous = findPreviousChapterAudio(root, chapter.slug);
  if (!previous) return res.status(404).json({ message: 'No preserved previous audio.' });

  /* Delete the live render first so the previous → live rename doesn't
     race a still-present current file. */
  const currentLive = findChapterAudio(root, chapter.slug);
  if (currentLive) await unlink(currentLive.path).catch(() => {});
  const liveSegments = join(root, `${chapter.slug}.segments.json`);
  if (existsSync(liveSegments)) await unlink(liveSegments).catch(() => {});

  try {
    await renameWithRetry(previous.path, join(root, `${chapter.slug}.${previous.ext}`));
  } catch (err) {
    /* eslint-disable-next-line no-console */
    console.error(`[chapter-audio] failed to restore previous audio for ${chapter.slug}: ${(err as Error).message}`);
    return res.status(500).json({ message: 'Failed to restore previous audio.' });
  }
  const previousSegments = join(root, `${chapter.slug}.previous.segments.json`);
  if (existsSync(previousSegments)) {
    await renameWithRetry(previousSegments, liveSegments).catch(() => {});
  }
  res.status(204).end();
});
