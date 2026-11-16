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

/* A path root: a `file:` URL (`file:` + `/`; ffmpeg's own "Error closing file:
   <strerror>" is not one), UNC / `\\?\`, a drive letter, `~/`, or a `/` that opens a
   token (not glued to a word, `#`, `.` or `/`, so `I/O`, `out#0/mp3`, `1/2` and
   `http://` stay whole). Paths can hold spaces, quotes and colons, so no end can be
   told apart from the text that follows: everything from the first root to the end
   of the line is dropped. */
const PATH_ROOT = /file:(?=\/)|\\\\|(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.])~\/|(?<![\w#./])\/(?=[\w.~-])/;

function scrubPaths(s: string): string {
  const m = PATH_ROOT.exec(s);
  return m ? `${s.slice(0, m.index)}<path>` : s;
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
