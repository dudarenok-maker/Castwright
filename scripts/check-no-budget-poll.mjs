#!/usr/bin/env node
// scripts/check-no-budget-poll.mjs
//
// Heuristic guardrail for two flaky-test anti-patterns in server test files:
//
//   1. Budgeted polling loops: a line of the form
//        Date.now() - <ident> > <ident-or-number>
//      These wall-clock-deadline races are non-deterministic under CPU load
//      and should be replaced with vi.waitFor() or event-based waits.
//
//   2. Oversized inline per-test timeouts: a 3rd-arg literal > 120_000 ms
//      on an it()/test() call, e.g. `}, 180_000)`.
//      Justified real-ffmpeg integration tests use ≤ 60_000; anything above
//      120_000 is a budget-bump that masks flakiness rather than fixing it.
//
// Usage:
//   node scripts/check-no-budget-poll.mjs             # scan server/src/**/*.test.ts
//   node scripts/check-no-budget-poll.mjs <dir>       # scan <dir>/**/*.test.ts
//
// Exits 0 if clean, non-zero and prints offending file:line entries if not.
//
// The core scan functions are exported so the node:test acceptance suite can
// import and exercise them against planted-violation temp files.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// --- Pattern regexes ---

/** Matches the budgeted-poll shape: Date.now() - <ident> > <ident|number> */
const BUDGET_POLL_RE = /Date\.now\(\)\s*-\s*[A-Za-z_$][A-Za-z0-9_$]*\s*>/;

/**
 * Matches the closing of an it()/test() call with a numeric 3rd-argument literal,
 * e.g. `}, 180_000)` or `}, 180000)`.
 * Group 1 captures the raw number string (may contain underscores).
 *
 * NOTE: this is a line-level heuristic. It flags any `}, <number>)` following
 * a test body close — which is the canonical Vitest inline-timeout shape. A
 * false-positive rate of nearly zero given real test files, and any false
 * positive just needs a comment explaining why the large timeout is justified,
 * which the rule then asks you to carry as a doc comment instead.
 */
const OVERSIZED_TIMEOUT_RE = /\}\s*,\s*(\d[\d_]*)\s*\)\s*;?\s*$/;
const OVERSIZED_THRESHOLD = 120_000;

/**
 * Recursively enumerate *.test.ts files under `dir`.
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function collectTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Scan a single file's content for violations.
 * @param {string} content  raw file text
 * @param {string} filePath label for error messages
 * @returns {{ file: string, line: number, kind: 'budget-poll'|'oversized-timeout', text: string }[]}
 */
export function scanContent(content, filePath) {
  const violations = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (BUDGET_POLL_RE.test(line)) {
      violations.push({ file: filePath, line: lineNum, kind: 'budget-poll', text: line.trim() });
    }

    const m = OVERSIZED_TIMEOUT_RE.exec(line);
    if (m) {
      const raw = m[1].replace(/_/g, '');
      const ms = Number(raw);
      if (ms > OVERSIZED_THRESHOLD) {
        violations.push({
          file: filePath,
          line: lineNum,
          kind: 'oversized-timeout',
          text: line.trim(),
        });
      }
    }
  }
  return violations;
}

/**
 * Scan all *.test.ts files under `targetDir` and return all violations.
 * @param {string} targetDir
 * @returns {{ file: string, line: number, kind: string, text: string }[]}
 */
export function scanDir(targetDir) {
  const files = collectTestFiles(targetDir);
  const all = [];
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    all.push(...scanContent(content, f));
  }
  return all;
}

// --- CLI entry point ---

const invokedHref = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  const repoRoot = process.cwd();
  const rawTarget = process.argv[2] ?? join(repoRoot, 'server', 'src');
  // Normalise: if the caller passes a relative path, resolve against cwd
  const targetDir = rawTarget.startsWith('/') || /^[A-Za-z]:/.test(rawTarget)
    ? rawTarget
    : join(repoRoot, rawTarget);

  let violations;
  try {
    statSync(targetDir);
  } catch {
    process.stderr.write(`check-no-budget-poll: target directory not found: ${targetDir}\n`);
    process.exit(1);
  }

  violations = scanDir(targetDir);

  if (violations.length === 0) {
    process.stdout.write('check-no-budget-poll: OK — no budgeted polls or oversized timeouts found.\n');
    process.exit(0);
  }

  process.stderr.write('check-no-budget-poll: FAIL — found anti-patterns:\n\n');
  for (const v of violations) {
    const rel = relative(repoRoot, v.file).replace(/\\/g, '/');
    const label = v.kind === 'budget-poll'
      ? 'budgeted poll (Date.now() deadline race)'
      : `oversized timeout (> ${OVERSIZED_THRESHOLD} ms)`;
    process.stderr.write(`  ${rel}:${v.line}  [${label}]\n    ${v.text}\n\n`);
  }
  process.stderr.write(
    'Fix: replace budgeted-poll helpers with vi.waitFor(); replace oversized\n' +
    'inline timeouts with the per-suite default in vitest.config.slow.ts.\n',
  );
  process.exit(1);
}
