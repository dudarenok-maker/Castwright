#!/usr/bin/env node
/* Frames the raw companion capture surfaces (produced by
   `npm run capture:companion` into mockups/marketing-screens/companion/) into
   Google-Play-ready assets and writes them to the permanent home
   brand/go-to-market/play-store/ (git-ignored — brand assets are local-only).

   Output:
   - screenshots/phone/<NN>-<id>.png        (1764x3136, 9:16) — primary LIGHT set
   - screenshots/phone/dark/<NN>-<id>.png   (1764x3136, 9:16) — DARK alternates
   - feature-graphic.png                    (1024x500)

   Rendering is done in headless chromium (Playwright — already a dev dep for
   e2e) rather than sharp/librsvg, because the brand caption font (General Sans,
   woff2) renders reliably via CSS @font-face in a browser but silently falls
   back to monospace in librsvg. Fonts and the raw screenshots are inlined as
   data: URIs so there are no file-origin issues. Every output is re-opened with
   sharp and its dimensions asserted before the run is declared green. */

import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { b64, shoot, phoneHtml, featureHtml, tabletLandscapeHtml, tabletPortraitHtml, foldBezelHtml } from './lib/play-frames/templates.mjs';
import { SURFACES, dimsForTemplate, rawRelPath, DIMS } from './lib/play-frames/surfaces.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = resolve(repoRoot, 'mockups/marketing-screens/companion');
const OUT_DIR = resolve(repoRoot, 'brand/go-to-market/play-store');

const TEMPLATES = {
  phone: phoneHtml,
  tabletLandscape: tabletLandscapeHtml,
  tabletPortrait: tabletPortraitHtml,
  foldBezel: foldBezelHtml,
};

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error(`✖ No raw captures at ${RAW_DIR}. Run \`npm run capture:companion\` first.`);
    process.exit(1);
  }
  const made = [];
  const missing = [];
  const browser = await chromium.launch();
  // finally so a mid-run failure (e.g. a dimension-assert throw in shoot) can't
  // leak the launched Chromium subprocess.
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });

    for (const surface of SURFACES) {
      for (const theme of ['light', 'dark']) {
        const outBase = theme === 'light'
          ? resolve(OUT_DIR, surface.outDir)
          : resolve(OUT_DIR, surface.outDir, 'dark');
        mkdirSync(outBase, { recursive: true });
        let n = 0;
        for (const scene of surface.scenes) {
          const template = scene.template ?? surface.template;
          // rawSubdir resolves per-scene first (the fold surface sets it per-scene:
          // 'tablet10' for the reused unfolded raws, 'fold' for the seam), then falls
          // back to the surface default, then '' (flat phone dir). Mirrors the
          // scene.template ?? surface.template fallback above (review fix N-NEW1).
          const raw = resolve(RAW_DIR, rawRelPath(surface, scene, theme));
          if (!existsSync(raw)) { missing.push(`${surface.id}/${scene.id}.${theme}`); continue; }
          n += 1;
          const nn = String(n).padStart(2, '0');
          const out = resolve(outBase, `${nn}-${scene.id}.png`);
          const html = TEMPLATES[template]({ rawDataUri: `data:image/png;base64,${b64(raw)}`, caption: scene.caption });
          const dims = await shoot(page, html, dimsForTemplate(template), out);
          made.push(`${surface.id} ${theme}/${nn}-${scene.id}.png (${dims})`);
        }
      }
    }
    // feature graphic unchanged — emit once after the surface loop.
    const featureOut = resolve(OUT_DIR, 'feature-graphic.png');
    const fdims = await shoot(page, featureHtml(), DIMS.feature, featureOut);
    made.push(`feature-graphic.png (${fdims})`);
  } finally {
    await browser.close();
  }

  console.log(`\n✔ Framed ${made.length} assets into ${OUT_DIR}:`);
  for (const m of made) console.log(`   ${m}`);
  if (missing.length) console.log(`\n⚠ Missing raw captures (skipped): ${missing.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
