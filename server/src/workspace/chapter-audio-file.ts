/* Locate a chapter's audio file on disk. MP3 is the only chapter audio
   format produced or recognised post-plan-39 — legacy `.wav` files from
   before the format switch are invisible to the locator. Voice samples
   (`server/src/routes/voice-sample.ts`) live in a different directory and
   are not handled here. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ChapterAudioExt = 'mp3';

export interface ChapterAudioFile {
  path: string;
  ext: ChapterAudioExt;
  mime: 'audio/mpeg';
  urlSuffix: 'audio.mp3';
}

export function findChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  const path = join(audioRoot, `${slug}.mp3`);
  if (!existsSync(path)) return null;
  return { path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' };
}

export function chapterAudioExists(audioRoot: string, slug: string): boolean {
  return existsSync(join(audioRoot, `${slug}.mp3`));
}
