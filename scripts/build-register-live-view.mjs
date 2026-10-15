#!/usr/bin/env node
// scripts/build-register-live-view.mjs
//
// Reconciles derived figures and row shells in
// docs/testing/onbox-acceptance-register-live-view.html against
// docs/testing/onbox-acceptance-register.md. Each row shell matched by ID/title
// (its <details class="item">…</details> block) is preserved verbatim; inter-shell
// content in a section body (blank lines, stray HTML markup between shells) is
// NOT preserved — shells are rebuilt in markdown order, joined by newlines. See
// docs/superpowers/specs/2026-08-28-onbox-register-generated-surfaces-design.md
// for the design; this comment states only the invariants the code must hold.
//
// Usage:
//   node scripts/build-register-live-view.mjs            # write the result
//   node scripts/build-register-live-view.mjs --check     # report, change nothing; exit 1 on drift
//
// Runs within the CI verify.yml `lint-and-checks` job (folded in by PR #3236),
// as its own step, immediately after `check:onbox-register` — this file does
// not spawn that script; run-check-onbox-register.mjs's npm wrapper spawns
// BOTH, in that order. No npm dependencies: only node builtins plus
// ./lib/read-normalized.mjs and ./lib/is-main-module.mjs (neither imports
// acorn — that lives in scripts/lib/module-graph.mjs, unused here).

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from './lib/read-normalized.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { splitRowId } from './check-onbox-register.mjs';

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

const BODY_GROUP_HEADING_REGEX = /^### ([A-Z])(\d+) · /gm;

export function parseBodyGroupCounts(mdText) {
  const counts = new Map();
  for (const m of mdText.matchAll(BODY_GROUP_HEADING_REGEX)) {
    const letter = m[1];
    counts.set(letter, (counts.get(letter) ?? 0) + 1);
  }
  return counts;
}

