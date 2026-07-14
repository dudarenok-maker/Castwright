import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { DIMS } from './surfaces.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = resolve(HERE, '../../../public/fonts');
const OUT_DIR = resolve(HERE, '../../../brand/go-to-market/play-store');

// Signature palette (src/styles.css design tokens).
const INK = '#0f0e0d';
const PURPLE_DEEP = '#3c194f';
const MAGENTA = '#a43c6c';
const PEACH = '#f79a83';
const CREAM = '#fcded7';

export const b64 = (p) => readFileSync(p).toString('base64');
const fontFace = (weight, file) =>
  `@font-face{font-family:'General Sans';font-weight:${weight};font-style:normal;` +
  `src:url('data:font/woff2;base64,${b64(resolve(FONT_DIR, file))}') format('woff2');}`;

export const FONTS = [
  fontFace(400, 'general-sans-400.woff2'),
  fontFace(500, 'general-sans-500.woff2'),
  fontFace(600, 'general-sans-600.woff2'),
  fontFace(700, 'general-sans-700.woff2'),
].join('\n');

export const captionSpans = (caption) =>
  caption.split('\n').map((l) => `<span>${l}</span>`).join('');

/** HTML for one framed phone screenshot. */
export function phoneHtml({ rawDataUri, caption }) {
  const captionHtml = captionSpans(caption);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${DIMS.phone.w}px;height:${DIMS.phone.h}px;overflow:hidden}
    .stage{width:${DIMS.phone.w}px;height:${DIMS.phone.h}px;
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
export function featureHtml() {
  const logo = resolve(OUT_DIR, 'castwright-play-header.svg');
  const wordmark = existsSync(logo)
    ? `<img class="mark" src="data:image/svg+xml;base64,${b64(logo)}"/>`
    : `<div class="mark-text">Castwright</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${FONTS}
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${DIMS.feature.w}px;height:${DIMS.feature.h}px;overflow:hidden}
    .stage{width:${DIMS.feature.w}px;height:${DIMS.feature.h}px;
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

export async function shoot(page, html, { w, h }, outPath) {
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
