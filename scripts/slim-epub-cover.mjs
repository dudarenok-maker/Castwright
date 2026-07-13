#!/usr/bin/env node
/* Slim a Calibre-produced epub's embedded cover to a small JPG in-place.
   The Coalfall sample epubs carry a 2048² PNG cover (~5.6 MB) — the whole
   file weight. Resizing it to a ~1000px JPG drops the epub to ~300 KB with no
   change to the manuscript text (so a captured sample's attribution is intact).

   Usage:
     node scripts/slim-epub-cover.mjs <in.epub> [out.epub] [--width 1000] [--quality 3]

   Omitting <out.epub> rewrites <in.epub> in place. Requires ffmpeg on PATH
   (already a project prerequisite — see scripts/preflight-ffmpeg.cjs). */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { findCover, slimEpubBuffer } from './lib/slim-epub-cover.mjs';

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Drop values that belong to --width / --quality from the positional list.
const flagVals = new Set([argVal('--width', null), argVal('--quality', null)].filter(Boolean));
const [inPath, outMaybe] = positionals.filter((p) => !flagVals.has(p));
if (!inPath) {
  console.error('Usage: node scripts/slim-epub-cover.mjs <in.epub> [out.epub] [--width N] [--quality N]');
  process.exit(1);
}
const outPath = outMaybe || inPath;
const width = Number(argVal('--width', 1000));
const quality = Number(argVal('--quality', 3));

const buf = readFileSync(inPath);
const before = buf.length;
const entries = unzipSync(new Uint8Array(buf));
const { coverPath } = findCover(entries);

const tmp = mkdtempSync(join(tmpdir(), 'slim-epub-'));
try {
  const coverIn = join(tmp, 'cover.in');
  const coverJpg = join(tmp, 'cover.jpg');
  writeFileSync(coverIn, Buffer.from(entries[coverPath]));
  // Never upscale: min(width, iw). Aspect-preserving.
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', coverIn, '-vf', `scale='min(${width},iw)':-1`, '-q:v', String(quality), coverJpg],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const jpgBytes = new Uint8Array(readFileSync(coverJpg));
  const out = Buffer.from(slimEpubBuffer(new Uint8Array(buf), jpgBytes));
  writeFileSync(outPath, out);
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  console.log(`Slimmed ${inPath}: ${kb(before)} → ${kb(out.length)} (cover ${coverPath} → .jpg) → ${outPath}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
