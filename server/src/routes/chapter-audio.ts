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

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio, type ChapterAudioFile } from '../workspace/chapter-audio-file.js';
import { isGenerationActive } from './generation.js';
import type { LoudnormSidecarJson } from '../tts/loudnorm.js';

/** Disk shape mirror of `ChapterPeaksFile` in `server/src/tts/mp3.ts`.
 *  Kept narrow + local so this route doesn't reach across the TTS module
 *  boundary just to import a type. */
interface ChapterPeaksFile {
  peaks: number[];
}

/** Read `<bookDir>/audio/<slug>.peaks.json` (or `.previous.peaks.json`)
 *  when present, returning the 240-bin envelope. Missing file → empty
 *  array; this is the graceful fallback contract that lets chapters
 *  generated before plan 56 keep loading. A corrupt / malformed file is
 *  also treated as missing (logged then absorbed) so a one-off bad write
 *  doesn't 500 the whole meta endpoint. */
async function readPeaksOrEmpty(peaksPath: string): Promise<number[]> {
  if (!existsSync(peaksPath)) return [];
  try {
    const file = await readJson<ChapterPeaksFile>(peaksPath);
    if (!file || !Array.isArray(file.peaks)) return [];
    return file.peaks;
  } catch (err) {
    console.warn(
      `[chapter-audio] failed to read peaks file at ${peaksPath}: ${(err as Error).message}`,
    );
    return [];
  }
}

/** Read `<bookDir>/audio/<slug>.lufs.json` when present, returning the
 *  loudness sidecar payload. Missing file → `null`; this is the graceful
 *  fallback contract for chapters generated before plan 71 / with
 *  `AUDIO_LOUDNORM_ENABLED=false` / silent-source fallthrough. Plan 77
 *  (LUFS report card) reads this off the wire and renders a "no data"
 *  badge when null. A corrupt / malformed file is treated as missing
 *  (logged then absorbed) so a one-off bad write doesn't 500 the meta
 *  endpoint. */
async function readLufsOrNull(lufsPath: string): Promise<LoudnormSidecarJson | null> {
  if (!existsSync(lufsPath)) return null;
  try {
    const file = await readJson<LoudnormSidecarJson>(lufsPath);
    if (!file || typeof file.i !== 'number' || typeof file.target !== 'number') return null;
    return file;
  } catch (err) {
    console.warn(
      `[chapter-audio] failed to read lufs file at ${lufsPath}: ${(err as Error).message}`,
    );
    return null;
  }
}

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
    /** `'title'` on the synthetic narrator-voiced chapter-title segment
        (see `synthesise-chapter.ts`). Filtered out before publishing to
        the `ChapterAudio` API segments[] because the wire contract types
        `sentenceId` as a required integer and title segments have an
        empty sentenceIds[]. The on-disk record stays so the writer can
        audit / future UI can opt in to rendering the title beat on the
        timeline. */
    kind?: 'title';
    // issue-waveform: per-segment QA, present when the gates ran
    suspect?: boolean;
    asrSuspect?: boolean;
    qa?: { reasons?: string[] };
    asr?: { reasons?: string[] };
  }>;
  /** Per-character voice snapshot captured at synthesis time. Read by the
      revisions route to surface drift. Older segments files (pre-snapshot
      field) omit this; the chapter-audio route ignores it either way. */
  characterSnapshots?: Record<
    string,
    {
      tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
      gender?: 'male' | 'female' | 'neutral';
      ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
      voiceId?: string;
      voiceEngine?: string;
      attributes?: string[];
    }
  >;
}

/** issue-waveform: map an on-disk segment to its wire shape, surfacing
    per-segment QA flags when present. `suspect` is true when either the
    pre-assembly segment-QA gate (`seg.suspect`) or the ASR content-QA gate
    (`seg.asrSuspect`) fired. `reasons` includes segment-QA reasons whenever
    `seg.suspect`; ASR reasons only when `seg.asrSuspect === true` (never
    for an inconclusive ASR verdict where `asrSuspect` is false/absent). */
