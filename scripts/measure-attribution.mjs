#!/usr/bin/env node
/*
 * measure-attribution.mjs — #1984 Wave 1 Task 8
 *
 * Read-only. Walks the real library and prints, for every book, the
 * attribution-health measurement (server/src/store/attribution-health.ts):
 * how much of the book's dialogue is being read by the narrator, split by
 * origin (model-assigned / engine-demoted / unknown-origin), plus the id-
 * drift and omission signals. This is the only place the distribution
 * exists — every earlier hand-computed figure in this strand's history was
 * wrong, for three different reasons (spec §The measurement script).
 *
 * Ships NO threshold, NO badge, NO UI. It exists so Wave 2's threshold is
 * set from real data instead of a sweep method that isn't in the tree.
 *
 * This script reuses the server's own measurement rather than
 * re-implementing any of it (the parser, the aligner, the resolver, the
 * language chain) — it dynamically imports `resolveAttributionState`,
 * `attributionShare` straight from the COMPILED server (`server/dist/**`),
 * never from `server/src`, matching scripts/repair-cast-id-drift.mjs's
 * precedent. `cd server && npm run build` (or the root `npm run build`)
 * must have been run first — the script fails loud with that exact
 * instruction if `server/dist` is missing.
 *
 * Three properties are requirements, not style (spec §The measurement
 * script):
 *   - It walks the LIBRARY (`<workspace>/books/<author>/<series>/<title>`),
 *     never the cache directory. On the reference box 54 of 76 caches have
 *     no book at all.
 *   - It skips `.upgrade-backups/` — automatically, by construction: that
 *     directory is a SIBLING of `books/` under the workspace root
 *     (server/src/workspace/upgrade-coordinator.ts), never nested inside
 *     it, so a walk rooted at `<workspace>/books` never enters it. No
 *     special-case needed, the same way scripts/repair-cast-id-drift.mjs's
 *     `collectBooks` avoids it.
 *   - It calls `resolveAttributionState`/`computeAttributionMeasurement`.
 *     No re-implementation of the filters, the resolver, the parser, or
 *     the aligner.
 *
 * Env:
 *   BASE / WORKSPACE_DIR / AUDIOBOOK_WORKSPACE   workspace root (checked in
 *                                                 that order); default
 *                                                 <home>/AudiobookWorkspace
 *   REPORT_PATH   where the JSON report is written; default
 *                 server/handoff/cache/attribution-measurement-report.json
 *                 (git-ignored scratch space — server/handoff/cache/* per
 *                 .gitignore, and the location the owner's own #1984
 *                 comments already call "scratch" for this strand's
 *                 harnesses).
 *
 * Tests: scripts/tests/measure-attribution.test.mjs — the script's own
 * exported pure helpers (formatting, sorting, the four distinct-row
 * shapes), never `server/dist` — so the unit tests run with no build step,
 * even though `main()` needs one.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Pure helpers (unit tested directly — see scripts/tests/measure-attribution.test.mjs)
// ---------------------------------------------------------------------------

/** The report columns, in print order. `pipelineSpoken`, `blindSpoken` and
    `overcountSpoken` are NOT columns — #2245 made them identically zero in
    every language, forever (spec F3/F4/F5). */
export const COLUMNS = [
  'title',
  'language',
  'languageSource',
  'spokenTotal',
  'tagTotal',
  'narratorIdSpoken',
  'share',
  'modelNarrator',
  'demotedNarrator',
  'unknownOriginNarrator',
  'unattributedSpeech',
  'splitSpeech',
  'orphanSpoken',
  'tagNarratorSpan',
  'dashOnlySpoken',
  'castCount',
  'state',
];

/** One row per book, built from a `resolveAttributionState` result plus the
    book's display label. `share` is `null` when there is nothing to divide
    (see attribution-health.ts's `attributionShare`) — printed as the
    literal string `'—'`, never `0` or `0%`, so a wholly-orphaned or
    wholly-unattributed book never reads as healthy. */
export function buildRow(label, stateResult, share) {
  const m = stateResult.measurement;
  return {
    title: label,
    language: m?.language ?? null,
    languageSource: m?.languageSource ?? null,
    spokenTotal: m?.spokenTotal ?? 0,
    tagTotal: m?.tagTotal ?? 0,
    narratorIdSpoken: m?.narratorIdSpoken ?? 0,
    share,
    modelNarrator: m?.modelNarrator ?? 0,
    demotedNarrator: m?.demotedNarrator ?? 0,
    unknownOriginNarrator: m?.unknownOriginNarrator ?? 0,
    unattributedSpeech: m?.unattributedSpeech ?? 0,
    splitSpeech: m?.splitSpeech ?? 0,
    orphanSpoken: m?.orphanSpoken ?? 0,
    tagNarratorSpan: m?.tagNarratorSpan ?? 0,
    dashOnlySpoken: m?.dashOnlySpoken ?? 0,
    castCount: m?.castCount ?? 0,
    state: stateResult.state,
    reason: stateResult.reason,
    chapters: m?.chapters ?? [],
  };
}

/** Sorted by share descending — a `null` share (nothing to divide) sorts
    LAST, never first and never coerced to 0 (which would misplace a
    wholly-orphaned book among the healthiest rather than the least
    measurable). Stable on ties (Array.prototype.sort is stable per spec). */
export function sortRowsByShareDescending(rows) {
  return [...rows].sort((a, b) => {
    if (a.share === null && b.share === null) return 0;
    if (a.share === null) return 1;
    if (b.share === null) return -1;
    return b.share - a.share;
  });
}

