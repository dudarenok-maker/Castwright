#!/usr/bin/env node
/* Repair: stamp a Xing/Info VBR header onto every chapter MP3 in the
   workspace that shipped without one. Companion to the plan 109 encoder fix
   (`docs/features/109-mp3-xing-vbr-header.md`).

   Every MP3 generated before plan 109 was piped to ffmpeg's `pipe:1`
   (non-seekable stdout), so libmp3lame could not seek back to write the Xing
   VBR header. The frames are fine — they decode to the correct length — but
   without the header, players and ffprobe estimate duration from a sampled
   bitrate and inflate it ~7x (a 10:34 chapter shows as ~76:18 in the player).

   This script remuxes each affected MP3 with `ffmpeg -c:a copy -write_xing 1`
   to a seekable temp file, then atomically replaces the original. `-c:a copy`
   is a lossless stream copy — no re-encode, no quality change, ~instant per
   file (only the header is added; bytes are otherwise identical). It is
   idempotent: files that already carry a Xing/Info header are skipped, so it
   is safe to re-run. Sidecars (.segments.json / .peaks.json / .lufs.json) are
   never touched.

   Usage:
     node scripts/rexing-existing.mjs                # repair every chapter under the configured workspace
     node scripts/rexing-existing.mjs --dry-run      # print planned repairs without touching disk
     node scripts/rexing-existing.mjs --workspace X  # override workspace root (otherwise reads WORKSPACE_DIR
                                                     # from server/.env, or the ../audiobook-workspace default)
     node scripts/rexing-existing.mjs --filter SUB   # only chapters whose relative path contains SUB */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
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
      console.error(`rexing-existing: unknown flag "${a}". Pass --help for usage.`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelpAndExit(code) {
  console.log(`Usage: node scripts/rexing-existing.mjs [--dry-run] [--workspace <path>] [--filter <substring>]

Walks <workspace>/books/**/audio/*.mp3 and stamps a Xing/Info VBR header onto
any MP3 that lacks one (lossless stream copy, no re-encode). Fixes the ~7x
inflated player duration on chapters generated before plan 109. Idempotent —
already-tagged files are skipped, so it is safe to re-run.

Options:
  --dry-run         print planned repairs without modifying any file
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
   `*.mp3` (including `<slug>.previous.mp3`, which the player can load). Unlike
   the relufs walker we do NOT gate on a sidecar — a missing Xing header is
   independent of whether a chapter has loudness data. Temp files written by
   this script end in `.tmp-<pid>-<ts>` (no `.mp3` suffix), so they are never
   re-picked. Exported so the script test can drive it against a fixture
   workspace without spawning ffmpeg. */
export function* iterMp3s(booksRoot) {
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
          yield { mp3Path: join(audioDir, entry), bookDir };
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

/* Decode an ID3v2 synchsafe size (4 bytes, top bit of each is 0). Mirrors the
   helper in server/src/tts/mp3.test.ts. */
function id3v2TagLength(b) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size;
}

/* Find the first valid MPEG audio frame header in the buffer. Returns its
   byte offset, or -1 if none found within the first 4 KiB. Mirrors the helper
   in server/src/tts/mp3.test.ts. */
function findMpegSync(b) {
  const skip = id3v2TagLength(b);
  const limit = Math.min(b.length - 4, skip + 4096);
  for (let i = skip; i < limit; i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
      const version = (b[i + 1] >> 3) & 0x3;
      const layer = (b[i + 1] >> 1) & 0x3;
      if (version === 1 || layer === 0) continue; // reserved patterns
      return i;
    }
  }
  return -1;
}

/* Idempotency gate (no ffmpeg). Read the head of the file, skip any ID3v2
   tag, find the first MPEG frame, and scan that frame's window for the literal
   `Xing` (VBR) or `Info` (CBR) tag LAME writes into the first frame's side-
   information region. A frame that carries this tag already has a reliable
   duration, so we leave it alone. Exported for the test. */
export function hasXingHeader(mp3Path) {
  let head;
  try {
    const fd = readFileSync(mp3Path);
    head = fd.subarray(0, 8192);
  } catch {
    return false;
  }
  return hasXingHeaderInBuffer(head);
}

/* Buffer-level core of `hasXingHeader`, split out so the test can exercise it
   on handcrafted buffers without touching disk. */
export function hasXingHeaderInBuffer(buf) {
  const sync = findMpegSync(buf);
  if (sync < 0) return false;
  /* The Xing/Info tag sits a fixed distance into the frame (after the 4-byte
     header + side info), but that distance varies with MPEG version + channel
     mode. Scanning a generous window from the frame start covers every layout
     without decoding the header geometry. */
  const window = buf.subarray(sync, sync + 200);
  return window.includes(Buffer.from('Xing')) || window.includes(Buffer.from('Info'));
}

/* Remux one MP3 with `-c:a copy -write_xing 1` to a seekable temp file, then
   atomically replace the original. `-f mp3` is explicit so ffmpeg doesn't have
   to infer the format from the temp file's (non-.mp3) extension. The atomic
   temp-then-rename mirrors rewriteSidecar in relufs-existing.mjs. */
function remuxWithXing(mp3Path) {
  return new Promise((res, rej) => {
    const tmp = `${mp3Path}.tmp-${process.pid}-${Date.now()}`;
    const args = [
      '-hide_banner',
      '-nostats',
      '-loglevel',
      'error',
      '-y',
      '-i',
      mp3Path,
      '-c:a',
      'copy',
      '-write_xing',
      '1',
      '-f',
      'mp3',
      tmp,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      try {
        unlinkSync(tmp);
      } catch {
        /* temp may not exist yet */
      }
      rej(
        new Error(
          `Failed to spawn ffmpeg for Xing remux: ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        try {
          unlinkSync(tmp);
        } catch {
          /* swallow */
        }
        rej(new Error(`ffmpeg Xing remux exited ${code}: ${stderr.trim() || '(no stderr)'}`));
        return;
      }
      try {
        renameSync(tmp, mp3Path);
        res();
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* swallow */
        }
        rej(err);
      }
    });
  });
}

