#!/usr/bin/env node
// Compute source-code statistics with `tokei` and render a Markdown table for
// the engineering notes. Two modes:
//
//   node scripts/code-stats.mjs            # print the table to stdout (preview)
//   node scripts/code-stats.mjs --write    # rewrite the CODE-STATS block in
//                                           # brand/project-narrative.md in place
//   node scripts/code-stats.mjs --help
//
// `npm run stats` is the no-flag preview; `npm run stats -- --write` writes.
// `scripts/bump-version.mjs` runs `--write` on every release so the narrative
// always carries fresh numbers (best-effort — a missing tokei is non-fatal).
//
// tokei is a LOCAL-ONLY maintainer dependency. It is NOT installed on CI: the
// pure helpers below (classifyFile / summarize / renderMarkdown / replaceBlock)
// are exported behind an import.meta-main guard and unit-tested against a
// fixture JSON in scripts/tests/code-stats.test.mjs, so coverage never needs
// the binary. Install locally with:
//   Windows  winget install XAMPPRocky.tokei
//   macOS    brew install tokei
//   any      cargo install tokei
// Then restart your shell so `tokei` lands on PATH.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const NARRATIVE = resolve(repoRoot, 'brand', 'project-narrative.md');

export const START_MARKER = '<!-- CODE-STATS:START -->';
export const END_MARKER = '<!-- CODE-STATS:END -->';

// Languages we count as "source code" for the prod/test split and the
// code-only total. JSON / YAML / Markdown / Plain Text are data + docs — shown
// in the table but excluded from the "code" headline so a lockfile bump can't
// masquerade as code growth.
const CODE_LANGS = new Set([
  'TypeScript',
  'TSX',
  'JavaScript',
  'Python',
  'PowerShell',
  'CSS',
  'Shell',
  'Batch',
]);

function die(msg) {
  process.stderr.write(`[FAIL] ${msg}\n`);
  process.exit(1);
}

