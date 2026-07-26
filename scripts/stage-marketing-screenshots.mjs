#!/usr/bin/env node
/* Converts the curated subset of mockups/marketing-screens/ (produced by
   `npm run capture:marketing`) to webp and stages both theme variants into
   brand/go-to-market/launch-post-images/marketing-site/screenshots/ — the
   folder mirrored into the separate Castwright-Website repo's
   public/screenshots/. Replaces the ad hoc process used before this script
   existed; re-run after any capture-rail change instead of hand-converting.

   Out of scope: companion-app screenshots (scripts/capture-companion.mjs is
   a separate pipeline) — not touched here. */

import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'mockups', 'marketing-screens');
const DEST_DIR = path.join(
  ROOT,
  'brand',
  'go-to-market',
  'launch-post-images',
  'marketing-site',
  'screenshots',
);

// scene/viewport → output filename. By default every entry is staged in BOTH
// themes: `<output>.webp` (light) and `<output>-dark.webp` (dark).
//
// An entry may pin `themes` to a single theme when the captured surface has only
// one treatment — see the series-cast-card entry, whose capture scene is
// dark-only by design. Two consequences, both deliberate:
//   - A single-theme entry drops the `-dark` suffix. The file isn't the dark half
//     of a pair, it's the only variant, and a consumer embedding it shouldn't
//     have to know which theme produced it.
//   - Without this, a dark-only source would count as a permanently `missing`
//     light file, and main() sets a non-zero exit code on any miss — so one
//     single-treatment asset would leave `npm run stage:marketing-screenshots`
//     red forever.
export const MANIFEST = [
  // --- Existing curated set (re-staged for freshness; stale since mid-June) ---
  { output: 'library', scene: 'library-shelf', viewport: 'desktop' },
  { output: 'library-full', scene: 'library-shelf-full', viewport: 'desktop' },
  { output: 'cast', scene: 'coalfall-cast', viewport: 'desktop' },
  { output: 'cast-reuse', scene: 'cast-reuse', viewport: 'desktop' },
  { output: 'coalfall-manuscript', scene: 'coalfall-manuscript', viewport: 'desktop' },
  { output: 'generate', scene: 'generating', viewport: 'desktop' },
  { output: 'listen', scene: 'listen', viewport: 'desktop' },
  { output: 'listen-phone', scene: 'listen', viewport: 'phone' },
  { output: 'listen-tablet', scene: 'listen', viewport: 'tablet' },
  { output: 'continue-listening', scene: 'continue-listening', viewport: 'desktop' },
  { output: 'continue-listening-phone', scene: 'continue-listening', viewport: 'phone' },
  { output: 'continue-listening-tablet', scene: 'continue-listening', viewport: 'tablet' },
  { output: 'voice-library', scene: 'voice-library', viewport: 'desktop' },
  // --- New story-driven additions (this pass) ---
  { output: 'quality-gate-suspect-chapter', scene: 'chapter-suspect', viewport: 'desktop' },
  { output: 'quality-gate-voice-drift', scene: 'voice-drift-report', viewport: 'desktop' },
  { output: 'quality-gate-preview-flagged', scene: 'preview-flagged', viewport: 'desktop' },
  { output: 'quality-gate-report-card', scene: 'qa-report-card', viewport: 'desktop' },
  { output: 'language-detect-russian', scene: 'language-detect-russian', viewport: 'desktop' },
  {
    output: 'language-cast-confirm-german',
    scene: 'language-cast-confirm-german',
    viewport: 'desktop',
  },
  {
    output: 'emotion-delivery-direction',
    scene: 'manuscript-emotion-direction',
    viewport: 'desktop',
  },
  { output: 'cast-pin-higher-quality', scene: 'cast-pin-higher-quality', viewport: 'desktop' },
  { output: 'series-memory-reveal', scene: 'series-memory-reveal', viewport: 'desktop' },
  { output: 'series-share-card', scene: 'series-share-card', viewport: 'desktop' },
  // --- fs-52 captions export (this pass) ---
  { output: 'captions-options', scene: 'export-captions-options', viewport: 'desktop' },
  { output: 'export-format-tiles', scene: 'export-download-tiles', viewport: 'desktop' },
  { output: 'fix-line-modal', scene: 'listen-fix-line-modal', viewport: 'desktop' },
  // --- The one asset that travels on its own, off-app: the exported cast card ---
  // Not a screenshot of a view but the file the app's own "Download image (.png)"
  // button produces (4:5 portrait, 672x840). Dark-only: the card is a fixed dark
  // surface whose accent comes from the themed `--magenta` token, and only the
  // dark value has usable contrast on it. See e2e/marketing/README.md.
  {
    output: 'series-cast-card',
    scene: 'series-cast-card-export',
    viewport: 'desktop',
    themes: ['dark'],
  },
];

// Pure — no filesystem access — so the test can exercise it without real files.
export function stagingPlan(manifest = MANIFEST, sourceDir = SOURCE_DIR, destDir = DEST_DIR) {
  const plan = [];
  for (const entry of manifest) {
    const themes = entry.themes ?? ['light', 'dark'];
    for (const theme of themes) {
      const src = path.join(sourceDir, `${entry.scene}.${entry.viewport}.${theme}.png`);
      const pairing = themes.length > 1;
      const destName =
        pairing && theme === 'dark' ? `${entry.output}-dark.webp` : `${entry.output}.webp`;
      plan.push({ src, dest: path.join(destDir, destName) });
    }
  }
  return plan;
}

function main() {
  mkdirSync(DEST_DIR, { recursive: true });
  const plan = stagingPlan();
  let missing = 0;
  let failed = 0;
  for (const { src, dest } of plan) {
    if (!existsSync(src)) {
      console.warn(`[stage-marketing-screenshots] missing source, skipped: ${src}`);
      missing++;
      continue;
    }
    const result = spawnSync('ffmpeg', ['-y', '-i', src, '-quality', '85', dest], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`[stage-marketing-screenshots] ffmpeg failed for ${src}`);
      failed++;
    }
  }
  const staged = plan.length - missing - failed;
  console.log(
    `[stage-marketing-screenshots] staged ${staged}/${plan.length} files into ${DEST_DIR}`,
  );
  if (missing > 0 || failed > 0) process.exitCode = 1;
}

// Only run when invoked directly (not when imported by tests) — comparing
// resolved filesystem paths rather than raw URL strings so this works on
// Windows too (`file://${process.argv[1]}` never matches a Windows path),
// mirroring the same guard already used in build-release-zip.mjs.
const invokedAsCli = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedAsCli) main();
