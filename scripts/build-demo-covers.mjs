// Build-time downscale of the git-ignored brand/book-covers/{bookId}.png sources
// into small committed apps/android/assets/demo-covers/{bookId}.png for the app-20
// on-device demo. Mirrors the brand/ -> public/ generated-PNG pattern. Run:
//   node scripts/build-demo-covers.mjs           (reads brand/book-covers/)
//   DEMO_COVERS_SRC=/path node scripts/build-demo-covers.mjs
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BOOK_IDS = ['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3', 'coalfall-commission'];

/** Display width of the committed demo covers (px). Keeps them small. */
export const COVER_WIDTH = 400;

/** The four (id, src, out) render targets. Sources/outputs are {bookId}.png. */
export function coverTargets(srcDir, outDir) {
  return BOOK_IDS.map((id) => ({
    id,
    src: resolve(srcDir, `${id}.png`),
    out: resolve(outDir, `${id}.png`),
  }));
}

async function main() {
  const { default: sharp } = await import('sharp'); // lazy: keeps the pure-helper test import-light
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const srcDir = process.env.DEMO_COVERS_SRC || resolve(root, 'brand/book-covers');
  const outDir = resolve(root, 'apps/android/assets/demo-covers');
  mkdirSync(outDir, { recursive: true });
  for (const t of coverTargets(srcDir, outDir)) {
    if (!existsSync(t.src)) {
      console.error(`[demo-covers] MISSING source ${t.src}`);
      process.exitCode = 1;
      continue;
    }
    await sharp(t.src).resize({ width: COVER_WIDTH }).png({ quality: 80 }).toFile(t.out);
    console.log(`[demo-covers] ${t.id} -> ${t.out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
