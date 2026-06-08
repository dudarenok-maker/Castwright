#!/usr/bin/env node
/*
 * repair-narrator-credit.mjs
 *
 * Back-catalogue backfill for the Castwright Wave 1 narrator credit (plan 204).
 *
 * Symptom: books created before the Wave 1 release have a null/empty
 * `narratorCredit` in their `.audiobook/state.json`. The server's book-state
 * GET already defaults it to "Castwright" for display, but the on-disk value
 * stays null — so export artist tags and any direct reader see no credit.
 * This script writes `narratorCredit: 'Castwright'` onto every book that has
 * no explicit narrator credit, making the data durable and self-consistent.
 *
 * Rules:
 *   - null / empty / whitespace-only → write 'Castwright'.
 *   - Any non-empty, non-whitespace value (including 'Castwright' already set)
 *     → skip. Explicit credits are NEVER overwritten.
 *   - Idempotent: running twice is safe.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write each changed state.json (a .bak is written first).
 *
 * Env:
 *   BASE                 workspace root (overrides everything)
 *   AUDIOBOOK_WORKSPACE  workspace root (same default the server uses)
 *   default              <home>/AudiobookWorkspace
 *
 * Usage:
 *   node scripts/repair-narrator-credit.mjs            # dry run
 *   node scripts/repair-narrator-credit.mjs --apply    # write
 *   BASE="C:/AudiobookWorkspace" node scripts/repair-narrator-credit.mjs --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Pure helper — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Given an array of `{ bookId, narratorCredit }` entries, return the bookIds
 * whose narratorCredit is null, undefined, empty, or whitespace-only.
 * Explicit credits (including 'Castwright' already written) are excluded.
 *
 * @param {Array<{ bookId: string, narratorCredit?: string | null }>} books
 * @returns {string[]}
 */
export function planBackfill(books) {
  return books
    .filter(({ narratorCredit }) => !narratorCredit || !narratorCredit.trim())
    .map(({ bookId }) => bookId);
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Recursively collect every `<dir>/.audiobook/` that holds a state.json. */
function findAudiobookDirs(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === '.audiobook') {
        if (fs.existsSync(path.join(child, 'state.json'))) found.push(child);
        continue; // never descend into .audiobook
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// main — exported for unit tests; also called when run as a script
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv    — process.argv slice (flags only; pass [] for defaults)
 * @param {string}   [booksRootOverride] — override BOOKS_ROOT (used in tests)
 */
export async function main(argv = process.argv.slice(2), booksRootOverride) {
  const APPLY = argv.includes('--apply');

  const BASE =
    (process.env.BASE && path.resolve(process.env.BASE)) ||
    (process.env.AUDIOBOOK_WORKSPACE && path.resolve(process.env.AUDIOBOOK_WORKSPACE)) ||
    path.join(os.homedir(), 'AudiobookWorkspace');

  const BOOKS_ROOT = booksRootOverride ?? path.join(BASE, 'books');

  if (!fs.existsSync(BOOKS_ROOT)) {
    console.error(`No books root at ${BOOKS_ROOT}. Set BASE to your workspace.`);
    return;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — workspace books: ${BOOKS_ROOT}\n`);

  // Collect all books with their current narratorCredit.
  const bookEntries = [];
  for (const ab of findAudiobookDirs(BOOKS_ROOT)) {
    const statePath = path.join(ab, 'state.json');
    const state = readJson(statePath);
    if (!state) continue;
    const bookId = path.relative(BOOKS_ROOT, path.dirname(ab));
    bookEntries.push({ bookId, narratorCredit: state.narratorCredit ?? null, statePath, state });
  }

  // Determine which books need the credit written.
  const toFill = planBackfill(bookEntries);

  if (toFill.length === 0) {
    console.log('All books already have an explicit narratorCredit — nothing to do.');
    return;
  }

  // Build a lookup from bookId to the full entry.
  const byId = new Map(bookEntries.map((e) => [e.bookId, e]));

  let written = 0;
  for (const bookId of toFill) {
    const entry = byId.get(bookId);
    if (!entry) continue;
    console.log(`  ${APPLY ? 'Writing' : 'Would write'} narratorCredit → 'Castwright'  [${bookId}]`);
    if (APPLY) {
      const bak = `${entry.statePath}.bak-narrator-credit-${Date.now()}`;
      fs.copyFileSync(entry.statePath, bak);
      const updated = { ...entry.state, narratorCredit: 'Castwright' };
      fs.writeFileSync(entry.statePath, `${JSON.stringify(updated, null, 2)}\n`);
      written += 1;
    }
  }

  console.log(
    `\n${APPLY ? 'Wrote' : 'Would write'} ${APPLY ? written : toFill.length} book(s).`,
  );
  if (!APPLY && toFill.length > 0) console.log('Re-run with --apply to write.');
}

// Run when executed directly (not imported in tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('repair-narrator-credit.mjs')) {
  main();
}
