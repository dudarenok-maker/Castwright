#!/usr/bin/env node
/* Backfill: re-measure every chapter MP3 in the workspace and rewrite its
   sibling `<slug>.lufs.json` with the actual post-encode loudness. Companion
   to the 2026-05-22 LUFS-drift fix — see
   `docs/features/archive/71-audio-loudness-normalization.md` for the bug
   write-up.

   Pre-fix sidecars carry `i = input_i` (pre-normalisation loudness of the
   raw PCM). The MP3 on disk is already normalised to -16 LUFS, but the
   sidecar (and therefore the per-chapter pill + report card) shows the
   pre-filter value. This script re-measures the encoded MP3 via ffmpeg's
   `ebur128` filter and rewrites the sidecar in place — no re-encode, no
   regenerate. ~3 s per chapter.

   Usage:
     node scripts/relufs-existing.mjs                # rewrite every chapter under the configured workspace
     node scripts/relufs-existing.mjs --dry-run      # print planned rewrites without touching disk
     node scripts/relufs-existing.mjs --workspace X  # override workspace root (otherwise reads WORKSPACE_DIR
                                                     # from server/.env, or the ../audiobook-workspace default)
     node scripts/relufs-existing.mjs --filter SUB   # only chapters whose relative path contains SUB

   Skips chapters without an existing `.lufs.json` sidecar (legacy chapters
   that were rendered before plan 71 — they have no sidecar to update; the
   report card already degrades to "no data" for them). */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ROOT = join(REPO_ROOT, 'server');