export function rewriteGcountInSection(html, sectionId, count) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>(?:(?!<\\/section>)[\\s\\S])*?<span class="gcount">)\\d+( rows?</span>)([\\s\\S]*?<\\/section>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`build-register-live-view: no gcount span found in section#${sectionId}`);
  return html.replace(
    sectionRegex,
    (whole, before, middle, closeSection) => `${before}${count}${count === 1 ? ' row</span>' : ' rows</span>'}${closeSection}`,
  );
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

  // buildLiveView's own helpers throw on a structural mismatch between the
  // markdown and the live view (e.g. a Blocked/Unconfirmed row's title was
  // reworded in the .md but not the .html, so reconcileTitledSection can no
  // longer find its shell by title). Uncaught, that crashes this CLI with a
  // raw stack trace instead of the checked, actionable exit-1 every other
  // drift case in this function already reports — the one path here that
  // didn't match the rest.
  let nextHtml;
  try {
    nextHtml = buildLiveView(mdText, currentHtml);
  } catch (err) {
    console.error(
      `register:build: ${liveViewPath} could not be reconciled against ${registerPath}: ${err.message}. Run \`npm run register:build\` after fixing the mismatch and commit the result.`,
    );
    return 1;
  }

  if (check) {
    const placeholderStillCommitted = currentHtml.includes('class="body-placeholder"');
    if (nextHtml !== currentHtml || placeholderStillCommitted) {
      if (placeholderStillCommitted) {
        console.error(
          'register:build --check: a committed row shell still carries class="body-placeholder" — fill in its content and re-run.',
        );
      }
      if (nextHtml !== currentHtml) {
        console.error(`register:build --check: ${liveViewPath} is out of date. Run \`npm run register:build\` and commit the result.`);
      }
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
// function's body is extended in place by each task. Never leave it calling
// only a subset silently — every task in PR 3 must update this function's
// body, not add a parallel one.
export function buildLiveView(mdText, currentHtml) {
  const figures = parseRegisterFigures(mdText);
  const bodyGroupCounts = parseBodyGroupCounts(mdText);
  const titledCounts = parseTitledSectionBodyCounts(mdText);
  let html = currentHtml;
  html = applyGeneratedRegion(html, 'strip', buildStripRegion(figures));
  for (const [letter, count] of figures.glanceGroups) {
    html = applyGeneratedRegion(html, `glance:${letter}`, String(count));
  }
  for (const [letter, count] of bodyGroupCounts) {
    html = rewriteGcountInSection(html, `g${letter.toLowerCase()}`, count);
  }
  // Body-derived, like every lettered group's gcount above — NOT
  // figures.blockedCount/unconfirmedCount (the hand-typed glance-table
  // cell), which self-corrects nothing if it drifts from the real rows.
  html = rewriteGcountInSection(html, 'blocked', titledCounts.blockedCount);
  html = rewriteGcountInSection(html, 'unconfirmed', titledCounts.unconfirmedCount);
  html = reconcileRowShells(mdText, html);
  return html;
}

function splitMdSections(mdText) {
  const headingRegex = /^## (.+)$/gm;
  const matches = [...mdText.matchAll(headingRegex)];
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : mdText.length;
    sections.push({ title: matches[i][1].trim(), body: mdText.slice(start, end) });
  }
  return sections;
}

const ROW_HEADING_REGEX = /^### ([A-Z]\d+) · (.+?)\r?$/gm;

function extractRowIdsInOrder(sectionMd) {
  return [...sectionMd.matchAll(ROW_HEADING_REGEX)].map((m) => ({ id: m[1], title: m[2] }));
}

// One shell = one whole <details class="item">…</details> block, including
// its own leading indentation — captured so a shell that is kept in place
// round-trips byte-identical rather than losing its indent on every rebuild.
// Non-nested in this markup (no <details> inside another), so a non-greedy
// match to the FIRST </details> after the opening tag is exact, not an
// approximation.
const SHELL_BY_ID_REGEX = /[ \t]*<details class="item">\s*<summary>\s*<span class="num">([^<]+)<\/span>[\s\S]*?<\/details>/g;

function splitShellsById(sectionHtml) {
  const shells = new Map();
  for (const m of sectionHtml.matchAll(SHELL_BY_ID_REGEX)) {
    shells.set(m[1], m[0]);
  }
  return shells;
}

function buildPlaceholderShell(id, title) {
  return `    <details class="item">
      <summary><span class="num">${id}</span><span class="iname">${title}</span><span class="risk">Not yet published</span><span class="chev">›</span></summary>
      <div class="body">
        <p class="body-placeholder">Not yet published — run \`npm run register:build\` after adding row content, or fill in manually and re-run --check.</p>
      </div>
    </details>`;
}

const BLOCKED_HEADING_REGEX = /^### (.+?)\r?$/gm;
const UNCONFIRMED_BULLET_REGEX = /^- \*\*(.+?)\*\*/gm;

// Blocked/Unconfirmed's row counts, unlike every lettered group's, were
// sourced from the hand-typed "## At a glance" table cell (parseRegisterFigures'
// blockedCount/unconfirmedCount) rather than the actual body rows — so a row
// added or removed from '## Blocked'/'## Unconfirmed' without a matching
// glance-table edit went undetected by both register:build --check (which
// wrote the stale, hand-typed number right back) and check-onbox-register
// (whose Check 1 iterates lettered groups only, by design, per its own
// header comment). Lettered groups derive their gcount from the body
// (parseBodyGroupCounts) precisely so this class of drift self-corrects;
// this mirrors that for the two title-matched sections.
export function parseTitledSectionBodyCounts(mdText) {
  let blockedCount = 0;
  let unconfirmedCount = 0;
  for (const section of splitMdSections(mdText)) {
    if (/^Blocked\b/.test(section.title)) {
      blockedCount = [...section.body.matchAll(BLOCKED_HEADING_REGEX)].length;
    } else if (/^Unconfirmed\b/.test(section.title)) {
      unconfirmedCount = [...section.body.matchAll(UNCONFIRMED_BULLET_REGEX)].length;
    }
  }
  return { blockedCount, unconfirmedCount };
}

// A Blocked heading / Unconfirmed bullet's captured text is
// "BLK101 · <title>" / "UNC101 · <title>". The ID is split with
// check-onbox-register's pinned splitRowId, not a second regex; only the
// section's own prefix counts. Text without such an ID yields id: null, which
// reconcileTitledSection rejects: register:build is where "every Blocked/
// Unconfirmed row carries an ID" is enforced, because checkRegister cannot
// require it (it is retro-applied to origin/main's register).
function parseTitledRow(rawText, idPrefix) {
  const sep = rawText.indexOf(' · ');
  if (sep > 0) {
    const parts = splitRowId(rawText.slice(0, sep));
    if (parts && parts.prefix === idPrefix) {
      return { id: rawText.slice(0, sep), title: rawText.slice(sep + 3) };
    }
  }
  return { id: null, title: rawText };
}

function reconcileTitledSection(html, sectionId, rows, idPrefix) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>[\\s\\S]*?<\\/header>\\s*\\n)([\\s\\S]*?)(\\s*<\\/section>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} (with a <header>) found`);
  const [, headerAndOpen, body, closeTag] = match;
  const shellsById = splitShellsById(body);
  const sectionName = idPrefix === 'BLK' ? 'Blocked' : 'Unconfirmed';
  const newBody = rows
    .map(({ id, title }) => {
      if (id === null) {
        throw new Error(
          `${sectionName} row "${title}" has no ${idPrefix} ID: allocate one from the section's next-id marker (e.g. ${idPrefix}107) and bump the marker`,
        );
      }
      // Keyed by ID: a shell already numbered with this ID is kept as-is; with
      // no such shell, a placeholder that register:build --check flags until
      // its content is filled in. A shell whose ID left the .md is dropped.
      return shellsById.get(id) ?? buildPlaceholderShell(id, title);
    })
    .join('\n');
  // No extra '\n' inserted here: closeTag's own `\s*` capture already carries
  // whatever whitespace separated the last shell from `</section>` in the
  // ORIGINAL html, verbatim and untouched by this function — prepending
  // another '\n' on top of it grew the gap by one line on every rebuild
  // (idempotence failure, Task 8 Step 2).
  // Use a replacer function instead of a string template to avoid JavaScript's
  // special-pattern interpretation ($1, $&, etc.) when the replacement text
  // contains these sequences.
  return html.replace(sectionRegex, () => `${headerAndOpen}${newBody}${closeTag}`);
}

