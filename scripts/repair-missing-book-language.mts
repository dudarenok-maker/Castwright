#!/usr/bin/env -S npx tsx
/*
 * repair-missing-book-language.mts
 *
 * Backfill for #2246 scope item 2. Seven pre-fs-2 books (the whole "Keeper of
 * the Lost Cities" series, measured 2026-08-11) have NO `language` key in
 * their `.audiobook/state.json` at all — they predate the field. Downstream,
 * absent and explicit `'en'` are INDISTINGUISHABLE today:
 * `bookStateLanguage` (server/src/workspace/scan.ts) resolves a missing key
 * to `'en'` via `normaliseBookLanguage` (server/src/tts/language.ts), the
 * same default the analyzer resolves language through. So a language-less
 * book has always been analysed as English — harmless while the book
 * genuinely is English, silent mis-narration the moment it isn't — and
 * nothing in the product can tell the two states apart or correct either
 * one.
 *
 * This script finds every book with a missing `language` key, builds text
 * samples, and calls the REAL `detectManuscriptLanguage` (server/src/tts/
 * detect-language.ts) — no re-implementation, so the backfilled value is
 * exactly what live detection would decide today.
 *
 * The load-bearing rule (do not soften this): it writes ONLY on
 * cross-source agreement. The analysis-cache sample and a fresh manuscript
 * re-parse are detected INDEPENDENTLY, and a write happens only when BOTH
 * come back `fallback: false` (a genuine decision, not a confidence-floor
 * guess) AND land on the SAME language. `fallback: false` alone is not
 * proof of confidence — franc has no confidence floor above its own
 * `minLength: 30`, so a short, unrepresentative sample (a table of
 * contents, a run of OCR noise) can return a fluent, WRONG, non-fallback
 * language. Per server/src/workspace/scan.ts, a non-`'en'` language forces
 * every character onto a designed Qwen voice and blocks the Kokoro
 * fallback, so a wrong write is materially worse than the absent key it
 * replaces — worth the false-negative cost of skipping a book that a
 * single source alone would have (maybe-correctly) called. Any other
 * combination — one source missing, either side surrendering, or the two
 * disagreeing — is a skip, reported with a reason naming which. Skipping
 * is fully recoverable; writing a wrong language is what this script
 * exists to prevent. No magic threshold here, and this gate is
 * corpus-validated, not theoretical: all 7 books actually written in the
 * live 2026-08-11 run resolved to the same confident `en` from both
 * sources independently — this gate would have written the same 7 — while
 * the junk cases that motivated it (a table-of-contents cache sample vs.
 * genuine prose, OCR noise) diverge between sources and are refused.
 *
 * Text samples, per book:
 *   - The book's analysis cache sentence text (server/handoff/cache/
 *     <manuscriptId>.json) — the same text real analysis already produced.
 *   - The book's own manuscript file, re-parsed the same way POST
 *     /:bookId/reparse does (server/src/parsers, real parseManuscript).
 *   - Neither readable → skip and name the book in the report. Only one
 *     readable → also a skip (nothing to corroborate it against). Never
 *     guess from less than two agreeing reads.
 *
 * KNOWN RESIDUAL (#2256) — the two reads are independent in DERIVATION, not
 * in CONTENT. The cache is built from the manuscript, so a book whose OWN
 * text is unrepresentative carries the same junk into both samples, and they
 * agree. Verified against this gate: a TOC-only book backfills `'es'`, a
 * nav-only EPUB and an OCR-noise PDF both backfill `'en'`. What the gate
 * does close is the reachable case that motivated it — a resumable,
 * per-chapter cache holding only front matter while the manuscript holds
 * real prose — where the two diverge and the book is refused. Closing the
 * rest needs a prose-signal floor (a minimum of terminal-punctuated
 * sentences, say), which is a threshold decision, so it is ticketed rather
 * than guessed at here.
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
  | { bookId: string; action: 'skip-single-source'; sampleSource: SampleSource; reason: string }
  | { bookId: string; action: 'skip-fallback'; reason: string }
  | {
      bookId: string;
      action: 'skip-disagreement';
      cacheLanguage: string;
      manuscriptLanguage: string;
      reason: string;
    }
  | { bookId: string; action: 'backfill'; language: string };

/* Cross-source agreement gate (#2246 C1 fix). `fallback === false` alone is
   NOT proof of confidence: franc has no confidence floor above its own
   `minLength: 30`, so a short, unrepresentative sample (a table of contents,
   a run of OCR noise) can return a fluent, wrong, non-fallback language. The
   only corroboration available here is a SECOND independent sample, so this
   detects the analysis-cache text and a fresh manuscript re-parse
   SEPARATELY and backfills only when both agree — never a single source,
   however confident it looks in isolation. */
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

  if (!hasCache || !hasManuscript) {
    // Conservative by design: one source cannot corroborate itself, so a
    // book with only a cache or only a manuscript sample is a skip, not a
    // single-source backfill — even though the OLD behaviour backfilled
    // from whichever one source it had.
    const sampleSource: SampleSource = hasCache ? 'analysis-cache' : 'manuscript';
    const missing: SampleSource = hasCache ? 'manuscript' : 'analysis-cache';
    return {
      bookId,
      action: 'skip-single-source',
      sampleSource,
      reason:
        `only ${sampleSource} text is available (no ${missing} text to corroborate) — a single ` +
        'source can never confirm itself, so it is never enough to write',
    };
  }

  const cacheDetection = detectManuscriptLanguage(cacheText as string, meta);
  const manuscriptDetection = detectManuscriptLanguage(manuscriptText as string, meta);

  if (cacheDetection.fallback || manuscriptDetection.fallback) {
    const surrendered =
      cacheDetection.fallback && manuscriptDetection.fallback
        ? 'both the analysis-cache and manuscript samples'
        : cacheDetection.fallback
          ? 'the analysis-cache sample'
          : 'the manuscript sample';
    return {
      bookId,
      action: 'skip-fallback',
      reason: `detection surrendered on ${surrendered} (confidence-floor guess) — a guess is never written`,
    };
  }

  if (cacheDetection.language !== manuscriptDetection.language) {
    return {
      bookId,
      action: 'skip-disagreement',
      cacheLanguage: cacheDetection.language,
      manuscriptLanguage: manuscriptDetection.language,
      reason:
        `analysis-cache text detected '${cacheDetection.language}' but manuscript text detected ` +
        `'${manuscriptDetection.language}' — sources disagree, never write an unconfirmed guess`,
    };
  }

  return { bookId, action: 'backfill', language: cacheDetection.language };
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
 *  manuscript-sentences.ts) or the cache is empty/corrupt — either way this
 *  never throws, it's just one of the two samples the caller cross-checks. */
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
  let skippedSingleSource = 0;
  let skippedFallback = 0;
  let skippedDisagreement = 0;
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

    // Both samples are built whenever there's no language key — not cache-
    // preferred-with-manuscript-as-fallback — because the gate below needs
    // two INDEPENDENT reads to corroborate against each other (#2246 C1: a
    // single confident-looking detection is not proof of confidence).
    let cacheText: string | null = null;
    let manuscriptText: string | null = null;
    if (!hasLanguageKey) {
      cacheText = state.manuscriptId ? await cacheSampleText(state.manuscriptId) : null;
      manuscriptText = await manuscriptSampleText(bookDir, state);
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
      case 'skip-single-source':
        skippedSingleSource += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'skip-fallback':
        skippedFallback += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'skip-disagreement':
        skippedDisagreement += 1;
        console.log(`  [${bookLabel}] SKIP — ${plan.reason}`);
        break;
      case 'backfill':
        backfillPlanned += 1;
        console.log(
          `  [${bookLabel}] ${APPLY ? 'Writing' : 'Would write'} language → '${plan.language}'  ` +
            '(analysis-cache and manuscript samples agree)',
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
      `${skippedNoText} skipped (no text), ${skippedSingleSource} skipped (single source only), ` +
      `${skippedFallback} skipped (detection surrendered), ${skippedDisagreement} skipped (sources disagree)` +
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
