/* M4B packer — Phase B of the audiobook export pipeline.

   Concats the per-chapter MP3s into a single AAC-LC file with
   QuickTime-style chapter atoms via an FFMETADATA sidecar. PocketBook
   surfaces the resulting `.m4b` under Audiobooks (not Music), with
   chapter UI and resume-position state — see
   `docs/features/32-audiobook-export.md`.

   Re-encodes (unlike Phase A's MP3.ZIP which is `-c:a copy`): 24 kHz
   mono MP3 → 44.1 kHz mono AAC-LC @ 96 kbps. The re-encode tolerates
   any source sample-rate mismatch (concat-demux + stream-copy is the
   classic source of click-at-boundary glitches; the re-encode path
   sidesteps that entirely).

   Refuses with `ExportIncompleteError` (re-exported from
   build-mp3-zip.ts) when any non-excluded chapter lacks a current
   `.mp3`. Callers turn that into a 409 with a "Regenerate missing
   chapters" hint, identical to the MP3.ZIP path. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { ExportIncompleteError } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

export { ExportIncompleteError } from './build-mp3-zip.js';

export interface BuildM4bOptions {
  bookDir: string;
  state: BookStateJson;
  outPath: string;
  /** Optional progress callback — fires as ffmpeg writes `-progress` ticks
      to stdout. Ratio is 0..1 over the *total* expected duration. */
  onProgress?: (ratio: number) => void;
}

export interface BuildM4bResult {
  sizeBytes: number;
  chapterCount: number;
  totalDurationSec: number;
}

export async function buildM4b(opts: BuildM4bOptions): Promise<BuildM4bResult> {
  const { bookDir, state, outPath, onProgress } = opts;

  const chapters = [...state.chapters]
    .filter(c => !c.excluded)
    .sort((a, b) => a.id - b.id);

  /* Same precheck as buildMp3Zip — both formats require a current MP3
     for every non-excluded chapter. Surface ALL missing slugs in one
     shot. */
  const root = audioDir(bookDir);
  const missing: string[] = [];
  const resolved: Array<{ chapter: typeof chapters[number]; mp3Path: string }> = [];
  for (const chapter of chapters) {
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ chapter, mp3Path: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  /* Probe each MP3 for its exact duration. We can't derive chapter
     ends from the post-encode probe — AAC priming samples and concat
     padding shift offsets by a few ms per chapter, which is enough to
     show wrong durations in some players. The per-source-MP3 duration
     is the source of truth for the chapter timestamps. */
  const durationsSec: number[] = [];
  for (const { mp3Path } of resolved) {
    durationsSec.push(await probeDurationSec(mp3Path));
  }
  const totalDurationSec = durationsSec.reduce((a, b) => a + b, 0);

  const stagingDir = `${outPath}.staging-${process.pid}-${Date.now()}`;
  await mkdir(stagingDir, { recursive: true });

  try {
    const ffmetadataPath = join(stagingDir, 'FFMETADATA.txt');
    const concatPath = join(stagingDir, 'concat.txt');

    await writeFile(ffmetadataPath, buildFfmetadata(state, resolved.map(r => r.chapter), durationsSec), 'utf8');
    await writeFile(concatPath, buildConcatList(resolved.map(r => r.mp3Path)), 'utf8');

    /* Plan 36 A2: pipe the cached OpenLibrary cover into the M4B as the
       iTunes `covr` atom when one exists for this book. The cover-art
       pipeline writes `<bookDir>/.audiobook/cover.jpg` after a successful
       fetch; if the file is absent (no cover picked, or DELETE cleared
       it) we skip the input entirely so the export still ships — same
       resilience PocketBook / Voice / Apple Books / BookPlayer rely on. */
    const cover = coverImagePath(bookDir);
    const coverPath = existsSync(cover) ? cover : null;

    await runFfmpegMux({
      concatPath,
      ffmetadataPath,
      coverPath,
      outPath,
      totalDurationSec,
      onProgress,
    });

    const finalStat = await stat(outPath);
    return {
      sizeBytes: finalStat.size,
      chapterCount: resolved.length,
      totalDurationSec,
    };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---- FFMETADATA + concat list -------------------------------------- */

/* The FFMETADATA spec uses `=`, `;`, `#`, `\`, and newline as control
   characters; backslash-prefix them in tag values. Newlines collapse
   to a literal `\n` (we never want a multi-line chapter title — most
   players truncate at the first newline anyway). */
function escapeFfmetadata(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/=/g,  '\\=')
    .replace(/;/g,  '\\;')
    .replace(/#/g,  '\\#')
    .replace(/\r?\n/g, '\\n');
}

function buildFfmetadata(
  state: BookStateJson,
  chapters: BookStateJson['chapters'],
  durationsSec: number[],
): string {
  const lines: string[] = [';FFMETADATA1'];

  const artist = (state.narratorCredit && state.narratorCredit.trim()) || state.author;
  lines.push(`title=${escapeFfmetadata(state.title)}`);
  lines.push(`artist=${escapeFfmetadata(artist)}`);
  lines.push(`album=${escapeFfmetadata(state.title)}`);
  lines.push(`album_artist=${escapeFfmetadata(state.author)}`);
  if (state.genre)           lines.push(`genre=${escapeFfmetadata(state.genre)}`);
  if (state.publicationDate) lines.push(`date=${escapeFfmetadata(state.publicationDate)}`);
  /* iTunes audiobook media kind — flips Apple/QuickTime players from
     'Music' to 'Audiobook'. Harmless on players that ignore it. */
  lines.push(`media_type=2`);
  lines.push('');

  let cursorMs = 0;
  for (let i = 0; i < chapters.length; i++) {
    const durMs = Math.max(1, Math.round(durationsSec[i] * 1000));
    const start = cursorMs;
    const end = cursorMs + durMs;
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${start}`);
    lines.push(`END=${end}`);
    lines.push(`title=${escapeFfmetadata(chapters[i].title)}`);
    lines.push('');
    cursorMs = end;
  }

  return lines.join('\n');
}

/* Concat demuxer file: one `file '<path>'` per chapter. Single-quotes
   are the only delimiter that survives backslashes on Windows; embedded
   single-quotes escape as `'\''`. */
function buildConcatList(paths: string[]): string {
  return paths.map(p => `file '${p.replace(/'/g, `'\\''`)}'`).join('\n') + '\n';
}

/* ---- ffprobe / ffmpeg child-process helpers ------------------------ */

function probeDurationSec(mp3Path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      mp3Path,
    ];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', c => stdoutChunks.push(c));
    child.stderr.on('data', c => stderrChunks.push(c));
    child.on('error', err => reject(new Error(
      `Failed to spawn ffprobe: ${err.message}. ` +
      `Install ffmpeg and ensure ffprobe is on PATH (winget install Gyan.FFmpeg).`,
    )));
    child.on('close', code => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        return reject(new Error(`ffprobe exited with code ${code} for ${mp3Path}: ${stderr || '(no stderr)'}`));
      }
      const raw = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const num = Number(raw);
      if (!Number.isFinite(num) || num <= 0) {
        return reject(new Error(`ffprobe returned non-positive duration for ${mp3Path}: ${raw}`));
      }
      resolve(num);
    });
  });
}

