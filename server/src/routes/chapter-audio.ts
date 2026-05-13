/* Per-chapter audio access for the playback slice.

   GET /api/books/:bookId/chapters/:chapterId/audio
     → JSON { url, durationSec, peaks, sampleRate, segments }
   GET /api/books/:bookId/chapters/:chapterId/audio.wav
     → the WAV file, with range-request support (Express's sendFile handles
       the Accept-Ranges + 206 partials that <audio> seeking needs).

   Why this route exists rather than reusing the /workspace static mount: the
   workspace directory tree uses display strings (`<Author>/<Series>/<Title>/
   audio/<slug>.wav`) with spaces and possibly diacritics. A bookId-keyed
   route is opaque, survives renames, and doesn't depend on URL-encoding
   every path segment correctly. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findBookByBookId } from '../workspace/scan.js';

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

/** Resolve a bookId + chapterId pair to its audio paths and on-disk state.
    Returns null when the book, chapter, or WAV file is missing — callers
    decide how to 404. */
async function locateChapterAudio(bookId: string, chapterIdRaw: string): Promise<{
  wavPath: string;
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
  const wavPath = join(root, `${chapter.slug}.wav`);
  if (!existsSync(wavPath)) return null;
  return {
    wavPath,
    segPath: join(root, `${chapter.slug}.segments.json`),
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
    url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/audio.wav`,
    durationSec: meta?.durationSec ?? 0,
    peaks: [],
    sampleRate: meta?.sampleRate ?? 24000,
    segments,
  });
});

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.wav', async (req: Request, res: Response) => {
  const found = await locateChapterAudio(req.params.bookId, req.params.chapterId);
  if (!found) return res.status(404).json({ message: 'Chapter audio not found.' });
  /* sendFile sets Content-Length + handles Range requests natively, which
     is what <audio> seeking relies on. */
  res.sendFile(found.wavPath, {
    headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-cache' },
  }, err => {
    if (err && !res.headersSent) res.status(500).end();
  });
});