export function reconcileRowShells(mdText, html) {
  const sections = splitMdSections(mdText);
  let result = html;
  for (const section of sections) {
    const letterMatch = section.title.match(/^Group ([A-Z])\b/);
    if (letterMatch) {
      const rowIds = extractRowIdsInOrder(section.body);
      result = reconcileOneSection(result, `g${letterMatch[1].toLowerCase()}`, rowIds);
      continue;
    }
    // Re-derived against the real .md: the Blocked heading reads "Blocked —
    // hardware not available" and Unconfirmed reads "Unconfirmed — not debts
    // until substantiated" — both start with the bare word, so the prefix
    // test below covers the real titles without assuming the whole line.
    if (/^Blocked\b/.test(section.title)) {
      const blockedRows = [...section.body.matchAll(BLOCKED_HEADING_REGEX)].map((m) => parseTitledRow(m[1], 'BLK'));
      result = reconcileTitledSection(result, 'blocked', blockedRows, 'BLK');
    } else if (/^Unconfirmed\b/.test(section.title)) {
      const unconfirmedRows = [...section.body.matchAll(UNCONFIRMED_BULLET_REGEX)].map((m) => parseTitledRow(m[1], 'UNC'));
      result = reconcileTitledSection(result, 'unconfirmed', unconfirmedRows, 'UNC');
    }
  }
  return result;
}

// Captures three groups: everything through the closing </header> tag
// (preserved verbatim — this is where Task 6's gcount rewrite already
// landed), the details-list body (rebuilt), and the closing </section> tag
// (preserved). The header is located structurally, not assumed to be a fixed
// string, so it survives regardless of what Task 6 wrote into it.
function reconcileOneSection(html, sectionId, rowIds) {
  const sectionRegex = new RegExp(
    `(<section[^>]*\\bid="${sectionId}"[^>]*>[\\s\\S]*?<\\/header>\\s*\\n)([\\s\\S]*?)(\\s*<\\/section>)`,
  );
  const match = html.match(sectionRegex);
  if (!match) throw new Error(`reconcileRowShells: no section#${sectionId} (with a <header>) found`);
  const [, headerAndOpen, body, closeTag] = match;
  const existingShells = splitShellsById(body);
  // No extra '\n' inserted before closeTag here either — see the matching
  // comment in reconcileTitledSection above; this is the same fix for the
  // same idempotence bug in the ID-keyed sibling function.
  const newBody = rowIds
    .map(({ id, title }) => existingShells.get(id) ?? buildPlaceholderShell(id, title))
    .join('\n');
  // Use a replacer function instead of a string template to avoid JavaScript's
  // special-pattern interpretation ($1, $&, etc.) when the replacement text
  // contains these sequences.
  return html.replace(sectionRegex, () => `${headerAndOpen}${newBody}${closeTag}`);
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
