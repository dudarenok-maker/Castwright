/* Per-chapter audio access for the playback slice.

   GET /api/books/:bookId/chapters/:chapterId/audio
     → JSON { url, durationSec, peaks, sampleRate, segments }
   GET /api/books/:bookId/chapters/:chapterId/audio.mp3
     → the MP3 file, with range-request support (new generations).
   GET /api/books/:bookId/chapters/:chapterId/audio.wav
     → the WAV file, with range-request support (legacy chapters from
       before the MP3 switch).

   GET /api/books/:bookId/chapters/:chapterId/audio/previous
     → JSON pointing at the PRESERVED prior render. Available only after
       a regen has happened and before the user accepts/rejects. 404
       when no preserved pair exists (legacy chapters or first renders).
   GET /api/books/:bookId/chapters/:chapterId/audio/previous.mp3
   GET /api/books/:bookId/chapters/:chapterId/audio/previous.wav
     → binary previews of the preserved file with range-support.
   DELETE /api/books/:bookId/chapters/:chapterId/audio/previous
     → ACCEPT — the new render wins. Removes both .previous.* files.
   POST   /api/books/:bookId/chapters/:chapterId/audio/previous/restore
     → REJECT — the prior render wins. Renames .previous.* over the
       live names, clobbering the just-rendered audio. 409 when a
       generation is in flight for the book (would race the write).

   Express's `sendFile` sets Accept-Ranges + handles 206 partials natively,
   which is what <audio> seeking relies on.

   Why this route exists rather than reusing the /workspace static mount: the
   workspace directory tree uses display strings (`<Author>/<Series>/<Title>/
   audio/<slug>.{mp3,wav}`) with spaces and possibly diacritics. A bookId-
   keyed route is opaque, survives renames, and doesn't depend on
   URL-encoding every path segment correctly. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio, type ChapterAudioFile, type ChapterAudioExt } from '../workspace/chapter-audio-file.js';
import { isGenerationActive } from './generation.js';

const EXT_MIME: Record<ChapterAudioExt, 'audio/mpeg' | 'audio/wav'> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

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

/** Look up the live (`<slug>.{mp3,wav}`) or preserved (`<slug>.previous.*`)
    audio pair. The previous variant probes both extensions explicitly
    rather than reusing findChapterAudio because previous files are named
    differently. */
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

/** Mirror of findChapterAudio but for the `.previous.*` siblings. Probes
    mp3 first (matching the live preference order), falls back to wav for
    legacy chapters whose preserved pair is .wav. */
function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  for (const ext of ['mp3', 'wav'] as const) {
    const path = join(audioRoot, `${slug}.previous.${ext}`);
    if (existsSync(path)) {
      return ext === 'mp3'
        ? { path, ext, mime: 'audio/mpeg', urlSuffix: 'audio.mp3' }
        : { path, ext, mime: 'audio/wav',  urlSuffix: 'audio.wav' };
    }
  }
  return null;
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
   `previous.{mp3,wav}` binary endpoints below. The revision-diff a/b
   player fetches BOTH this and the live `/audio` endpoint and renders
   one A audio element + one B audio element. */
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
  /* URL suffix for the previous variant is `audio/previous.{mp3,wav}`,
     hand-formatted because the ChapterAudioFile descriptor's urlSuffix
     hardcodes `audio.{mp3,wav}` for the live names. */
  const ext = found.audio.ext;
  res.json({
    url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/audio/previous.${ext}`,
    durationSec: meta?.durationSec ?? 0,
    peaks: [],
    sampleRate: meta?.sampleRate ?? 24000,
    segments,
  });
});

function makeFileHandler(expectedExt: ChapterAudioExt, variant: AudioVariant = 'current') {
  return async (req: Request, res: Response) => {
    /* Probe directly for the requested extension — don't reuse
       locateChapterAudio's prefer-mp3 ordering, because then a chapter that
       had both files (e.g. legacy .wav left around after regenerate) would
       always 404 the legacy .wav endpoint even though the file is there. */
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId)) return res.status(404).json({ message: 'Chapter audio not found.' });
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
    const chapter = located.state.chapters.find(c => c.id === chapterId);
    if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
    const fileName = variant === 'current'
      ? `${chapter.slug}.${expectedExt}`
      : `${chapter.slug}.previous.${expectedExt}`;
    const path = join(audioDir(located.bookDir), fileName);
    if (!existsSync(path)) return res.status(404).json({ message: 'Chapter audio not found.' });
    res.sendFile(path, {
      headers: { 'Content-Type': EXT_MIME[expectedExt], 'Cache-Control': 'no-cache' },
    }, err => {
      if (err && !res.headersSent) res.status(500).end();
    });
  };
}

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.mp3', makeFileHandler('mp3'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.wav', makeFileHandler('wav'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio/previous.mp3', makeFileHandler('mp3', 'previous'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio/previous.wav', makeFileHandler('wav', 'previous'));

/* ACCEPT — the user has chosen the new render. Delete both .previous.* files.
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
     race a still-present current file. The live extension may differ from
     the previous extension (e.g. previous.wav restored over an mp3
     re-render), so probe via findChapterAudio. */
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
