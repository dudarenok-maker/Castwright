/* Per-chapter audio access for the playback slice.

   GET /api/books/:bookId/chapters/:chapterId/audio
     → JSON { url, durationSec, peaks, sampleRate, segments }
   GET /api/books/:bookId/chapters/:chapterId/audio.mp3
     → the MP3 file, with range-request support (new generations).
   GET /api/books/:bookId/chapters/:chapterId/audio.wav
     → the WAV file, with range-request support (legacy chapters from
       before the MP3 switch).

   Express's `sendFile` sets Accept-Ranges + handles 206 partials natively,
   which is what <audio> seeking relies on.

   Why this route exists rather than reusing the /workspace static mount: the
   workspace directory tree uses display strings (`<Author>/<Series>/<Title>/
   audio/<slug>.{mp3,wav}`) with spaces and possibly diacritics. A bookId-
   keyed route is opaque, survives renames, and doesn't depend on
   URL-encoding every path segment correctly. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio, type ChapterAudioFile, type ChapterAudioExt } from '../workspace/chapter-audio-file.js';

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
}

export const chapterAudioRouter = Router();

/** Resolve a bookId + chapterId pair to its audio descriptor and on-disk
    state. Returns null when the book, chapter, or audio file is missing —
    callers decide how to 404. */
async function locateChapterAudio(
  bookId: string,
  chapterIdRaw: string,
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
  const audio = findChapterAudio(root, chapter.slug);
  if (!audio) return null;
  return {
    audio,
    segPath: `${root}/${chapter.slug}.segments.json`,
    chapterId,
    chapterTitle: chapter.title,
  };
}

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio', async (req: Request, res: Response) => {
  const found = await locateChapterAudio(req.params.bookId, req.params.chapterId);
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

function makeFileHandler(expectedExt: ChapterAudioExt) {
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
    const path = join(audioDir(located.bookDir), `${chapter.slug}.${expectedExt}`);
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
