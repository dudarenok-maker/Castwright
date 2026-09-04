#!/usr/bin/env node
// scripts/build-register-live-view.mjs
//
// Reconciles derived figures and row shells in
// docs/testing/onbox-acceptance-register-live-view.html against
// docs/testing/onbox-acceptance-register.md. Every hand-authored byte outside
// a generated target (BEGIN/END GENERATED:<name> region, or a row shell's own
// body/iname/risk spans) is preserved verbatim. See
// docs/superpowers/specs/2026-08-28-onbox-register-generated-surfaces-design.md
// for the design; this comment states only the invariants the code must hold.
//
// Usage:
//   node scripts/build-register-live-view.mjs            # write the result
//   node scripts/build-register-live-view.mjs --check     # report, change nothing; exit 1 on drift
//
// No npm dependencies: onbox-register-check.yml runs this with no `npm ci`
// step. node builtins and scripts/lib/* only.

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from './lib/read-normalized.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_REGISTER_PATH = 'docs/testing/onbox-acceptance-register.md';
export const DEFAULT_LIVE_VIEW_PATH = 'docs/testing/onbox-acceptance-register-live-view.html';

export function applyGeneratedRegion(html, name, newInner) {
  const beginMarker = `<!-- BEGIN GENERATED:${name} -->`;
  const endMarker = `<!-- END GENERATED:${name} -->`;
  const beginIndex = html.indexOf(beginMarker);
  const endIndex = html.indexOf(endMarker);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error(`missing generated-region marker pair "${name}"`);
  }
  const before = html.slice(0, beginIndex + beginMarker.length);
  const after = html.slice(endIndex);
  return `${before}${newInner}${after}`;
}

