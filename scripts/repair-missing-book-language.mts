#!/usr/bin/env -S npx tsx
/*
 * repair-missing-book-language.mts
 *
 * Backfill for #2246 scope item 2. Seven pre-fs-2 books (the whole "Keeper of
 * the Lost Cities" series, measured 2026-08-11) have NO `language` key in
 * their `.audiobook/state.json` at all — they predate the field. That's
 * nearly harmless while dialogue detection is language-blind, but #2245
 * makes detection language-DRIVEN: with no language there is no quote-table,
 * and every line in a book like that loses its dialogue classification.
 *
 * This script finds every book with a missing `language` key, builds a text
 * sample, and calls the REAL `detectManuscriptLanguage` (server/src/tts/
 * detect-language.ts) — no re-implementation, so the backfilled value is
 * exactly what live detection would decide today.
 *
 * The load-bearing rule (do not soften this): it writes ONLY when detection
 * genuinely decided — `fallback: false` (#2246 scope item 1). A
 * `fallback: true` result is a confidence-floor GUESS (no letters to sample,
 * or franc found no match), and after #2245 a wrong language actively
 * damages attribution (it picks the wrong quote-table) — worse than a
 * missing one. A guess is reported and the book is left untouched.
 *
 * Sample text preference, per book:
 *   1. The book's analysis cache sentence text (server/handoff/cache/
 *      <manuscriptId>.json) — the same text real analysis already produced.
 *   2. No cache → the book's own manuscript file, re-parsed the same way
 *      POST /:bookId/reparse does (server/src/parsers, real parseManuscript).
 *   3. Neither readable → skip and name the book in the report. Never guess
 *      with no material to look at.
 *
 * Write path: `writeStateJsonAtomic` (server/src/workspace/state-migrate.ts)
 * — the same schema-stamp + rotating-backup helper every other state.json
 * write site uses. Every other field is preserved via spread; nothing here
 * ever reconstructs the object.
 *
 * DRY RUN BY DEFAULT — prints the planned writes and exits without touching
 * disk. Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/repair-missing-book-language.mts            # dry run
 *   npx tsx scripts/repair-missing-book-language.mts --apply    # write
 *   npm run repair:book-language                                # dry run
 *   npm run repair:book-language -- --apply
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectManuscriptLanguage } from '../server/src/tts/detect-language.js';
import { loadAnalysisCache } from '../server/src/store/analysis-cache.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from '../server/src/workspace/state-migrate.js';
import { parseManuscript } from '../server/src/parsers/index.js';
import type { BookStateJson } from '../server/src/workspace/scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SERVER_ROOT = join(REPO_ROOT, 'server');

// ---------------------------------------------------------------------------
// Pure decision logic — exported for unit tests. No I/O in here at all: the
// real detectManuscriptLanguage is pure (text in, DetectionResult out), so
// this whole decision can be unit-tested with plain strings.
// ---------------------------------------------------------------------------

export type SampleSource = 'analysis-cache' | 'manuscript';

export type BookLanguagePlan =
  | { bookId: string; action: 'has-language'; existingLanguage?: string }
  | { bookId: string; action: 'skip-no-text'; reason: string }
  | { bookId: string; action: 'skip-fallback'; language: string; sampleSource: SampleSource; reason: string }
  | { bookId: string; action: 'backfill'; language: string; sampleSource: SampleSource };

export function planBookLanguage(input: {
  bookId: string;
  hasLanguageKey: boolean;
  existingLanguage?: string;
  cacheText: string | null;
  manuscriptText: string | null;
  meta?: { author?: string | null; title?: string | null };
}): BookLanguagePlan {
  const { bookId, hasLanguageKey, existingLanguage, cacheText, manuscriptText, meta = {} } = input;

  if (hasLanguageKey) {
    return { bookId, action: 'has-language', existingLanguage };
  }

  const hasCache = !!(cacheText && cacheText.trim());
  const hasManuscript = !!(manuscriptText && manuscriptText.trim());
  if (!hasCache && !hasManuscript) {
    return {
      bookId,
      action: 'skip-no-text',
      reason: 'no analysis-cache sentence text and no readable manuscript file',
    };
  }

  const sample: { text: string; source: SampleSource } = hasCache
    ? { text: cacheText as string, source: 'analysis-cache' }
    : { text: manuscriptText as string, source: 'manuscript' };

  const detection = detectManuscriptLanguage(sample.text, meta);

  if (detection.fallback) {
    return {
      bookId,
      action: 'skip-fallback',
      language: detection.language,
      sampleSource: sample.source,
      reason:
        `detection surrendered (confidence-floor guess '${detection.language}') from ${sample.source} ` +
        'text — a guess is never written',
    };
  }

  return { bookId, action: 'backfill', language: detection.language, sampleSource: sample.source };
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

/** Read server/.env the way the server's own load-env.ts does
 *  (`process.loadEnvFile`), but by absolute path — load-env.ts relies on
 *  process.cwd() being `server/`, which isn't true when this script is
 *  invoked from the repo root. Seeds the SAME env var
 *  (`server/src/workspace/paths.ts` reads WORKSPACE_DIR) so that module's
 *  own resolution algorithm — not a copy of it — produces the real answer. */
