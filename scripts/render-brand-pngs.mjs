// Rasterise the Castwright brand SVGs into the PNGs the app + Android need.
// Uses the Playwright chromium that the e2e suite already installs — no new dep.
//
//   node scripts/render-brand-pngs.mjs
//
// Re-run whenever brand/castwright-icon.svg or brand/castwright-og.svg change.
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ICON = resolve(root, 'brand/castwright-icon.svg');
const OG = resolve(root, 'brand/castwright-og.svg');

// out, src, width, height, omitBackground (transparent outside the artwork)
const JOBS = [
  ['public/icon-512.png', ICON, 512, 512, true],
  ['public/icon-192.png', ICON, 192, 192, true],
  ['public/apple-touch-icon.png', ICON, 180, 180, true],
  ['public/favicon-32.png', ICON, 32, 32, true],
  ['public/favicon-16.png', ICON, 16, 16, true],
  ['public/og.png', OG, 1200, 630, false],
  // Android legacy launcher icons (mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi)
  ['apps/android/android/app/src/main/res/mipmap-mdpi/ic_launcher.png', ICON, 48, 48, true],
  ['apps/android/android/app/src/main/res/mipmap-hdpi/ic_launcher.png', ICON, 72, 72, true],
  ['apps/android/android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', ICON, 96, 96, true],
  ['apps/android/android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', ICON, 144, 144, true],
  ['apps/android/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', ICON, 192, 192, true],
];

function sized(svg, w, h) {
  // Force the root <svg> to the target pixel box; viewBox drives the scaling.
  return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => {
    const cleaned = attrs.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
    return `<svg${cleaned} width="${w}" height="${h}">`;
  });
}

const browser = await chromium.launch();
try {
  for (const [out, src, w, h, omit] of JOBS) {
    const svg = sized(readFileSync(src, 'utf8'), w, h);
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`, {
      waitUntil: 'networkidle',
    });
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
