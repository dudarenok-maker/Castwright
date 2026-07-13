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

import { chromium } from 'playwright';
import sharp from 'sharp';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = resolve(repoRoot, 'mockups/marketing-screens/companion');
const OUT_DIR = resolve(repoRoot, 'brand/go-to-market/play-store');
const FONT_DIR = resolve(repoRoot, 'public/fonts');

const PHONE = { w: 1764, h: 3136 }; // Google Play phone screenshot, 9:16
const FEATURE = { w: 1024, h: 500 }; // Google Play feature graphic

// Signature palette (src/styles.css design tokens).
const INK = '#0f0e0d';
const PURPLE_DEEP = '#3c194f';
const MAGENTA = '#a43c6c';
const PEACH = '#f79a83';
const CREAM = '#fcded7';

// The curated, ORDERED upload set. Lead with the hero (library + Continue),
// then the listening/waveform shot. caption = one brand-voice line (\n = break).
const SCENES = [
  { id: 'library-home', caption: 'Your whole library,\nin one place.' },
  { id: 'player', caption: 'Every character,\ntheir own voice.' },
  { id: 'book-detail', caption: 'Every chapter,\nbeautifully in order.' },
  { id: 'library-offline', caption: 'Downloaded once.\nYours to hear offline.' },
  { id: 'pairing', caption: 'Pairs to your own server —\nnothing leaves your LAN.' },
  { id: 'settings', caption: 'Tuned exactly\nto how you listen.' },
];

const b64 = (p) => readFileSync(p).toString('base64');
const fontFace = (weight, file) =>
  `@font-face{font-family:'General Sans';font-weight:${weight};font-style:normal;` +
  `src:url('data:font/woff2;base64,${b64(resolve(FONT_DIR, file))}') format('woff2');}`;

const FONTS = [
  fontFace(400, 'general-sans-400.woff2'),
  fontFace(500, 'general-sans-500.woff2'),
  fontFace(600, 'general-sans-600.woff2'),
  fontFace(700, 'general-sans-700.woff2'),
].join('\n');

/** HTML for one framed phone screenshot. */
function phoneHtml({ rawDataUri, caption }) {
  const captionHtml = caption
    .split('\n')
    .map((l) => `<span>${l}</span>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${PHONE.w}px;height:${PHONE.h}px;overflow:hidden}
    .stage{width:${PHONE.w}px;height:${PHONE.h}px;
      background:linear-gradient(180deg,${INK} 0%,${PURPLE_DEEP} 46%,${MAGENTA} 76%,${PEACH} 100%);
      display:flex;flex-direction:column;align-items:center;
      font-family:'General Sans',system-ui,sans-serif}
    .caption{margin-top:150px;padding:0 120px;text-align:center;color:#fff;
      font-weight:600;font-size:88px;line-height:1.12;letter-spacing:-0.02em;
      display:flex;flex-direction:column;text-shadow:0 2px 24px rgba(0,0,0,.28)}
    .caption span:last-child{color:${CREAM}}
    .phone{margin-top:96px;width:1140px;border-radius:60px;
      background:#0b0b0c;padding:16px;
      box-shadow:0 40px 90px rgba(0,0,0,.42),0 0 0 2px rgba(255,255,255,.06)}
    .phone img{display:block;width:100%;border-radius:46px}
  </style></head><body>
    <div class="stage">
      <div class="caption">${captionHtml}</div>
      <div class="phone"><img src="${rawDataUri}"/></div>
    </div>
  </body></html>`;
}

/** HTML for the 1024x500 feature graphic. */
function featureHtml() {
  const logo = resolve(OUT_DIR, 'castwright-play-header.svg');
  const wordmark = existsSync(logo)
    ? `<img class="mark" src="data:image/svg+xml;base64,${b64(logo)}"/>`
    : `<div class="mark-text">Castwright</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${FEATURE.w}px;height:${FEATURE.h}px;overflow:hidden}
    .stage{width:${FEATURE.w}px;height:${FEATURE.h}px;
      background:linear-gradient(120deg,${INK} 0%,${PURPLE_DEEP} 42%,${MAGENTA} 74%,${PEACH} 108%);
      display:flex;flex-direction:column;justify-content:center;padding:0 84px;
      font-family:'General Sans',system-ui,sans-serif;color:#fff}
    .mark-text{font-weight:700;font-size:96px;letter-spacing:-0.02em}
    .mark{height:104px}
    .tag{margin-top:26px;font-weight:500;font-size:40px;line-height:1.2;
      color:${CREAM};max-width:820px}
  </style></head><body>
    <div class="stage">
      ${wordmark}
      <div class="tag">Any book, performed by a full cast — effortlessly.<br/>Even in your own voice.</div>
    </div>
  </body></html>`;
}

async function shoot(page, html, { w, h }, outPath) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: w, height: h } });
  const meta = await sharp(outPath).metadata();
  if (meta.width !== w || meta.height !== h) {
    throw new Error(`✖ ${outPath} is ${meta.width}x${meta.height}, expected ${w}x${h}`);
  }
  return `${meta.width}x${meta.height}`;
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    console.error(`✖ No raw captures at ${RAW_DIR}. Run \`npm run capture:companion\` first.`);
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const made = [];
  const missing = [];

  for (const theme of ['light', 'dark']) {
    const dir = theme === 'light'
      ? resolve(OUT_DIR, 'screenshots/phone')
      : resolve(OUT_DIR, 'screenshots/phone/dark');
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const scene of SCENES) {
      const raw = resolve(RAW_DIR, `${scene.id}.${theme}.png`);
      if (!existsSync(raw)) {
        missing.push(`${scene.id}.${theme}`);
        continue;
      }
      n += 1;
      const nn = String(n).padStart(2, '0');
      const out = resolve(dir, `${nn}-${scene.id}.png`);
      const rawDataUri = `data:image/png;base64,${b64(raw)}`;
      const dims = await shoot(page, phoneHtml({ rawDataUri, caption: scene.caption }), PHONE, out);
      made.push(`${theme}/${nn}-${scene.id}.png (${dims})`);
    }
  }

  const featureOut = resolve(OUT_DIR, 'feature-graphic.png');
  const fdims = await shoot(page, featureHtml(), FEATURE, featureOut);
  made.push(`feature-graphic.png (${fdims})`);

  await browser.close();

  console.log(`\n✔ Framed ${made.length} assets into ${OUT_DIR}:`);
  for (const m of made) console.log(`   ${m}`);
  if (missing.length) console.log(`\n⚠ Missing raw captures (skipped): ${missing.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
