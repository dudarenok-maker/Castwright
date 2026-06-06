/* fs-18 — ffmpeg/ffprobe presence probe for the admin diagnostics board.
   Both binaries are hard runtime deps: server/src/tts/mp3.ts spawns bare
   `ffmpeg` (MP3/M4A/Opus muxing) and the export path spawns bare `ffprobe`,
   both off PATH with no env override. So a bare-PATH `-version` probe matches
   exactly what those code paths resolve — no false "missing" when a configured
   path would actually work, because there is no configured path. */

import { spawnSync } from 'node:child_process';

export interface FfmpegProbe {
  ffmpeg: boolean;
  ffprobe: boolean;
}

/* `spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0` is the same
   detection pattern already used in server/src/export/build-m4b.test.ts and the
   libfdk_aac probe in mp3.ts. status is null (not 0) when the binary isn't on
   PATH (ENOENT), so the strict `=== 0` correctly reports absence. */
function present(bin: string): boolean {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

export function probeFfmpeg(): FfmpegProbe {
  return { ffmpeg: present('ffmpeg'), ffprobe: present('ffprobe') };
}
