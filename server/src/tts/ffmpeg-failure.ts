/* #4233 -- build the Error an ffmpeg subprocess failure rejects with.

   ffmpeg's stderr embeds absolute paths (`Output #0, mp3, to '<temp path>'`,
   `Error opening output <path>`) and, at `-loglevel info` (loudnorm on), the
   whole banner. That text used to be the Error's `message`, which the SSE
   failure frames and the generation `chapter_failed` reason broadcast to the
   client over LAN HTTPS. So `message` is a path-free summary (exit code + a
   scrubbed last line, keeping the "no space left" phrase the taxonomy's
   `disk-full` signature matches) and the full stderr rides on `ffmpegStderr`
   for the server log. */

export type FfmpegFailureError = Error & { ffmpegStderr: string };

const MAX_TAIL = 160;

function scrubPaths(s: string): string {
  return s
    .replace(/\\\\[^\s'"]+/g, '<path>') // UNC
    .replace(/[A-Za-z]:[\\/][^'"\r\n:]*/g, '<path>') // drive-letter, up to the next ':'
    .replace(/(?<![\w:.])\/[^\s'"():]+\/[^\s'"():]*/g, '<path>'); // posix, 2+ segments
}

export function ffmpegFailure(label: string, code: number | null, stderr: string): FfmpegFailureError {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let tail = scrubPaths(lines[lines.length - 1] ?? '').slice(0, MAX_TAIL);
  if (/no space left/i.test(stderr) && !/no space left/i.test(tail)) {
    tail = tail ? `${tail} (No space left on device)` : 'No space left on device';
  }
  const err = new Error(`${label} exited with code ${code}${tail ? `: ${tail}` : ''}`) as FfmpegFailureError;
  err.ffmpegStderr = stderr;
  return err;
}