function tokeiAvailable() {
  const r = spawnSync('tokei', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// Classify a tokei report path as test vs production code. Test = a
// `*.test.*` / `*.spec.*` file, or any file under an `e2e/` or `tests/`
// directory. Tolerates both path separators (tokei emits OS-native paths).
export function classifyFile(path) {
  const p = path.replace(/\\/g, '/');
  if (/\.(test|spec)\.[mc]?[jt]sx?$/.test(p)) return 'test';
  if (/(^|\/)(e2e|tests)\//.test(p)) return 'test';
  return 'prod';
}

// Reduce tokei's `--output json` object into the shape the renderer needs.
// tokei JSON: { "<Lang>": { code, comments, blanks, reports: [{name, stats}] },
// ..., "Total": {...} }. We ignore the "Total" key and recompute our own
// totals from the languages we list (tokei's Total folds in embedded-language
// children — e.g. CSS inside HTML — which would double-count here).
export function summarize(tokeiJson) {
  const byLanguage = [];
  let codeFiles = 0;
  let codeCode = 0;
  let prodCode = 0;
  let testCode = 0;
  let testFiles = 0;
  const totals = { files: 0, code: 0, comments: 0, blanks: 0 };

  for (const [lang, data] of Object.entries(tokeiJson)) {
    if (lang === 'Total' || !data || !Array.isArray(data.reports)) continue;
    const files = data.reports.length;
    byLanguage.push({
      lang,
      files,
      code: data.code,
      comments: data.comments,
      blanks: data.blanks,
    });
    totals.files += files;
    totals.code += data.code;
    totals.comments += data.comments;
    totals.blanks += data.blanks;

    if (CODE_LANGS.has(lang)) {
      codeFiles += files;
      codeCode += data.code;
      for (const report of data.reports) {
        const bucket = classifyFile(report.name);
        if (bucket === 'test') {
          testCode += report.stats.code;
          testFiles += 1;
        } else {
          prodCode += report.stats.code;
        }
      }
    }
  }

  byLanguage.sort((a, b) => b.code - a.code || a.lang.localeCompare(b.lang));
  return {
    byLanguage,
    totals,
    code: { files: codeFiles, code: codeCode, prodCode, testCode, testFiles },
  };
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

// Render the summary as the Markdown block body (no markers). `date` is passed
// in (stamped by main()) so this stays a pure, deterministic function for tests.
export function renderMarkdown(summary, { date }) {
  const { byLanguage, totals, code } = summary;
  const rows = byLanguage
    .map(
      (l) =>
        `| ${l.lang} | ${fmt(l.files)} | ${fmt(l.code)} | ${fmt(l.comments)} | ${fmt(l.blanks)} |`,
    )
    .join('\n');

  const ratio =
    code.prodCode > 0 ? (code.testCode / code.prodCode).toFixed(2) : '0.00';
  const noise = totals.code + totals.comments + totals.blanks;
  const noisePct = noise > 0 ? Math.round(((totals.comments + totals.blanks) / noise) * 100) : 0;

  return [
    `_Generated by \`npm run stats\` on ${date} via [tokei](https://github.com/XAMPPRocky/tokei). "Code" excludes blank lines and comments. \`node_modules\`, \`dist\`, and other \`.gitignore\`d paths are not counted._`,
    '',
    '| Language | Files | Code | Comments | Blanks |',
    '| --- | ---: | ---: | ---: | ---: |',
    rows,
    `| **Total** | **${fmt(totals.files)}** | **${fmt(totals.code)}** | **${fmt(totals.comments)}** | **${fmt(totals.blanks)}** |`,
    '',
    `- **Source code** (excl. JSON / Markdown / YAML): **${fmt(code.code)}** lines across **${fmt(code.files)}** files.`,
    `- **Production vs test:** ~${fmt(code.prodCode)} lines of application code against ~${fmt(code.testCode)} lines of test code (${fmt(code.testFiles)} test files) — roughly **${ratio}** lines of test per line of source.`,
    `- **Comment + blank share:** ~${noisePct}% of all tracked lines are comments or blank.`,
  ].join('\n');
}

// Swap the content between the CODE-STATS markers. Throws if either marker is
// missing so a doc that lost its anchors fails loudly rather than silently
// no-op'ing.
export function replaceBlock(docText, newBlock) {
  const startIdx = docText.indexOf(START_MARKER);
  const endIdx = docText.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Missing or malformed CODE-STATS markers (${START_MARKER} … ${END_MARKER}) in the target doc.`,
    );
  }
  // Preserve the doc's existing line ending so a CRLF checkout (Windows) stays
  // CRLF — otherwise emitting an LF block makes the write non-idempotent and
  // churns the diff on every run.
  const eol = docText.includes('\r\n') ? '\r\n' : '\n';
  const block = newBlock.replace(/\r?\n/g, eol);
  const before = docText.slice(0, startIdx + START_MARKER.length);
  const after = docText.slice(endIdx);
  return `${before}${eol}${block}${eol}${after}`;
}

function parseArgs(argv) {
  const out = { write: false };
  for (const a of argv) {
    if (a === '--write') out.write = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: node scripts/code-stats.mjs [--write]\n' +
          '  (no flag)  print the stats table to stdout\n' +
          '  --write    rewrite the CODE-STATS block in brand/project-narrative.md\n',
      );
      process.exit(0);
    } else {
      die(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!tokeiAvailable()) {
    die(
      'tokei not found on PATH. Install it (Windows: `winget install XAMPPRocky.tokei`, ' +
        'macOS: `brew install tokei`, any: `cargo install tokei`) and restart your shell.',
    );
  }

  const json = execFileSync('tokei', ['--output', 'json', repoRoot], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const summary = summarize(JSON.parse(json));
  const date = new Date().toISOString().slice(0, 10);
  const block = renderMarkdown(summary, { date });

  if (!args.write) {
    process.stdout.write(`${block}\n`);
    return;
  }

  const doc = readFileSync(NARRATIVE, 'utf8');
  const updated = replaceBlock(doc, block);
  if (updated === doc) {
    process.stdout.write('[code-stats] no change — stats already current.\n');
    return;
  }
  writeFileSync(NARRATIVE, updated);
  process.stdout.write(`[code-stats] updated ${NARRATIVE}\n`);
}

// import.meta-main guard so tests can import the pure helpers without running
// tokei (matches scripts/bump-version.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
