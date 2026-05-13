/* Locate a chapter's audio file on disk irrespective of container format.
   New generations produce MP3; legacy chapters from before that switch are
   WAV. Both extensions must keep working — we don't auto-transcode old
   chapters. Voice samples (`server/src/routes/voice-sample.ts`) live in a
   different directory and are not handled here.

   `mp3` is preferred when both exist (e.g. a chapter regenerated after the
   format switch but whose old WAV wasn't cleaned up). */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ChapterAudioExt = 'mp3' | 'wav';

export interface ChapterAudioFile {
  path: string;
  ext: ChapterAudioExt;
  mime: 'audio/mpeg' | 'audio/wav';
  urlSuffix: 'audio.mp3' | 'audio.wav';
}

const PROBE_ORDER: ReadonlyArray<ChapterAudioFile['ext']> = ['mp3', 'wav'];

export function findChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  for (const ext of PROBE_ORDER) {
    const path = join(audioRoot, `${slug}.${ext}`);
    if (existsSync(path)) return makeDescriptor(path, ext);
  }
  return null;
}

export function chapterAudioExists(audioRoot: string, slug: string): boolean {
  return PROBE_ORDER.some(ext => existsSync(join(audioRoot, `${slug}.${ext}`)));
}

function makeDescriptor(path: string, ext: ChapterAudioExt): ChapterAudioFile {
  return ext === 'mp3'
    ? { path, ext, mime: 'audio/mpeg', urlSuffix: 'audio.mp3' }
    : { path, ext, mime: 'audio/wav',  urlSuffix: 'audio.wav' };
}
