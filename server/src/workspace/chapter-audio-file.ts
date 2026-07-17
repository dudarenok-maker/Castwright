/* Locate a chapter's audio file on disk. Probes the audio formats produced
   by the encoder (plan 72 widened the set from mp3-only to mp3/m4a/ogg).
   Legacy `.wav` files from before plan 39 stay invisible. Voice samples
   (`server/src/routes/voice-sample.ts`) live in a different directory and
   are not handled here.

   The probe is ordered: an `.mp3` next to an `.m4a` (e.g. mid-format
   switch on the same book) resolves to whichever ranks first in
   `EXT_PROBE_ORDER` — mp3 wins so existing books keep behaving
   identically until they're re-rendered into a new format. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeIdSegment } from '../util/safe-path.js';

export type ChapterAudioExt = 'mp3' | 'm4a' | 'ogg';

export interface ChapterAudioFile {
  path: string;
  ext: ChapterAudioExt;
  mime: 'audio/mpeg' | 'audio/mp4' | 'audio/ogg';
  /** URL path suffix appended after `/chapters/:id/`. Stays per-format so
   *  the chapter-audio route can serve the right content-type without a
   *  second disk probe. Examples: `audio.mp3`, `audio.m4a`, `audio.ogg`. */
  urlSuffix: 'audio.mp3' | 'audio.m4a' | 'audio.ogg';
}

interface FormatDescriptor {
  ext: ChapterAudioExt;
  mime: ChapterAudioFile['mime'];
  urlSuffix: ChapterAudioFile['urlSuffix'];
}

/* Probe order: mp3 first so legacy books that pre-date plan 72 resolve
   identically. The other entries are checked in a deterministic order
   when an mp3 isn't present. */
const EXT_PROBE_ORDER: readonly FormatDescriptor[] = [
  { ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' },
  { ext: 'm4a', mime: 'audio/mp4', urlSuffix: 'audio.m4a' },
  { ext: 'ogg', mime: 'audio/ogg', urlSuffix: 'audio.ogg' },
];

export function findChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  /* `slug` is derived from user/import-controlled chapter metadata and reaches
     this join unfiltered from every export builder. sanitizeIdSegment collapses
     any `..` run and path separators to `_`, so a crafted slug like
     `../../secret` can only ever resolve to a plain file *inside* audioRoot
     (which won't exist → null), never escape it. It's a no-op on real slugs —
     they contain no separators or `..` runs — so behaviour is unchanged for
     every legitimate chapter. */
  const safeSlug = sanitizeIdSegment(slug);
  for (const desc of EXT_PROBE_ORDER) {
    const path = join(audioRoot, `${safeSlug}.${desc.ext}`);
    if (existsSync(path)) {
      return { path, ext: desc.ext, mime: desc.mime, urlSuffix: desc.urlSuffix };
    }
  }
  return null;
}

export function chapterAudioExists(audioRoot: string, slug: string): boolean {
  return findChapterAudio(audioRoot, slug) !== null;
}