function publishSegment(s: ChapterSegmentsFile['segments'][number]) {
  const suspect = Boolean(s.suspect || s.asrSuspect);
  const reasons = suspect
    ? [
        ...(s.suspect ? (s.qa?.reasons ?? []) : []),
        ...(s.asrSuspect ? (s.asr?.reasons ?? []) : []),
      ]
    : undefined;
  return {
    start: s.startSec,
    end: s.endSec,
    characterId: s.characterId,
    sentenceId: s.sentenceIds[0],
    ...(suspect ? { suspect: true } : {}),
    ...(reasons && reasons.length ? { reasons } : {}),
  };
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
  /** Sibling `<slug>.peaks.json` (current) or `<slug>.previous.peaks.json`
   *  (preserved) location. The file is optional — `readPeaksOrEmpty`
   *  treats absence as `peaks: []`. Plan 56's render path emits the
   *  current variant; the preserved variant has no writer today (rollback
   *  preservation in `preserveExistingAsPrevious` does not move peaks),
   *  so the preserved endpoint reliably returns `[]` for now — a
   *  deliberately graceful trade-off rather than a missing feature. */
  peaksPath: string;
  /** Sibling `<slug>.lufs.json` (plan 71 loudnorm sidecar). Missing →
   *  `readLufsOrNull` returns `null` so the meta endpoint degrades to
   *  `lufs: null` and the LUFS report card UI (plan 77) renders a
   *  neutral "no data" state. Only emitted on the current variant —
   *  the preserved (.previous.*) variant has no loudnorm writer today
   *  (parallel to `.previous.peaks.json`), so the path is non-null
   *  but the file is reliably absent and we return null. */
  lufsPath: string;
  chapterId: number;
  chapterTitle: string;
} | null> {
  const chapterId = Number.parseInt(chapterIdRaw, 10);
  if (!Number.isInteger(chapterId)) return null;
  const located = await findBookByBookId(bookId);
  if (!located) return null;
  const chapter = located.state.chapters.find((c) => c.id === chapterId);
  if (!chapter) return null;
  const root = audioDir(located.bookDir);
  const audio =
    variant === 'current'
      ? findChapterAudio(root, chapter.slug)
      : findPreviousChapterAudio(root, chapter.slug);
  if (!audio) return null;
  const segPath =
    variant === 'current'
      ? `${root}/${chapter.slug}.segments.json`
      : `${root}/${chapter.slug}.previous.segments.json`;
  const peaksPath =
    variant === 'current'
      ? join(root, `${chapter.slug}.peaks.json`)
      : join(root, `${chapter.slug}.previous.peaks.json`);
  const lufsPath =
    variant === 'current'
      ? join(root, `${chapter.slug}.lufs.json`)
      : join(root, `${chapter.slug}.previous.lufs.json`);
  return { audio, segPath, peaksPath, lufsPath, chapterId, chapterTitle: chapter.title };
}

/** Mirror of findChapterAudio but for the `.previous.mp3` sibling. */
function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  const path = join(audioRoot, `${slug}.previous.mp3`);
  if (!existsSync(path)) return null;
  return { path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' };
}

