/* ID3v2.4 re-tagger. Takes an existing MP3 on disk, writes a new MP3 to
   `destPath` with the supplied tags and the input's audio frames copied
   byte-for-byte (`-c:a copy`). No re-encode — the LAME VBR V2 bytes
   produced by encodePcmToMp3 survive intact.

   ffmpeg strips inbound MP3 tags by default when remuxing to mp3, so the
   destination ends up with only the tags we pass via `-metadata`. We
   suppress the ID3v1 trailer (deprecated, capped at 30-char fields) and
   pin to ID3v2.4 — PocketBook Reader on Android reads v2.3/2.4 fine.

   Tag mapping:
     title        → TIT2 (chapter title)
     album        → TALB (book title)
     artist       → TPE1 (narrator credit, falling back to author)
     album_artist → TPE2 (author)
     track        → TRCK ("N/total")
     genre        → TCON
     date         → TDRC (YYYY or YYYY-MM-DD)
     cover (opt)  → APIC (embedded JPEG/PNG, attached_pic disposition) */

import { spawn } from 'node:child_process';

export interface Id3Tags {
  title: string;
  album: string;
  artist: string;
  albumArtist: string;
  track: number;
  trackTotal: number;
  genre?: string | null;
  date?: string | null;
}

export interface ApplyId3Options {
  /** Optional path to a JPEG/PNG cover. When present, ffmpeg adds it as
      a second input and writes the ID3v2 APIC frame + attached_pic
      disposition. Stream-copied — source bytes preserved verbatim. */
  coverJpegPath?: string | null;
}

export async function applyId3v24Tags(
  srcPath: string,
  destPath: string,
  tags: Id3Tags,
  options: ApplyId3Options = {},
): Promise<void> {
  const coverPath = options.coverJpegPath ?? null;
  const args: string[] = [
    '-loglevel', 'error',
    '-y', /* overwrite dest if a previous run left one behind */
    '-i', srcPath,
    ...(coverPath ? ['-i', coverPath] : []),
    '-map', '0:a',           /* keep only the audio stream — skip embedded cover/data */
    ...(coverPath ? ['-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
    '-c:a', 'copy',
    '-id3v2_version', '4',
    '-write_id3v1', '0',
    '-metadata', `title=${tags.title}`,
    '-metadata', `album=${tags.album}`,
    '-metadata', `artist=${tags.artist}`,
    '-metadata', `album_artist=${tags.albumArtist}`,
    '-metadata', `track=${tags.track}/${tags.trackTotal}`,
  ];
  if (tags.genre)  args.push('-metadata', `genre=${tags.genre}`);
  if (tags.date)   args.push('-metadata', `date=${tags.date}`);
  args.push('-f', 'mp3', destPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', chunk => stderrChunks.push(chunk));
    child.on('error', err => reject(new Error(
      `Failed to spawn ffmpeg: ${err.message}. ` +
      `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
    )));
    child.on('close', code => {
      if (code === 0) return resolve();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`));
    });
  });
}
