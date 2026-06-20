/* srv-32 (plan 191) — pure builders for the companion sync manifest.
 *
 * A two-level manifest the Android companion diffs to delta-sync a
 * constantly-regenerated library:
 *
 *  - INDEX (`buildSyncManifestIndex`): one lightweight row per book
 *    (bookId + audio-aware `updatedAt` + cover ref + active-id set). A
 *    `?since` cutoff trims the `books` list but NEVER the `activeBookIds`
 *    set — that full set drives stateless client-side deletion (a
 *    filesystem scan has no tombstones for removed books).
 *  - DETAIL (`buildSyncManifestBookDetail`): one book's chapters keyed by
 *    the stable srv-35 `uuid`, each with a fingerprint (`audioRenderedAt`
 *    + file size — so any audio mutation bumps it), the actual rendered
 *    `urlSuffix`/`audioUrl`, and duration/lufs hints.
 *
 * Pure — all disk I/O (book walk, file stat, format probe) happens in the
 * route (library-sync-manifest.ts) and is passed in. See plan 191. */

import type { BookStateJson } from './scan.js';

/** Bump on any breaking change to the manifest shape. Surfaced in
 *  `GET /api/info` `schemas.syncManifest` so the companion can compat-gate. */
export const SYNC_MANIFEST_SCHEMA = 1;

/** Per-chapter on-disk audio facts the route gathers (stat + format probe)
 *  and hands to the detail builder. Absent from the map for a chapter with
 *  no rendered audio. */
export interface ChapterAudioFact {
  fileSize: number;
  urlSuffix: 'audio.mp3' | 'audio.m4a' | 'audio.ogg';
  /** Real PCM-measured length from the chapter's `<slug>.segments.json`
   *  (the authoritative source the library scan uses). Preferred over the
   *  QA verdict's `durationSec`, which is often absent on older books. */
  durationSec?: number;
}

export interface SyncManifestIndexBook {
  bookId: string;
  updatedAt: string;
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  /** Active (non-excluded) chapter count. */
  chapterCount: number;
  coverUrl?: string;
  /** Explicit "Mark as finished" flag from listen-progress.json (NOT the
   *  derived isFinished — durations aren't reliably loaded on the index path). */
  finished?: boolean;
  /** "Hide from shelf" flag from listen-progress.json. */
  hidden?: boolean;
}

export interface SyncManifestIndex {
  schemaVersion: number;
  books: SyncManifestIndexBook[];
  /** ALWAYS the full current set, even under `?since` — the client evicts
   *  any local book absent from it. */
  activeBookIds: string[];
}

export interface SyncManifestChapter {
  uuid: string;
  /** Current positional id — the client builds `audioUrl` from it; keying
   *  is by `uuid`. */
  id: number;
  title: string;
  /** `audioRenderedAt` + file size; absent when the chapter has no audio. */
  fingerprint?: string;
  urlSuffix?: 'audio.mp3' | 'audio.m4a' | 'audio.ogg';
  audioUrl?: string;
  durationSec?: number;
  lufs?: number;
}

export interface SyncManifestBookDetail {
  schemaVersion: number;
  bookId: string;
  updatedAt: string;
  chapters: SyncManifestChapter[];
  /** Full active-chapter set for this book — the client evicts any local
   *  chapter absent from it. */
  activeChapterUuids: string[];
}

/** A chapter's content fingerprint: changes whenever the rendered audio
 *  changes, because both inputs (the render timestamp and the byte size)
 *  move on every audio-mutating path (all converge on
 *  finalize-chapter-write.ts, which stamps a fresh `audioRenderedAt`).
 *  Undefined when the chapter has no rendered audio. */
export function chapterFingerprint(
  audioRenderedAt: string | undefined,
  fileSize: number | undefined,
): string | undefined {
  if (!audioRenderedAt || fileSize === undefined) return undefined;
  return `${audioRenderedAt}|${fileSize}`;
}

/** ISO-comparable max of `state.updatedAt` and every chapter's
 *  `audioRenderedAt`, so the index signal moves on a metadata edit OR an
 *  audio regen. (ISO-8601 UTC strings compare chronologically.) */
export function bookManifestUpdatedAt(state: BookStateJson): string {
  let max = state.updatedAt;
  for (const c of state.chapters) {
    if (c.audioRenderedAt && c.audioRenderedAt > max) max = c.audioRenderedAt;
  }
  return max;
}

export function buildSyncManifestIndex(
  books: ReadonlyArray<{ bookId: string; state: BookStateJson; coverUrl?: string; finished?: boolean; hidden?: boolean }>,
  since?: string,
): SyncManifestIndex {
  const rows: SyncManifestIndexBook[] = [];
  for (const { bookId, state, coverUrl, finished, hidden } of books) {
    const updatedAt = bookManifestUpdatedAt(state);
    if (since && updatedAt <= since) continue;
    rows.push({
      bookId,
      updatedAt,
      title: state.title,
      author: state.author,
      series: state.series,
      seriesPosition: state.seriesPosition,
      chapterCount: state.chapters.filter((c) => !c.excluded).length,
      ...(coverUrl ? { coverUrl } : {}),
      ...(finished ? { finished: true } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  }
  return {
    schemaVersion: SYNC_MANIFEST_SCHEMA,
    books: rows,
    // Full set regardless of `since` — drives client-side eviction.
    activeBookIds: books.map((b) => b.bookId),
  };
}

export function buildSyncManifestBookDetail(
  bookId: string,
  state: BookStateJson,
  audioByChapterId: ReadonlyMap<number, ChapterAudioFact>,
): SyncManifestBookDetail {
  const chapters: SyncManifestChapter[] = [];
  for (const c of state.chapters) {
    if (c.excluded) continue;
    const audio = audioByChapterId.get(c.id);
    const lufs = c.audioQa?.measuredLufs;
    const durationSec = audio?.durationSec ?? c.audioQa?.durationSec;
    chapters.push({
      // The route guarantees a uuid via ensureChapterUuids before building.
      uuid: c.uuid ?? '',
      id: c.id,
      title: c.title,
      ...(audio
        ? {
            fingerprint: chapterFingerprint(c.audioRenderedAt, audio.fileSize),
            urlSuffix: audio.urlSuffix,
            audioUrl: `/api/books/${bookId}/chapters/${c.id}/${audio.urlSuffix}`,
          }
        : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(lufs !== undefined && lufs !== null ? { lufs } : {}),
    });
  }
  return {
    schemaVersion: SYNC_MANIFEST_SCHEMA,
    bookId,
    updatedAt: bookManifestUpdatedAt(state),
    chapters,
    activeChapterUuids: chapters.map((c) => c.uuid),
  };
}
