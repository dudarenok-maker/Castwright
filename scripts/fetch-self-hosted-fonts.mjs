#!/usr/bin/env node
/**
 * Fetch + self-host the app webfonts (#698).
 *
 * Run on demand to (re)populate `public/fonts/` with woff2 files and a
 * generated `public/fonts/fonts.css`. The committed output is what the app
 * ships — the BUILD never runs this script, so it never depends on the
 * network (mirrors `scripts/render-brand-pngs.mjs`). Re-run only to refresh
 * the fonts (e.g. a new weight, or a Google version bump):
 *
 *   node scripts/fetch-self-hosted-fonts.mjs
 *
 * Why self-hosted: the external <link rel="stylesheet"> tags to
 * api.fontshare.com + fonts.googleapis.com gate page.goto()'s `load` event,
 * which stalls under e2e parallel-worker contention and flakes the pre-push
 * gate. Same-origin fonts make `load` fire promptly. Proven causally in the
 * #698 spike: goto dropped from ~28s (slow CDN) to ~1s (no external fonts).
 *
 * Fonts: General Sans (sans) + Lora (serif) — the app's two real fonts. NB:
 * the old index.html also *requested* jetbrains-mono from Fontshare, but
 * Fontshare silently ignores it (it isn't a Fontshare family), so `font-mono`
 * has always fallen back to system `ui-monospace`. We deliberately do NOT
 * self-host JetBrains Mono — doing so would be a visual change, not a faithful
 * reproduction. The `--font-mono` fallback chain in styles.css is unchanged.
 *
 * Subsets: Fontshare serves one un-subsetted woff2 per weight (kept whole).
 * Google subsets Lora by unicode-range; this is an English-only app, so we
 * keep ONLY `latin` + `latin-ext` (covers English + accented European
 * names). Non-Latin titles fall back to Georgia — an accepted limitation.
 *
 * Licensing (all self-hostable): General Sans = ITF Free Font License,
 * Lora = SIL OFL 1.1. License files live in public/fonts/LICENSES/.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'fonts');

// A modern browser UA so Google returns woff2 (latin subset) rather than ttf.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Source stylesheets — same params as the (now-removed) index.html <link>s. */
const SOURCES = [
  {
    label: 'Fontshare (General Sans)',
    url: 'https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap',
    // Fontshare blocks carry no subset comment and no unicode-range; keep all.
    keepSubset: () => true,
  },
  {
    label: 'Google Fonts (Lora)',
    url: 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;1,400&display=swap',
    // English-only app: keep just latin + latin-ext.
    keepSubset: (subset) => subset === 'latin' || subset === 'latin-ext',
  },
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function fileNameFor({ family, weight, style, subset }) {
  const parts = [slug(family)];
  if (style === 'italic') parts.push('italic');
  parts.push(String(weight));
  if (subset === 'latin-ext') parts.push('ext');
  return `${parts.join('-')}.woff2`;
}

/**
 * Parse @font-face blocks, optionally prefixed by a CSS subset comment
 * (Google emits e.g. a "latin" comment before each block). Returns
 * { family, weight, style, subset, woff2Url, unicodeRange }.
 */
function parseFaces(css) {
  const faces = [];
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const subsetComment = m[1] ?? null;
    const body = m[2];
    const family = body.match(/font-family:\s*['"]([^'"]+)['"]/)?.[1];
    if (!family) continue;
    const weight = Number(body.match(/font-weight:\s*(\d+)/)?.[1] ?? 400);
    const style = body.match(/font-style:\s*([a-z]+)/)?.[1] ?? 'normal';
    // Pull the woff2 url specifically (Fontshare also lists woff + ttf).
    const woff2 = body.match(
      /url\(\s*['"]?([^'")]+\.woff2[^'")]*)['"]?\s*\)\s*format\(\s*['"]woff2['"]\s*\)/,
    )?.[1];
    if (!woff2) continue;
    const unicodeRange = body.match(/unicode-range:\s*([^;]+);/)?.[1]?.trim() ?? null;
    // A subset name only exists for Google; Fontshare's comment is the family.
    const subset =
      subsetComment && subsetComment.toLowerCase() !== slug(family) ? subsetComment : null;
    faces.push({
      family,
      weight,
      style,
      subset,
      woff2Url: woff2.startsWith('//') ? `https:${woff2}` : woff2,
      unicodeRange,
    });
  }
  return faces;
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(OUT_DIR, { recursive: true });

  const generated = [];
  for (const src of SOURCES) {
    process.stdout.write(`Fetching ${src.label}…\n`);
    const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${src.label}: HTTP ${res.status}`);
    const css = await res.text();
    const faces = parseFaces(css).filter((f) => src.keepSubset(f.subset ?? 'latin'));
    if (faces.length === 0) throw new Error(`${src.label}: parsed 0 usable @font-face blocks`);

    for (const face of faces) {
      const file = fileNameFor(face);
      const buf = Buffer.from(
        await (await fetch(face.woff2Url, { headers: { 'User-Agent': UA } })).arrayBuffer(),
      );
      await writeFile(resolve(OUT_DIR, file), buf);
      process.stdout.write(
        `  ✓ ${file}  (${face.family} ${face.style} ${face.weight}${face.subset ? ` / ${face.subset}` : ''}, ${(buf.length / 1024).toFixed(1)} KB)\n`,
      );
      generated.push({ ...face, file });
    }
  }

  // Emit fonts.css with rewritten same-origin URLs.
  const header =
    '/* GENERATED by scripts/fetch-self-hosted-fonts.mjs — do not edit by hand.\n' +
    '   Self-hosted webfonts (#698). Re-run the script to refresh.\n' +
    '   Licenses: public/fonts/LICENSES/. */\n\n';
  const blocks = generated
    .map((f) => {
      const lines = [
        '@font-face {',
        `  font-family: '${f.family}';`,
        `  font-style: ${f.style};`,
        `  font-weight: ${f.weight};`,
        '  font-display: swap;',
        `  src: url('/fonts/${f.file}') format('woff2');`,
      ];
      if (f.unicodeRange) lines.push(`  unicode-range: ${f.unicodeRange};`);
      lines.push('}');
      return lines.join('\n');
    })
    .join('\n\n');
  await writeFile(resolve(OUT_DIR, 'fonts.css'), header + blocks + '\n');
  process.stdout.write(`\nWrote ${generated.length} woff2 + fonts.css to public/fonts/\n`);
}

main().catch((err) => {
  process.stderr.write(`\nfetch-self-hosted-fonts failed: ${err.message}\n`);
  process.exit(1);
});