const GLANCE_ROW_REGEX = /^\|\s*(?:\*\*([A-Z])\*\*|—)\s*\|\s*(.*?)\s*\|\s*(\d+)\s*\|\s*$/gm;
const OWED_TOTAL_REGEX = /\*\*(\d+)\s+owed\.\*\*\s*Oldest:\s*(\S.*?)\s*\(/;
const A1_STILL_OWED_REGEX = /<!--\s*stat:a1-still-owed\s+(\d+)\s*-->/;
const A1_SUBTOTAL_REGEX = /<!--\s*stat:a1-subtotal\s+(\d+)\s*-->/;

export function parseRegisterFigures(mdText) {
  const glanceGroups = new Map();
  let blockedCount = null;
  let unconfirmedCount = null;
  for (const m of mdText.matchAll(GLANCE_ROW_REGEX)) {
    const [, letter, label, countRaw] = m;
    const count = Number(countRaw);
    if (letter) {
      glanceGroups.set(letter, count);
    } else if (/^\*\*Blocked\*\*/.test(label)) {
      blockedCount = count;
    } else if (/^\*\*Unconfirmed\*\*/.test(label)) {
      unconfirmedCount = count;
    }
  }
  if (blockedCount === null) throw new Error('parseRegisterFigures: no Blocked row in the glance table');
  if (unconfirmedCount === null) throw new Error('parseRegisterFigures: no Unconfirmed row in the glance table');

  const owedMatch = mdText.match(OWED_TOTAL_REGEX);
  if (!owedMatch) throw new Error('parseRegisterFigures: no "**N owed.** Oldest: ..." line found');
  const owedTotal = Number(owedMatch[1]);
  const oldestDebtRaw = owedMatch[2];

  const a1StillOwedMatch = mdText.match(A1_STILL_OWED_REGEX);
  if (!a1StillOwedMatch) throw new Error('parseRegisterFigures: missing stat:a1-still-owed marker');
  const a1SubtotalMatch = mdText.match(A1_SUBTOTAL_REGEX);
  if (!a1SubtotalMatch) throw new Error('parseRegisterFigures: missing stat:a1-subtotal marker');

  return {
    owedTotal,
    oldestDebtRaw,
    glanceGroups,
    blockedCount,
    unconfirmedCount,
    a1StillOwed: Number(a1StillOwedMatch[1]),
    a1Subtotal: Number(a1SubtotalMatch[1]),
  };
}

// Oldest-debt tile: strip bold markup, then the leading YYYY- year prefix,
// keeping MM-DD. Three transforms — bold-strip, label-strip (none present in
// oldestDebtRaw as captured, since OWED_TOTAL_REGEX already stops before any
// trailing label), year-strip — the year-strip is the one earlier drafts of
// this rule missed.
function formatOldestDebt(raw) {
  const noBold = raw.replace(/\*\*/g, '');
  const noYear = noBold.replace(/^\d{4}-/, '');
  return noYear;
}

export function buildStripRegion(figures) {
  return `
    <div class="stat"><div class="n owed">${figures.owedTotal}</div><div class="l">Owed</div></div>
    <div class="stat"><div class="n">${figures.glanceGroups.size}</div><div class="l">Groups</div></div>
    <div class="stat"><div class="n blk">${figures.blockedCount}</div><div class="l">Blocked</div></div>
    <div class="stat"><div class="n">${figures.unconfirmedCount}</div><div class="l">Unconfirmed</div></div>
    <div class="stat"><div class="n">${figures.a1StillOwed}</div><div class="l">Still owed in A1 (of ${figures.a1Subtotal})</div></div>
    <div class="stat"><div class="n">${formatOldestDebt(figures.oldestDebtRaw)}</div><div class="l">Oldest debt</div></div>
  `;
}

export function main(
  registerPath = DEFAULT_REGISTER_PATH,
  liveViewPath = DEFAULT_LIVE_VIEW_PATH,
  { check = false, repoRoot = REPO_ROOT } = {},
) {
  const mdPath = resolve(repoRoot, registerPath);
  const htmlPath = resolve(repoRoot, liveViewPath);
  const mdText = readNormalized(mdPath);
  const currentHtml = readNormalized(htmlPath);

  const nextHtml = buildLiveView(mdText, currentHtml);

  if (check) {
    if (nextHtml !== currentHtml) {
      console.error(
        `register:build --check: ${liveViewPath} is out of date. Run \`npm run register:build\` and commit the result.`,
      );
      return 1;
    }
    console.log('register:build --check: up to date.');
    return 0;
  }

  // Always write LF. In practice this is a no-op today: readNormalized
  // already collapsed \r\n->\n on both inputs, and every string literal in
  // this module's own source is LF (this file is itself pinned eol=lf).
  // Kept explicit — not because it currently does anything, but because it
  // is the one line that keeps that true if a future edit ever concatenates
  // in raw, unnormalised text.
  writeFileSync(htmlPath, nextHtml.replace(/\r\n/g, '\n'));
  console.log(`register:build: wrote ${liveViewPath}.`);
  return 0;
}

// buildLiveView itself is added incrementally across Tasks 4-7 — this
// placeholder is replaced by Step 4 below in THIS task (strip only), then
// extended in place by each later task. Never leave it calling only a subset
// silently — every task in PR 3 must update this function's body, not add a
// parallel one.
export function buildLiveView(mdText, currentHtml) {
  const figures = parseRegisterFigures(mdText);
  let html = currentHtml;
  html = applyGeneratedRegion(html, 'strip', buildStripRegion(figures));
  return html;
}

if (isDirectlyInvoked(import.meta.url)) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length > 0) {
    console.error(`register:build: unrecognised argument(s): ${unknown.join(', ')}`);
    process.exitCode = 1;
  } else {
    // NOT process.exit(main(...)) — scripts/lib/is-main-module.mjs's own
    // header comment documents why: process.exit() terminates before Node
    // flushes pending async stdout writes, which is synchronous on Windows
    // but asynchronous on Linux/macOS, so a script with more than trivial
    // output can truncate its own tail on CI (ubuntu-latest) while looking
    // fine on every Windows dev box. This script's own console.log/error
    // calls are one line each — genuinely tiny — but set exitCode rather
    // than call exit() regardless, matching the documented safe pattern
    // rather than relying on today's output staying short forever.
    process.exitCode = main(DEFAULT_REGISTER_PATH, DEFAULT_LIVE_VIEW_PATH, { check });
  }
}