/* Entry point. Returns a summary object for testability. */
export async function main(cliOpts = {}) {
  const opts = { dryRun: false, workspace: null, filter: null, ...cliOpts };
  const workspaceRoot = resolveWorkspaceRoot(opts.workspace);
  const booksRoot = join(workspaceRoot, 'books');

  if (!existsSync(booksRoot)) {
    console.error(`rexing-existing: no books root at ${booksRoot}; nothing to do.`);
    return { workspaceRoot, processed: 0, repaired: 0, alreadyTagged: 0, skipped: 0, failed: 0 };
  }

  console.log(`rexing-existing: workspace = ${workspaceRoot}`);
  if (opts.dryRun) console.log('rexing-existing: DRY RUN — no files will be modified.');

  let processed = 0;
  let repaired = 0;
  let alreadyTagged = 0;
  let skipped = 0;
  let failed = 0;

  for (const chapter of iterMp3s(booksRoot)) {
    const relPath = relative(booksRoot, chapter.mp3Path);
    if (opts.filter && !relPath.includes(opts.filter)) {
      skipped += 1;
      continue;
    }
    processed += 1;
    try {
      if (hasXingHeader(chapter.mp3Path)) {
        alreadyTagged += 1;
        continue;
      }
      if (opts.dryRun) {
        console.log(`  [dry] ${relPath}: would stamp Xing header`);
        repaired += 1;
      } else {
        await remuxWithXing(chapter.mp3Path);
        console.log(`  ${relPath}: Xing header stamped`);
        repaired += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `rexing-existing: processed ${processed}, repaired ${repaired}, alreadyTagged ${alreadyTagged}, skipped ${skipped}, failed ${failed}.`,
  );
  return { workspaceRoot, processed, repaired, alreadyTagged, skipped, failed };
}

/* Run main() when invoked directly (not when imported by a test). */
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
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
