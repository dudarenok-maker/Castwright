/* srv-32 (plan 191) — GET /api/library/sync-manifest.
 *
 * The companion's delta-sync contract. Two modes on one route:
 *   - no query        → INDEX: one lightweight row per book + the full
 *                        activeBookIds set. `?since=<iso>` trims the rows.
 *   - ?bookId=<id>     → DETAIL: that book's chapters keyed by the stable
 *                        srv-35 uuid, with per-chapter fingerprint +
 *                        actual urlSuffix/audioUrl + duration/lufs.
 *
 * Pure shaping lives in workspace/sync-manifest.ts; this file is the I/O
 * wrapper (book walk, file stat, format probe) + manual gzip. See plan 191. */

import { Router } from 'express';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Request, Response } from '../http.js';
import { collectBooks, findBookByBookId } from '../workspace/scan.js';
import { ensureChapterUuids } from '../workspace/chapter-uuid.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { audioDir, coverImagePath, listenProgressJsonPath, stateJsonPath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import {
  buildSyncManifestIndex,
  buildSyncManifestBookDetail,
  type ChapterAudioFact,
} from '../workspace/sync-manifest.js';

export const syncManifestRouter = Router();

/** Serialize + gzip when the client advertises it. Manual (rather than a
 *  global compression middleware) so only this large response pays the
 *  CPU and every other route stays byte-for-byte unchanged. */
function sendMaybeGzip(req: Request, res: Response, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  const accept = req.headers['accept-encoding'];
  if (typeof accept === 'string' && /\bgzip\b/.test(accept)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzipSync(json));
  } else {
    res.end(json);
  }
}

syncManifestRouter.get('/sync-manifest', async (req: Request, res: Response) => {
  try {
    const bookId = typeof req.query.bookId === 'string' ? req.query.bookId : undefined;

    if (bookId) {
      const located = await findBookByBookId(bookId);
      if (!located) return res.status(404).json({ error: 'Book not found.' });
      const { bookDir, state } = located;
      /* srv-35 — guarantee a stable uuid on every chapter (and persist the
         migration) so the manifest keys are durable. Idempotent. */
      if (ensureChapterUuids(state)) {
        await writeStateJsonAtomic(stateJsonPath(bookDir), state).catch(() => {
          /* best-effort migration write; the in-memory state already has
             the uuids for this response. */
        });
      }
      const audioRoot = audioDir(bookDir);
      const audioByChapterId = new Map<number, ChapterAudioFact>();
      for (const c of state.chapters) {
        if (c.excluded) continue;
        const found = findChapterAudio(audioRoot, c.slug);
        if (!found) continue;
        let fileSize: number | undefined;
        try {
          fileSize = statSync(found.path).size;
        } catch {
          fileSize = undefined;
        }
        if (fileSize !== undefined) {
          /* Real PCM-measured length lives in the per-chapter segments file
             (state.json's audioQa.durationSec is often absent on older
             books). Read it so the companion can show total + per-chapter
             durations + listener progress. Best-effort: omit on any miss. */
          let durationSec: number | undefined;
          try {
            const seg = JSON.parse(
              readFileSync(join(audioRoot, `${c.slug}.segments.json`), 'utf8'),
            ) as { durationSec?: number };
            if (typeof seg.durationSec === 'number' && Number.isFinite(seg.durationSec)) {
              durationSec = seg.durationSec;
            }
          } catch {
            /* no segments file / unreadable → omit duration */
          }
          audioByChapterId.set(c.id, {
            fileSize,
            urlSuffix: found.urlSuffix,
            ...(durationSec !== undefined ? { durationSec } : {}),
          });
        }
      }
      return sendMaybeGzip(req, res, buildSyncManifestBookDetail(bookId, state, audioByChapterId));
    }

    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const books = await collectBooks();
    const rows = books.map(({ bookDir, state }) => {
      let finished = false;
      let hidden = false;
      try {
        const lp = JSON.parse(readFileSync(listenProgressJsonPath(bookDir), 'utf8')) as {
          finished?: boolean; hidden?: boolean;
        };
        finished = lp.finished === true;
        hidden = lp.hidden === true;
      } catch {
        /* no listen-progress.json yet → both false */
      }
      return {
        bookId: state.bookId,
        state,
        coverUrl:
          state.coverImage && existsSync(coverImagePath(bookDir))
            ? `/api/books/${state.bookId}/cover`
            : undefined,
        ...(finished ? { finished: true } : {}),
        ...(hidden ? { hidden: true } : {}),
      };
    });
    return sendMaybeGzip(req, res, buildSyncManifestIndex(rows, since));
  } catch (e) {
    console.error('[sync-manifest] failed', e);
    res
      .status(500)
      .json({ error: (e as Error).message || 'Failed to build sync manifest.' });
  }
});