/** The worst chapter of a row (highest narratorIdSpoken/spokenTotal share,
    floor at spokenTotal > 0 so a silent chapter doesn't win by division-by-
    zero). Returns null when the book has no chapters with any spoken span
    at all. */
export function worstChapter(row) {
  let worst = null;
  let worstShare = -1;
  for (const ch of row.chapters ?? []) {
    if (ch.spokenTotal <= 0) continue;
    const share = ch.narratorIdSpoken / ch.spokenTotal;
    if (share > worstShare) {
      worstShare = share;
      worst = ch;
    }
  }
  return worst;
}

/** Formats one row's `share` cell for the printed table. Never a bare `0`
    for a `null` share — that would read as "0% collapsed", i.e. healthy,
    for a book the metric has nothing to say about (D9's own failure
    shape). */
export function formatShare(share) {
  return share === null ? '—' : `${(share * 100).toFixed(1)}%`;
}

/** Four states must be visibly distinct from a healthy row and from each
    other, per spec: a book with a cast and nothing attributed (`missing`),
    a book whose language could not be corroborated (`unmeasurable`, reason
    'language not corroborated'), a book never analysed (`ok`, reason 'not
    analysed'), and a book whose source prose is gone (`unmeasurable`,
    reason 'no manuscript'). None may render as a blank row — every one of
    these renders `state` AND `reason` distinctly rather than leaving the
    reader to infer from a column of zeros. */
export function formatStateCell(row) {
  if (row.state === 'ok' && row.reason === 'healthy') return 'ok';
  return `${row.state} (${row.reason})`;
}

export function printReport(rows) {
  const sorted = sortRowsByShareDescending(rows);
  const header = [...COLUMNS];
  const lines = [header.join('\t')];
  for (const row of sorted) {
    lines.push(
      COLUMNS.map((col) => {
        if (col === 'share') return formatShare(row.share);
        if (col === 'state') return formatStateCell(row);
        return String(row[col]);
      }).join('\t'),
    );
  }
  console.log(lines.join('\n'));
  for (const row of sorted) {
    const worst = worstChapter(row);
    if (worst && row.spokenTotal > 0) {
      console.log(
        `  ${row.title} — worst chapter ${worst.chapterId}: ` +
          `${worst.narratorIdSpoken}/${worst.spokenTotal} narrator`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// I/O — everything below touches the filesystem or dynamically imports the
// compiled server.
// ---------------------------------------------------------------------------

function resolveWorkspaceDir() {
  return (
    (process.env.BASE && path.resolve(process.env.BASE)) ||
    (process.env.WORKSPACE_DIR && path.resolve(process.env.WORKSPACE_DIR)) ||
    (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
    path.join(os.homedir(), 'AudiobookWorkspace')
  );
}

function resolveReportPath() {
  return process.env.REPORT_PATH
    ? path.resolve(process.env.REPORT_PATH)
    : path.join(REPO_ROOT, 'server', 'handoff', 'cache', 'attribution-measurement-report.json');
}

/** Walk `<workspaceDir>/books/<author>/<series>/<title>` — the library, not
    the cache directory (see the module doc comment). An unreadable
    directory at any level is skipped and logged rather than aborting the
    whole run. */
function collectBookDirs(workspaceDir) {
  const booksRoot = path.join(workspaceDir, 'books');
  const found = []; // { bookDir, label }
  const dirs = (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return null;
    }
  };
  const authorDirs = dirs(booksRoot) ?? [];
  for (const author of authorDirs) {
    const seriesDirs = dirs(path.join(booksRoot, author)) ?? [];
    for (const series of seriesDirs) {
      const titleDirs = dirs(path.join(booksRoot, author, series)) ?? [];
      for (const title of titleDirs) {
        found.push({
          bookDir: path.join(booksRoot, author, series, title),
          label: `${author} / ${series} / ${title}`,
        });
      }
    }
  }
  return found;
}

async function loadServerModules() {
  const need = ['server/dist/store/attribution-health.js', 'server/dist/store/attribution-health-io.js'];
  for (const rel of need) {
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
      throw new Error(
        `Missing compiled server module: ${rel}\n` +
          `This script reuses the server's own measurement (computeAttributionMeasurement, ` +
          `resolveAttributionState) rather than re-implementing it. Run "cd server && npm run build" ` +
          `(or the root "npm run build") first, then re-run this script.`,
      );
    }
  }
  const [health, healthIo] = await Promise.all([
    import('../server/dist/store/attribution-health.js'),
    import('../server/dist/store/attribution-health-io.js'),
  ]);
  return {
    resolveAttributionState: healthIo.resolveAttributionState,
    attributionShare: health.attributionShare,
  };
}

async function main() {
  const workspaceDir = resolveWorkspaceDir();
  const { resolveAttributionState, attributionShare } = await loadServerModules();
  const bookDirs = collectBookDirs(workspaceDir);

  const rows = [];
  for (const { bookDir, label } of bookDirs) {
    let stateResult;
    try {
      stateResult = await resolveAttributionState(bookDir);
    } catch (err) {
      // A single book's I/O failure must not abort the whole run.
      stateResult = { state: 'unmeasurable', reason: `error: ${err.message}`, measurement: null };
    }
    const share = stateResult.measurement ? attributionShare(stateResult.measurement) : null;
    rows.push(buildRow(label, stateResult, share));
  }

  printReport(rows);

  const reportPath = resolveReportPath();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ workspaceDir, generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\nJSON report written to ${reportPath}`);
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  });
}