function parseArgs(argv) {
  const opts = { dryRun: false, workspace: null, filter: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--workspace') {
      opts.workspace = argv[i + 1];
      i += 1;
    } else if (a === '--filter') {
      opts.filter = argv[i + 1];
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printHelpAndExit(0);
    } else {
      console.error(`relufs-existing: unknown flag "${a}". Pass --help for usage.`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelpAndExit(code) {
  console.log(`Usage: node scripts/relufs-existing.mjs [--dry-run] [--workspace <path>] [--filter <substring>]

Walks <workspace>/books/**/audio/*.mp3 and rewrites the sibling *.lufs.json
with a fresh ebur128 measurement of the on-disk MP3. Companion to the
2026-05-22 LUFS-drift fix. Skips chapters without an existing sidecar.

Options:
  --dry-run         print planned rewrites without modifying any file
  --workspace <p>   override workspace root (defaults to server/.env WORKSPACE_DIR
                    or ../audiobook-workspace relative to the repo root)
  --filter <sub>    only chapters whose relative path contains <sub>
  --help, -h        print this help and exit`);
  process.exit(code);
}

/* Resolve the workspace root the same way server/src/workspace/paths.ts does
   at boot — env precedence, then default. Honours the override the server
   would honour, so this script and a running server agree on the layout. */
function resolveWorkspaceRoot(explicit) {
  if (explicit) return resolve(process.cwd(), explicit);
  loadServerDotEnv();
  const envDir = process.env.WORKSPACE_DIR?.trim();
  const dir = envDir && envDir.length > 0 ? envDir : '../audiobook-workspace';
  return resolve(SERVER_ROOT, dir);
}

function loadServerDotEnv() {
  /* Node 20.6+ ships native `process.loadEnvFile`. We use it the same way
     the server does (see `server/src/load-env.ts`). Silent no-op if the
     file doesn't exist — common on fresh clones. */
  const envPath = join(SERVER_ROOT, '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* Older Node? Fall back to a minimal parser for KEY=VALUE lines so the
       script doesn't hard-require 20.6+. */
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}

/* Walk every `audio/` directory under `<workspace>/books/` and yield every
   `*.mp3` that has a sibling `*.lufs.json`. Pre-fix sidecars are exactly
   what we want to rewrite; chapters with no sidecar are skipped silently
   (legacy / `AUDIO_LOUDNORM_ENABLED=false` / silent-source fallthrough).
   Exported so the script test can drive it against a fixture workspace
   without spawning ffmpeg. */
export function* iterChapters(booksRoot) {
  if (!existsSync(booksRoot)) return;
  /* Workspace layout: <booksRoot>/<Author>/<Series>/<Book>/audio/<slug>.mp3 */
  for (const author of readdirSync(booksRoot)) {
    const authorDir = join(booksRoot, author);
    if (!safeIsDir(authorDir)) continue;
    for (const series of readdirSync(authorDir)) {
      const seriesDir = join(authorDir, series);
      if (!safeIsDir(seriesDir)) continue;
      for (const book of readdirSync(seriesDir)) {
        const bookDir = join(seriesDir, book);
        const audioDir = join(bookDir, 'audio');
        if (!safeIsDir(audioDir)) continue;
        for (const entry of readdirSync(audioDir)) {
          if (!entry.endsWith('.mp3')) continue;
          const mp3Path = join(audioDir, entry);
          const lufsPath = join(audioDir, entry.replace(/\.mp3$/, '.lufs.json'));
          if (!existsSync(lufsPath)) continue;
          yield { mp3Path, lufsPath, bookDir };
        }
      }
    }
  }
}

function safeIsDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/* Spawn `ffmpeg -i <mp3> -af ebur128=peak=true -f null -` and parse the
   integrated loudness + range + true-peak out of the "Summarizing" block at
   the end of stderr. ebur128 emits per-frame I/M/S lines too; we MUST scope
   the regex to the trailing summary or we pick up an intermediate gate value. */
function measureMp3(mp3Path) {
  return new Promise((res, rej) => {
    const args = ['-hide_banner', '-nostats', '-i', mp3Path, '-af', 'ebur128=peak=true', '-f', 'null', '-'];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      rej(
        new Error(
          `Failed to spawn ffmpeg for ebur128 measurement: ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        rej(new Error(`ffmpeg ebur128 exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        res(parseEbur128Summary(stderr));
      } catch (e) {
        rej(e);
      }
    });
  });
}

/* Parse the `Summarizing` / `Integrated loudness` block from ebur128 stderr.
   Format (real example):
       [Parsed_ebur128_0 @ 0x55] Summarizing
       [Parsed_ebur128_0 @ 0x55]   Integrated loudness:
       [Parsed_ebur128_0 @ 0x55]     I:         -16.0 LUFS
       [Parsed_ebur128_0 @ 0x55]     Threshold: -26.1 LUFS
       [Parsed_ebur128_0 @ 0x55]   Loudness range:
       [Parsed_ebur128_0 @ 0x55]     LRA:        8.4 LU
       [Parsed_ebur128_0 @ 0x55]     Threshold: -36.1 LUFS
       [Parsed_ebur128_0 @ 0x55]     LRA low:   -21.0 LUFS
       [Parsed_ebur128_0 @ 0x55]     LRA high:  -12.6 LUFS
       [Parsed_ebur128_0 @ 0x55]   True peak:
       [Parsed_ebur128_0 @ 0x55]     Peak:      -1.5 dBFS
   Returns `{ i, lra, tp }` (LUFS, LU, dBTP). */
export function parseEbur128Summary(stderr) {
  const summaryIdx = stderr.lastIndexOf('Integrated loudness:');
  if (summaryIdx < 0) {
    throw new Error(`ebur128 stderr had no "Integrated loudness:" block: ${stderr.slice(-400)}`);
  }
  const summary = stderr.slice(summaryIdx);
  const iMatch = summary.match(/\bI:\s*(-?[0-9.]+|-?inf)\s*LUFS/);
  const lraMatch = summary.match(/\bLRA:\s*(-?[0-9.]+|-?inf)\s*LU\b/);
  /* True peak reports as dBFS in the ebur128 summary even though the field
     is conceptually dBTP — same scale, same sign convention. */
  const tpMatch = summary.match(/\bPeak:\s*(-?[0-9.]+|-?inf)\s*dB(?:TP|FS)/);
  if (!iMatch) throw new Error(`ebur128 summary had no "I:" line: ${summary.slice(0, 400)}`);
  if (!lraMatch) throw new Error(`ebur128 summary had no "LRA:" line: ${summary.slice(0, 400)}`);
  if (!tpMatch) throw new Error(`ebur128 summary had no "Peak:" line: ${summary.slice(0, 400)}`);
  return {
    i: parseNum(iMatch[1]),
    lra: parseNum(lraMatch[1]),
    tp: parseNum(tpMatch[1]),
  };
}

function parseNum(s) {
  if (s === '-inf' || s === '-Inf') return -Infinity;
  if (s === 'inf' || s === '+inf') return Infinity;
  return Number(s);
}

/* Rewrite a sidecar JSON atomically using the same temp-then-rename pattern
   `writeChapterLufsFile` (in `server/src/tts/mp3.ts`) uses. Preserves the
   existing `target` so re-measured chapters keep their original normalisation
   target; sets `twoPass: true` because that's what loudnorm runs at production
   default (the script is fixing the post-fix sidecar contract — single-pass
   chapters were always nominal-target and don't need re-measurement). */
function rewriteSidecar(lufsPath, measurement) {
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(lufsPath, 'utf8'));
  } catch {
    /* Malformed existing sidecar — overwrite anyway. The fresh measurement
       is the right answer regardless of what bytes were there before. */
  }
  const target = typeof existing?.target === 'number' ? existing.target : -16;
  const payload = {
    i: measurement.i,
    lra: measurement.lra,
    tp: measurement.tp,
    target,
    twoPass: true,
    measuredAt: new Date().toISOString(),
  };
  const tmp = `${lufsPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    renameSync(tmp, lufsPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow */
    }
    throw err;
  }
  return { previousI: typeof existing?.i === 'number' ? existing.i : null, newI: payload.i };
}

function fmtLufs(v) {
  if (v === null || Number.isNaN(v)) return '— LUFS';
  if (!Number.isFinite(v)) return `${v > 0 ? '+' : '-'}∞ LUFS`;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} LUFS`;
}

/* Entry point. Returns a summary object for testability (script tests can
   require this module and call main({ dryRun: true }) against a fixture
   workspace without re-spawning the script). */
export async function main(cliOpts = {}) {
  const opts = { dryRun: false, workspace: null, filter: null, ...cliOpts };
  const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
  const booksRoot = join(workspaceRoot, 'books');

  if (!existsSync(booksRoot)) {
    console.error(`relufs-existing: no books root at ${booksRoot}; nothing to do.`);
    return { workspaceRoot, processed: 0, rewritten: 0, skipped: 0, failed: 0 };
  }

  console.log(`relufs-existing: workspace = ${workspaceRoot}`);
  if (opts.dryRun) console.log('relufs-existing: DRY RUN — no files will be modified.');

  let processed = 0;
  let rewritten = 0;
  let skipped = 0;
  let failed = 0;

  for (const chapter of iterChapters(booksRoot)) {
    const relPath = relative(booksRoot, chapter.mp3Path);
    if (opts.filter && !relPath.includes(opts.filter)) {
      skipped += 1;
      continue;
    }
    processed += 1;
    try {
      const measurement = await measureMp3(chapter.mp3Path);
      if (opts.dryRun) {
        let previousI = null;
        try {
          previousI = JSON.parse(readFileSync(chapter.lufsPath, 'utf8'))?.i ?? null;
        } catch {
          /* dry-run swallows read errors */
        }
        console.log(`  [dry] ${relPath}: ${fmtLufs(previousI)} → ${fmtLufs(measurement.i)}`);
        rewritten += 1;
      } else {
        const { previousI, newI } = rewriteSidecar(chapter.lufsPath, measurement);
        console.log(`  ${relPath}: ${fmtLufs(previousI)} → ${fmtLufs(newI)}`);
        rewritten += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${relPath}: ${(err instanceof Error ? err.message : String(err))}`);
    }
  }

  console.log(
    `relufs-existing: processed ${processed}, rewritten ${rewritten}, skipped ${skipped}, failed ${failed}.`,
  );
  return { workspaceRoot, processed, rewritten, skipped, failed };
}

/* Run main() when invoked directly (not when imported by a test). */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2));
  main(opts).then(
    (result) => {
      process.exit(result.failed > 0 ? 1 : 0);
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