chapterAudioRouter.get(
  '/:bookId/chapters/:chapterId/audio',
  async (req: Request, res: Response) => {
    const found = await locateChapterAudio(req.params.bookId, req.params.chapterId, 'current');
    if (!found) return res.status(404).json({ message: 'Chapter audio not found.' });
    const meta = await readJson<ChapterSegmentsFile>(found.segPath);
    /* On-disk segments use `startSec/endSec/sentenceIds[]` (per-group). The
     ChapterAudio contract publishes `start/end/sentenceId` (singular) — map
     each group to one outward segment, using the group's first sentence id
     as the representative. Filter out title segments (`kind === 'title'`)
     so the wire shape stays clean: title segments have an empty sentenceIds[]
     and the OpenAPI contract types sentenceId as a required integer. */
    const segments = (meta?.segments ?? [])
      .filter((s) => s.kind !== 'title')
      .map(publishSegment);
    /* Plan 56: surface the real 240-bin RMS peaks emitted at encode time.
       Missing file → `[]`, preserving the pre-plan-56 contract so chapters
       generated before this plan keep loading and the Listen view falls
       back gracefully. */
    const peaks = await readPeaksOrEmpty(found.peaksPath);
    /* Plan 77: surface the EBU R128 loudness sidecar (plan 71) so the
       LUFS report card and per-chapter drift badge can compute drift
       from the target. Missing file → `null` — the chapter wasn't
       loudnormed (legacy chapter / AUDIO_LOUDNORM_ENABLED=false /
       silent-source fallthrough). The frontend MUST also gate any
       drift-vs-ground-truth comparison on `lufs.twoPass === true`;
       single-pass values are the nominal target, not a real measurement. */
    const lufs = await readLufsOrNull(found.lufsPath);
    res.json({
      url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/${found.audio.urlSuffix}`,
      durationSec: meta?.durationSec ?? 0,
      peaks,
      sampleRate: meta?.sampleRate ?? 24000,
      segments,
      lufs,
    });
  },
);

/* The preserved variant: same JSON shape as current, URL points at the
   `previous.mp3` binary endpoint below. The revision-diff a/b player
   fetches BOTH this and the live `/audio` endpoint and renders one A
   audio element + one B audio element. */
chapterAudioRouter.get(
  '/:bookId/chapters/:chapterId/audio/previous',
  async (req: Request, res: Response) => {
    const found = await locateChapterAudio(req.params.bookId, req.params.chapterId, 'previous');
    if (!found) return res.status(404).json({ message: 'No preserved previous audio.' });
    const meta = await readJson<ChapterSegmentsFile>(found.segPath);
    const segments = (meta?.segments ?? [])
      .filter((s) => s.kind !== 'title')
      .map(publishSegment);
    /* Plan 56: the preserved audition variant has no peaks writer today
       (rollback preservation does not move peaks alongside the audio +
       segments pair). `readPeaksOrEmpty` therefore typically returns `[]`
       for this path, which the Listen / revision-diff player handles
       gracefully. Wiring is symmetrical with /audio so a future preserve
       extension can light up the A/B waveform without a route change. */
    const peaks = await readPeaksOrEmpty(found.peaksPath);
    /* Plan 77: same fall-through as peaks — no .previous.lufs.json writer
       today (rollback preservation does not move loudnorm sidecars).
       Returns `null` so the wire shape stays uniform with the /audio
       endpoint. */
    const lufs = await readLufsOrNull(found.lufsPath);
    res.json({
      url: `/api/books/${encodeURIComponent(req.params.bookId)}/chapters/${found.chapterId}/audio/previous.mp3`,
      durationSec: meta?.durationSec ?? 0,
      peaks,
      sampleRate: meta?.sampleRate ?? 24000,
      segments,
      lufs,
    });
  },
);

function makeFileHandler(variant: AudioVariant = 'current') {
  return async (req: Request, res: Response) => {
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId))
      return res.status(404).json({ message: 'Chapter audio not found.' });
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
    const chapter = located.state.chapters.find((c) => c.id === chapterId);
    if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
    const audioRoot = audioDir(located.bookDir);
    const audio =
      variant === 'current'
        ? findChapterAudio(audioRoot, chapter.slug)
        : findPreviousChapterAudio(audioRoot, chapter.slug);
    if (!audio) return res.status(404).json({ message: 'Chapter audio not found.' });
    res.sendFile(
      audio.path,
      {
        headers: { 'Content-Type': audio.mime, 'Cache-Control': 'no-cache' },
      },
      (err) => {
        if (err && !res.headersSent) res.status(500).end();
      },
    );
  };
}

chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.mp3', makeFileHandler('current'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.m4a', makeFileHandler('current'));
chapterAudioRouter.get('/:bookId/chapters/:chapterId/audio.ogg', makeFileHandler('current'));
chapterAudioRouter.get(
  '/:bookId/chapters/:chapterId/audio/previous.mp3',
  makeFileHandler('previous'),
);

/* ACCEPT — the user has chosen the new render. Delete the .previous.* pair.
   404 when nothing to delete (caller didn't audition first, or already
   accepted/rejected). 204 on success. */
chapterAudioRouter.delete(
  '/:bookId/chapters/:chapterId/audio/previous',
  async (req: Request, res: Response) => {
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId))
      return res.status(404).json({ message: 'Chapter audio not found.' });
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
    const chapter = located.state.chapters.find((c) => c.id === chapterId);
    if (!chapter) return res.status(404).json({ message: 'Chapter audio not found.' });
    const root = audioDir(located.bookDir);
    const previous = findPreviousChapterAudio(root, chapter.slug);
    if (!previous) return res.status(404).json({ message: 'No preserved previous audio.' });
    /* Delete both files — segments.json absence on its own isn't a fault. */
    await unlink(previous.path).catch(() => {});
    await unlink(join(root, `${chapter.slug}.previous.segments.json`)).catch(() => {});
    res.status(204).end();
  },
);

/* REJECT — the user has chosen the prior render. Promote .previous.* over
   the live names. 409 when a generation is in flight (the rename would
   race the write path). 404 when no preserved pair. */
chapterAudioRouter.post(
  '/:bookId/chapters/:chapterId/audio/previous/restore',
  async (req: Request, res: Response) => {
    if (isGenerationActive(req.params.bookId)) {
      return res.status(409).json({
        message:
          'A generation is in flight for this book. Wait for the render to finish before rejecting.',
      });
    }
    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId))
      return res.status(404).json({ message: 'Chapter audio not found.' });
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Chapter audio not found.' });
    const chapter = located.state.chapters.find((c) => c.id === chapterId);
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
      console.error(
        `[chapter-audio] failed to restore previous audio for ${chapter.slug}: ${(err as Error).message}`,
      );
      return res.status(500).json({ message: 'Failed to restore previous audio.' });
    }
    const previousSegments = join(root, `${chapter.slug}.previous.segments.json`);
    if (existsSync(previousSegments)) {
      await renameWithRetry(previousSegments, liveSegments).catch(() => {});
    }
    res.status(204).end();
  },
);