interface RunFfmpegMuxOptions {
  concatPath: string;
  ffmetadataPath: string;
  /** Optional path to a JPEG/PNG cover. When present, ffmpeg adds it as a
      third input and writes the iTunes `covr` atom + `attached_pic`
      disposition. Stream-copied — no re-encode of the cover bytes. */
  coverPath: string | null;
  outPath: string;
  totalDurationSec: number;
  onProgress?: (ratio: number) => void;
}

function runFfmpegMux(opts: RunFfmpegMuxOptions): Promise<void> {
  const { concatPath, ffmetadataPath, coverPath, outPath, totalDurationSec, onProgress } = opts;
  const totalUs = Math.max(1, Math.round(totalDurationSec * 1_000_000));

  return new Promise<void>((resolve, reject) => {
    /* Inputs: concat-demuxed MP3s [0], FFMETADATA sidecar [1], and
       optionally the cover JPEG [2]. When the cover is present we map
       its video stream into the output with `attached_pic` disposition
       so iOS / Apple / Plex / BookPlayer treat it as the album art
       rather than a video track. Stream-copied (-c:v copy) — the source
       JPEG bytes are preserved verbatim. */
    const args = [
      '-y',
      '-loglevel', 'error',
      '-progress', 'pipe:1',
      '-nostats',
      '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-i', ffmetadataPath,
      ...(coverPath ? ['-i', coverPath] : []),
      '-map', '0:a',
      ...(coverPath ? ['-map', '2:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
      '-map_metadata', '1',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-ac', '1',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outPath,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks: Buffer[] = [];

    let stdoutBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (!onProgress) return;
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        /* `out_time_us` is microseconds (the trailing `_us` is correct
           despite the historical `_ms` alias also being present — both
           are microseconds in current ffmpeg builds; we prefer `_us`). */
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const us = Number(value);
          if (Number.isFinite(us) && us >= 0) {
            const ratio = Math.min(1, Math.max(0, us / totalUs));
            onProgress(ratio);
          }
        } else if (key === 'progress' && value === 'end') {
          onProgress(1);
        }
      }
    });
    child.stderr.on('data', c => stderrChunks.push(c));

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
