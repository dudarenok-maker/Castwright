/* Share-clip route — server-side slicing of a chapter MP3 to a user-
   requested time range, for the "Share clip" affordance on the listen
   view's player-region (plan 69).

   GET /api/books/:bookId/chapters/:chapterId/clip?start=<sec>&duration=<sec>

   No re-encode: uses `ffmpeg -ss <start> -t <duration> -c copy`. The
   `-ss` flag goes BEFORE `-i` (fast-seek path). At MP3 frame granularity
   this lands within ~26 ms of the requested boundary — plenty accurate
   for a 30 s share clip, and 20×+ faster than the after-`-i` accurate-
   seek path (which would re-decode the source). The trade-off is
   documented in `docs/features/archive/69-share-chapter-clip.md`.

   Validation:
   - `start` must parse as a finite number ≥ 0; otherwise 400.
   - `duration` must parse as a finite number > 0 AND ≤ 60; otherwise 400.
     The 60 s cap mirrors the BACKLOG entry's fair-use / viral-loop
     framing — long clips should use the regular chapter download.
   - Unknown bookId / chapterId / missing on-disk MP3 → 404.
   - ffmpeg spawn failure or non-zero exit → 500 with the stderr tail.

   Response: streamed `audio/mpeg` with `Content-Disposition: attachment`
   carrying a filename like `<chapter-slug>-clip-<start>s.mp3`. The
   actual byte count depends on the source MP3's VBR rate near the clip
   boundary; ffmpeg writes to stdout (pipe:1) which we pipe straight
   into the response. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { spawn } from 'node:child_process';
import { findBookByBookId } from '../workspace/scan.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { audioDir } from '../workspace/paths.js';

const MAX_DURATION_SEC = 60;

export const clipRouter = Router();

clipRouter.get(
  '/:bookId/chapters/:chapterId/clip',
  async (req: Request, res: Response) => {
    const startRaw = typeof req.query.start === 'string' ? req.query.start : '';
    const durationRaw = typeof req.query.duration === 'string' ? req.query.duration : '';
    const start = Number(startRaw);
    const duration = Number(durationRaw);

    if (!Number.isFinite(start) || start < 0) {
      return res
        .status(400)
        .json({ message: 'start must be a number >= 0 (in seconds).' });
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      return res
        .status(400)
        .json({ message: 'duration must be a positive number (in seconds).' });
    }
    if (duration > MAX_DURATION_SEC) {
      return res
        .status(400)
        .json({ message: `duration must be <= ${MAX_DURATION_SEC} seconds.` });
    }

    const chapterId = Number.parseInt(req.params.chapterId, 10);
    if (!Number.isInteger(chapterId)) {
      return res.status(404).json({ message: 'Chapter not found.' });
    }
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ message: 'Book not found.' });
    const chapter = located.state.chapters.find((c) => c.id === chapterId);
    if (!chapter) return res.status(404).json({ message: 'Chapter not found.' });

    const root = audioDir(located.bookDir);
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      return res.status(404).json({ message: 'Chapter audio not found on disk.' });
    }

    /* Fast-seek path: -ss BEFORE -i. ffmpeg jumps to the nearest
       key-/MP3-frame boundary before decoding starts, which means we
       don't decode anything (combined with -c copy below). For a 30 s
       social clip this is ample precision; for frame-perfect cuts we'd
       move -ss AFTER -i (decoder must produce every frame from 0 to
       start before discarding). The chosen placement keeps latency at
       sub-second even on long chapters. */
    const filename = `${chapter.slug}-clip-${Math.floor(start)}s.mp3`;
    const args = [
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      audio.path,
      '-c',
      'copy',
      '-f',
      'mp3',
      'pipe:1',
    ];

    let child;
    try {
      child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return res.status(500).json({
        message: `Failed to spawn ffmpeg: ${(err as Error).message}. ` +
          'Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).',
      });
    }

    let headersSent = false;
    const stderrChunks: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (!headersSent && !res.headersSent) {
        res.status(500).json({
          message: `ffmpeg spawn failed: ${err.message}`,
        });
      } else {
        /* Headers already gone — abort the streaming response so the
           client sees a truncated body rather than a hanging socket. */
        res.destroy(err);
      }
    });

    /* Hold response headers until we know ffmpeg actually started
       producing output. If ffmpeg exits non-zero before the first
       stdout chunk we can still send a clean 500 JSON. */
    child.stdout.once('data', (chunk: Buffer) => {
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.write(chunk);
      child.stdout.pipe(res, { end: false });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        if (!headersSent && !res.headersSent) {
          return res.status(500).json({
            message: `ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`,
          });
        }
        /* Already streaming — end the response so the client sees a
           truncated download rather than a hung socket. */
        return res.end();
      }
      if (!headersSent && !res.headersSent) {
        /* ffmpeg exited 0 but produced nothing. Vanishingly rare — most
           commonly a start past the end of the file. Surface as 500
           with a clear message. */
        return res.status(500).json({
          message: 'ffmpeg produced no output (clip range may extend past chapter end).',
        });
      }
      return res.end();
    });

    /* Client disconnects mid-stream — kill the child so we don't keep
       ffmpeg running uselessly. */
    req.on('close', () => {
      if (!child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      }
    });
  },
);
