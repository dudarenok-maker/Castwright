// Rasterise the Castwright brand SVGs into the PNGs the app + Android need.
// Uses the Playwright chromium that the e2e suite already installs — no new dep.
//
//   node scripts/render-brand-pngs.mjs
//
// Re-run whenever brand/castwright-icon.svg or brand/castwright-og.svg change.
//
// NOTE (fe-37): the small-size favicons — public/favicon-16.png, favicon-32.png
// and favicon.svg — are HAND-DESIGNED (committed in public/, per the ≤32px glyph
// rule). The script deliberately does NOT render them, so a re-run can never
// clobber the designer's files. The render-script test pins this invariant.
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const ICON = resolve(root, 'brand/castwright-icon.svg');
const OG = resolve(root, 'brand/castwright-og.svg');

// out, src, width, height, omitBackground (transparent outside the artwork)
export const JOBS = [
  ['public/icon-512.png', ICON, 512, 512, true],
  ['public/icon-192.png', ICON, 192, 192, true],
  ['public/apple-touch-icon.png', ICON, 180, 180, true],
  ['public/og.png', OG, 1200, 630, false],
  // Android legacy launcher icons (mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi)
  ['apps/android/android/app/src/main/res/mipmap-mdpi/ic_launcher.png', ICON, 48, 48, true],
  ['apps/android/android/app/src/main/res/mipmap-hdpi/ic_launcher.png', ICON, 72, 72, true],
  ['apps/android/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', ICON, 96, 96, true],
  ['apps/android/android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', ICON, 144, 144, true],
  ['apps/android/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', ICON, 192, 192, true],
];

// app-15: iOS AppIcon set. iOS forbids an alpha channel and applies its own
// superellipse mask, so these render SQUARE (rx 118 -> 0) and OPAQUE
// (omitBackground:false). Same artwork as the Android/web icon, corners filled.
// Filenames + sizes match ios/Runner/Assets.xcassets/AppIcon.appiconset/Contents.json.
const IOS_DIR = 'apps/android/ios/Runner/Assets.xcassets/AppIcon.appiconset';
const squareTile = (svg) => svg.replace('rx="118"', 'rx="0"');
export const IOS_JOBS = [
  [`${IOS_DIR}/Icon-App-20x20@1x.png`, ICON, 20, 20, false, squareTile],
  [`${IOS_DIR}/Icon-App-20x20@2x.png`, ICON, 40, 40, false, squareTile],
  [`${IOS_DIR}/Icon-App-20x20@3x.png`, ICON, 60, 60, false, squareTile],
  [`${IOS_DIR}/Icon-App-29x29@1x.png`, ICON, 29, 29, false, squareTile],
  [`${IOS_DIR}/Icon-App-29x29@2x.png`, ICON, 58, 58, false, squareTile],
  [`${IOS_DIR}/Icon-App-29x29@3x.png`, ICON, 87, 87, false, squareTile],
  [`${IOS_DIR}/Icon-App-40x40@1x.png`, ICON, 40, 40, false, squareTile],
  [`${IOS_DIR}/Icon-App-40x40@2x.png`, ICON, 80, 80, false, squareTile],
  [`${IOS_DIR}/Icon-App-40x40@3x.png`, ICON, 120, 120, false, squareTile],
  [`${IOS_DIR}/Icon-App-60x60@2x.png`, ICON, 120, 120, false, squareTile],
  [`${IOS_DIR}/Icon-App-60x60@3x.png`, ICON, 180, 180, false, squareTile],
  [`${IOS_DIR}/Icon-App-76x76@1x.png`, ICON, 76, 76, false, squareTile],
  [`${IOS_DIR}/Icon-App-76x76@2x.png`, ICON, 152, 152, false, squareTile],
  [`${IOS_DIR}/Icon-App-83.5x83.5@2x.png`, ICON, 167, 167, false, squareTile],
  [`${IOS_DIR}/Icon-App-1024x1024@1x.png`, ICON, 1024, 1024, false, squareTile],
];

export function sized(svg, w, h) {
  // Force the root <svg> to the target pixel box; viewBox drives the scaling.
  return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => {
    const cleaned = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    return `<svg${cleaned} width="${w}" height="${h}">`;
  });
}

export async function renderJobs(jobs) {
  const browser = await chromium.launch();
  try {
    for (const [out, src, w, h, omit, transform] of jobs) {
      let svg = sized(readFileSync(src, 'utf8'), w, h);
      if (transform) svg = transform(svg);
      const page = await browser.newPage({
        viewport: { width: w, height: h },
        deviceScaleFactor: 1,
      });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`,
        { waitUntil: 'networkidle' },
      );
      const outPath = resolve(root, out);
      mkdirSync(dirname(outPath), { recursive: true });
      await page.locator('svg').screenshot({ path: outPath, omitBackground: omit });
      await page.close();
      console.log(`  rendered ${out}  (${w}x${h})`);
    }
    console.log('done.');
  } finally {
    await browser.close();
  }
}

export async function renderAll() {
  await renderJobs([...JOBS, ...IOS_JOBS]);
}

// Only render when invoked directly — so the test can import JOBS without
// launching chromium. realpath both sides to survive symlinked temp dirs.
const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  await renderAll();
}