function loadServerDotEnv(): void {
  const envPath = join(SERVER_ROOT, '.env');
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Fallback KEY=VALUE parse for a Node < 20.6 host (loadEnvFile is newer).
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
}

/** Every directory under `root` that IS a book — i.e. contains an
 *  `.audiobook/state.json`. Generic recursive descent (books nest by
 *  author/series, but this doesn't assume a fixed depth) rather than a
 *  hardcoded 3-level walk. Never descends into `.audiobook` itself or into
 *  `.upgrade-backups` (per-upgrade snapshot copies of state.json living
 *  outside any book folder — see server/src/workspace/upgrade-coordinator.ts
 *  — which must never be mistaken for a live book). */
function findAudiobookDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.upgrade-backups') continue;
      const child = join(dir, e.name);
      if (e.name === '.audiobook') {
        if (existsSync(join(child, 'state.json'))) found.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return found;
}

/** Join every sentence's text out of the book's analysis cache. Returns null
 *  when there's no cache (the common case for these seven — the analysis
 *  cache is install-relative scratch space, see server/src/export/
 *  manuscript-sentences.ts) or the cache is empty/corrupt — either way the
 *  caller falls through to the manuscript-file sample, never throws. */
export async function cacheSampleText(manuscriptId: string): Promise<string | null> {
  try {
    const cache = await loadAnalysisCache(manuscriptId);
    // '\n', not ' ' — detectManuscriptLanguage runs stripFrontMatterBoilerplate
    // first, which is LINE-based and drops any line matching an unanchored
    // global-boilerplate pattern. Joining every sentence onto one line means a
    // single boilerplate match (a stray copyright/e-library notice sentence
    // mid-cache) wipes the ENTIRE sample, not just that one sentence.
    const text = Object.values(cache.chapters ?? {})
      .flat()
      .map((s) => s.text)
      .join('\n')
      .trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** Re-parse the book's own manuscript file on disk (same parseManuscript the
 *  reparse route uses) and return its sourceText. Null when the book has no
 *  manuscript file, it's missing on disk, or it fails to parse — never
 *  throws, so a bad file just falls through to "no text" rather than
 *  aborting the whole run. */
async function manuscriptSampleText(bookDir: string, state: BookStateJson): Promise<string | null> {
  if (!state.manuscriptFile) return null;
  const manuscriptPath = join(bookDir, state.manuscriptFile);
  if (!existsSync(manuscriptPath)) return null;
  try {
    const buffer = readFileSync(manuscriptPath);
    const parsed = await parseManuscript({
      buffer,
      fileName: state.manuscriptFile,
      sourcePath: manuscriptPath,
    });
    return parsed.sourceText && parsed.sourceText.trim().length > 0 ? parsed.sourceText : null;
  } catch {
    return null;
  }
}

/**
 * @param argv                — process.argv slice (flags only; pass [] for defaults)
 * @param booksRootOverride   — override the resolved BOOKS_ROOT (used in tests)
 */
export async function main(argv: string[] = process.argv.slice(2), booksRootOverride?: string): Promise<void> {
  const APPLY = argv.includes('--apply');

  loadServerDotEnv();
  const { BOOKS_ROOT, stateJsonPath } = await import('../server/src/workspace/paths.js');
  const booksRoot = booksRootOverride ?? BOOKS_ROOT;

  if (!existsSync(booksRoot)) {
    console.error(`No books root at ${booksRoot}. Set WORKSPACE_DIR (server/.env) to your workspace.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — workspace books: ${booksRoot}\n`);

  const audiobookDirs = findAudiobookDirs(booksRoot);

  let alreadyHad = 0;
  let backfillPlanned = 0;
  let backfillWritten = 0;
  let skippedNoText = 0;
  let skippedFallback = 0;
  let unreadable = 0;

  for (const audiobookDir of audiobookDirs) {
    const bookDir = dirname(audiobookDir);
    const bookLabel = relative(booksRoot, bookDir);
    const statePath = stateJsonPath(bookDir);
    // readStateJsonWithRecovery re-throws the original parse error when the
    // main state.json is corrupt AND every rotated backup is also corrupt or
    // missing (state-io.ts) — that's a real, reachable case (one bad book
    // in a workspace of many), not a reason to abort the entire run. Caught
    // here so `state` lands `null` the same as the missing-file case below,
    // rather than letting the parse error propagate and kill every book
    // after this one.
    let state: BookStateJson | null;
    try {
      state = await readStateJsonWithRecovery(statePath);
    } catch {
      state = null;
    }
    if (!state) {
      unreadable += 1;
      console.log(`  [${bookLabel}] SKIP — state.json unreadable`);
      continue;
    }

    const hasLanguageKey = Object.prototype.hasOwnProperty.call(state, 'language');
    const existingLanguage = (state as BookStateJson & { language?: string }).language;

    let cacheText: string | null = null;
    let manuscriptText: string | null = null;
    if (!hasLanguageKey) {
      cacheText = state.manuscriptId ? await cacheSampleText(state.manuscriptId) : null;
      if (!cacheText) manuscriptText = await manuscriptSampleText(bookDir, state);
    }

    const plan = planBookLanguage({
      bookId: state.bookId ?? bookLabel,
      hasLanguageKey,
      existingLanguage,
      cacheText,
      manuscriptText,
      meta: { author: state.author, title: state.title },
    });

    switch (plan.action) {
      case 'has-language':
        alreadyHad += 1;
        console.log(`  [${bookLabel}] already has language '${plan.existingLanguage}' — skipped`);
        break;
      case 'skip-no-text':
        skippedNoText += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'skip-fallback':
        skippedFallback += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'backfill':
        backfillPlanned += 1;
        console.log(
          `  [${bookLabel}] ${APPLY ? 'Writing' : 'Would write'} language → '${plan.language}'  ` +
            `(source: ${plan.sampleSource})`,
        );
        if (APPLY) {
          await writeStateJsonAtomic(statePath, { ...state, language: plan.language });
          backfillWritten += 1;
        }
        break;
    }
  }

  console.log(
    `\n${audiobookDirs.length} book(s) scanned — ${alreadyHad} already had a language, ` +
      `${APPLY ? backfillWritten : backfillPlanned} ${APPLY ? 'written' : 'would be written'}, ` +
      `${skippedNoText} skipped (no text), ${skippedFallback} skipped (detection surrendered)` +
      `${unreadable > 0 ? `, ${unreadable} skipped (state.json unreadable)` : ''}.`,
  );
  if (!APPLY && backfillPlanned > 0) console.log('Re-run with --apply to write.');
}

// Run when executed directly (not imported in tests).
if (
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('repair-missing-book-language.mts')
) {
  main();
}
